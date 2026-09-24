/**
 * Pure GitHub API helpers — no express, no database, no server.
 *
 * Shared by the HTTP routes (`routes/github.ts`) and the credential verifier
 * (`verify.ts`), so "is the token good" means the same thing in both places.
 * The owner-resolution fallback (fine-grained PATs often cannot read `/user`)
 * is the workaround v1's `routes/github.ts` already used.
 */
export const GITHUB_API = 'https://api.github.com';
/** One GitHub call must never hang a request: v1 used the same 15s budget. */
export const GITHUB_CALL_TIMEOUT_MS = 15_000;

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'WAIS-App',
  };
}

export function classifyGitHubToken(token: string): string {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('ghu_') || token.startsWith('ghs_') || token.startsWith('ghr_')) {
    return 'oauth-or-app';
  }
  return 'personal-access-token';
}

export async function callGitHub(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS),
  });
}

/**
 * Who owns the token, or null when it is rejected.
 *
 * Fine-grained PATs often cannot read `/user` at all (403), so the owner of
 * the most recently updated repo is the fallback. A 401 on `/user` means the
 * token itself is bad and the fallback would fail the same way.
 *
 * Network failures are *not* swallowed: a null return means "the provider
 * said no", and callers that need the distinction (the verifier does) catch
 * the throw to tell "rejected" apart from "unreachable".
 */
export async function resolveGitHubOwner(
  token: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const userRes = await callGitHub(token, '/user', fetchImpl);
  if (userRes.ok) {
    const user = (await userRes.json()) as { login?: string };
    if (user.login) return user.login;
  } else if (userRes.status === 401) {
    return null;
  }

  const reposRes = await callGitHub(token, '/user/repos?per_page=1&sort=updated', fetchImpl);
  if (!reposRes.ok) return null;
  const repos = (await reposRes.json()) as Array<{ owner?: { login?: string } }>;
  return repos[0]?.owner?.login ?? null;
}
