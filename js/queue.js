// ==========================================
// AUTOMATED QUEUING, DISPATCH & AUTO-RETRY ENGINE
// ==========================================

import { state, el, saveProjects, normalizeProject } from './state.js';
import { classifyAntigravityError } from './api.js';
import { startLiveTimer, stopLiveTimer, generateThoughtStream } from './thinking-panel.js';
import { renderConversation, detectStepRole, getRoleLabel } from './execution-cards.js';
import { renderHistoryList, updateAgentStatusHeader, updateQueueBadge, showWelcomeHero } from './sidebar.js';
import { updateArtifactsDockForProject } from './artifacts.js';
import { incrementCallCount } from './call-budget.js';
import { updateMobileLiveActivity } from './mobile-nav.js';

let openSettingsCallback = null;
let showToastCallback = null;
let autoRetryTimer = null;

export function setQueueHandlers(handlers) {
  if (handlers.openSettings) openSettingsCallback = handlers.openSettings;
  if (handlers.showToast) showToastCallback = handlers.showToast;
}

export function handlePromptSubmission() {
  if (!el.chatInput) return;
  const text = el.chatInput.value.trim();
  const hasFiles = state.attachedFiles.length > 0;
  if (!text && !hasFiles) return;

  const promptText = text || (hasFiles ? 'Please analyze and process the attached file(s) in your remote sandbox environment.' : '');
  const attached = [...state.attachedFiles];

  el.chatInput.value = '';
  state.attachedFiles = [];

  let project = null;
  if (state.activeSessionId) {
    project = state.projects.find(p => p.id === state.activeSessionId);
  }

  if (!project) {
    project = {
      id: 'conv_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
      title: promptText.slice(0, 36) + (promptText.length > 36 ? '...' : ''),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      messages: []
    };
    state.projects.unshift(project);
    state.activeSessionId = project.id;
  }

  normalizeProject(project);

  const turn = {
    id: 'turn_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
    prompt: promptText,
    files: attached,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: Date.now(),
    durationMs: null,
    steps: [],
    output: null,
    error: null,
    currentSubAgent: null,
    interactionId: null
  };

  project.messages.push(turn);
  project.status = 'running';
  project.updatedAt = Date.now();
  saveProjects();

  showWelcomeHero(false);
  if (el.activeSessionTitle) el.activeSessionTitle.textContent = project.title || 'Conversation';
  updateArtifactsDockForProject(project);
  renderConversation(project);
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  if (state.activeTask) {
    state.taskQueue.push({ projectId: project.id, turnId: turn.id });
    updateQueueBadge();
    renderConversation(project);
  } else {
    executeTurn(project.id, turn.id);
  }
}

export async function executeTurn(projectId, turnId) {
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }

  const project = state.projects.find(p => p.id === projectId);
  if (!project) {
    processNextInQueue();
    return;
  }
  normalizeProject(project);

  const turn = project.messages.find(m => m.id === turnId);
  if (!turn) {
    processNextInQueue();
    return;
  }

  if (!state.apiKey && !state.hasEnvKey) {
    turn.status = 'failed';
    turn.error = 'Google AI Studio API Key is missing. Open Settings to enter your key.';
    project.status = 'failed';
    saveProjects();
    if (state.activeSessionId === project.id) renderConversation(project);
    renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
    if (openSettingsCallback) openSettingsCallback();
    processNextInQueue();
    return;
  }

  state.activeTask = { projectId: project.id, turnId: turn.id };
  turn.status = 'running';
  turn.startedAt = Date.now();
  turn.engine = state.selectedEngine || 'antigravity-preview-05-2026';
  turn.currentSubAgent = 'Connecting to Remote Linux Sandbox...';
  project.status = 'running';
  saveProjects();

  startLiveTimer(turn);
  updateAgentStatusHeader(true);
  updateQueueBadge();
  if (state.activeSessionId === project.id) renderConversation(project);
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  state.abortController = new AbortController();

  try {
    let previousInteractionId = null;
    let environmentId = project.environmentId || null;
    for (const prevTurn of project.messages) {
      if (prevTurn.id !== turn.id) {
        if (prevTurn.interactionId) previousInteractionId = prevTurn.interactionId;
        if (prevTurn.environmentId) environmentId = prevTurn.environmentId;
      }
    }

    // Extract prior completed conversation turns for continuous session memory
    const history = (project.messages || [])
      .filter(m => m.id !== turn.id && (m.status === 'completed' || m.status === 'success') && m.prompt)
      .slice(-8)
      .map(m => ({
        prompt: m.prompt,
        output: m.output || (m.steps && m.steps.length > 0 ? 'Action completed' : '')
      }));

    const payload = {
      prompt: turn.prompt,
      files: turn.files || [],
      engine: 'antigravity-preview-05-2026',
      previousInteractionId: previousInteractionId,
      environmentId: environmentId,
      history: history
    };

    const headers = { 'Content-Type': 'application/json' };
    if (state.apiKey) headers['x-gemini-api-key'] = state.apiKey;

    turn.steps = [];
    turn.thoughts = [];
    turn.output = '';

    incrementCallCount();

    const response = await fetch('/api/stream-task', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const classified = classifyAntigravityError(errData.error || errData, response.status);

      if (classified.type === 'quota_exceeded') {
        pauseTurnForQuota(project, turn, 60000);
        return;
      }

      if (classified.type === 'daily_quota_exhausted') {
        failTurn(project, turn, classified.message);
        return;
      }

      if (turn.interactionId) {
        console.log(`Stream error (HTTP ${response.status}), reconnecting via polling for interaction ${turn.interactionId}...`);
        startPolling(project, turn, turn.interactionId);
        return;
      }

      // Fallback to /api/execute-task if stream fails to initiate
      console.log(`Stream error (HTTP ${response.status}), falling back to /api/execute-task runner...`);
      return executeTurnViaBackendTask(project, turn, payload, headers);
    }

    if (!response.body) {
      failTurn(project, turn, 'Antigravity model is not available: No readable stream received.');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let streamCompleted = false;

    while (!streamCompleted) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const blocks = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = blocks.pop() || '';

      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue;

        const lines = block.split(/\r?\n/);
        let rawHeaderType = '';
        const dataLines = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) {
            rawHeaderType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            dataLines.push(trimmed.slice(5).trim());
          }
        }

        const dataStr = dataLines.join('\n');
        if (!dataStr) continue;

        if (rawHeaderType === 'error') {
          let errObj = {};
          try { errObj = JSON.parse(dataStr); } catch (_) { errObj = { message: dataStr }; }
          const classified = classifyAntigravityError(errObj);
          if (classified.type === 'quota_exceeded') {
            pauseTurnForQuota(project, turn, 60000);
            return;
          }
          if (classified.type === 'daily_quota_exhausted') {
            failTurn(project, turn, classified.message);
            return;
          }
          if (turn.interactionId) {
            console.log(`SSE error event received, reconnecting via polling for interaction ${turn.interactionId}...`);
            startPolling(project, turn, turn.interactionId);
            return;
          }
          failTurn(project, turn, classified.message);
          return;
        }

        if (rawHeaderType === 'done' || dataStr === '[DONE]') {
          streamCompleted = true;
          break;
        }

        let eventData;
        try { eventData = JSON.parse(dataStr); } catch (_) { continue; }

        if (eventData.normalized_activity) {
          turn.currentActivity = eventData.normalized_activity.title;
          turn.activityDetail = eventData.normalized_activity.detail;
          turn.activityPhase = eventData.normalized_activity.phase;
          updateMobileLiveActivity(eventData.normalized_activity);
        }

        const delta = eventData.delta || {};
        const step = eventData.step || {};
        let eventType = (rawHeaderType || eventData.event_type || eventData.type || '').toLowerCase();

        const isThoughtEvent = eventType === 'thought' || delta.type === 'thought' || step.type === 'thought' ||
          Boolean(delta.thought_summary) || Boolean(delta.thought) || Boolean(step.summary && step.type === 'thought');

        if (isThoughtEvent) {
          eventType = 'thought';
        } else if (!eventType) {
          if (eventData.interaction?.status === 'completed' || eventData.interaction?.status === 'success') {
            eventType = 'interaction.completed';
          } else if (eventData.interaction?.id) {
            eventType = 'interaction.created';
          } else if (delta.type || delta.text || delta.arguments || delta.result) {
            eventType = 'step.delta';
          } else if (step.type || step.id) {
            eventType = 'step.start';
          }
        }

        if (eventType === 'interaction.created') {
          const inter = eventData.interaction || eventData;
          if (inter.id) turn.interactionId = inter.id;
          if (inter.environment_id) {
            turn.environmentId = inter.environment_id;
            project.environmentId = inter.environment_id;
          }
          turn.currentSubAgent = 'Antigravity: Sandbox connected...';
          saveProjects();
          if (state.activeSessionId === project.id) renderConversation(project);
        } else if (eventType === 'thought') {
          let thoughtText = '';
          if (typeof delta === 'string') thoughtText = delta;
          else if (delta.thought) thoughtText = typeof delta.thought === 'string' ? delta.thought : JSON.stringify(delta.thought);
          else if (delta.thought_summary) thoughtText = delta.thought_summary;
          else if (delta.text) thoughtText = delta.text;
          else if (delta.content) {
            thoughtText = typeof delta.content === 'string' ? delta.content : (delta.content.text || '');
          } else if (step.summary) {
            if (Array.isArray(step.summary)) {
              thoughtText = step.summary.map(s => typeof s === 'string' ? s : (s.text || '')).join('');
            } else if (typeof step.summary === 'string') {
              thoughtText = step.summary;
            }
          }

          const thoughtSummary = delta.thought_summary || (typeof step.summary === 'string' ? step.summary : '');

          if (thoughtText || thoughtSummary) {
            if (!turn.thoughts) turn.thoughts = [];
            if (turn.thoughts.length === 0 || (thoughtSummary && turn.thoughts[turn.thoughts.length - 1].summary !== thoughtSummary)) {
              turn.thoughts.push({
                summary: thoughtSummary,
                text: thoughtText,
                timestamp: Date.now()
              });
            } else {
              const lastThought = turn.thoughts[turn.thoughts.length - 1];
              lastThought.text = (lastThought.text || '') + thoughtText;
            }
          }
          turn.currentSubAgent = thoughtSummary ? `[Thinking] ${thoughtSummary}` : 'Antigravity thinking...';
          saveProjects();
          if (state.activeSessionId === project.id) {
            const streamBody = document.getElementById(`thinking-body-${turn.id}`);
            if (streamBody) {
              const thoughts = generateThoughtStream(turn);
              const isRunning = turn.status === 'running';
              streamBody.innerHTML = thoughts.map((t, i) => {
                const isLastActive = isRunning && i === thoughts.length - 1;
                return `
                  <div class="thought-item ${isLastActive ? 'active' : (t.isDone ? 'completed' : '')}">
                    <span class="thought-icon">${t.icon || '🧠'}</span>
                    <div class="thought-content">
                      <div class="thought-stage-label ${isLastActive ? 'active' : ''}">${escapeHtml(t.stage)}</div>
                      <div class="thought-text">
                        ${escapeHtml(t.text)}
                        ${isLastActive ? '<span class="thought-typing-cursor"></span>' : ''}
                      </div>
                    </div>
                  </div>
                `;
              }).join('');
            }
          }
        } else if (eventType === 'step.start') {
          const stepObj = eventData.step || {};
          const stepIndex = eventData.index !== undefined ? eventData.index : turn.steps.length;
          turn.steps[stepIndex] = {
            index: stepIndex,
            type: stepObj.type || 'model_output',
            id: stepObj.id || `step-${stepIndex}`,
            status: 'running',
            startedAt: Date.now(),
            arguments: stepObj.arguments || {},
            content: stepObj.content || [],
            liveText: ''
          };
          const roleLabel = getRoleLabel(detectStepRole(stepObj));
          turn.currentSubAgent = `[Antigravity: ${roleLabel}] Executing in sandbox...`;
          saveProjects();
          if (state.activeSessionId === project.id) {
            renderConversation(project);
            updateArtifactsDockForProject(project);
          }
        } else if (eventType === 'step.delta') {
          const stepIndex = eventData.index !== undefined ? eventData.index : (turn.steps.length > 0 ? turn.steps.length - 1 : 0);
          if (!turn.steps[stepIndex]) {
            turn.steps[stepIndex] = {
              index: stepIndex,
              type: eventData.delta?.type || 'model_output',
              status: 'running',
              liveText: '',
              arguments: {}
            };
          }
          const activeStep = turn.steps[stepIndex];
          const deltaObj = eventData.delta || {};

          if (deltaObj.type === 'code_execution_call') {
            activeStep.type = 'code_execution_call';
            if (deltaObj.arguments?.code) {
              activeStep.code = (activeStep.code || '') + deltaObj.arguments.code;
              activeStep.liveText = activeStep.code;
            }
            if (deltaObj.arguments?.language) activeStep.language = deltaObj.arguments.language;
            turn.currentSubAgent = `Antigravity running ${activeStep.language || 'bash'} in sandbox...`;
          } else if (deltaObj.type === 'code_execution_result') {
            activeStep.type = 'code_execution_result';
            if (deltaObj.result) {
              activeStep.result = (activeStep.result || '') + deltaObj.result;
              activeStep.liveText = activeStep.result;
            }
          } else if (deltaObj.type === 'thought' || deltaObj.type === 'thought_summary' || deltaObj.thought_summary || deltaObj.thought || (deltaObj.content && deltaObj.type !== 'text')) {
            let thText = '';
            if (typeof deltaObj.thought === 'string') thText = deltaObj.thought;
            else if (typeof deltaObj.thought_summary === 'string') thText = deltaObj.thought_summary;
            else if (deltaObj.content && typeof deltaObj.content === 'object') {
              thText = deltaObj.content.text || '';
            } else if (typeof deltaObj.content === 'string') {
              thText = deltaObj.content;
            }
            if (thText) {
              if (!turn.thoughts) turn.thoughts = [];
              if (turn.thoughts.length === 0) {
                turn.thoughts.push({ summary: deltaObj.thought_summary || '', text: thText, timestamp: Date.now() });
              } else {
                turn.thoughts[turn.thoughts.length - 1].text += thText;
              }
              turn.currentSubAgent = deltaObj.thought_summary ? `[Thinking] ${deltaObj.thought_summary}` : 'Antigravity thinking...';
            }
          } else if (deltaObj.type === 'text' || deltaObj.text || (deltaObj.content && deltaObj.type === 'text')) {
            const textDelta = deltaObj.text || (deltaObj.content && typeof deltaObj.content === 'object' ? deltaObj.content.text : '') || (typeof deltaObj.content === 'string' ? deltaObj.content : '');
            activeStep.liveText = (activeStep.liveText || '') + textDelta;
            turn.output = (turn.output || '') + textDelta;
            turn.currentSubAgent = 'Antigravity synthesizing response...';
          }

          if (state.activeSessionId === project.id) {
            renderConversation(project);
            updateArtifactsDockForProject(project);
          }
        } else if (eventType === 'step.stop') {
          const stepIndex = eventData.index !== undefined ? eventData.index : (turn.steps.length - 1);
          if (turn.steps[stepIndex]) {
            turn.steps[stepIndex].status = 'completed';
            turn.steps[stepIndex].completedAt = Date.now();
          }
          saveProjects();
          if (state.activeSessionId === project.id) {
            renderConversation(project);
          }
        } else if (eventType === 'interaction.completed') {
          const finalInter = eventData.interaction || {};
          if (finalInter.id) turn.interactionId = finalInter.id;
          if (finalInter.environment_id) {
            turn.environmentId = finalInter.environment_id;
            project.environmentId = finalInter.environment_id;
          }
          if (Array.isArray(finalInter.steps)) {
            turn.steps = finalInter.steps;
          }
          if (!turn.output && finalInter.output_text) {
            turn.output = finalInter.output_text;
          }
          finishTurn(project, turn, finalInter);
          return;
        }
      }
    }

    if (turn.status === 'running' || turn.status === 'reconnecting') {
      if (turn.interactionId && !streamCompleted) {
        console.log(`Stream ended silently without completion event, reconnecting via polling for interaction ${turn.interactionId}...`);
        turn.status = 'reconnecting';
        saveProjects();
        if (state.activeSessionId === project.id) renderConversation(project);
        startPolling(project, turn, turn.interactionId);
        return;
      }
      finishTurn(project, turn, { steps: turn.steps, output_text: turn.output });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      failTurn(project, turn, 'Task cancelled');
    } else {
      const classified = classifyAntigravityError(err);
      if (classified.type === 'quota_exceeded') {
        pauseTurnForQuota(project, turn, 60000);
      } else if (classified.type === 'daily_quota_exhausted') {
        failTurn(project, turn, classified.message);
      } else if (turn.interactionId) {
        console.log(`Stream catch error, reconnecting via polling for interaction ${turn.interactionId}...`, err);
        startPolling(project, turn, turn.interactionId);
      } else {
        failTurn(project, turn, classified.message);
      }
    }
  }
}

export function pauseTurnForQuota(project, turn, retryAfterMs = 60000) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  stopLiveTimer();

  turn.status = 'paused';
  turn.error = `Quota/Rate limit hit. Auto-retrying in ${Math.round(retryAfterMs / 1000)}s...`;
  project.status = 'paused';
  state.activeTask = { projectId: project.id, turnId: turn.id, paused: true };
  saveProjects();

  updateAgentStatusHeader(false);
  if (state.activeSessionId === project.id) {
    renderConversation(project);
    updateArtifactsDockForProject(project);
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  if (showToastCallback) {
    showToastCallback(`Quota limit reached. Auto-retrying in ${Math.round(retryAfterMs / 1000)}s...`, 'info');
  }

  // Schedule auto-retry without advancing queue or discarding task
  autoRetryTimer = setTimeout(() => {
    executeTurn(project.id, turn.id);
  }, retryAfterMs);
}

export function startPolling(project, turn, interactionId) {
  const checkStatus = async () => {
    if (!state.activeTask || state.activeTask.turnId !== turn.id) {
      if (state.pollTimer) clearInterval(state.pollTimer);
      return;
    }

    const headers = {};
    if (state.apiKey) headers['x-gemini-api-key'] = state.apiKey;

    try {
      const res = await fetch(`/api/poll-task/${encodeURIComponent(interactionId)}`, {
        headers,
        signal: state.abortController ? state.abortController.signal : undefined
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const classified = classifyAntigravityError(errData.error || errData, res.status);
        clearInterval(state.pollTimer);
        if (res.status === 404) {
          console.warn(`Interaction ${interactionId} returned 404. Falling back to fresh execution POST...`);
          delete turn.interactionId;
          executeTurn(project.id, turn.id);
          return;
        }
        if (classified.type === 'quota_exceeded') {
          pauseTurnForQuota(project, turn, 60000);
        } else {
          failTurn(project, turn, classified.message);
        }
        return;
      }

      const data = await res.json().catch(() => null);
      if (!data) return;
      const status = (data.status || '').toLowerCase();

      if (Array.isArray(data.steps) && data.steps.length > 0) {
        turn.steps = data.steps;
        const latest = data.steps[data.steps.length - 1];
        const role = detectStepRole(latest);
        turn.currentSubAgent = `[Antigravity: ${getRoleLabel(role)}] Executing in sandbox...`;
      }
      if (data.environment_id) {
        turn.environmentId = data.environment_id;
        project.environmentId = data.environment_id;
      }
      if (data.output_text) {
        turn.output = data.output_text;
      }

      saveProjects();
      if (state.activeSessionId === project.id) {
        renderConversation(project);
        updateArtifactsDockForProject(project);
      }

      if (status === 'completed' || status === 'success') {
        clearInterval(state.pollTimer);
        finishTurn(project, turn, data);
      } else if (status === 'failed' || status === 'cancelled') {
        clearInterval(state.pollTimer);
        const errObj = data.error || {};
        const classified = classifyAntigravityError(errObj);
        if (classified.type === 'quota_exceeded') {
          pauseTurnForQuota(project, turn, 60000);
        } else {
          failTurn(project, turn, classified.message);
        }
      }

    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('Poll error:', e);
      }
    }
  };

  setTimeout(checkStatus, 1500);
  state.pollTimer = setInterval(checkStatus, state.pollRateMs);
}

export async function executeTurnViaBackendTask(project, turn, payload, headers) {
  try {
    turn.currentSubAgent = 'Antigravity: executing task via backend runner...';
    saveProjects();
    if (state.activeSessionId === project.id) renderConversation(project);

    const execRes = await fetch('/api/execute-task', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: state.abortController ? state.abortController.signal : undefined
    });

    if (!execRes.ok) {
      const errData = await execRes.json().catch(() => ({}));
      const classified = classifyAntigravityError(errData.error || errData, execRes.status);
      failTurn(project, turn, classified.message);
      return;
    }

    const execData = await execRes.json();
    if (execData.id) {
      turn.interactionId = execData.id;
      if (execData.environment_id) {
        turn.environmentId = execData.environment_id;
        project.environmentId = execData.environment_id;
      }
      if (Array.isArray(execData.steps) && execData.steps.length > 0) {
        turn.steps = execData.steps;
      }
      if (execData.output_text) {
        turn.output = execData.output_text;
      }
      if (execData.status === 'completed' || execData.status === 'success') {
        finishTurn(project, turn, execData);
        return;
      }
      startPolling(project, turn, execData.id);
    } else {
      finishTurn(project, turn, execData);
    }
  } catch (err) {
    const classified = classifyAntigravityError(err);
    failTurn(project, turn, classified.message);
  }
}

export function finishTurn(project, turn, resultData) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  stopLiveTimer();

  turn.status = 'success';
  turn.completedAt = Date.now();
  turn.durationMs = turn.startedAt ? (Date.now() - turn.startedAt) : 0;
  turn.steps = resultData.steps || turn.steps || [];

  let output = '';
  if (Array.isArray(resultData.steps)) {
    for (const s of resultData.steps) {
      if (s.type === 'model_output') {
        if (Array.isArray(s.content)) {
          for (const c of s.content) {
            if (typeof c === 'string') output += c;
            else if (c && c.text) output += c.text;
          }
        } else if (typeof s.content === 'string') {
          output += s.content;
        } else if (s.text) {
          output += s.text;
        }
      }
    }
  }
  if (!output && resultData.output_text) {
    output = resultData.output_text;
  }
  turn.output = output || turn.output || 'Task completed successfully in sandbox.';

  const hasRunningTurns = project.messages.some(m => m.status === 'running' || m.status === 'queued');
  project.status = hasRunningTurns ? 'running' : 'success';
  project.updatedAt = Date.now();

  state.activeTask = null;
  saveProjects();

  updateAgentStatusHeader(false);
  updateQueueBadge();
  if (state.activeSessionId === project.id) {
    renderConversation(project);
    updateArtifactsDockForProject(project);
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  updateMobileLiveActivity({
    phase: 'completed',
    title: 'Mission Completed',
    detail: 'Build outputs and deliverables ready',
    status: 'completed'
  });

  // Push reply to WhatsApp gateway if this is a WhatsApp project turn from Web UI
  if (project.isWhatsApp || project.source === "whatsapp" || (project.id && String(project.id).startsWith("wa_"))) {
    if (turn.source !== "whatsapp") {
      const cleanPhone = (project.sender || project.id || "").replace(/[^0-9]/g, "");
      fetch("/api/whatsapp/send-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${localStorage.getItem("awais_whatsapp_admin_secret") || "wa_admin_secret_change_me_in_prod"}`
        },
        body: JSON.stringify({
          conversationId: project.id,
          senderPhone: cleanPhone,
          message: turn.output || turn.prompt
        })
      }).catch(err => {
        console.warn("[WhatsApp Sync] Could not dispatch reply to WhatsApp endpoint:", err);
      });
    }
  }

  processNextInQueue();
}

export function failTurn(project, turn, errorMsg) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  stopLiveTimer();

  turn.status = 'failed';
  turn.completedAt = Date.now();
  turn.durationMs = turn.startedAt ? (Date.now() - turn.startedAt) : 0;
  turn.error = errorMsg;

  project.status = 'failed';
  project.updatedAt = Date.now();

  state.activeTask = null;
  saveProjects();

  updateAgentStatusHeader(false);
  updateQueueBadge();
  if (state.activeSessionId === project.id) {
    renderConversation(project);
    updateArtifactsDockForProject(project);
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  updateMobileLiveActivity({
    phase: 'failed',
    title: 'Mission Failed or Paused',
    detail: errorMsg || 'Check error logs',
    status: 'failed'
  });

  processNextInQueue();
}

export function processNextInQueue() {
  if (state.taskQueue.length > 0) {
    const nextItem = state.taskQueue.shift();
    updateQueueBadge();
    if (typeof nextItem === 'object' && nextItem.projectId && nextItem.turnId) {
      executeTurn(nextItem.projectId, nextItem.turnId);
    } else if (typeof nextItem === 'string') {
      const proj = state.projects.find(p => p.id === nextItem);
      if (proj && proj.messages && proj.messages.length > 0) {
        const lastTurn = proj.messages[proj.messages.length - 1];
        executeTurn(proj.id, lastTurn.id);
      }
    }
  }
}

export function cancelTask(projectId, turnId) {
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  if (state.abortController) {
    try { state.abortController.abort(); } catch (e) {}
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  stopLiveTimer();

  const project = state.projects.find(p => p.id === projectId);
  if (project) {
    normalizeProject(project);
    const turn = project.messages.find(m => m.id === turnId) || project.messages[project.messages.length - 1];
    if (turn) {
      turn.status = 'failed';
      turn.error = 'Task was cancelled by the user.';
      turn.completedAt = Date.now();
      turn.durationMs = turn.startedAt ? (Date.now() - turn.startedAt) : 0;
    }
    project.status = 'failed';
    project.updatedAt = Date.now();
    saveProjects();
  }

  state.activeTask = null;
  updateAgentStatusHeader(false);
  updateQueueBadge();

  if (project && state.activeSessionId === project.id) {
    renderConversation(project);
    updateArtifactsDockForProject(project);
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');
  if (showToastCallback) showToastCallback('Task execution cancelled.', 'info');
  processNextInQueue();
}

export function retryTask(projectId, turnId) {
  if (autoRetryTimer && state.activeTask?.turnId === turnId) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }

  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  normalizeProject(project);

  const turn = project.messages.find(m => m.id === turnId) || project.messages[project.messages.length - 1];
  if (!turn) return;

  turn.status = 'pending';
  turn.error = null;
  turn.output = null;
  turn.steps = [];
  project.status = 'running';
  saveProjects();

  if (state.activeSessionId === projectId) {
    renderConversation(project);
    updateArtifactsDockForProject(project);
  }
  renderHistoryList(el.searchHistoryInput ? el.searchHistoryInput.value : '');

  if (state.activeTask) {
    state.taskQueue.push({ projectId: project.id, turnId: turn.id });
    updateQueueBadge();
    if (showToastCallback) showToastCallback('Task added to queue.', 'info');
  } else {
    executeTurn(project.id, turn.id);
  }
}
