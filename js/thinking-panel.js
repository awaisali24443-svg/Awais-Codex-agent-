// ==========================================
// THINKING PANEL & LIVE TIMER
// ==========================================

import { state, escapeHtml } from './state.js';

let liveTimerInterval = null;

export function startLiveTimer(turn) {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(() => {
    if (!state.activeTask || state.activeTask.turnId !== turn.id || (turn.status !== 'running' && turn.status !== 'paused' && turn.status !== 'reconnecting')) {
      clearInterval(liveTimerInterval);
      liveTimerInterval = null;
      return;
    }

    if (turn.status === 'paused') {
      const remainingSec = turn.pausedUntil ? Math.max(0, Math.ceil((turn.pausedUntil - Date.now()) / 1000)) : 60;
      const statusTextEl = document.getElementById(`exec-status-text-${turn.id}`);
      if (statusTextEl) {
        statusTextEl.textContent = `• Rate limit hit — auto-retrying in ${remainingSec}s...`;
      }
      return;
    }

    const elapsedSec = ((Date.now() - turn.startedAt) / 1000).toFixed(1);

    const timerPill = document.getElementById(`thinking-timer-${turn.id}`);
    if (timerPill) {
      timerPill.textContent = `Thinking (${elapsedSec}s)`;
    }

    const execDuration = document.getElementById(`exec-duration-${turn.id}`);
    if (execDuration) {
      execDuration.textContent = `${elapsedSec}s`;
    }

    // Live progressive step updates during execution
    const streamBody = document.getElementById(`thinking-body-${turn.id}`);
    if (streamBody) {
      const thoughts = generateThoughtStream(turn);
      const isRunning = turn.status === 'running';
      const newHtml = thoughts.map((t, i) => {
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
      if (streamBody.innerHTML !== newHtml) {
        streamBody.innerHTML = newHtml;
      }
    }
  }, 150);
}

export function stopLiveTimer() {
  if (liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
}

export function generateThoughtStream(turn) {
  const thoughts = [];
  const isRunning = turn.status === 'running';

  // 1. Real thoughts streamed directly from Antigravity thought events
  if (Array.isArray(turn.thoughts) && turn.thoughts.length > 0) {
    turn.thoughts.forEach((t, idx) => {
      const isThoughtActive = isRunning && idx === turn.thoughts.length - 1;
      const stageName = t.summary ? t.summary : (turn.thoughts.length > 1 ? `Reasoning #${idx + 1}` : 'Thought Process');
      thoughts.push({
        stage: stageName,
        icon: '🧠',
        text: t.text || t.summary || '',
        isDone: !isThoughtActive
      });
    });
  }

  // 2. Real steps from Antigravity live stream or execution
  if (Array.isArray(turn.steps) && turn.steps.length > 0) {
    turn.steps.forEach((step, idx) => {
      const isStepRunning = isRunning && (step.status === 'running' || idx === turn.steps.length - 1);
      let stage = 'Antigravity Execution';
      let icon = '⚡';
      let text = '';

      if (step.type === 'model_output' || step.type === 'text' || step.type === 'output' || step.type === 'response') {
        return; // Exclude final model response text from thinking panel (Part 1 fix)
      } else if (step.type === 'code_execution_call' || step.type === 'code_execution') {
        const lang = step.language || step.arguments?.language || 'bash';
        stage = `Sandbox Execution (${lang})`;
        icon = '💻';
        text = step.code || step.arguments?.code || step.liveText || 'Running command in container sandbox...';
      } else if (step.type === 'code_execution_result') {
        stage = 'Sandbox Terminal Output';
        icon = '📋';
        text = (step.result || step.arguments?.result || step.liveText || 'Command executed successfully.').trim();
      } else if (step.type === 'google_search' || step.type === 'google_search_call') {
        stage = 'Live Web Search';
        icon = '🌐';
        text = step.query || step.arguments?.query || step.liveText || 'Searching Google web indexes...';
      } else if (step.type === 'thought' || step.thought) {
        stage = 'Deliberation';
        icon = '💭';
        text = typeof step.thought === 'string' ? step.thought : (step.thought_summary || JSON.stringify(step.thought || ''));
      } else if (step.function_call) {
        const name = step.function_call.name || 'tool';
        stage = `Tool Invocation: ${name}`;
        icon = '⚡';
        const argsStr = JSON.stringify(step.function_call.arguments || {});
        text = `Tool "${name}": ${argsStr.slice(0, 160)}`;
      } else {
        stage = `Step #${idx + 1}`;
        icon = '⚡';
        text = step.liveText || step.output || (step.type || 'tool_call');
      }

      thoughts.push({
        stage: stage,
        icon: icon,
        text: text.slice(0, 320) + (text.length > 320 ? '...' : ''),
        isDone: !isStepRunning
      });
    });
  }

  // 3. If running and no real thought or step has arrived yet, show ONLY one neutral "Connecting..." status
  if (thoughts.length === 0 && isRunning) {
    thoughts.push({
      stage: 'Connecting',
      icon: '⏳',
      text: 'Connecting to Antigravity remote sandbox...',
      isDone: false
    });
  }

  return thoughts;
}
