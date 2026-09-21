// ==========================================
// MOBILE NAVIGATION & SCREEN ROUTER
// ==========================================

import { state, el, escapeHtml } from './state.js';
import { selectProject, renderHistoryList } from './sidebar.js';
import { renderConversation } from './execution-cards.js';
import { openSettingsModal } from './main.js';
import { refreshMemoryUI } from './memory.js';

let currentScreen = 'hub'; // 'hub' | 'new_mission' | 'mission_control' | 'projects' | 'settings'

export function getCurrentScreen() {
  return currentScreen;
}

export function switchScreen(screenName, data = {}) {
  currentScreen = screenName;
  state.activeScreen = screenName;

  const isMobile = window.innerWidth <= 768;

  const screens = ['hub', 'new_mission', 'mission_control', 'projects', 'settings'];
  screens.forEach(s => {
    const elScreen = document.getElementById(`screen-${s}`);
    if (elScreen) {
      if (isMobile) {
        elScreen.style.display = s === screenName ? 'flex' : 'none';
      } else {
        if (s === 'mission_control') {
          elScreen.style.display = 'flex';
        } else {
          elScreen.style.display = 'none';
        }
      }
    }
  });

  // Update Bottom Nav active state
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    const target = btn.dataset.screen;
    if (target === screenName || (screenName === 'mission_control' && target === 'hub')) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Top app bar back button visibility
  const backBtn = document.getElementById('mobile-header-back-btn');
  if (backBtn) {
    backBtn.style.display = (isMobile && (screenName === 'mission_control' || screenName === 'new_mission')) ? 'inline-flex' : 'none';
  }

  // Update top session title on mobile
  const titleEl = document.getElementById('active-session-title');
  if (titleEl && isMobile) {
    if (screenName === 'hub') titleEl.textContent = 'Awais Codex';
    else if (screenName === 'new_mission') titleEl.textContent = 'New Mission';
    else if (screenName === 'projects') titleEl.textContent = 'Projects & Sandboxes';
    else if (screenName === 'settings') titleEl.textContent = 'Control Settings';
    else if (screenName === 'mission_control') {
      const activeProj = state.projects.find(p => p.id === state.activeSessionId);
      titleEl.textContent = activeProj?.title || 'Mission Control';
    }
  }

  // Screen specific rendering
  if (screenName === 'hub') {
    renderHubScreen();
  } else if (screenName === 'mission_control') {
    if (data.projectId) {
      selectProject(data.projectId);
    }
    renderLiveMissionCockpit();
  } else if (screenName === 'projects') {
    renderProjectsScreen();
  } else if (screenName === 'settings') {
    renderSettingsScreen();
  }
}

export function renderHubScreen() {
  const activeMissionHero = document.getElementById('hub-active-mission-card');
  const recentMissionsList = document.getElementById('hub-recent-missions-list');

  // Check if there is an active running/queued task
  const activeTask = state.activeTask;
  const runningProject = state.projects.find(p => p.status === 'running' || p.status === 'queued' || (p.messages && p.messages.some(m => m.status === 'running' || m.status === 'queued')));

  if (activeMissionHero) {
    if (runningProject || activeTask) {
      const proj = runningProject || state.projects.find(p => p.id === activeTask?.projectId);
      const activeTurn = proj?.messages?.find(m => m.status === 'running' || m.status === 'queued') || proj?.messages?.[proj.messages.length - 1];
      const title = proj?.title || activeTurn?.prompt?.slice(0, 36) || 'Autonomous Mission';
      const statusText = activeTurn?.status === 'running' ? 'WORKING' : 'QUEUED';
      const statusColor = activeTurn?.status === 'running' ? 'var(--accent)' : 'var(--amber)';

      activeMissionHero.style.display = 'block';
      activeMissionHero.innerHTML = `
        <div class="hub-active-card-header">
          <span class="hub-active-pulse-badge">
            <span class="pulse-dot"></span>
            ${statusText}
          </span>
          <span class="hub-active-engine">Antigravity 05-2026</span>
        </div>
        <div class="hub-active-card-title">${escapeHtml(title)}</div>
        <div class="hub-active-activity-banner" id="hub-live-activity-text">
          ⚡ ${escapeHtml(activeTurn?.currentActivity || 'Executing autonomous task in remote sandbox...')}
        </div>
        <div class="hub-active-card-footer">
          <span>Tap to monitor live progress →</span>
        </div>
      `;

      activeMissionHero.onclick = () => {
        switchScreen('mission_control', { projectId: proj?.id });
      };
    } else {
      activeMissionHero.style.display = 'none';
    }
  }

  // Render recent missions list
  if (recentMissionsList) {
    if (state.projects.length === 0) {
      recentMissionsList.innerHTML = `
        <div class="hub-empty-state">
          <div class="hub-empty-icon">🚀</div>
          <div class="hub-empty-title">No missions yet</div>
          <div class="hub-empty-desc">Launch your first autonomous mission with Google Antigravity</div>
          <button type="button" class="btn-hub-new-mission" onclick="window.AwaisMobile.switchScreen('new_mission')">
            + Create New Mission
          </button>
        </div>
      `;
    } else {
      recentMissionsList.innerHTML = state.projects.map(p => {
        const isSuccess = p.status === 'success' || !p.status;
        const isRunning = p.status === 'running';
        const isFailed = p.status === 'failed';
        const statusClass = isRunning ? 'running' : (isSuccess ? 'success' : 'failed');
        const statusLabel = isRunning ? 'Running' : (isSuccess ? 'Completed' : 'Failed');

        const turnsCount = p.messages?.length || 1;
        const hasApk = (p.messages || []).some(m => m.steps?.some(s => s.tool_calls?.some(c => (c.arguments?.TargetFile || '').endsWith('.apk'))));
        const apkBadge = hasApk ? `<span class="hub-item-badge apk">📦 APK</span>` : '';

        const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent';

        return `
          <div class="hub-mission-item" data-id="${p.id}">
            <div class="hub-mission-item-left">
              <span class="hub-status-dot ${statusClass}"></span>
              <div class="hub-mission-item-info">
                <div class="hub-mission-item-title">${escapeHtml(p.title || p.prompt?.slice(0, 32) || 'Untitled Mission')}</div>
                <div class="hub-mission-item-meta">
                  <span>${statusLabel}</span> • <span>${turnsCount} ${turnsCount === 1 ? 'turn' : 'turns'}</span> • <span>${dateStr}</span>
                </div>
              </div>
            </div>
            <div class="hub-mission-item-right">
              ${apkBadge}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </div>
        `;
      }).join('');

      recentMissionsList.querySelectorAll('.hub-mission-item').forEach(elItem => {
        elItem.addEventListener('click', () => {
          const id = elItem.dataset.id;
          switchScreen('mission_control', { projectId: id });
        });
      });
    }
  }
}

export function renderLiveMissionCockpit() {
  const activeProj = state.projects.find(p => p.id === state.activeSessionId);
  if (!activeProj) return;

  const headerTitle = document.getElementById('cockpit-mission-title');
  if (headerTitle) {
    headerTitle.textContent = activeProj.title || activeProj.prompt?.slice(0, 36) || 'Mission Control';
  }

  // Render conversation/execution cards inside the cockpit container
  renderConversation(activeProj);
}

export function renderProjectsScreen() {
  const container = document.getElementById('projects-screen-container');
  if (!container) return;

  const environments = [];
  state.projects.forEach(p => {
    const env = p.environmentId || p.messages?.find(m => m.environmentId)?.environmentId;
    if (env && !environments.includes(env)) {
      environments.push(env);
    }
  });

  container.innerHTML = `
    <div class="projects-header">
      <h2>Projects & Remote Sandboxes</h2>
      <p>Active Linux cloud sandboxes running Google Antigravity</p>
    </div>
    <div class="projects-stats-row">
      <div class="project-stat-card">
        <div class="stat-num">${state.projects.length}</div>
        <div class="stat-label">Total Missions</div>
      </div>
      <div class="project-stat-card">
        <div class="stat-num">${environments.length || 1}</div>
        <div class="stat-label">Active Sandboxes</div>
      </div>
    </div>
    <div class="sandboxes-list-title">Cloud Environments</div>
    <div class="sandboxes-list">
      ${environments.length > 0 ? environments.map(env => `
        <div class="sandbox-card">
          <div class="sandbox-card-header">
            <span class="sandbox-icon">☁️</span>
            <span class="sandbox-id">${escapeHtml(env)}</span>
            <span class="sandbox-status-pill online">Active</span>
          </div>
          <div class="sandbox-desc">Linux Container • Tools & Compilers Ready</div>
        </div>
      `).join('') : `
        <div class="sandbox-card">
          <div class="sandbox-card-header">
            <span class="sandbox-icon">☁️</span>
            <span class="sandbox-id">remote (Default Sandbox)</span>
            <span class="sandbox-status-pill online">Active</span>
          </div>
          <div class="sandbox-desc">Allocates dynamically on mission launch</div>
        </div>
      `}
    </div>
  `;
}

export function renderSettingsScreen() {
  const container = document.getElementById('settings-screen-container');
  if (!container) return;

  const hasKey = Boolean(state.apiKey || state.hasEnvKey);
  const keyLabel = state.apiKey ? 'Configured in browser' : (state.hasEnvKey ? 'Configured in backend (.env)' : 'Missing');
  const keyColor = hasKey ? 'var(--emerald)' : 'var(--rose)';

  container.innerHTML = `
    <div class="mobile-settings-header">
      <h2>Control Center Settings</h2>
      <p>Manage model, persistent memory & WhatsApp tunnel</p>
    </div>

    <div class="mobile-settings-section">
      <div class="mobile-settings-section-title">Engine Configuration</div>
      <div class="mobile-setting-row" onclick="window.AwaisMobile.openSettingsModal()">
        <div class="setting-row-left">
          <div class="setting-title">Antigravity API Key</div>
          <div class="setting-subtitle" style="color: ${keyColor};">${keyLabel}</div>
        </div>
        <span class="setting-row-arrow">→</span>
      </div>
      <div class="mobile-setting-row">
        <div class="setting-row-left">
          <div class="setting-title">Active Model</div>
          <div class="setting-subtitle">antigravity-preview-05-2026 (Strict)</div>
        </div>
        <span class="setting-row-badge">Active</span>
      </div>
    </div>

    <div class="mobile-settings-section">
      <div class="mobile-settings-section-title">Agent Memory & Brain</div>
      <div class="mobile-setting-row" onclick="window.AwaisMobile.openMemoryModal()">
        <div class="setting-row-left">
          <div class="setting-title">Persistent Memory Store</div>
          <div class="setting-subtitle">View user profile & cross-session learnings</div>
        </div>
        <span class="setting-row-arrow">🧠</span>
      </div>
    </div>

    <div class="mobile-settings-section">
      <div class="mobile-settings-section-title">Integrations & Tunnels</div>
      <div class="mobile-setting-row" onclick="window.AwaisMobile.openSettingsModal()">
        <div class="setting-row-left">
          <div class="setting-title">WhatsApp Agent Tunnel</div>
          <div class="setting-subtitle">Pair mobile phone with agent tunnel</div>
        </div>
        <span class="setting-row-arrow">→</span>
      </div>
      <div class="mobile-setting-row" onclick="window.AwaisMobile.openSettingsModal()">
        <div class="setting-row-left">
          <div class="setting-title">GitHub Repository Export</div>
          <div class="setting-subtitle">Manage Personal Access Token (PAT)</div>
        </div>
        <span class="setting-row-arrow">→</span>
      </div>
    </div>

    <div class="mobile-settings-section">
      <div class="mobile-settings-section-title">Interface & PWA</div>
      <div class="mobile-setting-row" id="mobile-theme-row">
        <div class="setting-row-left">
          <div class="setting-title">Theme Mode</div>
          <div class="setting-subtitle" id="mobile-theme-status">Dark</div>
        </div>
        <button type="button" class="btn-toggle-theme-mobile" id="btn-theme-mobile">Toggle</button>
      </div>
    </div>
  `;

  const btnTheme = document.getElementById('btn-theme-mobile');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('awais_codex_theme', newTheme);
      const status = document.getElementById('mobile-theme-status');
      if (status) status.textContent = newTheme === 'dark' ? 'Dark' : 'Light';
    });
  }
}

export function initMobileNav() {
  // Bottom nav button clicks
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const screen = btn.dataset.screen;
      if (screen) {
        switchScreen(screen);
      }
    });
  });

  // Top header back button
  const backBtn = document.getElementById('mobile-header-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      switchScreen('hub');
    });
  }

  // Quick prompt chips in New Mission or Hub
  document.querySelectorAll('.quick-prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const promptText = chip.dataset.prompt;
      if (promptText) {
        const input = document.getElementById('mobile-mission-prompt');
        if (input) {
          input.value = promptText;
          switchScreen('new_mission');
          input.focus();
        }
      }
    });
  });

  // Launch mission button in screen-new-mission
  const launchBtn = document.getElementById('btn-launch-mission-mobile');
  const promptInput = document.getElementById('mobile-mission-prompt');
  if (launchBtn && promptInput) {
    launchBtn.addEventListener('click', () => {
      const prompt = promptInput.value.trim();
      if (!prompt) return;

      const chatInput = document.getElementById('chat-input');
      if (chatInput) {
        chatInput.value = prompt;
        const sendBtn = document.getElementById('send-msg-btn');
        if (sendBtn) {
          promptInput.value = '';
          switchScreen('mission_control');
          sendBtn.click();
        }
      }
    });
  }

  // Mobile Artifacts Toggle Button (Header)
  const artifactsToggleBtn = document.getElementById('mobile-artifacts-toggle-btn');
  if (artifactsToggleBtn) {
    artifactsToggleBtn.addEventListener('click', () => {
      const dock = document.getElementById('artifacts-dock');
      if (dock) {
        dock.classList.toggle('open');
      }
    });
  }

  // Handle viewport resizing between desktop and mobile smoothly
  window.addEventListener('resize', () => {
    switchScreen(currentScreen);
  });

  // Expose global controller
  window.AwaisMobile = {
    switchScreen,
    getCurrentScreen,
    openSettingsModal,
    openMemoryModal: () => {
      const modal = document.getElementById('memory-modal');
      if (modal) {
        modal.style.display = 'flex';
        refreshMemoryUI();
      }
    }
  };

  // Start on Hub screen if mobile width
  if (window.innerWidth <= 768) {
    switchScreen('hub');
  }
}

export function updateMobileLiveActivity(activity) {
  if (!activity) return;

  const hubText = document.getElementById('hub-live-activity-text');
  if (hubText) {
    hubText.textContent = `⚡ ${activity.title || 'Executing task'}${activity.detail ? ' — ' + activity.detail : ''}`;
  }

  const cockpitBanner = document.getElementById('cockpit-hero-banner');
  const cockpitText = document.getElementById('cockpit-live-activity-text');
  const cockpitTitle = document.getElementById('cockpit-mission-title');

  if (cockpitText) {
    cockpitText.textContent = `${activity.title || 'Executing task'}${activity.detail ? ' — ' + activity.detail : ''}`;
  }

  if (cockpitTitle && state.activeSessionId) {
    const proj = state.projects.find(p => p.id === state.activeSessionId);
    if (proj) {
      cockpitTitle.textContent = proj.title || 'Mission Control';
    }
  }

  if (cockpitBanner) {
    if (activity.status === 'completed') {
      cockpitBanner.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    } else if (activity.status === 'failed') {
      cockpitBanner.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    } else {
      cockpitBanner.style.borderColor = 'rgba(59, 130, 246, 0.35)';
    }
    cockpitBanner.style.display = 'block';
  }
}

export function updateMobileArtifactsBadge(count) {
  const badge = document.getElementById('mobile-artifacts-count');
  if (badge) {
    badge.textContent = String(count || 0);
  }
}
