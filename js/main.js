// ==========================================
// MAIN APPLICATION ENTRY POINT & EVENT LISTENERS
// ==========================================

import { state, el, initEl, STORAGE_KEYS, saveProjects, loadProjects, escapeHtml, formatFileSize } from './state.js';
import { setExecutionCardHandlers, renderConversation } from './execution-cards.js';
import { setSidebarHandlers, renderHistoryList, selectProject, deleteProject, showWelcomeHero, updateAgentStatusHeader, updateQueueBadge, toggleSidebarCollapse } from './sidebar.js';
import { setArtifactsHandlers, updateArtifactsDockForProject, switchArtifactTab, openArtifactsDock, closeArtifactsDock, toggleArtifactsDock, toggleSplitMode, openLightbox, closeLightbox, openDownloadModal, closeDownloadModal, downloadCustomArtifact, downloadWorkspaceArchive } from './artifacts.js';
import { setQueueHandlers, handlePromptSubmission, cancelTask, retryTask } from './queue.js';
import { updateCallBudgetUI } from './call-budget.js';
import { getGitHubToken, setGitHubToken, checkGitHubStatus, testGitHubConnection, setGitHubHandlers } from './github.js';
import { initMemoryUI, setMemoryHandlers, openMemoryModal } from './memory.js';

let deferredPwaPrompt = null;
let whatsappPollTimer = null;

export function getWhatsAppAdminSecret() {
  return localStorage.getItem('awais_whatsapp_admin_secret') || 'wa_admin_secret_change_me_in_prod';
}

export function fetchWithWhatsAppAuth(url, options = {}) {
  const secret = getWhatsAppAdminSecret();
  const headers = options.headers ? new Headers(options.headers) : new Headers();
  headers.set('Authorization', `Bearer ${secret}`);
  headers.set('x-whatsapp-admin-secret', secret);
  return fetch(url, { ...options, headers });
}

export function init() {
  initEl();
  loadSettings();
  initTheme();
  loadProjects();
  updateCallBudgetUI();
  initOfflineIndicator();

  // Wire cross-module handler callbacks
  setExecutionCardHandlers({ cancelTask, retryTask, openSettings });
  setSidebarHandlers({ renderConversation, updateArtifactsDockForProject, showConfirmModal, showToast });
  setArtifactsHandlers({ showToast });
  setQueueHandlers({ openSettings, showToast });
  setGitHubHandlers({ showToast, openSettings });
  setMemoryHandlers({ showToast });
  initMemoryUI();

  setupEventListeners();
  initPWA();

  if (state.projects.length > 0) {
    const active = state.projects.find(p => p.id === state.activeSessionId) || state.projects[0];
    selectProject(active.id);
  } else {
    showWelcomeHero(true);
    renderHistoryList();
    updateArtifactsDockForProject(null);
  }

  updateEnginePillDisplay();
  updateQueueBadge();

  // Check if polling is needed and start polling loop only if WhatsApp agent paired or WA conversations exist
  checkAndManageWhatsAppPolling();
}

export async function checkAndManageWhatsAppPolling() {
  // Always immediately sync conversations on check
  syncWhatsAppConversations();

  // Keep WhatsApp polling active so any inbound WhatsApp messages appear in real-time
  if (!whatsappPollTimer) {
    whatsappPollTimer = setInterval(syncWhatsAppConversations, 3500);
  }
}

export async function syncWhatsAppConversations() {
  try {
    const res = await fetchWithWhatsAppAuth('/api/whatsapp/conversations');
    if (!res.ok) return;
    const data = await res.json();
    if (data && Array.isArray(data.conversations)) {
      let changed = false;
      data.conversations.forEach(waConv => {
        const existingIdx = state.projects.findIndex(p => p.id === waConv.id);
        const normalizedProject = {
          id: waConv.id,
          title: waConv.title,
          source: 'whatsapp',
          isWhatsApp: true,
          sender: waConv.sender,
          createdAt: waConv.createdAt || waConv.updatedAt,
          updatedAt: waConv.updatedAt,
          messages: (waConv.messages || []).map(m => ({
            id: m.id,
            prompt: m.prompt,
            source: 'whatsapp',
            status: m.status || 'success',
            steps: m.steps || [],
            output: m.output || '',
            artifacts: m.artifacts || [],
            startedAt: m.startedAt,
            completedAt: m.completedAt,
            durationMs: m.durationMs
          }))
        };

        if (existingIdx >= 0) {
          const existing = state.projects[existingIdx];
          if (JSON.stringify(existing.messages) !== JSON.stringify(normalizedProject.messages) || existing.title !== normalizedProject.title) {
            state.projects[existingIdx] = normalizedProject;
            changed = true;
            if (state.activeSessionId === waConv.id) {
              renderConversation(normalizedProject);
            }
          }
        } else {
          state.projects.unshift(normalizedProject);
          changed = true;
        }
      });

      if (changed) {
        saveProjects();
        renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
        checkAndManageWhatsAppPolling();
      }
    }
  } catch (_) {}
}

function loadSettings() {
  state.apiKey = localStorage.getItem(STORAGE_KEYS.API_KEY) || "";
  state.selectedEngine = localStorage.getItem(STORAGE_KEYS.ENGINE) || "antigravity-preview-05-2026";
  state.autoFallback = localStorage.getItem(STORAGE_KEYS.AUTO_FALLBACK) !== "false";
  state.pollRateMs = parseInt(localStorage.getItem(STORAGE_KEYS.POLL_RATE) || "4000", 10);
  state.activeSessionId = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION) || null;

  // Sync apiKey to server WhatsApp gateway if stored locally
  if (state.apiKey) {
    fetchWithWhatsAppAuth("/api/whatsapp/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geminiApiKey: state.apiKey })
    }).catch(() => {});
  }

  fetch("/api/health")
    .then(r => r.json())
    .then(data => {
      if (data.hasApiKey || data.hasEnvKey) {
        state.hasEnvKey = true;
      }
      if (el.keyStatusIndicator) {
        if (state.apiKey) {
          el.keyStatusIndicator.textContent = 'Custom API Key configured in browser';
          el.keyStatusIndicator.style.color = 'var(--emerald)';
        } else if (state.hasEnvKey) {
          el.keyStatusIndicator.textContent = 'Environment GEMINI_API_KEY detected';
          el.keyStatusIndicator.style.color = 'var(--emerald)';
        } else {
          el.keyStatusIndicator.textContent = 'No API Key detected. Please enter your Google AI Studio API key.';
          el.keyStatusIndicator.style.color = 'var(--rose)';
        }
      }
    })
    .catch(() => {});
}

function saveSettings() {
  if (el.settingApiKey) {
    state.apiKey = el.settingApiKey.value.trim();
    localStorage.setItem(STORAGE_KEYS.API_KEY, state.apiKey);
    if (state.apiKey) {
      fetchWithWhatsAppAuth("/api/whatsapp/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey: state.apiKey })
      }).catch(() => {});
    }
  }
  if (el.settingEngine) {
    state.selectedEngine = el.settingEngine.value;
    localStorage.setItem(STORAGE_KEYS.ENGINE, state.selectedEngine);
  }
  if (el.settingPollRate) {
    state.pollRateMs = parseInt(el.settingPollRate.value, 10) || 4000;
    localStorage.setItem(STORAGE_KEYS.POLL_RATE, String(state.pollRateMs));
  }
  updateEnginePillDisplay();
  closeSettings();
  showToast('Settings saved.', 'info');
}

function renderWhatsAppAgentsList(agents) {
  const container = document.getElementById('whatsapp-agents-list-container');
  const itemsBox = document.getElementById('whatsapp-agents-list-items');
  const statusBadge = document.getElementById('whatsapp-pairing-status-badge');
  const pairStatusLabel = document.getElementById('whatsapp-pair-key-status');

  if (!container || !itemsBox) return;

  if (!agents || agents.length === 0) {
    container.style.display = 'none';
    if (statusBadge) {
      statusBadge.textContent = 'No Key Paired';
      statusBadge.style.background = 'rgba(239,68,68,0.12)';
      statusBadge.style.color = 'var(--rose)';
    }
    if (pairStatusLabel) pairStatusLabel.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  if (statusBadge) {
    const hasOnline = agents.some(a => a.status === 'online');
    statusBadge.textContent = hasOnline ? '⚡ Agent Online' : 'Connecting Agent';
    statusBadge.style.background = hasOnline ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.15)';
    statusBadge.style.color = hasOnline ? '#22c55e' : '#eab308';
  }
  if (pairStatusLabel) pairStatusLabel.style.display = 'inline';

  itemsBox.innerHTML = agents.map(a => {
    const isOnline = a.status === 'online';
    const statusColor = isOnline ? '#22c55e' : (a.status === 'connecting' ? '#eab308' : 'var(--rose)');
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-surface); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-subtle);">
        <div>
          <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${statusColor};"></span>
            <span>${escapeHtml(a.name || 'Awais Codex Agent')}</span>
            <span style="font-size: 10px; font-weight: normal; color: var(--text-muted); font-family: monospace;">(${escapeHtml(a.pairingKey.slice(0, 16))}...)</span>
          </div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
            Status: <strong style="color: ${statusColor};">${a.status.toUpperCase()}</strong> | Messages processed: ${a.messagesProcessed || 0}
          </div>
        </div>
        <button type="button" class="btn-remove-pairing-key" data-key="${escapeHtml(a.pairingKey)}" class="btn-modal-secondary" style="font-size: 10px; padding: 3px 8px; color: var(--rose); border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; background: transparent; cursor: pointer;">
          Disconnect
        </button>
      </div>
    `;
  }).join('');

  // Attach disconnect handlers
  itemsBox.querySelectorAll('.btn-remove-pairing-key').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.currentTarget.getAttribute('data-key');
      if (!key) return;
      try {
        await fetchWithWhatsAppAuth(`/api/whatsapp/pair/${encodeURIComponent(key)}`, { method: 'DELETE' });
        showToast('Pairing key disconnected', 'info');
        loadWhatsAppAgents();
      } catch (err) {
        showToast('Error disconnecting key', 'rose');
      }
    });
  });
}

function loadWhatsAppAgents() {
  fetchWithWhatsAppAuth('/api/whatsapp/agents')
    .then(r => r.json())
    .then(data => {
      if (data.agents) {
        renderWhatsAppAgentsList(data.agents);
        if (data.agents.length > 0) {
          const keyInput = document.getElementById('whatsapp-pairing-key-input');
          const nameInput = document.getElementById('whatsapp-agent-name-input');
          if (keyInput && !keyInput.value) keyInput.value = data.agents[0].pairingKey;
          if (nameInput && !nameInput.value) nameInput.value = data.agents[0].name || 'Awais Codex Agent';
        }
      }
    })
    .catch(() => {});
}

function openSettings() {
  if (!el.settingsModal) return;
  if (el.settingApiKey) el.settingApiKey.value = state.apiKey;
  if (el.settingEngine) el.settingEngine.value = state.selectedEngine;
  if (el.settingPollRate) el.settingPollRate.value = String(state.pollRateMs);

  const agentApiUrlInput = document.getElementById('whatsapp-agent-api-url');
  if (agentApiUrlInput) {
    agentApiUrlInput.value = `${window.location.origin}/api/whatsapp/agent`;
  }

  const openaiApiUrlInput = document.getElementById('whatsapp-openai-api-url');
  if (openaiApiUrlInput) {
    openaiApiUrlInput.value = `${window.location.origin}/v1/chat/completions`;
  }

  const webhookInput = document.getElementById('whatsapp-webhook-url-input');
  if (webhookInput) {
    webhookInput.value = `${window.location.origin}/api/whatsapp`;
  }

  const verifyTokenInput = document.getElementById('whatsapp-verify-token-input');
  if (verifyTokenInput) {
    verifyTokenInput.value = 'Awais Codex';
  }

  // Load WhatsApp active agent instances
  loadWhatsAppAgents();

  const whatsappKeyInput = document.getElementById('whatsapp-api-key-input');
  const whatsappKeyStatus = document.getElementById('whatsapp-key-status');
  const whatsappPhoneInput = document.getElementById('whatsapp-phone-id-input');
  const whatsappPhoneStatus = document.getElementById('whatsapp-phone-status');

  const savedWaKey = localStorage.getItem('awais_whatsapp_api_key') || '';
  if (whatsappKeyInput && savedWaKey) {
    whatsappKeyInput.value = savedWaKey;
    if (whatsappKeyStatus) whatsappKeyStatus.style.display = 'inline';
  }

  const savedPhoneId = localStorage.getItem('awais_whatsapp_phone_id') || '';
  if (whatsappPhoneInput && savedPhoneId) {
    whatsappPhoneInput.value = savedPhoneId;
    if (whatsappPhoneStatus) whatsappPhoneStatus.style.display = 'inline';
  }

  // Fetch live server config for WhatsApp
  fetchWithWhatsAppAuth('/api/whatsapp/config')
    .then(r => r.json())
    .then(data => {
      if (data.hasApiKey && whatsappKeyStatus) {
        whatsappKeyStatus.style.display = 'inline';
      }
      if (data.phoneNumberId && whatsappPhoneInput) {
        if (!whatsappPhoneInput.value) whatsappPhoneInput.value = data.phoneNumberId;
        if (whatsappPhoneStatus) whatsappPhoneStatus.style.display = 'inline';
      }
    })
    .catch(() => {});

  // Fetch GitHub connection status
  const githubTokenInput = document.getElementById('github-token-input');
  const githubStatusBadge = document.getElementById('github-status-badge');
  const githubConnectionInfo = document.getElementById('github-connection-info');
  if (githubTokenInput) {
    githubTokenInput.value = getGitHubToken();
  }
  checkGitHubStatus().then(gh => {
    if (githubStatusBadge) {
      if (gh.connected || gh.hasToken) {
        githubStatusBadge.textContent = gh.username ? `@${gh.username}` : 'Connected';
        githubStatusBadge.style.background = 'rgba(34,197,94,0.15)';
        githubStatusBadge.style.color = '#22c55e';
        if (githubConnectionInfo) {
          githubConnectionInfo.style.display = 'block';
          githubConnectionInfo.textContent = `✓ Connected${gh.username ? ' as ' + gh.username : ''}`;
        }
      } else {
        githubStatusBadge.textContent = 'Disconnected';
        githubStatusBadge.style.background = '';
        githubStatusBadge.style.color = '';
        if (githubConnectionInfo) githubConnectionInfo.style.display = 'none';
      }
    }
  }).catch(() => {});

  el.settingsModal.style.display = 'flex';
}

function closeSettings() {
  if (!el.settingsModal) return;
  el.settingsModal.style.display = 'none';
}

function initTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
  if (el.themeLabel) {
    el.themeLabel.textContent = theme === 'dark' ? 'Dark Theme' : 'Light Theme';
  }
}

function updateEnginePillDisplay() {
  if (el.enginePillLabel) {
    el.enginePillLabel.textContent = 'Antigravity (antigravity-preview-05-2026)';
  }
  if (el.engineBadgeLabel) {
    el.engineBadgeLabel.textContent = 'Antigravity (antigravity-preview-05-2026)';
  }
}

function setupEventListeners() {
  // Sidebar navigation
  if (el.toggleSidebarNavBtn) {
    el.toggleSidebarNavBtn.addEventListener('click', toggleSidebarCollapse);
  }
  if (el.sidebarBackdrop) {
    el.sidebarBackdrop.addEventListener('click', toggleSidebarCollapse);
  }
  if (el.sidebarCollapseBtn) {
    el.sidebarCollapseBtn.addEventListener('click', toggleSidebarCollapse);
  }

  if (el.newChatBtn) {
    el.newChatBtn.addEventListener('click', createNewChat);
  }
  if (el.headerNewChatBtn) {
    el.headerNewChatBtn.addEventListener('click', createNewChat);
  }

  if (el.searchHistoryInput) {
    el.searchHistoryInput.addEventListener('input', (e) => {
      renderHistoryList(e.target.value);
    });
  }

  // Navigation tabs in sidebar
  if (el.sidebarNavChat) {
    el.sidebarNavChat.addEventListener('click', () => {
      closeArtifactsDock();
    });
  }
  if (el.sidebarNavArtifacts) {
    el.sidebarNavArtifacts.addEventListener('click', () => {
      toggleArtifactsDock();
    });
  }
  if (el.sidebarNavInstall) {
    el.sidebarNavInstall.addEventListener('click', () => {
      openInstallModal();
    });
  }
  if (el.sidebarNavSplit) {
    el.sidebarNavSplit.addEventListener('click', () => {
      toggleSplitMode();
    });
  }
  if (el.sidebarNavDownload) {
    el.sidebarNavDownload.addEventListener('click', () => {
      openDownloadModal();
    });
  }
  if (el.sidebarNavMemory) {
    el.sidebarNavMemory.addEventListener('click', () => {
      openMemoryModal();
    });
  }
  const headerMemoryBtn = document.getElementById('header-memory-btn');
  if (headerMemoryBtn) {
    headerMemoryBtn.addEventListener('click', () => {
      openMemoryModal();
    });
  }
  if (el.sidebarNavSettings) {
    el.sidebarNavSettings.addEventListener('click', () => {
      openSettings();
    });
  }

  // Theme toggle
  if (el.themeToggleBtn) {
    el.themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  if (el.openSettingsBtn) {
    el.openSettingsBtn.addEventListener('click', openSettings);
  }

  // Settings modal
  if (el.closeSettingsBtn) el.closeSettingsBtn.addEventListener('click', closeSettings);
  if (el.cancelSettingsBtn) el.cancelSettingsBtn.addEventListener('click', closeSettings);
  if (el.saveSettingsBtn) el.saveSettingsBtn.addEventListener('click', saveSettings);
  if (el.toggleKeyViewBtn) {
    el.toggleKeyViewBtn.addEventListener('click', () => {
      if (el.settingApiKey) {
        el.settingApiKey.type = el.settingApiKey.type === 'password' ? 'text' : 'password';
      }
    });
  }

  if (el.wipeAllHistoryBtn) {
    el.wipeAllHistoryBtn.addEventListener('click', () => {
      showConfirmModal('Delete all task history? This action cannot be undone.', () => {
        state.projects = [];
        state.activeSessionId = null;
        state.taskQueue = [];
        saveProjects();
        if (el.messagesList) el.messagesList.innerHTML = '';
        showWelcomeHero(true);
        renderHistoryList();
        updateQueueBadge();
        updateArtifactsDockForProject(null);
        closeSettings();
        showToast('All conversation history wiped.', 'info');
      }, 'Wipe All History', 'Wipe All');
    });
  }

  // Download Artifacts Modal
  if (el.closeDownloadModalBtn) el.closeDownloadModalBtn.addEventListener('click', closeDownloadModal);
  if (el.dismissDownloadModalBtn) el.dismissDownloadModalBtn.addEventListener('click', closeDownloadModal);
  if (el.customDownloadBtn) el.customDownloadBtn.addEventListener('click', downloadCustomArtifact);
  if (el.downloadEnvTarBtn) el.downloadEnvTarBtn.addEventListener('click', downloadWorkspaceArchive);

  // Install PWA Modal
  if (el.closeInstallModalBtn) el.closeInstallModalBtn.addEventListener('click', closeInstallModal);
  if (el.dismissInstallModalBtn) el.dismissInstallModalBtn.addEventListener('click', closeInstallModal);
  if (el.openInstallFromSettingsBtn) el.openInstallFromSettingsBtn.addEventListener('click', () => {
    closeSettings();
    openInstallModal();
  });

  if (el.copyPwaUrlBtn && el.pwaShareUrlInput) {
    el.copyPwaUrlBtn.addEventListener('click', () => {
      copyTextToClipboard(el.pwaShareUrlInput.value, 'App URL copied!');
    });
  }

  // WhatsApp 2026 Pairing Key listeners
  const saveWhatsappPairingBtn = document.getElementById('save-whatsapp-pairing-btn');
  const whatsappPairingKeyInput = document.getElementById('whatsapp-pairing-key-input');
  const whatsappAgentNameInput = document.getElementById('whatsapp-agent-name-input');
  const refreshWhatsappAgentsBtn = document.getElementById('refresh-whatsapp-agents-btn');

  if (saveWhatsappPairingBtn && whatsappPairingKeyInput) {
    saveWhatsappPairingBtn.addEventListener('click', async () => {
      const pairingKey = whatsappPairingKeyInput.value.trim();
      const name = whatsappAgentNameInput ? whatsappAgentNameInput.value.trim() : 'Awais Codex Agent';
      if (!pairingKey) {
        showToast('Please enter a WhatsApp pairing key (wa_agent_...)', 'rose');
        return;
      }

      saveWhatsappPairingBtn.disabled = true;
      saveWhatsappPairingBtn.textContent = 'Connecting...';

      try {
        const res = await fetchWithWhatsAppAuth('/api/whatsapp/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairingKey, name })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('⚡ WhatsApp Agent pairing key saved! Connecting worker...', 'info');
          if (data.allAgents) renderWhatsAppAgentsList(data.allAgents);
          else loadWhatsAppAgents();
          checkAndManageWhatsAppPolling();
        } else {
          showToast(`Error pairing key: ${data.error || 'Failed'}`, 'rose');
        }
      } catch (err) {
        showToast(`Pairing failed: ${err.message}`, 'rose');
      } finally {
        saveWhatsappPairingBtn.disabled = false;
        saveWhatsappPairingBtn.textContent = '⚡ Pair & Connect';
      }
    });
  }

  if (refreshWhatsappAgentsBtn) {
    refreshWhatsappAgentsBtn.addEventListener('click', () => {
      showToast('Checking WhatsApp Agent connections...', 'info');
      loadWhatsAppAgents();
    });
  }

  // WhatsApp & Agent copy button listeners
  const copyWhatsappAgentUrlBtn = document.getElementById('copy-whatsapp-agent-url-btn');
  const whatsappAgentApiUrlInput = document.getElementById('whatsapp-agent-api-url');
  if (copyWhatsappAgentUrlBtn && whatsappAgentApiUrlInput) {
    copyWhatsappAgentUrlBtn.addEventListener('click', () => {
      copyTextToClipboard(whatsappAgentApiUrlInput.value, 'Agent API URL copied!');
    });
  }

  const copyWhatsappOpenaiUrlBtn = document.getElementById('copy-whatsapp-openai-url-btn');
  const whatsappOpenaiApiUrlInput = document.getElementById('whatsapp-openai-api-url');
  if (copyWhatsappOpenaiUrlBtn && whatsappOpenaiApiUrlInput) {
    copyWhatsappOpenaiUrlBtn.addEventListener('click', () => {
      copyTextToClipboard(whatsappOpenaiApiUrlInput.value, 'OpenAI endpoint URL copied!');
    });
  }

  const copyWhatsappWebhookBtn = document.getElementById('copy-whatsapp-webhook-btn');
  const whatsappWebhookInput = document.getElementById('whatsapp-webhook-url-input');
  if (copyWhatsappWebhookBtn && whatsappWebhookInput) {
    copyWhatsappWebhookBtn.addEventListener('click', () => {
      copyTextToClipboard(whatsappWebhookInput.value, 'WhatsApp Webhook URL copied!');
    });
  }

  const copyWhatsappTokenBtn = document.getElementById('copy-whatsapp-token-btn');
  const whatsappVerifyTokenInput = document.getElementById('whatsapp-verify-token-input');
  if (copyWhatsappTokenBtn && whatsappVerifyTokenInput) {
    copyWhatsappTokenBtn.addEventListener('click', () => {
      copyTextToClipboard(whatsappVerifyTokenInput.value, 'WhatsApp Verify Token copied!');
    });
  }

  const saveWhatsappKeyBtn = document.getElementById('save-whatsapp-key-btn');
  const whatsappKeyInput = document.getElementById('whatsapp-api-key-input');
  const whatsappKeyStatus = document.getElementById('whatsapp-key-status');
  if (saveWhatsappKeyBtn && whatsappKeyInput) {
    saveWhatsappKeyBtn.addEventListener('click', async () => {
      const val = whatsappKeyInput.value.trim();
      localStorage.setItem('awais_whatsapp_api_key', val);
      try {
        await fetchWithWhatsAppAuth('/api/whatsapp/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: val })
        });
        if (whatsappKeyStatus) whatsappKeyStatus.style.display = 'inline';
        showToast('WhatsApp API Key saved!', 'info');
      } catch (_) {
        showToast('Key saved to local storage.', 'info');
      }
    });
  }

  // Save WhatsApp Phone Number ID
  const saveWhatsappPhoneBtn = document.getElementById('save-whatsapp-phone-btn');
  const whatsappPhoneInput = document.getElementById('whatsapp-phone-id-input');
  const whatsappPhoneStatus = document.getElementById('whatsapp-phone-status');
  if (saveWhatsappPhoneBtn && whatsappPhoneInput) {
    saveWhatsappPhoneBtn.addEventListener('click', async () => {
      const val = whatsappPhoneInput.value.trim();
      localStorage.setItem('awais_whatsapp_phone_id', val);
      try {
        await fetchWithWhatsAppAuth('/api/whatsapp/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumberId: val })
        });
        if (whatsappPhoneStatus) whatsappPhoneStatus.style.display = 'inline';
        showToast('Phone Number ID saved!', 'info');
      } catch (_) {
        showToast('Phone ID saved locally.', 'info');
      }
    });
  }

  // Third-Party Agent API Direct Test
  const testInboundBtn = document.getElementById('test-inbound-whatsapp-btn');
  const testResultBox = document.getElementById('whatsapp-test-result-box');
  const testPromptInput = document.getElementById('whatsapp-test-prompt-input');

  if (testInboundBtn && testResultBox) {
    testInboundBtn.addEventListener('click', async () => {
      const promptText = (testPromptInput ? testPromptInput.value.trim() : '') || 'hi';
      testResultBox.style.display = 'block';
      testResultBox.style.color = 'var(--text-muted)';
      testResultBox.innerHTML = `<em>Calling Agent API with prompt: "${escapeHtml(promptText)}" (No webhook needed)...</em>`;

      const startTime = Date.now();
      try {
        const res = await fetchWithWhatsAppAuth('/api/whatsapp/test-inbound', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: promptText,
            sender: 'tester_agent_direct'
          })
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const data = await res.json();
        if (res.ok && (data.success || data.response || data.choices)) {
          const replyText = data.response || data.reply || data.choices?.[0]?.message?.content || data.output || 'OK';
          testResultBox.style.color = '#22c55e';
          testResultBox.innerHTML = `<strong>✓ Agent Responded [${elapsed}s] HTTP ${res.status}:</strong><br/><pre style="white-space:pre-wrap; margin-top:4px; font-family:monospace; font-size:11px; max-height:120px; overflow-y:auto; color:var(--text-main);">${escapeHtml(replyText)}</pre><div style="font-size:10px; color:var(--text-muted); margin-top:4px;">Direct JSON delivered to third-party agent &amp; recorded into workspace history.</div>`;
          showToast(`Agent reply received in ${elapsed}s!`, 'info');

          // Refresh conversations in sidebar
          fetchWithWhatsAppAuth('/api/whatsapp/conversations')
            .then(r => r.json())
            .then(cData => {
              if (cData.conversations) {
                cData.conversations.forEach(wc => {
                  const existingIdx = state.projects.findIndex(p => p.id === wc.id);
                  if (existingIdx >= 0) {
                    state.projects[existingIdx] = wc;
                  } else {
                    state.projects.unshift(wc);
                  }
                });
                saveProjects();
                renderHistoryList();
              }
            })
            .catch(() => {});
        } else {
          testResultBox.style.color = 'var(--rose)';
          testResultBox.textContent = `❌ Agent Call Failed (HTTP ${res.status}): ${data.error || JSON.stringify(data)}`;
        }
      } catch (err) {
        testResultBox.style.color = 'var(--rose)';
        testResultBox.textContent = `❌ Network Error: ${err.message}`;
      }
    });
  }

  // WhatsApp Outbound Test Ping
  const testOutboundBtn = document.getElementById('test-outbound-whatsapp-btn');
  if (testOutboundBtn && testResultBox) {
    testOutboundBtn.addEventListener('click', async () => {
      const recipient = prompt('Enter recipient phone number with country code (e.g. +923001234567):');
      if (!recipient || !recipient.trim()) return;

      testResultBox.style.display = 'block';
      testResultBox.style.color = 'var(--text-muted)';
      testResultBox.textContent = `Sending test message to ${recipient.trim()} via Meta Cloud API...`;

      try {
        const res = await fetchWithWhatsAppAuth('/api/whatsapp/test-send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: recipient.trim(),
            message: '👋 *Awais Codex Integration Test*\nYour WhatsApp connection to Awais Codex is active!'
          })
        });
        const data = await res.json();
        if (data.success) {
          testResultBox.style.color = '#22c55e';
          testResultBox.innerHTML = `<strong>✓ Sent to ${escapeHtml(recipient)}!</strong> Meta delivered the message successfully.`;
          showToast('Test WhatsApp message delivered!', 'info');
        } else {
          testResultBox.style.color = 'var(--rose)';
          testResultBox.innerHTML = `<strong>❌ Meta Send Failed:</strong> ${escapeHtml(data.error || 'Unknown error')}<br/><small style="color:var(--text-muted)">Verify your Access Token and Phone Number ID.</small>`;
        }
      } catch (err) {
        testResultBox.style.color = 'var(--rose)';
        testResultBox.textContent = `❌ Request Exception: ${err.message}`;
      }
    });
  }

  // WhatsApp Live Logs Viewer
  const toggleLogsBtn = document.getElementById('toggle-whatsapp-logs-btn');
  const logsContainer = document.getElementById('whatsapp-logs-container');
  if (toggleLogsBtn && logsContainer) {
    toggleLogsBtn.addEventListener('click', async () => {
      if (logsContainer.style.display === 'block') {
        logsContainer.style.display = 'none';
        toggleLogsBtn.textContent = 'View Logs';
        return;
      }

      logsContainer.style.display = 'block';
      toggleLogsBtn.textContent = 'Hide Logs';
      logsContainer.innerHTML = '<div style="color:var(--text-muted)">Loading recent webhook events...</div>';

      try {
        const res = await fetchWithWhatsAppAuth('/api/whatsapp/logs');
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          logsContainer.innerHTML = data.logs.map(l => {
            const time = new Date(l.timestamp).toLocaleTimeString();
            const color = l.status === 'success' ? '#22c55e' : (l.status === 'failed' ? 'var(--rose)' : 'var(--amber)');
            return `<div style="padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="color:var(--text-muted)">[${time}]</span>
              <span style="color:${color}; font-weight:600;">[${l.type}]</span>
              <span>${escapeHtml(l.summary)}</span>
            </div>`;
          }).join('');
        } else {
          logsContainer.innerHTML = '<div style="color:var(--text-muted)">No webhook events recorded yet. Send a message to see logs here.</div>';
        }
      } catch (err) {
        logsContainer.innerHTML = `<div style="color:var(--rose)">Failed to fetch logs: ${escapeHtml(err.message)}</div>`;
      }
    });
  }

  // GitHub Token Connect
  const saveGithubTokenBtn = document.getElementById('save-github-token-btn');
  const githubTokenInput = document.getElementById('github-token-input');
  const githubStatusBadge = document.getElementById('github-status-badge');
  const githubConnectionInfo = document.getElementById('github-connection-info');
  if (saveGithubTokenBtn && githubTokenInput) {
    saveGithubTokenBtn.addEventListener('click', async () => {
      const token = githubTokenInput.value.trim();
      if (!token) {
        setGitHubToken('');
        if (githubStatusBadge) {
          githubStatusBadge.textContent = 'Disconnected';
          githubStatusBadge.style.background = '';
          githubStatusBadge.style.color = '';
        }
        if (githubConnectionInfo) githubConnectionInfo.style.display = 'none';
        showToast('GitHub token removed.', 'info');
        return;
      }

      saveGithubTokenBtn.textContent = 'Testing...';
      try {
        const repos = await testGitHubConnection(token);
        if (githubStatusBadge) {
          githubStatusBadge.textContent = 'Connected';
          githubStatusBadge.style.background = 'rgba(34,197,94,0.15)';
          githubStatusBadge.style.color = '#22c55e';
        }
        if (githubConnectionInfo) {
          githubConnectionInfo.style.display = 'block';
          githubConnectionInfo.textContent = `✓ Connected! Found ${repos.length} repositories.`;
        }
        showToast(`GitHub connected! Access to ${repos.length} repos.`, 'info');
      } catch (err) {
        showToast(`GitHub connection failed: ${err.message}`, 'error');
        if (githubConnectionInfo) {
          githubConnectionInfo.style.display = 'block';
          githubConnectionInfo.style.color = 'var(--rose)';
          githubConnectionInfo.textContent = `Connection failed: ${err.message}`;
        }
      } finally {
        saveGithubTokenBtn.textContent = 'Connect';
      }
    });
  }

  // Lightbox
  if (el.closeLightboxBtn) el.closeLightboxBtn.addEventListener('click', closeLightbox);
  if (el.imageLightboxModal) {
    el.imageLightboxModal.addEventListener('click', (e) => {
      if (e.target === el.imageLightboxModal) closeLightbox();
    });
  }

  // Artifacts Dock tabs
  if (el.artifactTabCode) el.artifactTabCode.addEventListener('click', () => switchArtifactTab('code'));
  if (el.artifactTabPreview) el.artifactTabPreview.addEventListener('click', () => switchArtifactTab('preview'));
  if (el.artifactTabLogs) el.artifactTabLogs.addEventListener('click', () => switchArtifactTab('logs'));
  if (el.artifactCloseBtn) el.artifactCloseBtn.addEventListener('click', closeArtifactsDock);

  if (el.artifactCopyBtn) {
    el.artifactCopyBtn.addEventListener('click', () => {
      const project = state.projects.find(p => p.id === state.activeSessionId) || state.activeTask;
      if (!project) return;
      const artifacts = project._artifacts || [];
      const art = artifacts.find(a => a.id === state.activeArtifactId) || artifacts[0];
      if (art && art.code) {
        copyTextToClipboard(art.code, 'Artifact code copied!');
      }
    });
  }

  if (el.artifactDownloadBtn) {
    el.artifactDownloadBtn.addEventListener('click', () => {
      const project = state.projects.find(p => p.id === state.activeSessionId) || state.activeTask;
      if (!project) return;
      const artifacts = project._artifacts || [];
      const art = artifacts.find(a => a.id === state.activeArtifactId) || artifacts[0];
      if (art) {
        if (art.apkPath) {
          window.location.href = `/api/download-artifact?filePath=${encodeURIComponent(art.apkPath)}&filename=${encodeURIComponent(art.name)}`;
        } else {
          const blob = new Blob([art.code], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = art.name;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    });
  }

  // Chat input and send
  if (el.sendMsgBtn) {
    el.sendMsgBtn.addEventListener('click', handlePromptSubmission);
  }

  if (el.chatInput) {
    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handlePromptSubmission();
      }
    });
    el.chatInput.addEventListener('input', autoResizeTextarea);
  }

  // File uploads
  if (el.attachFileBtn && el.fileUploadInput) {
    el.attachFileBtn.addEventListener('click', () => el.fileUploadInput.click());
    el.fileUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(Array.from(e.target.files));
        el.fileUploadInput.value = '';
      }
    });
  }

  // Drag and drop
  const dropZone = el.mainWorkspace || document.body;
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (el.dropOverlay) el.dropOverlay.style.display = 'flex';
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null && el.dropOverlay) {
      el.dropOverlay.style.display = 'none';
    }
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (el.dropOverlay) el.dropOverlay.style.display = 'none';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  });

  // Active Session Rename / Delete Header
  if (el.renameSessionBtn) {
    el.renameSessionBtn.addEventListener('click', startRenamingActiveSession);
  }
  if (el.deleteSessionBtn) {
    el.deleteSessionBtn.addEventListener('click', () => {
      if (!state.activeSessionId) return;
      showConfirmModal('Delete current task history?', () => {
        deleteProject(state.activeSessionId);
        showToast('Task deleted.', 'info');
      }, 'Delete Task', 'Delete');
    });
  }

  // Confirmation modal listeners
  if (el.closeConfirmBtn) el.closeConfirmBtn.addEventListener('click', closeConfirmModal);
  if (el.cancelConfirmBtn) el.cancelConfirmBtn.addEventListener('click', closeConfirmModal);
}

function createNewChat() {
  state.activeSessionId = null;
  state.attachedFiles = [];
  renderAttachmentPreviews();
  showWelcomeHero(true);
  if (el.messagesList) el.messagesList.innerHTML = '';
  if (el.activeSessionTitle) el.activeSessionTitle.textContent = 'Awais Codex';
  if (el.chatInput) el.chatInput.value = '';
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
  updateArtifactsDockForProject(null);
  if (window.innerWidth <= 768 && el.sidebar) {
    el.sidebar.classList.add('collapsed');
  }
}

function autoResizeTextarea() {
  if (!el.chatInput) return;
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 180) + 'px';
}

function handleFilesSelected(files) {
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.attachedFiles.push({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: e.target.result
      });
      renderAttachmentPreviews();
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentPreviews() {
  if (!el.attachmentPreviews) return;
  el.attachmentPreviews.innerHTML = '';

  if (state.attachedFiles.length === 0) {
    el.attachmentPreviews.style.display = 'none';
    updateAttachBtnState();
    return;
  }

  el.attachmentPreviews.style.display = 'flex';
  state.attachedFiles.forEach((f, idx) => {
    const pill = document.createElement('div');
    pill.className = 'attachment-pill';
    pill.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
      </svg>
      <span class="attachment-name">${escapeHtml(f.name)}</span>
      <span class="attachment-size">(${formatFileSize(f.size)})</span>
      <button type="button" class="attachment-remove-btn" title="Remove attachment">&times;</button>
    `;
    pill.querySelector('.attachment-remove-btn').addEventListener('click', () => {
      state.attachedFiles.splice(idx, 1);
      renderAttachmentPreviews();
    });
    el.attachmentPreviews.appendChild(pill);
  });

  updateAttachBtnState();
}

function updateAttachBtnState() {
  if (!el.attachFileBtn) return;
  if (state.attachedFiles.length > 0) {
    el.attachFileBtn.style.color = 'var(--emerald)';
  } else {
    el.attachFileBtn.style.color = 'var(--text-muted)';
  }
}

function startRenamingActiveSession() {
  if (!state.activeSessionId || !el.activeSessionTitle || !el.renameTitleInput) return;
  const project = state.projects.find(p => p.id === state.activeSessionId);
  if (!project) return;

  el.activeSessionTitle.style.display = 'none';
  el.renameTitleInput.style.display = 'block';
  el.renameTitleInput.value = project.title || project.prompt;
  el.renameTitleInput.focus();
  el.renameTitleInput.select();

  const handleKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitActiveSessionRename();
      cleanup();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelActiveSessionRename();
      cleanup();
    }
  };

  const handleBlur = () => {
    commitActiveSessionRename();
    cleanup();
  };

  const cleanup = () => {
    el.renameTitleInput.removeEventListener('keydown', handleKeydown);
    el.renameTitleInput.removeEventListener('blur', handleBlur);
  };

  el.renameTitleInput.addEventListener('keydown', handleKeydown);
  el.renameTitleInput.addEventListener('blur', handleBlur);
}

function commitActiveSessionRename() {
  if (!state.activeSessionId || !el.renameTitleInput) return;
  const project = state.projects.find(p => p.id === state.activeSessionId);
  if (!project) return;

  const newTitle = el.renameTitleInput.value.trim();
  if (newTitle) {
    project.title = newTitle;
    saveProjects();
    if (el.activeSessionTitle) el.activeSessionTitle.textContent = newTitle;
    renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
  }
  cancelActiveSessionRename();
}

function cancelActiveSessionRename() {
  if (el.activeSessionTitle) el.activeSessionTitle.style.display = 'inline-block';
  if (el.renameTitleInput) el.renameTitleInput.style.display = 'none';
}

function openInstallModal() {
  if (!el.installPwaModal) return;
  if (el.pwaShareUrlInput) el.pwaShareUrlInput.value = window.location.href;
  el.installPwaModal.style.display = 'flex';
}

function closeInstallModal() {
  if (!el.installPwaModal) return;
  el.installPwaModal.style.display = 'none';
}

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update();
    }).catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    if (el.directInstallContainer) el.directInstallContainer.style.display = 'block';
  });

  if (el.directInstallBtn) {
    el.directInstallBtn.addEventListener('click', async () => {
      if (!deferredPwaPrompt) return;
      deferredPwaPrompt.prompt();
      const { outcome } = await deferredPwaPrompt.userChoice;
      if (outcome === 'accepted') {
        showToast('App installed successfully!', 'info');
      }
      deferredPwaPrompt = null;
      if (el.directInstallContainer) el.directInstallContainer.style.display = 'none';
    });
  }
}

function showConfirmModal(title, onAccept, headingText = 'Confirm Action', acceptText = 'Confirm') {
  if (!el.confirmModal) return;
  if (el.confirmModalTitle) el.confirmModalTitle.textContent = headingText;
  if (el.confirmModalMessage) el.confirmModalMessage.textContent = title;
  if (el.acceptConfirmBtn) el.acceptConfirmBtn.textContent = acceptText;

  el.confirmModal.style.display = 'flex';

  const handleAccept = () => {
    cleanup();
    closeConfirmModal();
    if (onAccept) onAccept();
  };

  const cleanup = () => {
    if (el.acceptConfirmBtn) el.acceptConfirmBtn.removeEventListener('click', handleAccept);
  };

  if (el.acceptConfirmBtn) {
    el.acceptConfirmBtn.addEventListener('click', handleAccept);
  }
}

function closeConfirmModal() {
  if (el.confirmModal) el.confirmModal.style.display = 'none';
}

function showToast(message, type = 'info') {
  if (!el.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast-item ${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
  `;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => { toast.remove(); }, 300);
  }, 3000);
}

async function copyTextToClipboard(text, successMsg = 'Copied to clipboard!') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast(successMsg, 'info');
  } catch (err) {
    showToast('Failed to copy to clipboard', 'error');
  }
}

function initOfflineIndicator() {
  let banner = document.getElementById('offline-indicator-banner');

  function updateStatus() {
    if (!navigator.onLine) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'offline-indicator-banner';
        banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: #dc2626; color: #ffffff; padding: 8px 16px; font-size: 13px; font-weight: 500; text-align: center; z-index: 99999; box-shadow: 0 2px 8px rgba(0,0,0,0.3);';
        banner.textContent = "You're offline — queued tasks won't start until you're back online with this tab open.";
        document.body.appendChild(banner);
      } else {
        banner.style.display = 'block';
      }
    } else if (banner) {
      banner.style.display = 'none';
    }
  }

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

// Global DOM ready bootstrap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
