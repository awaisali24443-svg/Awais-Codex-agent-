// ==========================================
// SIDEBAR & HISTORY MANAGEMENT
// ==========================================

import { state, el, escapeHtml, saveProjects } from './state.js';

let renderConversationCallback = null;
let updateArtifactsDockCallback = null;
let showConfirmModalCallback = null;
let showToastCallback = null;

export function setSidebarHandlers(handlers) {
  if (handlers.renderConversation) renderConversationCallback = handlers.renderConversation;
  if (handlers.updateArtifactsDockForProject) updateArtifactsDockCallback = handlers.updateArtifactsDockForProject;
  if (handlers.showConfirmModal) showConfirmModalCallback = handlers.showConfirmModal;
  if (handlers.showToast) showToastCallback = handlers.showToast;
}

export function renderHistoryList(filterQuery = '') {
  if (!el.historyList) return;
  el.historyList.innerHTML = '';
  const q = filterQuery.toLowerCase().trim();

  const filtered = state.projects.filter(p => {
    if (!q) return true;
    return (p.title || p.prompt || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '12px 10px';
    empty.style.fontSize = '12px';
    empty.style.color = 'var(--text-subtle)';
    empty.textContent = q ? 'No matching tasks.' : 'No tasks yet.';
    el.historyList.appendChild(empty);
    return;
  }

  filtered.forEach(project => {
    const item = document.createElement('div');
    item.className = `history-item ${project.id === state.activeSessionId ? 'active' : ''}`;
    item.dataset.id = project.id;

    const dotClass = project.status || 'success';
    const isWhatsApp = project.isWhatsApp || project.source === 'whatsapp';
    const waBadge = isWhatsApp ? `<span style="font-size: 10px; background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.3); border-radius: 4px; padding: 1px 5px; margin-right: 5px; font-weight: 600; vertical-align: middle;">WA</span>` : '';

    item.innerHTML = `
      <div class="history-item-left">
        <span class="history-item-status-dot ${dotClass}"></span>
        ${waBadge}
        <span class="history-item-title" title="${escapeHtml(project.title || project.prompt || 'Conversation')}">${escapeHtml((project.title || project.prompt || 'Conversation').slice(0, 32))}</span>
        <input class="history-item-edit-input" style="display: none;" />
      </div>
      <div class="history-item-actions">
        <button class="history-item-btn rename-btn" title="Rename task">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="history-item-btn del-btn" title="Delete task">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;

    const renameBtn = item.querySelector('.rename-btn');
    const delBtn = item.querySelector('.del-btn');
    const titleSpan = item.querySelector('.history-item-title');
    const editInput = item.querySelector('.history-item-edit-input');

    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      titleSpan.style.display = 'none';
      editInput.style.display = 'block';
      editInput.value = project.title || project.prompt || 'Conversation';
      editInput.focus();
      editInput.select();
    });

    let isCommitting = false;
    const commitEdit = () => {
      if (isCommitting) return;
      isCommitting = true;
      const val = editInput.value.trim();
      if (val) {
        project.title = val;
        saveProjects();
        if (state.activeSessionId === project.id && el.activeSessionTitle) {
          el.activeSessionTitle.textContent = val;
        }
      }
      renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
    };

    editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        isCommitting = true;
        renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
      }
    });

    editInput.addEventListener('blur', () => {
      commitEdit();
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (showConfirmModalCallback) {
        showConfirmModalCallback('Delete this conversation?', () => {
          deleteProject(project.id);
          if (showToastCallback) showToastCallback('Conversation deleted.', 'info');
        }, 'Delete Conversation', 'Delete');
      } else {
        deleteProject(project.id);
      }
    });

    item.addEventListener('click', (e) => {
      if (!e.target.closest('.history-item-actions') && !e.target.closest('.history-item-edit-input')) {
        selectProject(project.id);
        if (window.innerWidth <= 768 && el.sidebar) {
          el.sidebar.classList.add('collapsed');
        }
      }
    });

    el.historyList.appendChild(item);
  });
}

export function selectProject(projectId) {
  state.activeSessionId = projectId;
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  if (el.activeSessionTitle) {
    el.activeSessionTitle.textContent = project.title || project.prompt.slice(0, 36);
  }
  showWelcomeHero(false);
  if (renderConversationCallback) renderConversationCallback(project);
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
  if (updateArtifactsDockCallback) updateArtifactsDockCallback(project);
}

export function deleteProject(projectId) {
  // If it's a WhatsApp conversation, synchronize deletion with backend server storage
  if (projectId && (projectId.startsWith('wa_') || state.projects.find(p => p.id === projectId)?.isWhatsApp)) {
    fetch(`/api/whatsapp/conversations/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
      .catch(err => console.warn('Failed to delete WhatsApp conversation on server:', err));
  }

  state.projects = state.projects.filter(p => p.id !== projectId);
  state.taskQueue = state.taskQueue.filter(id => (typeof id === 'object' ? id.projectId !== projectId : id !== projectId));
  saveProjects();

  if (state.activeSessionId === projectId) {
    if (state.projects.length > 0) {
      selectProject(state.projects[0].id);
    } else {
      state.activeSessionId = null;
      if (el.messagesList) el.messagesList.innerHTML = '';
      showWelcomeHero(true);
      if (el.activeSessionTitle) el.activeSessionTitle.textContent = 'Awais Codex';
      if (updateArtifactsDockCallback) updateArtifactsDockCallback(null);
    }
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
  updateQueueBadge();
}

export function showWelcomeHero(show) {
  if (el.welcomeHero) {
    el.welcomeHero.style.display = show ? 'flex' : 'none';
  }
}

export function updateAgentStatusHeader(isRunning) {
  if (!el.agentStatusPill || !el.agentStatusLabel) return;
  if (isRunning) {
    el.agentStatusPill.className = 'agent-status-badge running';
    el.agentStatusLabel.textContent = 'Running';
  } else {
    el.agentStatusPill.className = 'agent-status-badge';
    el.agentStatusLabel.textContent = 'Ready';
  }
}

export function updateQueueBadge() {
  const count = state.taskQueue.length;
  if (!el.queueCounter || !el.queueCounterText) return;
  if (count > 0) {
    el.queueCounter.style.display = 'inline-flex';
    el.queueCounter.classList.add('has-items');
    el.queueCounterText.textContent = `${count} queued`;
  } else {
    el.queueCounter.style.display = 'none';
    el.queueCounter.classList.remove('has-items');
    el.queueCounterText.textContent = '';
  }
}

export function toggleSidebarCollapse() {
  if (el.sidebar) {
    el.sidebar.classList.toggle('collapsed');
  }
}
