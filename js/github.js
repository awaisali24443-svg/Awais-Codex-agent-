// ==========================================
// GITHUB INTEGRATION (ISOLATED MODULE)
// ==========================================

const GITHUB_TOKEN_KEY = 'awais_codex_github_token';

let githubToastCallback = null;
let githubOpenSettingsCallback = null;

export function setGitHubHandlers(handlers = {}) {
  if (handlers.showToast) githubToastCallback = handlers.showToast;
  if (handlers.openSettings) githubOpenSettingsCallback = handlers.openSettings;
}

function notify(msg, type = 'info') {
  if (githubToastCallback) {
    githubToastCallback(msg, type);
  } else {
    console.log(`[GitHub] (${type}) ${msg}`);
  }
}

export function getGitHubToken() {
  return localStorage.getItem(GITHUB_TOKEN_KEY) || '';
}

export function setGitHubToken(token) {
  localStorage.setItem(GITHUB_TOKEN_KEY, (token || '').trim());
}

export async function checkGitHubStatus() {
  try {
    const token = getGitHubToken();
    const headers = {};
    if (token) headers['x-github-token'] = token;
    const res = await fetch('/api/github/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.warn('Failed to check GitHub status:', e);
  }
  return { connected: false, hasToken: false, username: null };
}

export async function testGitHubConnection(token) {
  const t = (token || getGitHubToken()).trim();
  
  const res = await fetch('/api/github/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t ? { token: t } : {})
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  if (t) setGitHubToken(t);
  return data.repos || [];
}

export async function pushTaskToGitHub(project, turn) {
  let token = getGitHubToken();
  if (!token) {
    const status = await checkGitHubStatus();
    if (!status.hasToken) {
      notify('GitHub token not configured. Please add your token in Settings.', 'rose');
      if (githubOpenSettingsCallback) githubOpenSettingsCallback();
      return;
    }
  }

  const repoName = (project?.title || 'awais-codex-export')
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'awais-codex-export';

  notify(`Pushing project "${repoName}" to GitHub...`, 'info');

  try {
    const res = await fetch('/api/github/export-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token || undefined,
        repoName,
        projectTitle: project?.title || 'Awais Codex Project',
        projectContent: turn?.output || turn?.prompt || '',
        description: `Exported from Awais Codex project "${project?.title || 'Untitled'}"`,
        isPrivate: false,
        environmentId: project?.environmentId || turn?.environmentId,
        apiKey: localStorage.getItem('awais_codex_api_key') || ''
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify(`GitHub Push Failed: ${data.error || res.statusText}`, 'rose');
      return;
    }

    if (data.repoUrl) {
      notify(`✓ Files pushed to GitHub repository: ${data.repoUrl}`, 'info');
    } else {
      notify('✓ Files pushed to GitHub successfully!', 'info');
    }
  } catch (err) {
    notify(`GitHub Push Error: ${err.message}`, 'rose');
  }
}
