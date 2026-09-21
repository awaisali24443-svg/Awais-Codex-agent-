import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

const router = Router();

function getFilesRecursively(dir: string, baseDir: string = dir): { relativePath: string; absolutePath: string }[] {
  let results: { relativePath: string; absolutePath: string }[] = [];
  if (!fs.existsSync(dir)) return results;

  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === '.git' || file === 'node_modules' || file === 'dist' || file === '.tmp' || file.endsWith('.tar') || file.endsWith('.zip') || file.endsWith('.apk')) {
      continue;
    }
    const absolutePath = path.join(dir, file);
    const stat = fs.statSync(absolutePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(absolutePath, baseDir));
    } else if (stat && stat.isFile() && stat.size < 5 * 1024 * 1024) { // Only push files < 5MB
      const relativePath = path.relative(baseDir, absolutePath).replace(/\\/g, '/');
      results.push({ relativePath, absolutePath });
    }
  }
  return results;
}

// Resolve GitHub token from request or backend environment variables
export function resolveGitHubToken(req?: Request, explicitToken?: string): string {
  if (explicitToken && typeof explicitToken === 'string' && explicitToken.trim()) {
    return explicitToken.trim();
  }
  const bodyToken = (req?.body && (req.body.token || req.body.githubToken)) as string;
  if (bodyToken && typeof bodyToken === 'string' && bodyToken.trim()) {
    return bodyToken.trim();
  }
  const headerToken = (req?.headers?.['x-github-token'] || req?.headers?.['authorization'] || '') as string;
  if (headerToken) {
    const clean = headerToken.startsWith('Bearer ') ? headerToken.slice(7).trim() : headerToken.trim();
    if (clean) return clean;
  }
  const envToken = (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PAT ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GITHUB_API_KEY ||
    ''
  ).trim();
  return envToken;
}

export function getGitHubHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Awais-Codex-App'
  };
}

// Helper to determine the repository owner/user for fine-grained or classic tokens
async function resolveGitHubOwner(token: string): Promise<string> {
  // 1. Try /user endpoint
  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: getGitHubHeaders(token)
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData.login) return userData.login;
    }
  } catch (_) {}

  // 2. If fine-grained PAT does not have user profile scope, query /user/repos
  try {
    const reposRes = await fetch('https://api.github.com/user/repos?per_page=1&sort=updated', {
      headers: getGitHubHeaders(token)
    });
    if (reposRes.ok) {
      const repos = await reposRes.json();
      if (Array.isArray(repos) && repos.length > 0 && repos[0]?.owner?.login) {
        return repos[0].owner.login;
      }
    }
  } catch (_) {}

  return process.env.GITHUB_USERNAME || 'authenticated-user';
}

// Fully isolated GitHub integration API routes
router.get('/api/github/status', async (req: Request, res: Response) => {
  const token = resolveGitHubToken(req);
  if (!token) {
    return res.json({
      connected: false,
      hasToken: false,
      isServerToken: false,
      username: null
    });
  }

  const isServerToken = Boolean(
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PAT ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GITHUB_API_KEY
  );

  let username = 'authenticated-user';
  let connected = false;

  try {
    const owner = await resolveGitHubOwner(token);
    if (owner && owner !== 'authenticated-user') {
      username = owner;
      connected = true;
    } else {
      connected = true;
    }
  } catch (_) {
    connected = true;
  }

  res.json({
    connected,
    hasToken: true,
    isServerToken,
    username,
    tokenType: token.startsWith('github_pat_') ? 'fine-grained' : (token.startsWith('ghp_') ? 'classic' : 'personal-access-token')
  });
});

router.post('/api/github/repos', async (req: Request, res: Response) => {
  const token = resolveGitHubToken(req, req.body?.token);
  if (!token) {
    res.status(401).json({ error: 'GitHub Personal Access Token required. Add GITHUB_TOKEN in backend or Settings.' });
    return;
  }

  try {
    const fetchRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=30', {
      headers: getGitHubHeaders(token)
    });

    if (!fetchRes.ok) {
      const err = await fetchRes.text();
      res.status(fetchRes.status).json({ error: `GitHub API error (${fetchRes.status}): ${err}` });
      return;
    }

    const repos = await fetchRes.json();
    res.json({ repos });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list GitHub repositories' });
  }
});

router.post('/api/github/export-repo', async (req: Request, res: Response) => {
  const { token, repoName, description, isPrivate, environmentId, apiKey } = req.body || {};
  const activeToken = resolveGitHubToken(req, token);

  if (!activeToken) {
    res.status(401).json({ error: 'GitHub Personal Access Token required. Please configure GITHUB_TOKEN in environment variables.' });
    return;
  }

  if (!repoName) {
    res.status(400).json({ error: 'Repository name required' });
    return;
  }

  try {
    // 1. Get user login info (supports both Fine-Grained & Classic PATs)
    const owner = await resolveGitHubOwner(activeToken);

    // 2. Create or find repository
    let repoData: any = null;
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        ...getGitHubHeaders(activeToken),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: repoName,
        description: description || 'Exported from Awais Codex',
        private: Boolean(isPrivate)
      })
    });

    if (createRes.ok) {
      repoData = await createRes.json();
    } else {
      // If repository already exists (422), fetch repository details
      const getRepoRes = await fetch(`https://api.github.com/repos/${owner}/${encodeURIComponent(repoName)}`, {
        headers: getGitHubHeaders(activeToken)
      });
      if (getRepoRes.ok) {
        repoData = await getRepoRes.json();
      } else {
        const err = await createRes.text();
        res.status(createRes.status).json({ error: `Failed to create or access repository: ${err}` });
        return;
      }
    }

    // 3. Collect files from environment snapshot or local workspace
    let filesToPush: { relativePath: string; absolutePath: string }[] = [];
    let tempDirToClean: string | null = null;

    if (environmentId && apiKey) {
      try {
        const downloadUrl = `https://generativelanguage.googleapis.com/v1beta/files/environment-${encodeURIComponent(environmentId)}:download?alt=media`;
        const fileRes = await fetch(downloadUrl, { headers: { 'x-goog-api-key': apiKey } });

        if (fileRes.ok) {
          const arrayBuf = await fileRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          tempDirToClean = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gh-export-'));
          const tarPath = path.join(tempDirToClean, 'snapshot.tar');
          fs.writeFileSync(tarPath, buffer);

          const extractDir = path.join(tempDirToClean, 'extracted');
          fs.mkdirSync(extractDir, { recursive: true });
          execSync(`tar -xf "${tarPath}" -C "${extractDir}"`);
          filesToPush = getFilesRecursively(extractDir);
        }
      } catch (err) {
        console.warn('Failed downloading environment tarball for GitHub export, falling back to local files:', err);
      }
    }

    if (filesToPush.length === 0) {
      filesToPush = getFilesRecursively(process.cwd());
    }

    // 4. Push each file using GitHub Contents API (15s timeout per call)
    let pushedCount = 0;
    for (const fileItem of filesToPush) {
      try {
        const contentBuffer = fs.readFileSync(fileItem.absolutePath);
        const base64Content = contentBuffer.toString('base64');

        const githubPath = fileItem.relativePath.split('/').map(encodeURIComponent).join('/');

        // Check if file already exists to get SHA for update
        let existingSha: string | undefined = undefined;
        try {
          const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${githubPath}`, {
            headers: getGitHubHeaders(activeToken),
            signal: AbortSignal.timeout(15000)
          });
          if (checkRes.ok) {
            const checkData: any = await checkRes.json();
            existingSha = checkData.sha;
          }
        } catch (_) {}

        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${githubPath}`, {
          method: 'PUT',
          headers: {
            ...getGitHubHeaders(activeToken),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `Update ${fileItem.relativePath} via Awais Codex`,
            content: base64Content,
            sha: existingSha
          }),
          signal: AbortSignal.timeout(15000)
        });

        if (putRes.ok) {
          pushedCount++;
        }
      } catch (fileErr) {
        console.warn(`Failed to push file ${fileItem.relativePath} to GitHub:`, fileErr);
      }
    }

    // Clean up temporary directory if used
    if (tempDirToClean) {
      try { fs.rmSync(tempDirToClean, { recursive: true, force: true }); } catch (_) {}
    }

    res.json({
      success: true,
      repoUrl: repoData?.html_url || `https://github.com/${owner}/${repoName}`,
      pushedFilesCount: pushedCount
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to export to GitHub' });
  }
});

export default router;
