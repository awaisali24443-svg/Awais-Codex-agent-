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

// Fully isolated GitHub integration API routes
router.get('/api/github/status', (req: Request, res: Response) => {
  const token = process.env.GITHUB_TOKEN || req.headers['x-github-token'] || '';
  res.json({
    connected: Boolean(token),
    hasToken: Boolean(token),
    username: token ? 'authenticated-user' : null
  });
});

router.post('/api/github/repos', async (req: Request, res: Response) => {
  const token = (req.body && req.body.token) || process.env.GITHUB_TOKEN || req.headers['x-github-token'];
  if (!token) {
    res.status(401).json({ error: 'GitHub Personal Access Token required' });
    return;
  }

  try {
    const fetchRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=30', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Awais-Codex-App'
      }
    });

    if (!fetchRes.ok) {
      const err = await fetchRes.text();
      res.status(fetchRes.status).json({ error: `GitHub API error: ${err}` });
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
  const activeToken = token || process.env.GITHUB_TOKEN;

  if (!activeToken) {
    res.status(401).json({ error: 'GitHub Personal Access Token required' });
    return;
  }

  if (!repoName) {
    res.status(400).json({ error: 'Repository name required' });
    return;
  }

  try {
    // 1. Get user login info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${activeToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Awais-Codex-App'
      }
    });

    if (!userRes.ok) {
      const err = await userRes.text();
      res.status(userRes.status).json({ error: `GitHub authentication failed: ${err}` });
      return;
    }

    const userData = await userRes.json();
    const owner = userData.login;

    // 2. Create or find repository
    let repoData: any = null;
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${activeToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Awais-Codex-App',
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
        headers: {
          'Authorization': `Bearer ${activeToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Awais-Codex-App'
        }
      });
      if (getRepoRes.ok) {
        repoData = await getRepoRes.json();
      } else {
        const err = await createRes.text();
        res.status(createRes.status).json({ error: `Failed to create repository: ${err}` });
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
            headers: {
              'Authorization': `Bearer ${activeToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Awais-Codex-App'
            },
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
            'Authorization': `Bearer ${activeToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Awais-Codex-App',
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
