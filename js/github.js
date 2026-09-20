// ==========================================
// GITHUB INTEGRATION (ISOLATED MODULE)
// ==========================================

const GITHUB_TOKEN_KEY = 'awais_codex_github_token';

export function getGitHubToken() {
  return localStorage.getItem(GITHUB_TOKEN_KEY) || '';
}

export function setGitHubToken(token) {
  localStorage.setItem(GITHUB_TOKEN_KEY, token.trim());
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
  if (!t) throw new Error('Please enter a GitHub Personal Access Token');
  
  const res = await fetch('/api/github/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: t })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  setGitHubToken(t);
  return data.repos || [];
}

export async function pushTaskToGitHub(project, turn) {
  let token = getGitHubToken();
  if (!token) {
    const input = prompt('Enter your GitHub Personal Access Token (repo scope required):');
    if (!input || !input.trim()) {
      return;
    }
    token = input.trim();
    setGitHubToken(token);
  }

  const repoName = (project?.title || 'awais-codex-export')
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'awais-codex-export';

  try {
    const res = await fetch('/api/github/export-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        repoName,
        description: `Exported from Awais Codex project "${project?.title || 'Untitled'}"`,
        isPrivate: false,
        environmentId: project?.environmentId || turn?.environmentId,
        apiKey: localStorage.getItem('awais_codex_api_key') || ''
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`GitHub Push Failed: ${data.error || res.statusText}`);
      return;
    }

    if (data.repoUrl) {
      alert(`Successfully pushed files to GitHub!\nRepository: ${data.repoUrl}`);
    } else {
      alert('Files pushed to GitHub successfully!');
    }
  } catch (err) {
    alert(`GitHub Push Error: ${err.message}`);
  }
}

