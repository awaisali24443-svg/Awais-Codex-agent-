/**
 * GitHub routes — the service's GitHub integration, rebuilt for v2.
 *
 * v1 had this (`routes/github.ts` + `js/github.js`): token validation, a repo
 * list, and pushing generated files to a new repo. The v2 rewrite dropped all
 * of it — the old router was never mounted, `GITHUB_TOKEN` was documented in
 * `.env.example` but never read, and the secrets store refused `github_pat` —
 * so anything that tried to use GitHub through the service failed. This module
 * puts it back, on v2 terms:
 *
 *   1. **The token lives in the secrets store.** `github_pat` is a known
 *      secret (`server/settings.ts`), so the Settings panel renders it with no
 *      UI changes and `GITHUB_TOKEN` keeps working as the environment fallback.
 *      It is read per request, so a pasted key connects without a restart.
 *   2. **Session auth, not none.** v1 mounted these routes with no
 *      authentication at all, so anyone who could reach the URL could push
 *      files into the operator's GitHub account with the server's PAT. Here
 *      the router is mounted under `/api` behind `requireSession` in app.ts —
 *      the same bar as every other credential-adjacent route.
 *   3. **Token validation is the connection check.** `GET /github/status`
 *      calls the provider and reports what the provider says, the way
 *      `server/verify.ts` does for the other credentials: a stored key that
 *      GitHub rejects is "not connected", not "configured".
 *
 * Reused from v1, because it was already careful: the token-resolution order,
 * the `/user` → `/user/repos` owner fallback for fine-grained PATs, and the
 * create-or-reuse + per-file `PUT /contents` with SHA lookup. Dropped from v1:
 * the environment-tarball export path — that was the v1 agent sandbox's file
 * format and does not exist in v2. Callers pass explicit `files[]`.
 *
 * Mounted in app.ts under `/api`, e.g. `GET /api/github/status`.
 */
import { Router, type Request, type Response } from 'express';

import type { SecretsStore } from '../settings.js';
import {
  callGitHub,
  classifyGitHubToken,
  resolveGitHubOwner,
} from '../github.js';

export interface GitHubRouteDeps {
  /** Read at request time: a key pasted in Settings applies immediately. */
  secrets: Pick<SecretsStore, 'get'>;
  /** Overridden in tests; the real one talks to api.github.com. */
  fetchImpl?: typeof fetch;
}

/** Guardrails on what one export can push — the API bills per request. */
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Resolution order: an explicit per-request token (body or header) wins, then
 * the stored `github_pat` — whose environment fallback is `GITHUB_TOKEN`, wired
 * in `createStores`. A per-request token is how a one-off export runs without
 * touching Settings; the stored one is how the integration stays connected.
 */
function resolveToken(req: Request, secrets: Pick<SecretsStore, 'get'>): string {
  const body = (req.body ?? {}) as { token?: unknown; githubToken?: unknown };
  for (const candidate of [body.token, body.githubToken]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const header = req.headers['x-github-token'] ?? req.headers['authorization'];
  if (typeof header === 'string' && header.trim()) {
    const clean = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    if (clean) return clean;
  }
  return secrets.get('github_pat').trim();
}

/** Express 4 does not catch async throws — same wrapper shape as the other routers. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: Error) => {
      console.error('[github] request failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'github_failed', message: err.message });
      }
    });
  };
}

export function createGitHubRoutes({ secrets, fetchImpl = fetch }: GitHubRouteDeps): Router {
  const router = Router();

  /**
   * Is GitHub connected? The provider's answer, not the store's: a token that
   * GitHub rejects reports connected:false even though hasToken is true, which
   * is the distinction a Settings panel needs to show "replace your key".
   */
  router.get(
    '/github/status',
    handle(async (req, res) => {
      const token = resolveToken(req, secrets);
      if (!token) {
        res.json({ connected: false, hasToken: false, isServerToken: false, username: null });
        return;
      }

      // A network failure is neither "no token" nor "bad token": say so
      // explicitly instead of letting the generic 500 handler blur it.
      let owner: string | null = null;
      let unreachable = false;
      try {
        owner = await resolveGitHubOwner(token, fetchImpl);
      } catch {
        unreachable = true;
      }
      res.json({
        connected: owner !== null,
        hasToken: true,
        // A stored key (or its GITHUB_TOKEN fallback) is the server's token;
        // a per-request one belongs to whoever made the call.
        isServerToken: secrets.get('github_pat').trim() === token,
        username: owner,
        tokenType: classifyGitHubToken(token),
        ...(unreachable ? { error: 'network_unreachable' } : {}),
      });
    }),
  );

  /** The repos the token can see, most recently updated first. */
  router.get(
    '/github/repos',
    handle(async (req, res) => {
      const token = resolveToken(req, secrets);
      if (!token) {
        res
          .status(401)
          .json({ error: 'github_token_required', message: 'Store a GitHub PAT in Settings (github_pat) or set GITHUB_TOKEN.' });
        return;
      }

      const ghRes = await callGitHub(token, '/user/repos?sort=updated&per_page=30', fetchImpl);
      if (!ghRes.ok) {
        const detail = (await ghRes.text()).slice(0, 300);
        res
          .status(ghRes.status)
          .json({ error: 'github_api_error', message: `GitHub answered ${ghRes.status}: ${detail}` });
        return;
      }

      const repos = (await ghRes.json()) as Array<{
        name: string;
        full_name: string;
        html_url: string;
        private: boolean;
        description: string | null;
        updated_at: string;
      }>;
      res.json({
        repos: repos.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          url: r.html_url,
          private: r.private,
          description: r.description,
          updatedAt: r.updated_at,
        })),
      });
    }),
  );

  /**
   * Create (or reuse) a repo and push files into it, one `PUT /contents/...`
   * per file with a prior SHA lookup so updates do not 409. Body:
   * `{ repoName, description?, private?, files: [{ path, content }] }`.
   * Paths are confined to the repo — no absolute paths, no `..`.
   */
  router.post(
    '/github/export-repo',
    handle(async (req, res) => {
      const token = resolveToken(req, secrets);
      if (!token) {
        res
          .status(401)
          .json({ error: 'github_token_required', message: 'Store a GitHub PAT in Settings (github_pat) or set GITHUB_TOKEN.' });
        return;
      }

      const { repoName, description, private: isPrivate, files } = (req.body ?? {}) as {
        repoName?: unknown;
        description?: unknown;
        private?: unknown;
        files?: unknown;
      };

      if (typeof repoName !== 'string' || !repoName.trim()) {
        res.status(400).json({ error: 'repo_name_required', message: 'body.repoName is required' });
        return;
      }
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: 'files_required', message: 'body.files must be a non-empty array of { path, content }' });
        return;
      }
      if (files.length > MAX_FILES) {
        res.status(400).json({ error: 'too_many_files', message: `at most ${MAX_FILES} files per export` });
        return;
      }

      const clean: Array<{ path: string; content: string }> = [];
      for (const f of files) {
        const item = f as { path?: unknown; content?: unknown };
        if (typeof item?.path !== 'string' || typeof item?.content !== 'string') {
          res.status(400).json({ error: 'bad_file', message: 'every file needs a string path and string content' });
          return;
        }
        const p = item.path.replace(/\\/g, '/').trim();
        if (!p || p.startsWith('/') || p.split('/').includes('..')) {
          res.status(400).json({ error: 'bad_path', message: `refusing path outside the repo: ${item.path}` });
          return;
        }
        if (Buffer.byteLength(item.content, 'utf8') > MAX_FILE_BYTES) {
          res.status(400).json({ error: 'file_too_large', message: `${p} exceeds the 1 MB per-file limit` });
          return;
        }
        clean.push({ path: p, content: item.content });
      }

      const owner = await resolveGitHubOwner(token, fetchImpl);
      if (!owner) {
        res.status(401).json({ error: 'github_auth_failed', message: 'GitHub rejected the token.' });
        return;
      }

      const name = repoName.trim();
      let htmlUrl = `https://github.com/${owner}/${name}`;

      // Create, falling back to the existing repo when creation 422s.
      const createRes = await callGitHub(token, '/user/repos', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: typeof description === 'string' ? description : `Exported from Awais Codex`,
          private: Boolean(isPrivate),
        }),
      });
      if (createRes.ok) {
        const created = (await createRes.json()) as { html_url?: string };
        if (created.html_url) htmlUrl = created.html_url;
      } else if (createRes.status !== 422) {
        const detail = (await createRes.text()).slice(0, 300);
        res
          .status(createRes.status)
          .json({ error: 'github_api_error', message: `Could not create the repo: ${detail}` });
        return;
      }

      let pushed = 0;
      const failed: string[] = [];
      for (const file of clean) {
        try {
          const ghPath = file.path.split('/').map(encodeURIComponent).join('/');
          let sha: string | undefined;
          try {
            const checkRes = await callGitHub(
              token,
              `/repos/${owner}/${encodeURIComponent(name)}/contents/${ghPath}`,
              fetchImpl,
            );
            if (checkRes.ok) {
              const existing = (await checkRes.json()) as { sha?: string };
              sha = existing.sha;
            }
          } catch {
            /* a missing file is the normal case: push without a SHA */
          }

          const putRes = await callGitHub(
            token,
            `/repos/${owner}/${encodeURIComponent(name)}/contents/${ghPath}`,
            fetchImpl,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: `Add ${file.path} via Awais Codex`,
                content: Buffer.from(file.content, 'utf8').toString('base64'),
                sha,
              }),
            },
          );
          if (putRes.ok) pushed++;
          else failed.push(file.path);
        } catch {
          failed.push(file.path);
        }
      }

      res.json({ ok: true, repoUrl: htmlUrl, pushedFiles: pushed, failedFiles: failed });
    }),
  );

  return router;
}
