// ==========================================
// STATE MANAGEMENT & DOM REFERENCES
// ==========================================

export const STORAGE_KEYS = {
  API_KEY: 'awais_codex_api_key',
  THEME: 'awais_codex_theme',
  POLL_RATE: 'awais_poll_rate',
  PROJECTS: 'awais_codex_projects',
  ENGINE: 'awais_codex_engine',
  AUTO_FALLBACK: 'awais_codex_auto_fallback',
  ACTIVE_SESSION: 'awais_codex_active_session'
};

export const state = {
  apiKey: '',
  hasEnvKey: false,
  selectedEngine: 'antigravity-preview-05-2026',
  autoFallback: true,
  pollRateMs: 4000,
  activeSessionId: null,
  projects: [],      // Array of tasks/conversations
  activeTask: null,  // Currently executing task
  taskQueue: [],     // Array of task IDs waiting to execute
  pollTimer: null,
  abortController: null,
  attachedFiles: [], // Files currently staged for upload
  artifactsDockOpen: false,
  activeArtifactId: null,
  activeArtifactTab: 'code', // 'code' | 'preview' | 'logs'
  splitMode: false
};

// DOM references object
export const el = {};

export function initEl() {
  el.sidebar = document.getElementById('sidebar');
  el.sidebarBackdrop = document.getElementById('sidebar-backdrop');
  el.sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
  el.toggleSidebarNavBtn = document.getElementById('toggle-sidebar-nav-btn');
  el.newChatBtn = document.getElementById('new-chat-btn');
  el.headerNewChatBtn = document.getElementById('header-new-chat-btn');
  el.searchHistoryInput = document.getElementById('search-history-input');
  el.historyList = document.getElementById('history-list');

  // Sidebar Navigation Tabs
  el.sidebarNavChat = document.getElementById('sidebar-nav-chat');
  el.sidebarNavArtifacts = document.getElementById('sidebar-nav-artifacts');
  el.sidebarNavInstall = document.getElementById('sidebar-nav-install');
  el.sidebarNavSplit = document.getElementById('sidebar-nav-split');
  el.sidebarNavDownload = document.getElementById('sidebar-nav-download');
  el.sidebarNavSettings = document.getElementById('sidebar-nav-settings');
  el.sidebarArtifactsBadge = document.getElementById('sidebar-artifacts-badge');
  el.sidebarSplitText = document.getElementById('sidebar-split-text');

  el.themeToggleBtn = document.getElementById('theme-toggle-btn');
  el.themeIcon = document.getElementById('theme-icon');
  el.themeLabel = document.getElementById('theme-label');
  el.openSettingsBtn = document.getElementById('open-settings-btn');

  el.mainWorkspace = document.getElementById('main-workspace');
  el.activeSessionTitle = document.getElementById('active-session-title');
  el.renameTitleInput = document.getElementById('rename-title-input');
  el.renameSessionBtn = document.getElementById('rename-session-btn');
  el.deleteSessionBtn = document.getElementById('delete-session-btn');
  el.agentStatusPill = document.getElementById('agent-status-pill');
  el.agentStatusLabel = document.getElementById('agent-status-label');
  el.queueCounter = document.getElementById('queue-counter');
  el.queueCounterText = document.getElementById('queue-counter-text');

  // Topbar & Artifacts Dock elements
  el.toggleSplitBtn = document.getElementById('sidebar-nav-split');
  el.splitBtnText = document.getElementById('sidebar-split-text');
  el.toggleArtifactsBtn = document.getElementById('sidebar-nav-artifacts');
  el.artifactsBadge = document.getElementById('sidebar-artifacts-badge');
  el.artifactsDock = document.getElementById('artifacts-dock');
  el.artifactsCountPill = document.getElementById('artifacts-count-pill');
  el.artifactsFileList = document.getElementById('artifacts-file-list');
  el.artifactTabCode = document.getElementById('artifact-tab-code');
  el.artifactTabPreview = document.getElementById('artifact-tab-preview');
  el.artifactTabLogs = document.getElementById('artifact-tab-logs');
  el.artifactCopyBtn = document.getElementById('artifact-copy-btn');
  el.artifactDownloadBtn = document.getElementById('artifact-download-btn');
  el.artifactCloseBtn = document.getElementById('artifact-close-btn');
  el.artifactCodeView = document.getElementById('artifact-code-view');
  el.artifactPreviewView = document.getElementById('artifact-preview-view');
  el.artifactLogsView = document.getElementById('artifact-logs-view');
  el.artifactFilenamePill = document.getElementById('artifact-filename-pill');
  el.artifactLangPill = document.getElementById('artifact-lang-pill');
  el.artifactStatsPill = document.getElementById('artifact-stats-pill');
  el.artifactLineNumbers = document.getElementById('artifact-line-numbers');
  el.artifactCodeDisplay = document.getElementById('artifact-code-display');
  el.artifactPreviewFrame = document.getElementById('artifact-preview-frame');
  el.artifactPreviewPlaceholder = document.getElementById('artifact-preview-placeholder');
  el.artifactLogsDisplay = document.getElementById('artifact-logs-display');

  // Lightbox
  el.imageLightboxModal = document.getElementById('image-lightbox-modal');
  el.lightboxImg = document.getElementById('lightbox-img');
  el.lightboxCaption = document.getElementById('lightbox-caption');
  el.closeLightboxBtn = document.getElementById('close-lightbox-btn');

  el.dropOverlay = document.getElementById('drop-overlay');
  el.chatContainer = document.getElementById('chat-container');
  el.welcomeHero = document.getElementById('welcome-hero');
  el.messagesList = document.getElementById('messages-list');
  el.chatInput = document.getElementById('chat-input');
  el.chatInputBox = document.getElementById('chat-input-box');
  el.attachmentPreviews = document.getElementById('attachment-previews');
  el.attachFileBtn = document.getElementById('attach-file-btn');
  el.fileUploadInput = document.getElementById('file-upload-input');
  el.inputEnginePill = document.getElementById('input-engine-pill');
  el.enginePillLabel = document.getElementById('engine-pill-label');
  el.enginePillDot = document.getElementById('engine-pill-dot');
  el.sendMsgBtn = document.getElementById('send-msg-btn');
  el.quickEngineSelect = null;

  // Settings Modal
  el.settingsModal = document.getElementById('settings-modal');
  el.closeSettingsBtn = document.getElementById('close-settings-btn');
  el.cancelSettingsBtn = document.getElementById('cancel-settings-btn');
  el.saveSettingsBtn = document.getElementById('save-settings-btn');
  el.settingApiKey = document.getElementById('setting-api-key');
  el.toggleKeyViewBtn = document.getElementById('toggle-key-view-btn');
  el.keyStatusIndicator = document.getElementById('key-status-indicator');
  el.settingEngine = document.getElementById('setting-engine');
  el.engineBadgeLabel = document.getElementById('engine-badge-label');
  el.settingAutoFallback = null;
  el.engineHintDesc = document.getElementById('engine-hint-desc');
  el.settingPollRate = document.getElementById('setting-poll-rate');
  el.wipeAllHistoryBtn = document.getElementById('wipe-all-history-btn');

  // Download Artifacts Modal
  el.openDownloadModalBtn = document.getElementById('sidebar-nav-download');
  el.downloadArtifactsModal = document.getElementById('download-artifacts-modal');
  el.closeDownloadModalBtn = document.getElementById('close-download-modal-btn');
  el.dismissDownloadModalBtn = document.getElementById('dismiss-download-modal-btn');
  el.modalDetectedApksSection = document.getElementById('modal-detected-apks-section');
  el.modalApkItemsList = document.getElementById('modal-apk-items-list');
  el.customDownloadPath = document.getElementById('custom-download-path');
  el.customDownloadBtn = document.getElementById('custom-download-btn');
  el.downloadEnvTarBtn = document.getElementById('download-env-tar-btn');

  // PWA & Mobile Installation
  el.installPwaTopbarBtn = document.getElementById('sidebar-nav-install');
  el.installPwaBtnText = null;
  el.openInstallFromSettingsBtn = document.getElementById('open-install-from-settings-btn');
  el.installPwaModal = document.getElementById('install-pwa-modal');
  el.closeInstallModalBtn = document.getElementById('close-install-modal-btn');
  el.dismissInstallModalBtn = document.getElementById('dismiss-install-modal-btn');
  el.iframeInstallWarning = document.getElementById('iframe-install-warning');
  el.openInBrowserBtn = document.getElementById('open-in-browser-btn');
  el.directInstallContainer = document.getElementById('direct-install-container');
  el.directInstallBtn = document.getElementById('direct-install-btn');
  el.tabPwaIos = document.getElementById('tab-pwa-ios');
  el.tabPwaAndroid = document.getElementById('tab-pwa-android');
  el.tabPwaLink = document.getElementById('tab-pwa-link');
  el.panelPwaIos = document.getElementById('panel-pwa-ios');
  el.panelPwaAndroid = document.getElementById('panel-pwa-android');
  el.panelPwaLink = document.getElementById('panel-pwa-link');
  el.pwaShareUrlInput = document.getElementById('pwa-share-url-input');
  el.copyPwaUrlBtn = document.getElementById('copy-pwa-url-btn');
  el.offlineIndicator = document.getElementById('offline-indicator');

  // Mobile Bottom Navigation (deprecated, replaced by sidebar)
  el.mobileBottomNav = null;
  el.mobileNavChat = null;
  el.mobileNavHistory = null;
  el.mobileNavArtifacts = null;
  el.mobileNavInstall = null;
  el.mobileNavSettings = null;

  // Confirmation Modal & Toast
  el.confirmModal = document.getElementById('confirm-modal');
  el.confirmModalTitle = document.getElementById('confirm-modal-title');
  el.confirmModalMessage = document.getElementById('confirm-modal-message');
  el.closeConfirmBtn = document.getElementById('close-confirm-btn');
  el.cancelConfirmBtn = document.getElementById('cancel-confirm-btn');
  el.acceptConfirmBtn = document.getElementById('accept-confirm-btn');
  el.toastContainer = document.getElementById('toast-container');
}

export function saveProjects() {
  try {
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(state.projects));
  } catch (e) {
    console.error('Projects save error:', e);
  }
}

export function normalizeProject(project) {
  if (!project) return null;
  if (!Array.isArray(project.messages)) {
    project.messages = [];
    if (project.prompt) {
      project.messages.push({
        id: `turn_${project.id}_legacy`,
        prompt: project.prompt,
        files: project.files || [],
        status: project.status || 'success',
        steps: project.steps || [],
        output: project.output || null,
        error: project.error || null,
        startedAt: project.startedAt || project.createdAt,
        completedAt: project.completedAt || null,
        durationMs: project.durationMs || null,
        interactionId: project.interactionId || null,
        environmentId: project.environmentId || null
      });
    }
  }
  if (!project.title && project.messages.length > 0) {
    const firstP = project.messages[0].prompt || 'Conversation';
    project.title = firstP.slice(0, 36) + (firstP.length > 36 ? '...' : '');
  }
  return project;
}

export function loadProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.projects = parsed.map(p => {
          normalizeProject(p);
          return p;
        });
      }
    }
  } catch (e) {
    console.error('Projects load error:', e);
    state.projects = [];
  }
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

