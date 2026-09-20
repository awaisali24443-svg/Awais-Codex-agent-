// ==========================================
// EXECUTION CARDS & CONVERSATION RENDERING
// ==========================================

import { state, el, escapeHtml, formatFileSize, normalizeProject, saveProjects } from './state.js';
import { generateThoughtStream } from './thinking-panel.js';
import { openLightbox, updateArtifactsDockForProject, openArtifactByCodeIndex } from './artifacts.js';
import { getGitHubToken, pushTaskToGitHub } from './github.js';

let cancelTaskCallback = null;
let retryTaskCallback = null;
let openSettingsCallback = null;

export function setExecutionCardHandlers(handlers) {
  if (handlers.cancelTask) cancelTaskCallback = handlers.cancelTask;
  if (handlers.retryTask) retryTaskCallback = handlers.retryTask;
  if (handlers.openSettings) openSettingsCallback = handlers.openSettings;
}

export function renderConversation(project) {
  if (!project) return;
  normalizeProject(project);
  if (!el.messagesList) return;
  el.messagesList.innerHTML = '';

  const messages = Array.isArray(project.messages) && project.messages.length > 0
    ? project.messages
    : [{
        id: `turn_${project.id}`,
        prompt: project.prompt,
        files: project.files || [],
        status: project.status || 'success',
        steps: project.steps || [],
        output: project.output || null,
        error: project.error || null,
        startedAt: project.startedAt || project.createdAt,
        durationMs: project.durationMs || null,
        currentSubAgent: project.currentSubAgent || null
      }];

  messages.forEach((turn) => {
    // 1. User Message (Text + File Attachments)
    let attachmentsHtml = '';
    if (turn.files && turn.files.length > 0) {
      attachmentsHtml = '<div class="user-attached-files-container">';
      turn.files.forEach(f => {
        if (f.type && f.type.startsWith('image/')) {
          attachmentsHtml += `
            <div class="user-attached-file-img-wrap">
              <img src="${f.dataUrl}" class="user-attached-img" alt="${escapeHtml(f.name)}" title="Click to view full image" style="cursor: pointer;" />
              <span class="user-attached-img-tag">${escapeHtml(f.name)} (${formatFileSize(f.size)})</span>
            </div>
          `;
        } else if (f.type && f.type.startsWith('video/')) {
          attachmentsHtml += `
            <div class="user-attached-file-video-wrap">
              <video src="${f.dataUrl}" controls class="user-attached-video"></video>
              <span class="user-attached-file-tag">${escapeHtml(f.name)} (${formatFileSize(f.size)})</span>
            </div>
          `;
        } else if (f.type && f.type.startsWith('audio/')) {
          attachmentsHtml += `
            <div class="user-attached-file-audio-wrap">
              <audio src="${f.dataUrl}" controls class="user-attached-audio"></audio>
              <span class="user-attached-file-tag">${escapeHtml(f.name)} (${formatFileSize(f.size)})</span>
            </div>
          `;
        } else {
          attachmentsHtml += `
            <div class="user-attached-file-doc-pill" title="${escapeHtml(f.name)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
              </svg>
              <span>${escapeHtml(f.name)}</span>
              <span class="doc-size">(${formatFileSize(f.size)})</span>
            </div>
          `;
        }
      });
      attachmentsHtml += '</div>';
    }

    const isQueuedTurn = turn.status === 'queued';
    let editBtnHtml = '';
    if (isQueuedTurn) {
      editBtnHtml = `
        <button type="button" class="btn-edit-queued-prompt" title="Edit prompt before execution" style="margin-top: 8px; padding: 6px 12px; min-height: 38px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text-main); background: var(--bg-hover); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <span>Edit</span>
        </button>
      `;
    }

    const userRow = document.createElement('div');
    userRow.className = 'message-row user';
    userRow.innerHTML = `
      <div class="user-bubble">
        ${attachmentsHtml}
        ${turn.prompt ? `<div class="user-bubble-text">${escapeHtml(turn.prompt)}</div>` : ''}
        <input class="user-bubble-edit-input" style="display: none; width: 100%; min-height: 38px; padding: 6px 10px; font-size: 14px; background: var(--bg-main); color: var(--text-main); border: 1px solid var(--accent); border-radius: 6px; margin-top: 6px;" />
        ${editBtnHtml}
      </div>
    `;

    userRow.querySelectorAll('.user-attached-img').forEach(img => {
      img.addEventListener('click', () => {
        const src = img.getAttribute('src');
        const alt = img.getAttribute('alt');
        openLightbox(src, alt);
      });
    });

    const editBtn = userRow.querySelector('.btn-edit-queued-prompt');
    const userTextEl = userRow.querySelector('.user-bubble-text');
    const editInputEl = userRow.querySelector('.user-bubble-edit-input');

    if (editBtn && userTextEl && editInputEl) {
      editBtn.addEventListener('click', () => {
        userTextEl.style.display = 'none';
        editBtn.style.display = 'none';
        editInputEl.style.display = 'block';
        editInputEl.value = turn.prompt || '';
        editInputEl.focus();
        editInputEl.select();
      });

      let isCommitting = false;
      const saveEdit = () => {
        if (isCommitting) return;
        isCommitting = true;
        const val = editInputEl.value.trim();
        if (val) {
          turn.prompt = val;
          saveProjects();
          userTextEl.textContent = val;
        }
        userTextEl.style.display = 'block';
        editBtn.style.display = 'inline-flex';
        editInputEl.style.display = 'none';
      };

      const cancelEdit = () => {
        isCommitting = true;
        userTextEl.style.display = 'block';
        editBtn.style.display = 'inline-flex';
        editInputEl.style.display = 'none';
      };

      editInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
      });

      editInputEl.addEventListener('blur', () => {
        saveEdit();
      });
    }

    el.messagesList.appendChild(userRow);

    // 2. Agent Execution Container for this turn
    const agentRow = document.createElement('div');
    agentRow.className = 'message-row agent';

    const wrapper = document.createElement('div');
    wrapper.className = 'agent-wrapper';
    wrapper.id = `agent-exec-${turn.id}`;
    wrapper.appendChild(createExecutionCard(turn, project));

    agentRow.appendChild(wrapper);
    el.messagesList.appendChild(agentRow);
  });

  scrollToBottom();
}

export function createExecutionCard(turn, project) {
  const card = document.createElement('div');
  card.className = 'agent-message-container';
  card.id = `card-${turn.id}`;

  const isRunning = turn.status === 'running';
  const isQueued = turn.status === 'queued';
  const isPaused = turn.status === 'paused';
  const isDailyLimit = turn.status === 'daily_limit_reached';
  const isSuccess = turn.status === 'success';
  const isFailed = turn.status === 'failed';

  const elapsedSec = turn.durationMs 
    ? (turn.durationMs / 1000).toFixed(1)
    : (turn.startedAt ? ((Date.now() - turn.startedAt) / 1000).toFixed(1) : '');
  const durationStr = elapsedSec ? `${elapsedSec}s` : '';

  // Minimal Thinking Pill (Manus / Claude style)
  let thinkingHtml = '';
  if (isRunning || isSuccess || isPaused || (turn.steps && turn.steps.length > 0)) {
    const timerText = isRunning ? `Thinking (${elapsedSec || '0.0'}s)...` : `Thought for ${durationStr || '0.0s'}`;
    const thoughtList = generateThoughtStream(turn);
    let thoughtsItemsHtml = '';

    thoughtList.forEach((t, i) => {
      const isLastActive = isRunning && i === thoughtList.length - 1;
      thoughtsItemsHtml += `
        <div class="thought-item ${isLastActive ? 'active' : (t.isDone ? 'completed' : '')}">
          <span class="thought-icon">${t.icon || '•'}</span>
          <div class="thought-content">
            <div class="thought-stage-label ${isLastActive ? 'active' : ''}">${escapeHtml(t.stage)}</div>
            <div class="thought-text">
              ${escapeHtml(t.text)}
              ${isLastActive ? '<span class="thought-typing-cursor"></span>' : ''}
            </div>
          </div>
        </div>
      `;
    });

    const isUserCollapsed = (window._userCollapsedTurns && window._userCollapsedTurns[turn.id] !== undefined)
      ? window._userCollapsedTurns[turn.id]
      : (!isRunning);

    thinkingHtml = `
      <div class="thinking-process-card ${isRunning ? 'is-running' : ''} ${isUserCollapsed ? 'collapsed' : ''}" id="thinking-card-${turn.id}">
        <button type="button" class="thinking-process-header" style="background: none; border: none; padding: 4px 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; font-size: 12px; color: var(--text-muted); background-color: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); margin-bottom: 8px;">
          <svg class="thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: ${isUserCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}; transition: transform 0.2s ease;">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span id="thinking-timer-${turn.id}" style="font-weight: 500;">${timerText}</span>
        </button>
        <div class="thinking-process-body" id="thinking-body-${turn.id}" style="display: ${isUserCollapsed ? 'none' : 'block'}; padding: 10px; margin-bottom: 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px;">
          ${thoughtsItemsHtml}
        </div>
      </div>
    `;
  }

  // Final Response Section (Clean flow without heavy outer box)
  let finalResponseHtml = '';
  if (turn.output) {
    const hasGeneratedCode = turn.output.includes('```');
    let extraActionsHtml = '';
    
    if (hasGeneratedCode) {
      const ghToken = getGitHubToken();
      const ghLabel = ghToken ? 'Push to GitHub' : 'Connect GitHub';
      extraActionsHtml = `
        <button type="button" class="agent-mini-btn push-github-btn" data-project-id="${escapeHtml(project.id)}" data-turn-id="${escapeHtml(turn.id)}" style="padding: 4px 10px; font-size: 11px; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
          </svg>
          <span>${ghLabel}</span>
        </button>
      `;
    }

    finalResponseHtml = `
      <div class="agent-final-response" style="font-size: 14.5px; line-height: 1.6; color: var(--text-main); font-weight: 400;">
        ${formatMarkdownOutput(turn.output, turn.id)}
      </div>
      <div class="agent-action-bar" style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
        <button type="button" class="agent-mini-btn copy-output-btn" style="padding: 4px 8px; font-size: 11px; background: none; border: none; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; opacity: 0.7; transition: opacity 0.15s ease;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
        ${extraActionsHtml}
      </div>
    `;
  } else if (isFailed || isDailyLimit) {
    finalResponseHtml = `
      <div class="agent-final-response" style="color: var(--rose); background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 12px 14px; font-size: 13.5px;">
        <div style="display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 4px;">
          <span>Notice</span>
        </div>
        <div>${escapeHtml(turn.error || 'Execution encountered an error.')}</div>
        <div style="margin-top: 10px;">
          <button type="button" class="retry-task-btn" data-project-id="${escapeHtml(project.id)}" data-turn-id="${escapeHtml(turn.id)}" style="padding: 5px 12px; font-size: 12px; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-main); cursor: pointer;">
            Retry Task
          </button>
        </div>
      </div>
    `;
  }

  const stopBtnHtml = isRunning
    ? `<button type="button" class="btn-cancel-task" data-project-id="${escapeHtml(project.id)}" data-turn-id="${escapeHtml(turn.id)}" style="padding: 4px 10px; font-size: 11px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; border-radius: 6px; cursor: pointer;">Stop Execution</button>`
    : '';

  card.innerHTML = `
    <div class="agent-message-body" style="padding: 4px 0;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
        ${thinkingHtml}
        ${stopBtnHtml}
      </div>
      ${finalResponseHtml}
    </div>
  `;

  // Wire event listeners safely
  const thinkingHeader = card.querySelector('.thinking-process-header');
  if (thinkingHeader) {
    thinkingHeader.addEventListener('click', () => {
      const processCard = thinkingHeader.closest('.thinking-process-card');
      const body = card.querySelector('.thinking-process-body');
      const chevron = thinkingHeader.querySelector('.thinking-chevron');
      if (!window._userCollapsedTurns) window._userCollapsedTurns = {};
      
      const isCurrentlyCollapsed = processCard ? processCard.classList.contains('collapsed') : (body ? body.style.display === 'none' : true);
      const nextCollapsed = !isCurrentlyCollapsed;
      window._userCollapsedTurns[turn.id] = nextCollapsed;

      if (processCard) {
        if (nextCollapsed) processCard.classList.add('collapsed');
        else processCard.classList.remove('collapsed');
      }
      if (body) {
        body.style.display = nextCollapsed ? 'none' : 'block';
      }
      if (chevron) {
        chevron.style.transform = nextCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
      }
    });
  }

  const pushGhBtn = card.querySelector('.push-github-btn');
  if (pushGhBtn) {
    pushGhBtn.addEventListener('click', () => {
      pushTaskToGitHub(project, turn);
    });
  }

  const copyBtn = card.querySelector('.copy-output-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!turn.output) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(turn.output);
        } else {
          const ta = document.createElement('textarea');
          ta.value = turn.output;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const span = copyBtn.querySelector('span');
        if (span) {
          const orig = span.textContent;
          span.textContent = 'Copied!';
          setTimeout(() => { span.textContent = orig; }, 1800);
        }
      } catch (err) {
        console.warn('Copy to clipboard failed:', err);
      }
    });
  }

  const retryTaskBtn = card.querySelector('.retry-task-btn');
  if (retryTaskBtn && retryTaskCallback) {
    retryTaskBtn.addEventListener('click', () => {
      retryTaskCallback(project.id, turn.id);
    });
  }

  const cancelTaskBtn = card.querySelector('.btn-cancel-task');
  if (cancelTaskBtn && cancelTaskCallback) {
    cancelTaskBtn.addEventListener('click', () => {
      cancelTaskCallback(project.id, turn.id);
    });
  }

  return card;
}

export function detectStepRole(step) {
  if (!step) return 'planner';
  if (step.function_call) {
    const name = (step.function_call.name || '').toLowerCase();
    if (name.includes('code') || name.includes('bash') || name.includes('exec') || name.includes('terminal')) return 'code';
    if (name.includes('search') || name.includes('url') || name.includes('browse') || name.includes('web')) return 'search';
    return 'code';
  }
  if (step.type === 'tool_call' || step.type === 'code_execution' || step.type === 'code_execution_call' || step.type === 'code_execution_result') return 'code';
  if (step.type === 'google_search') return 'search';
  if (step.type === 'model_output') return 'output';
  return 'planner';
}

export function getRoleLabel(role) {
  switch (role) {
    case 'code': return 'Sandbox Runner';
    case 'search': return 'Web Search';
    case 'output': return 'Response';
    default: return 'Antigravity Agent';
  }
}

export function getStepSummary(step) {
  if (step.type === 'code_execution_call') {
    const lang = step.language || step.arguments?.language || 'bash';
    return `Executing ${lang} command in sandbox`;
  }
  if (step.type === 'code_execution_result') {
    return 'Sandbox output received';
  }
  if (step.function_call) {
    return `Tool Execution: ${step.function_call.name || 'sandbox command'}`;
  }
  if (step.type === 'model_output') {
    return 'Synthesizing output response';
  }
  if (step.type === 'code_execution') {
    return 'Executing code in Linux container';
  }
  return 'Agent reasoning & tool execution';
}

export function formatStepContent(step) {
  let content = '';
  if (step.code || step.arguments?.code) {
    content += `[Code Execution (${step.language || step.arguments?.language || 'bash'})]:\n${step.code || step.arguments?.code}\n\n`;
  }
  if (step.result || step.arguments?.result) {
    content += `[Sandbox Output]:\n${step.result || step.arguments?.result}\n\n`;
  }
  if (step.thought) {
    content += `[Thought]:\n${typeof step.thought === 'string' ? step.thought : JSON.stringify(step.thought, null, 2)}\n\n`;
  }
  if (step.function_call) {
    content += `[Tool Call]: ${step.function_call.name}\nArguments:\n${JSON.stringify(step.function_call.arguments || {}, null, 2)}\n\n`;
  }
  if (step.content) {
    if (Array.isArray(step.content)) {
      step.content.forEach(c => {
        if (c.text) content += c.text + '\n';
      });
    } else if (typeof step.content === 'string') {
      content += step.content + '\n';
    }
  }
  if (!content && step.output) {
    content = typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2);
  }
  if (!content && step.liveText) {
    content = step.liveText;
  }
  return content || JSON.stringify(step, null, 2);
}

export function detectApkInfo(text, steps) {
  let combined = '';
  if (typeof text === 'string') combined += text + '\n';
  if (Array.isArray(steps)) {
    steps.forEach(s => {
      if (s.output) combined += (typeof s.output === 'string' ? s.output : JSON.stringify(s.output)) + '\n';
      if (s.content) combined += JSON.stringify(s.content) + '\n';
    });
  }
  if (!combined) return null;

  const apkPathMatch = combined.match(/(?:(?:path to \.apk|apk path|full path to \.apk|apk):\s*)?([a-zA-Z0-9_\-\.\/]+\/([a-zA-Z0-9_\-]+\.apk))/i)
    || combined.match(/(\/[a-zA-Z0-9_\-\.\/]+\/([a-zA-Z0-9_\-]+\.apk))/i);

  if (apkPathMatch) {
    const fullPath = apkPathMatch[1].trim();
    const filename = apkPathMatch[2] || fullPath.split('/').pop() || 'app-debug.apk';
    const sizeMatch = combined.match(/(?:file size|size):\s*([0-9\.]+\s*(?:M|MB|KB|G|GB|B)?)/i);
    const size = sizeMatch ? sizeMatch[1].trim() : '4.3 MB';
    return { path: fullPath, filename, size };
  }
  return null;
}

export function formatMarkdownOutput(text, projectId) {
  if (!text) return '';
  const raw = String(text);

  const apk = detectApkInfo(raw);
  let apkBannerHtml = '';
  if (apk) {
    apkBannerHtml = `
      <div class="apk-download-card" style="margin: 14px 0; padding: 14px 16px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 12px; min-width: 240px;">
          <div style="width: 40px; height: 40px; border-radius: 8px; background: rgba(16, 185, 129, 0.2); display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--emerald); flex-shrink: 0;">
            📦
          </div>
          <div>
            <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              <span>Android APK Package</span>
              <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.25); color: var(--emerald); font-weight: 600;">${escapeHtml(apk.size)}</span>
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); font-family: monospace; word-break: break-all; margin-top: 2px;">
              ${escapeHtml(apk.path)}
            </div>
            <div style="font-size: 11px; color: #f59e0b; margin-top: 4px; font-weight: 500;">
              ⚠ Placeholder build — not installable, real build files weren't found.
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <a href="/api/download-artifact?filePath=${encodeURIComponent(apk.path)}&filename=${encodeURIComponent(apk.filename)}" download="${escapeHtml(apk.filename)}" class="btn-modal-primary" style="background: var(--emerald); text-decoration: none; padding: 7px 15px; font-size: 12px; border-radius: 6px; display: inline-flex; align-items: center; gap: 6px; color: #fff; font-weight: 500;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <span>Download APK</span>
          </a>
          <button type="button" class="btn-modal-secondary btn-copy-apk-path" data-path="${escapeHtml(apk.path)}" style="padding: 7px 11px; font-size: 12px; border-radius: 6px;" title="Copy file path to clipboard">
            <span>Copy Path</span>
          </button>
        </div>
      </div>
    `;
  }

  const codeBlockRegex = /```([a-zA-Z0-9_\-\.\+]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let html = apkBannerHtml;
  let match;
  let codeIdx = 0;

  while ((match = codeBlockRegex.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index);
    if (before) {
      html += formatInlineMarkdown(before);
    }

    const rawLang = (match[1] || 'code').trim().toLowerCase();
    const codeContent = match[2];
    const filename = guessFilename(rawLang, codeIdx);
    const encodedCode = encodeURIComponent(codeContent);

    html += `
      <div class="dev-code-card" data-project-id="${escapeHtml(projectId || '')}" data-code-idx="${codeIdx}">
        <div class="dev-code-header">
          <div class="dev-code-meta">
            <span class="dev-code-lang">${escapeHtml(rawLang || 'code')}</span>
            <span class="dev-code-filename">${escapeHtml(filename)}</span>
          </div>
          <div class="dev-code-actions">
            <button type="button" class="btn-inspect-artifact" title="Inspect & preview in Developer Artifacts Dock" data-project-id="${escapeHtml(projectId || '')}" data-code-idx="${codeIdx}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="15" y1="3" x2="15" y2="21"></line>
              </svg>
              <span>Inspect in Dock</span>
            </button>
            <button type="button" class="btn-copy-code" title="Copy code snippet" data-encoded-code="${encodedCode}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
        </div>
        <div class="dev-code-body">
          <pre><code>${escapeHtml(codeContent)}</code></pre>
        </div>
      </div>
    `;
    codeIdx++;
    lastIndex = codeBlockRegex.lastIndex;
  }

  const remaining = raw.slice(lastIndex);
  if (remaining) {
    html += formatInlineMarkdown(remaining);
  }

  return html;
}

export function formatInlineMarkdown(str) {
  if (!str) return '';
  let escaped = escapeHtml(str);
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return escaped;
}

export function guessFilename(lang, idx) {
  const i = idx + 1;
  switch (lang) {
    case 'python':
    case 'py':
      return idx === 0 ? 'main.py' : `module_${i}.py`;
    case 'javascript':
    case 'js':
      return idx === 0 ? 'index.js' : `script_${i}.js`;
    case 'typescript':
    case 'ts':
      return idx === 0 ? 'index.ts' : `service_${i}.ts`;
    case 'html':
    case 'htm':
      return idx === 0 ? 'index.html' : `view_${i}.html`;
    case 'css':
      return 'styles.css';
    case 'json':
      return 'data.json';
    case 'sql':
      return `query_${i}.sql`;
    case 'bash':
    case 'sh':
    case 'shell':
      return 'sandbox_run.sh';
    case 'yaml':
    case 'yml':
      return 'config.yaml';
    case 'markdown':
    case 'md':
      return 'README.md';
    case 'dockerfile':
      return 'Dockerfile';
    default:
      return `artifact_${i}.${lang || 'txt'}`;
  }
}

function scrollToBottom() {
  setTimeout(() => {
    if (el.chatContainer) {
      el.chatContainer.scrollTop = el.chatContainer.scrollHeight;
    }
  }, 50);
}
