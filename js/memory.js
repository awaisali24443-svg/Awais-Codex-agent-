// ==========================================
// PERSISTENT MEMORY UI & CLIENT CONTROLLER
// ==========================================

import { escapeHtml } from './state.js';

let memoryToastCallback = null;

export function setMemoryHandlers(handlers = {}) {
  if (handlers.showToast) memoryToastCallback = handlers.showToast;
}

function notify(msg, type = 'info') {
  if (memoryToastCallback) {
    memoryToastCallback(msg, type);
  } else {
    console.log(`[Memory UI] (${type}) ${msg}`);
  }
}

let cachedMemories = [];
let cachedProfile = null;

export async function fetchMemories() {
  try {
    const res = await fetch('/api/memory');
    if (!res.ok) return { memories: [], profile: null };
    const data = await res.json();
    cachedMemories = data.memories || [];
    cachedProfile = data.profile || null;
    return data;
  } catch (err) {
    console.error('Failed to fetch memories:', err);
    return { memories: [], profile: null };
  }
}

export async function addMemory(category, content, tags = []) {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, content, tags })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    notify('Memory saved to persistent store.', 'info');
    await refreshMemoryUI();
    return data.memory;
  } catch (err) {
    notify(`Failed to save memory: ${err.message}`, 'rose');
    throw err;
  }
}

export async function deleteMemory(id) {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notify('Memory removed from persistent store.', 'info');
    await refreshMemoryUI();
  } catch (err) {
    notify(`Failed to delete memory: ${err.message}`, 'rose');
  }
}

export async function clearAllMemories() {
  try {
    const res = await fetch('/api/memory/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notify('Persistent memory reset to defaults.', 'info');
    await refreshMemoryUI();
  } catch (err) {
    notify(`Failed to clear memory: ${err.message}`, 'rose');
  }
}

export async function saveUserProfile(updates) {
  try {
    const res = await fetch('/api/memory/profile/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notify('User Profile updated in persistent memory.', 'info');
    await refreshMemoryUI();
  } catch (err) {
    notify(`Failed to update profile: ${err.message}`, 'rose');
  }
}

export async function refreshMemoryUI(filterQuery = '') {
  const container = document.getElementById('memory-items-list');
  const countBadge = document.getElementById('memory-count-badge');
  const profileNameInput = document.getElementById('memory-profile-name');
  const profileRoleInput = document.getElementById('memory-profile-role');
  const profileDirectives = document.getElementById('memory-profile-directives');

  const data = await fetchMemories();
  const memories = data.memories || [];
  const profile = data.profile || {};

  if (countBadge) {
    countBadge.textContent = `${memories.length} item${memories.length === 1 ? '' : 's'}`;
  }

  if (profileNameInput && !profileNameInput.matches(':focus')) {
    profileNameInput.value = profile.name || '';
  }
  if (profileRoleInput && !profileRoleInput.matches(':focus')) {
    profileRoleInput.value = profile.role || '';
  }
  if (profileDirectives && !profileDirectives.matches(':focus')) {
    profileDirectives.value = (profile.customDirectives || []).join('\n');
  }

  if (!container) return;

  const query = filterQuery.toLowerCase().trim();
  const filtered = query
    ? memories.filter(m => 
        (m.content && m.content.toLowerCase().includes(query)) ||
        (m.category && m.category.toLowerCase().includes(query)) ||
        (m.tags && m.tags.some(t => t.toLowerCase().includes(query)))
      )
    : memories;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-subtle); font-size: 13px;">
        ${query ? 'No memories match your search filter.' : 'No long-term memories recorded yet. The agent automatically learns preferences as you chat, or you can add one above.'}
      </div>
    `;
    return;
  }

  const categoryColors = {
    preference: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: 'rgba(59, 130, 246, 0.3)' },
    instruction: { bg: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: 'rgba(168, 85, 247, 0.3)' },
    project: { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: 'rgba(34, 197, 94, 0.3)' },
    fact: { bg: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: 'rgba(234, 179, 8, 0.3)' },
    learning: { bg: 'rgba(236, 72, 153, 0.15)', color: '#f472b6', border: 'rgba(236, 72, 153, 0.3)' }
  };

  container.innerHTML = filtered.map(m => {
    const style = categoryColors[m.category] || categoryColors.fact;
    const dateStr = new Date(m.updatedAt || m.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const tagsHtml = (m.tags || []).map(t => 
      `<span style="display:inline-block; padding: 2px 6px; font-size: 10px; border-radius: 4px; background: var(--bg-surface-hover); color: var(--text-muted); margin-right: 4px;">#${escapeHtml(t)}</span>`
    ).join('');

    return `
      <div class="memory-card-item" style="padding: 12px 14px; margin-bottom: 8px; border-radius: 8px; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: ${style.bg}; color: ${style.color}; border: 1px solid ${style.border};">
              ${escapeHtml(m.category)}
            </span>
            <span style="font-size: 11px; color: var(--text-subtle);">
              ${escapeHtml(m.source || 'auto')} • ${dateStr}
            </span>
          </div>
          <button class="delete-memory-btn" data-id="${escapeHtml(m.id)}" title="Delete memory" style="background: none; border: none; color: var(--text-subtle); cursor: pointer; padding: 2px 6px; border-radius: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div style="font-size: 13px; color: var(--text-main); line-height: 1.45;">
          ${escapeHtml(m.content)}
        </div>
        ${tagsHtml ? `<div style="margin-top: 2px;">${tagsHtml}</div>` : ''}
      </div>
    `;
  }).join('');

  // Attach delete handlers
  container.querySelectorAll('.delete-memory-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      if (id) deleteMemory(id);
    });
  });
}

export function openMemoryModal() {
  const modal = document.getElementById('memory-modal');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('open');
    refreshMemoryUI();
  }
}

export function closeMemoryModal() {
  const modal = document.getElementById('memory-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('open');
  }
}

export function initMemoryUI() {
  const openBtn = document.getElementById('sidebar-nav-memory');
  const headerOpenBtn = document.getElementById('header-memory-btn');
  const closeBtn = document.getElementById('close-memory-modal-btn');
  const dismissBtn = document.getElementById('dismiss-memory-modal-btn');
  const searchInput = document.getElementById('memory-search-input');
  const addBtn = document.getElementById('add-memory-submit-btn');
  const addCategorySelect = document.getElementById('add-memory-category');
  const addContentInput = document.getElementById('add-memory-content');
  const clearBtn = document.getElementById('clear-all-memories-btn');
  const saveProfileBtn = document.getElementById('save-memory-profile-btn');

  if (openBtn) openBtn.addEventListener('click', openMemoryModal);
  if (headerOpenBtn) headerOpenBtn.addEventListener('click', openMemoryModal);
  if (closeBtn) closeBtn.addEventListener('click', closeMemoryModal);
  if (dismissBtn) dismissBtn.addEventListener('click', closeMemoryModal);

  const modal = document.getElementById('memory-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeMemoryModal();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      refreshMemoryUI(searchInput.value);
    });
  }

  if (addBtn && addContentInput && addCategorySelect) {
    addBtn.addEventListener('click', async () => {
      const content = addContentInput.value.trim();
      const category = addCategorySelect.value || 'fact';
      if (!content) {
        notify('Please enter memory content to remember.', 'rose');
        return;
      }
      try {
        addBtn.disabled = true;
        await addMemory(category, content);
        addContentInput.value = '';
      } finally {
        addBtn.disabled = false;
      }
    });

    addContentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addBtn.click();
      }
    });
  }

  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async () => {
      const name = document.getElementById('memory-profile-name')?.value || '';
      const role = document.getElementById('memory-profile-role')?.value || '';
      const directivesRaw = document.getElementById('memory-profile-directives')?.value || '';
      const customDirectives = directivesRaw.split('\n').map(l => l.trim()).filter(Boolean);

      saveProfileBtn.textContent = 'Saving...';
      try {
        await saveUserProfile({ name, role, customDirectives });
      } finally {
        saveProfileBtn.textContent = 'Save Profile';
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (window.confirm ? window.confirm('Clear all learned persistent memories and reset to defaults?') : true) {
        clearAllMemories();
      }
    });
  }

  // Pre-fetch memories
  fetchMemories();
}
