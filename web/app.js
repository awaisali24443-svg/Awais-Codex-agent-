/* ==========================================================================
   Codex — client.

   The rule this file follows: the server owns the run, this only draws it.
   Nothing here is required for a task to finish, so a dropped connection, a
   backgrounded tab or a phone that sleeps mid-task costs nothing. On reconnect
   the stream replays from the last event we acknowledged and the UI is whole
   again.

   Two kinds of event arrive:
     *.delta    decoration. No id, never stored, dropped when the socket is
                busy. Rendered instantly so tokens appear as they are produced.
     everything else is durable and carries `id:`. A snapshot carries the FULL
                text so far, so drawing it is a replace, not an append — replay
                is idempotent and no merge logic can drift.
   ========================================================================== */

/* `$` hands back whatever element the id names. The cast keeps the file
   checkable: without it, every `el.prompt.value` is an error on `HTMLElement`,
   the noise buries the mistakes worth catching (a function that does not
   exist), and the check gets turned off. */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

const el = {
  login: $('screen-login'),
  app: $('screen-app'),
  loginForm: $('login-form'),
  loginKey: $('login-key'),
  loginSubmit: $('login-submit'),
  loginHint: $('login-hint'),

  stream: $('stream'),
  thread: $('thread'),
  hero: $('hero'),
  chips: $('chips'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('btn-send'),

  drawer: $('drawer'),
  scrim: $('scrim'),
  convos: $('convos'),
  budget: $('budget'),
  memory: $('memory'),
  memoryTitle: $('memory-title'),
  memoryBody: $('memory-body'),
  memoryToggle: $('memory-toggle'),
  settings: $('settings'),
  settingsTitle: $('settings-title'),
  settingsBody: $('settings-body'),
  settingsToggle: $('settings-toggle'),
  topbarTitle: $('topbar-title'),
  statusDot: $('status-dot'),
  toast: $('toast'),
  note: $('composer-note'),
};

const state = {
  conversationId: null,
  runId: null,
  source: null,
  running: false,
  conversations: [],
  budget: null,
  memory: null,
  settings: null,
};

/* ------------------------------------------------------------------ api -- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  if (res.status === 401) {
    showLogin();
    /** @type {Error & { status: number, body?: unknown }} */
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    throw err;
  }

  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: raw }; }

  if (!res.ok) {
    /** @type {Error & { status: number, body: unknown }} */
    const err = Object.assign(new Error(body?.message || body?.error || `HTTP ${res.status}`), {
      status: res.status,
      body,
    });
    throw err;
  }
  return body;
}

/* --------------------------------------------------------------- screens -- */

function showLogin() {
  closeStream();
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginKey.value = '';
  setTimeout(() => el.loginKey.focus(), 60);
}

function showApp() {
  el.login.hidden = true;
  el.app.hidden = false;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

function toast(message, ms = 4200) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 220);
  }, ms);
}

function note(message) {
  el.note.textContent = message || '';
}

/* ---------------------------------------------------------------- login --- */

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = el.loginKey.value.trim();
  if (!key) return;

  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = 'Checking…';
  el.loginHint.classList.remove('bad');

  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ key }) });
    el.loginHint.textContent = 'Saved on this device. You will not be asked again.';
    // The key is not kept in localStorage on purpose: the httpOnly cookie is
    // the credential, so a script on this page can never read it back out.
    el.loginKey.value = '';
    await enter();
  } catch (err) {
    el.loginHint.classList.add('bad');
    el.loginHint.textContent =
      err.status === 401 ? 'That key is not right.' : 'Could not reach the server.';
    el.loginKey.select();
  } finally {
    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = 'Continue';
  }
});

/* ----------------------------------------------------------------- boot -- */

async function enter() {
  showApp();
  renderThread([]);
  await Promise.allSettled([loadConversations(), loadBudget(), loadMemory(), loadSettings()]);

  try {
    const { run } = await api('/api/runs/active');
    if (run) {
      state.conversationId = run.conversationId;
      renderAsk(run.prompt);
      attach(run.id, 0);
      setRunning(true);
      toast('A task is already running — showing it live.');
      return;
    }
  } catch { /* not fatal: just means nothing is running */ }

  if (state.conversationId) {
    await openConversation(state.conversationId);
  } else {
    showHero(true);
  }
}

function showHero(on) {
  el.hero.hidden = !on;
  el.chips.classList.toggle('hide', !on);
}

/* ---------------------------------------------------------- conversations -- */

async function loadConversations() {
  try {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    renderConversations();
  } catch { /* silent */ }
}

function renderConversations() {
  el.convos.innerHTML = '';
  if (!state.conversations.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'No tasks yet.';
    el.convos.append(p);
    return;
  }

  for (const convo of state.conversations) {
    const button = document.createElement('button');
    button.className = 'convo' + (convo.id === state.conversationId ? ' on' : '');

    const title = document.createElement('span');
    title.className = 'convo-title';
    title.textContent = convo.title;

    const meta = document.createElement('small');
    meta.textContent = `${relativeTime(convo.updatedAt)} · ${convo.runCount} run${convo.runCount === 1 ? '' : 's'}`;

    button.append(title, meta);
    button.addEventListener('click', () => {
      closeDrawer();
      openConversation(convo.id);
    });
    el.convos.append(button);
  }
}

async function openConversation(id) {
  state.conversationId = id;
  el.topbarTitle.textContent = state.conversations.find((c) => c.id === id)?.title ?? 'Codex';
  showHero(false);
  renderThread([]);

  try {
    const { messages } = await api(`/api/conversations/${id}/messages`);
    for (const message of messages) {
      if (message.role === 'user') renderAsk(message.content);
      else if (message.role === 'assistant') renderAnswer(message.content);
    }
  } catch { /* silent */ }

  renderConversations();
  scrollToEnd(true);
}

/* --------------------------------------------------------------- drawing -- */

function renderThread(nodes) {
  el.thread.innerHTML = '';
  for (const node of nodes) el.thread.append(node);
}

function renderAsk(text) {
  const node = document.createElement('div');
  node.className = 'ask';
  node.textContent = text;
  el.thread.append(node);
  scrollToEnd();
  return node;
}

function renderAnswer(text) {
  const node = document.createElement('div');
  node.className = 'answer';
  node.innerHTML = markdown(text);
  el.thread.append(node);
  scrollToEnd();
  return node;
}

function renderNotice(text, bad = false, icon = 'info') {
  const node = document.createElement('div');
  node.className = 'notice' + (bad ? ' bad' : '');
  node.innerHTML = `${iconFor(icon)}<span></span>`;
  node.querySelector('span').textContent = text;
  el.thread.append(node);
  scrollToEnd();
  return node;
}

/* A run in progress is drawn as one card: thinking, then steps, then answer. */
function createRunCard(runId = null) {
  const card = document.createElement('div');
  card.className = 'run';

  const thinking = document.createElement('details');
  thinking.className = 'thinking';
  thinking.open = true;
  thinking.innerHTML = `
    <summary class="thinking-head">
      <span class="spinner"></span>
      <span class="label">Thinking</span>
      <span class="meta"></span>
      <svg class="thinking-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </summary>
    <div class="thinking-body"></div>`;

  const steps = document.createElement('div');
  steps.className = 'steps';

  const answer = document.createElement('div');
  answer.className = 'answer';

  // Filled at the end of the run, from the artifact record rather than from the
  // stream, so a replayed or reopened conversation shows the same files.
  const files = document.createElement('div');
  files.className = 'files';

  card.append(thinking, steps, answer, files);
  el.thread.append(card);
  scrollToEnd();

  return {
    card,
    files,
    runId,
    thinking,
    thinkingBody: thinking.querySelector('.thinking-body'),
    thinkingMeta: thinking.querySelector('.meta'),
    thinkingLabel: thinking.querySelector('.label'),
    spinner: thinking.querySelector('.spinner'),
    steps,
    answer,
    // the durable text, and the un-acknowledged tail drawn on top of it
    thinkingText: '',
    thinkingTail: '',
    answerText: '',
    answerTail: '',
    stepIndex: new Map(),
    elapsed: null,
    startedAt: Date.now(),
  };
}

function drawThinking(card) {
  const text = card.thinkingText + card.thinkingTail;
  card.thinkingBody.textContent = text;
  card.thinkingMeta.textContent = card.elapsed ?? `${Math.round(text.length / 4)} tok`;
}

function drawAnswer(card, streaming) {
  const text = card.answerText + card.answerTail;
  card.answer.innerHTML = markdown(text) + (streaming ? '<span class="caret"></span>' : '');
}

function addStep(card, key, { name, detail = '', icon = 'dot', done = false }) {
  let step = card.stepIndex.get(key);
  if (!step) {
    step = document.createElement('div');
    step.className = 'step';
    step.innerHTML = `
      <div class="step-rail"><span class="step-icon">${iconFor(icon)}</span></div>
      <div class="step-body">
        <div class="step-name"></div>
        <div class="step-detail" hidden></div>
      </div>`;
    card.steps.append(step);
    card.stepIndex.set(key, step);
  }

  step.querySelector('.step-name').textContent = name;
  if (detail) {
    const detailNode = step.querySelector('.step-detail');
    detailNode.hidden = false;
    detailNode.textContent = detail;
  }
  if (done) step.querySelector('.step-icon').innerHTML = iconFor('check');
  scrollToEnd();
  return step;
}

/* ----------------------------------------------------------------- icons -- */

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/>',
  warn: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  android: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M12 12l8-4.5M12 12v9M12 12 4 7.5"/>',
  spark: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
};

function iconFor(name) {
  const path = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24">${path}</svg>`;
}

function iconForTool(name = '') {
  const n = name.toLowerCase();
  if (/command|shell|exec|run|gradle|npm|build/.test(n)) return 'terminal';
  if (/create_file|edit_file|write|file/.test(n)) return 'file';
  if (/read|list|glob|dir|folder/.test(n)) return 'folder';
  if (/search|find|grep/.test(n)) return 'search';
  if (/browse|fetch|http|url|web/.test(n)) return 'globe';
  if (/apk|android|package/.test(n)) return 'android';
  if (/code|script|python/.test(n)) return 'code';
  return 'package';
}

/* ------------------------------------------------------------ event sink -- */

function handleEvent(card, event, data) {
  switch (event) {
    case 'run.started':
      note('');
      break;

    case 'log':
      addStep(card, `log:${card.steps.children.length}`, {
        name: data.message || 'step',
        icon: data.level === 'error' ? 'warn' : data.level === 'warn' ? 'warn' : 'info',
        done: true,
      });
      break;

    case 'tool.call':
      addStep(card, `tool:${data.name}:${card.steps.children.length}`, {
        name: prettyTool(data.name),
        detail: shortJson(data.args),
        icon: iconForTool(data.name),
      });
      break;

    case 'tool.result': {
      const last = card.steps.querySelector('.step:last-child .step-icon');
      if (last) last.innerHTML = iconFor('check');
      break;
    }

    case 'thinking.snapshot':
      card.thinkingText = data.text || '';
      card.thinkingTail = '';
      drawThinking(card);
      break;

    case 'thinking.delta':
      card.thinkingTail += data.chunk || '';
      if (!card.thinking.open) card.thinking.open = true;
      drawThinking(card);
      break;

    case 'text.snapshot':
      card.answerText = data.text || '';
      card.answerTail = '';
      drawAnswer(card, false);
      break;

    case 'text.delta':
      card.answerTail += data.chunk || '';
      drawAnswer(card, true);
      break;

    case 'run.environment':
      if (data.environmentId) {
        addStep(card, 'env', {
          name: 'Sandbox ready',
          detail: String(data.environmentId),
          icon: 'package',
          done: true,
        });
      }
      break;

    case 'artifact':
      addStep(card, `artifact:${data.id}`, {
        name: `Built ${data.name || 'a file'}`,
        detail: data.path ? String(data.path) : '',
        icon: iconForTool(String(data.name || '')),
        done: true,
      });
      break;

    case 'memory.recall':
      // Only worth a line when something was actually remembered, and phrased
      // so it explains why the answer may sound like it knows you.
      if (data.recalled > 0) {
        addStep(card, 'memory', {
          name: `Remembered ${data.recalled} thing${data.recalled === 1 ? '' : 's'} about you`,
          icon: 'spark',
          done: true,
        });
      }
      break;

    case 'run.completed':
      finishCard(card, 'done');
      break;

    case 'run.failed':
      finishCard(card, 'failed', data);
      break;

    case 'run.cancelled':
      finishCard(card, 'cancelled');
      break;
  }
}

function finishCard(card, outcome, data = {}) {
  card.spinner.classList.add('done');
  card.spinner.style.animation = 'none';
  card.spinner.setAttribute('class', 'spinner done');
  card.elapsed = `${((Date.now() - card.startedAt) / 1000).toFixed(1)}s`;
  card.thinkingLabel.textContent = 'Thinking';
  drawThinking(card);
  drawAnswer(card, false);

  if (outcome === 'failed') {
    const message = humanError(data.errorType, data.errorMessage);
    renderNotice(message, true, 'warn');
  } else if (outcome === 'cancelled') {
    renderNotice('Stopped. Whatever it produced is kept below.', false, 'info');
  }

  setRunning(false);
  loadBudget();
  loadConversations();
  loadArtifacts(card);
  // Extraction runs after the run is closed, so give it a moment to land
  // before asking what was learned — otherwise the list is always one behind.
  setTimeout(loadMemory, 1_200);
}

/* Files the mission produced. Read from the artifact record, so it works the
   same live, on replay, and months later from the history drawer — and a file
   whose sandbox has expired still appears, with the reason it cannot be
   fetched rather than a silently broken link. */
async function loadArtifacts(card) {
  if (!card.runId) return;
  try {
    const { artifacts } = await api(`/api/runs/${card.runId}/artifacts`);
    card.files.innerHTML = '';
    for (const artifact of artifacts) card.files.append(artifactChip(artifact));
  } catch { /* the run is what matters; a missing file list is not fatal */ }
}

function artifactChip(artifact) {
  const chip = document.createElement('button');
  chip.className = 'file';
  chip.type = 'button';
  chip.innerHTML = `${iconFor('package')}<span></span>`;
  const label = artifact.name + (artifact.size ? ` · ${formatBytes(artifact.size)}` : '');
  chip.querySelector('span').textContent = label;

  chip.addEventListener('click', async () => {
    chip.classList.add('busy');
    try {
      const response = await fetch(artifact.downloadUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast(body?.message || `Could not fetch ${artifact.name}.`);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      link.click();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${artifact.name}`);
    } catch {
      toast('Download failed — check your connection.');
    } finally {
      chip.classList.remove('busy');
    }
  });

  return chip;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanError(type, message) {
  const known = {
    quota_exceeded: "Today's agent quota is used up. It resets around noon.",
    rate_limited: 'The agent was busy. Try again in a moment.',
    auth_failed: 'The API key was rejected. Check GEMINI_API_KEY in Render.',
    agent_unavailable: 'That agent id no longer exists — Google date-stamps them.',
    idle_timeout: 'The agent went quiet, so the task was closed to free the slot.',
    budget_exceeded: "You have used today's runs. It resets at midnight UTC.",
    network_error: 'Lost the connection to the agent.',
    truncated: 'The agent finished without producing an answer.',
  };
  return known[type] || type ? `${known[type] || type}: ${message || ''}`.trim() : message || 'The task failed.';
}

function prettyTool(name = '') {
  return String(name).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortJson(value) {
  if (!value || (typeof value === 'object' && !Object.keys(value).length)) return '';
  try {
    const text = JSON.stringify(value);
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  } catch { return ''; }
}

/* ------------------------------------------------------------------ sse -- */

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function attach(runId, after = 0) {
  closeStream();
  state.runId = runId;

  const card = createRunCard(runId);
  const url = `/api/runs/${runId}/stream${after ? `?after=${after}` : ''}`;
  const source = new EventSource(url, { withCredentials: true });
  state.source = source;

  const durable = [
    'run.started', 'log', 'tool.call', 'tool.result',
    'thinking.snapshot', 'text.snapshot', 'run.environment',
    'artifact', 'memory.recall',
    'run.completed', 'run.failed', 'run.cancelled',
  ];
  for (const name of durable) {
    source.addEventListener(name, (message) => {
      let data = {};
      try { data = JSON.parse(message.data); } catch { /* ignore */ }
      handleEvent(card, name, data);
    });
  }

  // Decoration only — no id, so these never move the replay position.
  source.addEventListener('text.delta', (m) => {
    try { handleEvent(card, 'text.delta', JSON.parse(m.data)); } catch { /* ignore */ }
  });
  source.addEventListener('thinking.delta', (m) => {
    try { handleEvent(card, 'thinking.delta', JSON.parse(m.data)); } catch { /* ignore */ }
  });

  source.addEventListener('end', () => {
    source.close();
    if (state.source === source) state.source = null;
  });

  source.addEventListener('error', () => {
    // EventSource reconnects on its own and replays from Last-Event-ID, so a
    // blip is invisible. Only say something if the run is known to be over.
    if (source.readyState === EventSource.CLOSED && state.running) {
      note('Connection lost — reopen to catch up. The task keeps running.');
    }
  });
}

/* ------------------------------------------------------------- composer -- */

function setRunning(on) {
  state.running = on;
  el.statusDot.hidden = !on;
  el.topbarTitle.textContent = on ? 'Working…' : (state.conversations.find((c) => c.id === state.conversationId)?.title ?? 'Codex');
  el.send.disabled = on || !el.prompt.value.trim();
}

el.prompt.addEventListener('input', () => {
  autoGrow();
  el.send.disabled = state.running || !el.prompt.value.trim();
});

el.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

function autoGrow() {
  el.prompt.style.height = 'auto';
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, window.innerHeight * 0.34)}px`;
}

for (const chip of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.chip'))) {
  chip.addEventListener('click', () => {
    el.prompt.value = chip.dataset.fill || '';
    autoGrow();
    el.send.disabled = false;
    el.prompt.focus();
    el.prompt.setSelectionRange(el.prompt.value.length, el.prompt.value.length);
  });
}

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = el.prompt.value.trim();
  if (!prompt || state.running) return;

  el.prompt.value = '';
  autoGrow();
  el.send.disabled = true;
  showHero(false);
  renderAsk(prompt);
  scrollToEnd(true);

  try {
    const { run, budget } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ prompt, conversationId: state.conversationId }),
    });
    state.conversationId = run.conversationId;
    if (budget) note(`${budget.remaining} of ${budget.limit} runs left today`);
    setRunning(true);
    attach(run.id, 0);
    loadConversations();
    loadBudget();
  } catch (err) {
    // 409 means something is already running. That is a state, not a failure:
    // attach to it instead of showing an error.
    if (err.status === 409 && err.body?.activeRunId) {
      renderNotice('Another task is still running — showing it instead.', false, 'info');
      state.conversationId = state.conversationId;
      setRunning(true);
      attach(err.body.activeRunId, 0);
      return;
    }
    if (err.status === 429) {
      renderNotice(humanError('budget_exceeded', err.body?.message), true, 'warn');
      return;
    }
    renderNotice(err.message || 'Could not start the task.', true, 'warn');
  }
});

/* --------------------------------------------------------------- budget -- */

async function loadBudget() {
  try {
    const { buckets } = await api('/api/budget');
    const web = buckets.find((b) => b.bucket === 'web') || buckets[0];
    state.budget = web;
    renderBudget();
  } catch { /* silent */ }
}

function renderBudget() {
  if (!state.budget) return;
  const { used, limit, remaining } = state.budget;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  el.budget.innerHTML = `
    <div>${remaining} of ${limit} runs left today</div>
    <div class="budget-bar"><div class="budget-fill${remaining <= limit * 0.15 ? ' low' : ''}" style="width:${pct}%"></div></div>`;
}

/* ----------------------------------------------------------------- memory -- */

/* Two panels in the drawer read the server's state: what the agent remembers
   and what it is configured with. Both are lazy and silent — a failure to load
   either must never take the app down with it, which is exactly what happened
   when `enter()` called a renderer that did not exist yet. */

async function loadMemory() {
  try {
    state.memory = await api('/api/memory');
    renderMemory();
  } catch { /* the app works without the panel */ }
}

function profileLine(profile) {
  if (!profile) return '';
  const parts = [];
  if (profile.name) parts.push(profile.name);
  if (profile.role) parts.push(profile.role);
  if (profile.environment) parts.push(`on ${profile.environment}`);
  if (Array.isArray(profile.preferredFrameworks) && profile.preferredFrameworks.length) {
    parts.push(profile.preferredFrameworks.join(', '));
  }
  if (Array.isArray(profile.customDirectives) && profile.customDirectives.length) {
    parts.push(profile.customDirectives.join('; '));
  }
  return parts.join(' · ');
}

function renderMemory() {
  const data = state.memory;
  if (!data) return;

  const profile = profileLine(data.profile);
  const items = Array.isArray(data.memories) ? data.memories : [];

  // Nothing learned yet: an empty "Remembered" section teaches the operator
  // nothing, so it stays out of the way until there is something in it.
  if (!profile && items.length === 0) {
    el.memory.hidden = true;
    return;
  }

  el.memory.hidden = false;
  el.memoryTitle.textContent = items.length ? `Remembered (${items.length})` : 'Remembered';

  const rows = [];
  if (profile) {
    rows.push(`<div class="memory-item"><span class="tag">you</span>${escapeHtml(profile)}</div>`);
  }
  for (const item of items.slice(0, 6)) {
    rows.push(
      `<div class="memory-item"><span class="tag">${escapeHtml(item.category)}</span>${escapeHtml(item.content)}</div>`,
    );
  }
  if (items.length > 6) {
    rows.push(`<div class="memory-note">…and ${items.length - 6} more</div>`);
  }
  rows.push('<button class="memory-forget" id="memory-forget">Forget everything</button>');

  el.memoryBody.innerHTML = rows.join('');
  el.memoryBody.querySelector('#memory-forget')?.addEventListener('click', forgetEverything);
}

async function forgetEverything() {
  const button = el.memoryBody.querySelector('#memory-forget');
  if (button?.dataset.busy) return;
  if (button) { button.dataset.busy = '1'; button.textContent = 'Forgetting…'; }
  try {
    const { removed } = await api('/api/memory/clear', { method: 'POST' });
    state.memory = null;
    el.memory.hidden = true;
    toast(removed ? `Forgot ${removed} thing${removed === 1 ? '' : 's'}.` : 'Nothing was remembered.');
  } catch (err) {
    toast(err.message || 'Could not clear what was remembered.');
    if (button) { button.dataset.busy = ''; button.textContent = 'Forget everything'; }
  }
}

/* --------------------------------------------------------------- settings -- */

const SECRET_STATE = {
  stored: (secret) => ({
    text: `saved here · ${secret.fingerprint}`,
    className: 'ok',
  }),
  environment: (secret) => ({
    text: `from ${secret.envVar} in the environment`,
    className: 'ok',
  }),
  missing: () => ({ text: 'not set', className: 'bad' }),
  unreadable: () => ({ text: 'cannot decrypt — MASTER_KEY changed', className: 'bad' }),
};

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    renderSettings();
  } catch { /* the app works without the panel */ }
}

function renderSettings() {
  const data = state.settings;
  if (!data) return;
  el.settings.hidden = false;

  const saved = data.settings.filter((s) => s.source === 'stored').length;
  el.settingsTitle.textContent = saved ? `Settings (${saved})` : 'Settings';

  const rows = data.settings.map((setting) => `
    <label class="setting-row">
      <span class="setting-label">
        ${escapeHtml(setting.label)}
        <em>${setting.source === 'stored' ? 'saved here' : `from ${escapeHtml(setting.envVar)}`}</em>
      </span>
      <input class="setting-input" data-setting="${escapeHtml(setting.key)}"
        type="${typeof setting.value === 'number' ? 'number' : 'text'}"
        value="${escapeHtml(String(setting.value))}" />
    </label>`);

  const secrets = data.secrets.map((secret) => {
    const state_ = (SECRET_STATE[secret.source] || SECRET_STATE.missing)(secret);
    return `
      <div class="secret" data-secret="${escapeHtml(secret.name)}">
        <div class="secret-main">
          <span class="secret-name">${escapeHtml(secret.label)}</span>
          <span class="secret-state ${state_.className}">${escapeHtml(state_.text)}</span>
        </div>
        <div class="secret-actions">
          <button class="primary" data-act="set" data-name="${escapeHtml(secret.name)}">Replace</button>
          ${secret.source === 'stored'
            ? `<button class="danger" data-act="remove" data-name="${escapeHtml(secret.name)}">Remove</button>`
            : ''}
        </div>
      </div>`;
  });

  // Whether the phone channel is actually connected. "Paste the API key" is the
  // whole setup, so the panel shows the result of having done it — including the
  // reason when it is not working, which is the difference between "it is off"
  // and "it is broken".
  const whatsapp = data.whatsapp;
  const whatsappNote = !whatsapp
    ? ''
    : whatsapp.state === 'running'
      ? `<p class="setting-note"><b>WhatsApp connected</b>${whatsapp.agentId ? ` as ${escapeHtml(whatsapp.agentId)}` : ''}. Text it a task and it answers here too.</p>`
      : whatsapp.state === 'error'
        ? `<p class="setting-note bad"><b>WhatsApp cannot connect.</b> ${escapeHtml(whatsapp.lastError || 'The platform refused the key.')} Generate a new API key in WhatsApp → Settings → Agents, and replace it here.</p>`
        : `<p class="setting-note">${escapeHtml(whatsapp.detail || 'WhatsApp is not connected.')}</p>`;

  const encryptionNote = data.encryption.available
    ? `<p class="setting-note">Keys are encrypted with MASTER_KEY before they are stored, and are never sent back to this screen — only a short fingerprint is.</p>`
    : `<p class="setting-note bad">${escapeHtml(data.encryption.hint || 'Storing secrets is unavailable.')}</p>`;

  el.settingsBody.innerHTML = `${rows.join('')}<p class="setting-note">Changes apply immediately — no redeploy.</p>${secrets.join('')}${whatsappNote}${encryptionNote}`;

  for (const input of el.settingsBody.querySelectorAll('.setting-input')) {
    input.addEventListener('change', () => saveSetting(input));
  }
  el.settingsBody.addEventListener('click', onSettingsClick);
}

async function saveSetting(input) {
  const key = input.dataset.setting;
  const raw = input.value;
  const value = input.type === 'number' ? Number(raw) : raw;
  input.disabled = true;
  try {
    const { value: applied } = await api(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    toast(`${key === 'dailyRunBudget' ? 'Budget' : 'Setting'} saved: ${applied}`);
    // The budget shown at the top of the drawer must agree with the new limit.
    if (key === 'dailyRunBudget') await loadBudget();
    await loadSettings();
  } catch (err) {
    toast(err.message || 'That value was refused.');
    input.value = input.defaultValue;
  } finally {
    input.disabled = false;
  }
}

function onSettingsClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const name = button.dataset.name;
  if (button.dataset.act === 'remove') void removeSecret(name);
  if (button.dataset.act === 'set') askSecret(button, name);
}

/** The value is entered, sent, and forgotten by this screen — it is never shown again. */
function askSecret(button, name) {
  const row = button.closest('.secret');
  const actions = row.querySelector('.secret-actions');
  actions.innerHTML = `
    <input class="secret-input" type="password" autocomplete="off" spellcheck="false"
      placeholder="paste the key, then Save" data-name="${escapeHtml(name)}" />
    <button class="primary" data-act="save">Save</button>
    <button data-act="cancel">Cancel</button>`;
  const input = actions.querySelector('.secret-input');
  input.focus();
  actions.addEventListener('click', (event) => {
    const act = event.target.closest('button[data-act]')?.dataset.act;
    if (act === 'save') void saveSecret(name, input.value);
    if (act === 'cancel') void loadSettings();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void saveSecret(name, input.value);
  });
}

async function saveSecret(name, value) {
  if (!value || !value.trim()) {
    toast('Nothing to save.');
    return;
  }
  try {
    const { secret, whatsapp } = await api(`/api/settings/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    // The response is metadata; the value is deliberately not echoed anywhere.
    toast(`${secret.label} saved (${secret.fingerprint}).`);
    // Saving the WhatsApp key connects (or fails to) immediately — say which,
    // rather than leaving the answer to be discovered by texting it.
    if (name === 'whatsapp_token' && whatsapp) {
      toast(
        whatsapp.state === 'running'
          ? 'WhatsApp connected.'
          : whatsapp.state === 'error'
            ? `WhatsApp refused that key: ${whatsapp.lastError || 'check it and try again'}`
            : whatsapp.detail || 'WhatsApp is not connected.',
        6_000,
      );
    }
    await loadSettings();
  } catch (err) {
    toast(err.message || 'Could not store that key.');
  }
}

async function removeSecret(name) {
  try {
    await api(`/api/settings/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast('Removed. The environment value, if any, applies again.');
    await loadSettings();
  } catch (err) {
    toast(err.message || 'Could not remove that key.');
  }
}

/* --------------------------------------------------------------- drawer -- */

function openDrawer() {
  el.drawer.classList.add('open');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.scrim.hidden = false;
  requestAnimationFrame(() => el.scrim.classList.add('show'));
}

function closeDrawer() {
  el.drawer.classList.remove('open');
  el.drawer.setAttribute('aria-hidden', 'true');
  el.scrim.classList.remove('show');
  setTimeout(() => { el.scrim.hidden = true; }, 240);
}

$('btn-menu').addEventListener('click', openDrawer);

/* Collapsible panels. The bodies are populated separately, so opening one is
   only ever a matter of flipping two attributes. */
function bindPanel(toggle, body) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });
}

bindPanel(el.memoryToggle, el.memoryBody);
bindPanel(el.settingsToggle, el.settingsBody);
$('btn-close-drawer').addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

function newTask() {
  closeDrawer();
  closeStream();
  state.conversationId = null;
  state.runId = null;
  setRunning(false);
  renderThread([]);
  showHero(true);
  el.topbarTitle.textContent = 'Codex';
  el.prompt.focus();
  renderConversations();
}

$('btn-new').addEventListener('click', newTask);
$('btn-new-2').addEventListener('click', newTask);

$('btn-signout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  closeDrawer();
  showLogin();
});

/* ---------------------------------------------------------------- scroll -- */

let pinned = true;
el.stream.addEventListener('scroll', () => {
  const distance = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
  pinned = distance < 90;
}, { passive: true });

function scrollToEnd(force = false) {
  if (!force && !pinned) return;
  requestAnimationFrame(() => { el.stream.scrollTop = el.stream.scrollHeight; });
}

/* -------------------------------------------------------------- markdown -- */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * A deliberately small markdown subset: headings, lists, fences, inline code
 * and emphasis. It escapes first, so model output can never inject markup into
 * the page — the cost of a full markdown library is not worth its attack
 * surface here.
 */
function markdown(source) {
  const text = escapeHtml(source || '').replace(/\r\n/g, '\n');
  const parts = text.split(/```/);
  let html = '';

  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9+-]*\n/, '').replace(/\n$/, '');
      html += `<pre><code>${body}</code></pre>`;
      return;
    }

    const blocks = part.split(/\n{2,}/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      if (/^#{1,3}\s/.test(trimmed)) {
        const level = trimmed.match(/^#+/)[0].length;
        html += `<h${level}>${inline(trimmed.replace(/^#+\s*/, ''))}</h${level}>`;
        continue;
      }

      const lines = trimmed.split('\n');
      if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
        html += `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
        continue;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        html += `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
        continue;
      }

      html += `<p>${inline(trimmed).replace(/\n/g, '<br />')}</p>`;
    }
  });

  return html;
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ pwa -- */

/* Installable, and usable with no network. The worker itself is network-first,
   so this never serves a stale app while you are online — it only fills in when
   the phone has nothing. Registration is best-effort: in an iframe, or on an
   origin that refuses workers, the app carries on regardless. */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* not fatal */ });
  });
}

/* ------------------------------------------------------------------ go --- */

(async function start() {
  registerWorker();
  try {
    await api('/api/auth/session');
    await enter();
  } catch {
    showLogin();
  }
})();

window.addEventListener('pagehide', closeStream);
