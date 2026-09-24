import { stripMarkdownForSpeech, combineTranscripts, recognitionErrorMessage } from './voice.js';
import { SUGGESTIONS, suggestionFill, fillComposerFromChip } from './welcome.js';
import {
  statusForStep,
  nodeIconForStatus,
  hasExpandableDetail,
  formatStepTime,
  stripMilestones,
} from './timeline.js';
import {
  PANEL_SECTIONS,
  visibleSections,
  defaultSection,
  createPanelState,
  openPanelState,
  closePanelState,
  selectPanelSection,
} from './panel.js';

/* ==========================================================================
   WAIS — client.

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
  branchBar: $('branch-bar'),
  hero: $('hero'),
  chips: $('chips'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('btn-send'),
  stop: $('btn-stop'),

  drawer: $('drawer'),
  scrim: $('scrim'),
  convos: $('convos'),
  budget: $('budget'),
  memory: $('memory'),
  memoryTitle: $('memory-title'),
  memoryBody: $('memory-body'),
  memoryToggle: $('memory-toggle'),
  settingsBody: $('settings-body'),
  settingsScreen: $('screen-settings'),
  settingsOpen: $('btn-settings'),
  settingsBack: $('btn-settings-back'),
  schedules: $('schedules'),
  schedulesTitle: $('schedules-title'),
  schedulesBody: $('schedules-body'),
  schedulesToggle: $('schedules-toggle'),
  topbarTitle: $('topbar-title'),
  statusDot: $('status-dot'),
  toast: $('toast'),
  panel: $('panel'),
  panelBackdrop: $('panel-backdrop'),
  panelClose: $('panel-close'),
  panelTabs: $('panel-tabs'),
  panelBody: $('panel-body'),
  note: $('composer-note'),
  pingToggle: $('ping-wrap'),
  pingCheck: $('ping-check'),
  researchWrap: $('research-wrap'),
  researchCheck: $('research-check'),
  researchMinutes: $('research-minutes'),
  researchCustom: $('research-custom'),
};

const state = {
  conversationId: null,
  branchId: null,
  runId: null,
  source: null,
  running: false,
  conversations: [],
  budget: null,
  memory: null,
  settings: null,
  scheduled: null,
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
  el.settingsScreen.hidden = true;
  el.login.hidden = false;
  el.loginKey.value = '';
  setTimeout(() => el.loginKey.focus(), 60);
}

function showApp() {
  el.login.hidden = true;
  el.settingsScreen.hidden = true;
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
  await Promise.allSettled([loadConversations(), loadBudget(), loadMemory(), loadSettings(), loadScheduled()]);

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

  // The WhatsApp "done" ping toggle only appears when a key is configured —
  // offering a ping we cannot send would be a lie.
  try {
    const status = await api('/api/status');
    if (status.whatsappConfigured) el.pingToggle.hidden = false;
  } catch { /* silent: the toggle just stays hidden */ }

  if (state.conversationId) {
    await openConversation(state.conversationId);
  } else {
    showHero(true);
  }
}

function showHero(on) {
  el.hero.hidden = !on;
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

async function openConversation(id, branchId = null) {
  state.conversationId = id;
  state.branchId = branchId;
  // A run in flight owns the title ("Working…"); opening the conversation
  // must not clobber it back, or the header says idle while the stop button
  // says busy.
  el.topbarTitle.textContent = state.running
    ? 'Working…'
    : (state.conversations.find((c) => c.id === id)?.title ?? 'WAIS');
  showHero(false);
  renderThread([]);

  // Resolve the branch before fetching: without it, opening a conversation
  // that has forks would render every branch's messages interleaved.
  const branches = await fetchBranches(id);
  const main = branches.find((b) => b.label === 'main') ?? branches[0];
  if (!state.branchId || !branches.some((b) => b.id === state.branchId)) state.branchId = main?.id ?? null;
  renderBranchBar(branches);

  const qs = state.branchId ? `?branch=${encodeURIComponent(state.branchId)}` : '';
  // Pending LinkedIn drafts filed by the agent (```linkedin-post blocks).
  // One fetch per open, keyed by run, so history answers get a Publish button.
  const draftByRun = new Map();
  try {
    const { drafts } = await api(`/api/linkedin/drafts?conversationId=${encodeURIComponent(id)}`);
    for (const d of drafts ?? []) draftByRun.set(d.runId, d.id);
  } catch { /* LinkedIn not connected or not configured — no buttons */ }
  try {
    const { messages } = await api(`/api/conversations/${id}/messages${qs}`);
    for (const message of messages) {
      const node = message.role === 'user' ? renderAsk(message.content) : renderAnswer(message.content);
      attachMessageActions(node, message, draftByRun.get(message.runId));
    }
  } catch { /* silent */ }

  renderConversations();
  scrollToEnd(true);
}

async function fetchBranches(id) {
  try {
    const { branches } = await api(`/api/conversations/${id}/branches`);
    return Array.isArray(branches) ? branches : [];
  } catch { return []; }
}

/* The branch switcher: one pill per branch, shown only once a fork exists.
   Switching re-opens the conversation at that branch — the thread re-renders
   from that branch's view, nothing is copied or lost. */
function renderBranchBar(branches) {
  el.branchBar.innerHTML = '';
  for (const branch of branches) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'branch-pill' + (branch.id === state.branchId ? ' on' : '');
    pill.textContent = branch.label;
    pill.title = branch.parentBranchId ? `${branch.label} — forked from an earlier message` : 'The original thread';
    pill.addEventListener('click', () => {
      if (branch.id !== state.branchId && !state.running) openConversation(state.conversationId, branch.id);
    });
    el.branchBar.append(pill);
  }
  el.branchBar.hidden = branches.length < 2;
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
  stopSpeaking(); // The operator moved on — stop reading the old answer.
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

  // The plan checklist: one row per announced milestone, updated in place as
  // `plan.milestone` events arrive. Hidden until the first milestone lands, so
  // missions without a plan look exactly as before.
  const plan = document.createElement('div');
  plan.className = 'plan';
  plan.hidden = true;

  const answer = document.createElement('div');
  answer.className = 'answer';

  // Filled at the end of the run, from the artifact record rather than from the
  // stream, so a replayed or reopened conversation shows the same files.
  const files = document.createElement('div');
  files.className = 'files';

  card.append(thinking, plan, steps, answer, files);
  el.thread.append(card);
  scrollToEnd();

  return {
    card,
    files,
    runId,
    plan,
    planIndex: new Map(),
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
  // The planning protocol lines ("Step 1/3: ...") are the timeline's job. The
  // agent also writes them into its prose, which is why an answer used to open
  // with its own plan before the reply; they are filtered out here so the
  // answer is the answer. The stored record keeps everything.
  const text = stripMilestones(card.answerText + card.answerTail);
  card.answer.innerHTML = markdown(text) + (streaming ? '<span class="caret"></span>' : '');
}

/* ------------------------------------------------------------ plan view -- */

/**
 * The plan checklist. Rows are keyed by step index so a re-announced step
 * updates in place and a replay renders the same list in order. A "done"
 * announcement only ever upgrades a row; a later plan line for the same step
 * never un-checks it.
 */
function updatePlan(card, data) {
  const index = Number(data.index);
  const total = Number(data.total);
  if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1) return;

  card.plan.hidden = false;
  let row = card.planIndex.get(index);
  if (!row) {
    row = document.createElement('div');
    row.className = 'plan-row';
    row.innerHTML = '<span class="plan-check"></span><span class="plan-num"></span><span class="plan-label"></span>';
    card.planIndex.set(index, row);
    // Insert in numeric order.
    const keys = [...card.planIndex.keys()].sort((a, b) => a - b);
    const next = keys[keys.indexOf(index) + 1];
    card.plan.insertBefore(row, next !== undefined ? card.planIndex.get(next) : null);
  }

  row.querySelector('.plan-num').textContent = `${index}/${total}`;
  if (data.label) row.querySelector('.plan-label').textContent = String(data.label);
  if (data.done) row.classList.add('done');
  scrollToEnd();
}

/* ------------------------------------------------------- plan preview -- */

/**
 * The plan checklist in its waiting state: the proposed steps plus Approve
 * and Edit. Rebuilding from scratch keeps an edited plan, a re-render, and a
 * replayed stream from ever duplicating rows or buttons.
 */
function renderPlanPreview(card, plan) {
  const steps = Array.isArray(plan) ? plan : [];
  card.plan.hidden = false;
  card.planIndex.clear();
  card.plan.innerHTML = '';
  for (const step of steps) {
    updatePlan(card, { index: step.index, total: step.total, label: step.label, done: false });
  }
  const actions = document.createElement('div');
  actions.className = 'plan-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'msg-btn primary';
  approve.textContent = '✓ Approve & start';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'msg-btn';
  edit.textContent = '✎ Edit plan';
  actions.append(approve, edit);
  card.plan.append(actions);
  approve.addEventListener('click', () => approvePlan(card, approve));
  edit.addEventListener('click', () => editPlan(card));
  scrollToEnd();
}

/** The wait is over: drop the Approve / Edit buttons, keep the checklist. */
function closePlanPreview(card) {
  card.plan.querySelectorAll('.plan-actions').forEach((node) => node.remove());
}

async function approvePlan(card, button) {
  button.disabled = true;
  try {
    await api(`/api/runs/${card.runId}/approve`, { method: 'POST' });
    // 'run.plan_approved' arrives on the stream and closes the preview; the
    // close here covers a stream that is momentarily behind.
    closePlanPreview(card);
    note('Plan approved — starting…');
    setRunning(true);
  } catch (err) {
    button.disabled = false;
    toast(err.body?.message || err.message || 'Could not approve the plan.');
  }
}

/**
 * Inline plan editing: labels become inputs, Save sends the new labels to the
 * server (reindexed 1..N), and the broadcast 'run.plan_updated' re-renders
 * the checklist. Cancel restores the untouched labels.
 */
function editPlan(card) {
  const actions = card.plan.querySelector('.plan-actions');
  if (!actions || actions.hidden) return;
  const originals = [];
  for (const row of card.plan.querySelectorAll('.plan-row')) {
    const label = row.querySelector('.plan-label');
    originals.push(label.textContent);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'plan-edit';
    input.value = label.textContent;
    input.maxLength = 140;
    label.replaceWith(input);
  }
  actions.hidden = true;
  const editor = document.createElement('div');
  editor.className = 'plan-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'msg-btn primary';
  save.textContent = 'Save plan';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'msg-btn';
  cancel.textContent = 'Cancel';
  editor.append(save, cancel);
  card.plan.append(editor);

  const restore = (labels) => {
    card.plan.querySelectorAll('.plan-row').forEach((row, i) => {
      const span = document.createElement('span');
      span.className = 'plan-label';
      span.textContent = labels[i] ?? '';
      row.querySelector('.plan-edit')?.replaceWith(span);
    });
    editor.remove();
    actions.hidden = false;
  };
  cancel.addEventListener('click', () => restore(originals));
  save.addEventListener('click', async () => {
    const labels = [...card.plan.querySelectorAll('.plan-edit')]
      .map((el) => el.value.trim())
      .filter(Boolean);
    if (!labels.length) {
      toast('The plan needs at least one step.');
      return;
    }
    save.disabled = true;
    try {
      await api(`/api/runs/${card.runId}/plan`, {
        method: 'POST',
        body: JSON.stringify({ steps: labels }),
      });
      // The server reindexes and broadcasts 'run.plan_updated', which
      // re-renders the checklist — nothing left to do here.
    } catch (err) {
      save.disabled = false;
      toast(err.body?.message || err.message || 'Could not save the plan.');
    }
  });
}

/* A mission step drawn as one node on the timeline. The node on the rail
   shows the step's status (spinner while running, check/dash/cross after);
   the body shows the name, a small timestamp, and an expandable detail. */
function addStep(card, key, { name, detail = '', icon = 'dot', done = false, status = null }) {
  let step = card.stepIndex.get(key);
  if (!step) {
    step = document.createElement('div');
    step.className = 'step';
    step.innerHTML = `
      <div class="step-rail"><span class="step-icon"></span></div>
      <div class="step-body">
        <div class="step-head"><span class="step-name"></span><span class="step-time"></span></div>
        <div class="step-detail" hidden></div>
      </div>`;
    step.querySelector('.step-time').textContent = formatStepTime();
    step.querySelector('.step-body').addEventListener('click', () => {
      if (step.classList.contains('expandable')) step.classList.toggle('expanded');
    });
    card.steps.append(step);
    card.stepIndex.set(key, step);
  }

  step.querySelector('.step-name').textContent = name;
  if (hasExpandableDetail(detail)) {
    const detailNode = step.querySelector('.step-detail');
    if (detailNode.textContent !== detail) detailNode.textContent = detail;
    detailNode.hidden = false;
    step.classList.add('expandable');
  }
  setStepStatus(step, statusForStep({ done, icon, status }));
  scrollToEnd();
  return step;
}

/* Paint a step's node with its timeline status. The node is the status —
   the per-tool flavor the old icon carried lives on in the detail line. */
function setStepStatus(step, status) {
  step.dataset.status = status;
  const node = step.querySelector('.step-icon');
  const glyph = nodeIconForStatus(status);
  node.innerHTML = glyph === 'spinner'
    ? '<span class="step-spin" aria-hidden="true"></span>'
    : iconFor(glyph);
}

/* ----------------------------------------------------------------- icons -- */

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  dash: '<path d="M5 12h14"/>',
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
  eye: '<path d="M2 12s3.6-6.8 10-6.8S22 12 22 12s-3.6 6.8-10 6.8S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
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
      card.prompt = typeof data.prompt === 'string' ? data.prompt : '';
      // The definitive budget line arrives on 'research.started' below; this
      // early mark means a replay that starts mid-run still shows the mode.
      if (data.deepResearch) {
        addStep(card, 'research', {
          name: `Deep research — up to ${Number(data.researchBudgetMinutes) || 15} min budget`,
          icon: 'search',
        });
      }
      break;

    case 'log': {
      const message = data.message || 'step';
      // A rate limit is the one wait that can last minutes, and a card that
      // only says "Thinking" through it looks like a hang. It gets a step of
      // its own that stays running until the mission moves again.
      if (/rate limited|waiting \d+s/i.test(message)) {
        addStep(card, 'rate-limit', { name: message, icon: 'warn', status: 'running' });
        break;
      }
      const waiting = card.stepIndex.get('rate-limit');
      if (waiting) setStepStatus(waiting, 'done');
      addStep(card, `log:${card.steps.children.length}`, {
        name: message,
        icon: data.level === 'error' ? 'warn' : data.level === 'warn' ? 'warn' : 'info',
        done: true,
      });
      break;
    }

    case 'plan.milestone':
      updatePlan(card, data);
      break;

    case 'run.plan_ready':
    case 'run.plan_updated':
      // The planning pass proposed steps (or the operator edited them): the
      // run waits in 'awaiting_plan' and the card shows Approve / Edit. The
      // mission does not start until the operator taps Approve.
      renderPlanPreview(card, data.plan);
      break;

    case 'run.plan_approved':
      // The wait is over; 'run.started' follows on this same stream and the
      // execution milestones tick the approved steps off in place.
      closePlanPreview(card);
      note('Plan approved — starting…');
      break;

    case 'tool.call':
      addStep(card, `tool:${data.name}:${card.steps.children.length}`, {
        name: prettyTool(data.name),
        detail: shortJson(data.args),
        icon: iconForTool(data.name),
      });
      break;

    case 'tool.result': {
      const last = card.steps.querySelector('.step:last-child');
      if (last) setStepStatus(last, 'done');
      break;
    }

    case 'google.read': {
      // The access log: what the agent read from the operator's Google
      // account. The content itself travels inside the mission, not here.
      const kindLabel = {
        'gmail-search': 'Searched Gmail',
        'gmail-read': 'Read an email',
        'calendar-list': 'Checked Calendar',
      }[data.kind] || 'Google read';
      const detail = [data.query, data.summary].filter(Boolean).join(' — ');
      addStep(card, `google:${card.steps.children.length}`, {
        name: data.ok === false ? `${kindLabel} failed` : kindLabel,
        detail,
        icon: data.ok === false ? 'warn' : 'eye',
      });
      break;
    }

    case 'thinking.snapshot':
      card.thinkingText = data.text || '';
      card.thinkingTail = '';
      drawThinking(card);
      break;

    case 'thinking.delta': {
      const waiting = card.stepIndex.get('rate-limit');
      if (waiting) setStepStatus(waiting, 'done');
      card.thinkingTail += data.chunk || '';
      if (!card.thinking.open) card.thinking.open = true;
      drawThinking(card);
      break;
    }

    case 'text.snapshot':
      card.answerText = data.text || '';
      card.answerTail = '';
      drawAnswer(card, false);
      break;

    case 'text.delta': {
      const waiting = card.stepIndex.get('rate-limit');
      if (waiting) setStepStatus(waiting, 'done');
      card.answerTail += data.chunk || '';
      drawAnswer(card, true);
      break;
    }

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

    case 'research.started':
      addStep(card, 'research', {
        name: `Deep research — up to ${data.budgetMinutes} min`,
        detail: 'Chaining passes until the budget is spent',
        icon: 'search',
      });
      break;

    case 'research.pass':
      addStep(card, 'research', {
        name: data.lastChance
          ? 'Deep research — final pass: synthesising the report'
          : `Deep research — pass ${data.pass}, ~${data.remainingMinutes} min left`,
        icon: 'search',
      });
      break;

    case 'artifact':
      addStep(card, `artifact:${data.id}`, {
        name: `Built ${data.name || 'a file'}`,
        detail: data.path ? String(data.path) : '',
        icon: iconForTool(String(data.name || '')),
        done: true,
      });
      break;

    case 'sources.checked': {
      const dead = Array.isArray(data.dead) ? data.dead : [];
      const checked = Number(data.checked) || 0;
      addStep(card, 'sources', {
        name: dead.length === 0
          ? `Sources checked — ${checked} link${checked === 1 ? '' : 's'} alive`
          : `Sources checked — ${checked - dead.length} alive, ${dead.length} dead`,
        detail: dead.slice(0, 5).join(', '),
        icon: dead.length === 0 ? 'check' : 'warn',
        done: true,
      });
      break;
    }

    case 'verification.checked': {
      const failed = Array.isArray(data.failed) ? data.failed : [];
      const checked = Number(data.checked) || 0;
      const passed = Number(data.passed) || 0;
      addStep(card, 'verification', {
        name: failed.length === 0
          ? `Verified — ${checked} check${checked === 1 ? '' : 's'} passed`
          : `Verification — ${passed} of ${checked} checks passed`,
        detail: failed.join(', '),
        icon: failed.length === 0 ? 'check' : 'warn',
        done: true,
      });
      break;
    }

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
      // The agent filed a LinkedIn draft: one tap publishes, nothing auto-posts.
      if (data.linkedInDraft) card.answer.append(linkedInPublishButton(data.linkedInDraft));
      break;

    case 'run.failed':
      finishCard(card, 'failed', data);
      break;

    case 'run.paused':
      finishCard(card, 'paused');
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

  // Prove-it's-done: the checks the server ran before closing the mission,
  // rendered as checklist lines. Present on both done and failed finishes —
  // a failed verification lists exactly which checks failed.
  if (Array.isArray(data.verification) && data.verification.length > 0) {
    for (const check of data.verification) {
      const passed = check && check.passed === true;
      addStep(card, `proof:${check && check.name}`, {
        name: `${passed ? '✓' : '✗'} ${check && check.name} — ${check && check.evidence}`,
        status: passed ? 'done' : 'failed',
      });
    }
  }

  if (outcome === 'failed') {
    const message = humanError(data.errorType, data.errorMessage);
    const noticeNode = renderNotice(message, true, 'warn');
    if (data.errorType === 'interrupted') {
      // The server restarted mid-mission. Resume continues from the first
      // unfinished step; retry starts over. Both are offered, resume first.
      noticeNode.append(runActionButtons(card, { resume: true, retry: true, share: true, outputs: true, notice: noticeNode }));
    } else {
      // A failed complex task is usually worth one more attempt, not a retyped
      // prompt. The retry starts a fresh run with the same prompt in the same
      // conversation; it costs one daily run like any other mission.
      noticeNode.append(runActionButtons(card, { retry: true, share: true, outputs: true, notice: noticeNode }));
    }
  } else if (outcome === 'paused') {
    // Not terminal: the partial answer stands, the finished steps are
    // checkpointed, and resuming carries on from the first unfinished one.
    const noticeNode = renderNotice('Stopped part-way. The finished steps are saved.', false, 'warn');
    noticeNode.append(runActionButtons(card, { resume: true, share: true, outputs: true, notice: noticeNode }));
  } else if (outcome === 'cancelled') {
    const noticeNode = renderNotice('Stopped. Whatever it produced is kept below.', false, 'info');
    noticeNode.append(runActionButtons(card, { share: true, outputs: true }));
  } else {
    // A finished task can be re-run as-is or tweaked in the composer and
    // re-sent.
    const noticeNode = renderNotice('Done.', false, 'check');
    noticeNode.append(runActionButtons(card, { retry: true, share: true, outputs: true, notice: noticeNode }));
  }

  setRunning(false);
  loadBudget();
  loadConversations();
  loadArtifacts(card);
  // Extraction runs after the run is closed, so give it a moment to land
  // before asking what was learned — otherwise the list is always one behind.
  setTimeout(loadMemory, 1_200);
}

/* Re-run a finished task with the same prompt via the retry endpoint: a brand
   new run in the same conversation. The finished notice is replaced by the
   new run's card.
   @param {{ button: HTMLButtonElement, notice?: { remove(): void } | null }} opts */
async function retryRun(card, opts) {
  const { button, notice } = opts;
  button.disabled = true;
  try {
    const { run, branchId } = await api(`/api/runs/${card.runId}/retry`, { method: 'POST' });
    if (branchId) state.branchId = branchId;
    state.conversationId = run.conversationId;
    if (notice) notice.remove();
    setRunning(true);
    attach(run.id, 0);
    loadConversations();
    loadBudget();
  } catch (err) {
    button.disabled = false;
    renderNotice(err.body?.message || err.message || 'Could not retry.', true, 'warn');
  }
}

/* Resume a paused or interrupted run: the SAME run continues from its first
   unfinished step — finished work is kept, and it costs no new daily run.
   @param {{ runId: string }} card
   @param {{ button: HTMLButtonElement, notice?: { remove(): void } | null }} opts */
async function resumeRun(card, opts) {
  const { button, notice } = opts;
  button.disabled = true;
  try {
    const { run, branchId } = await api(`/api/runs/${card.runId}/resume`, { method: 'POST' });
    if (branchId) state.branchId = branchId;
    state.conversationId = run.conversationId;
    if (notice) notice.remove();
    setRunning(true);
    attach(run.id, 0);
    loadConversations();
    loadBudget();
  } catch (err) {
    button.disabled = false;
    toast(err.body?.message || err.message || 'Could not resume.');
  }
}

/* Manus-style per-message actions on history. Every user message gets an
   inline edit pencil; every finished answer gets a retry button. Edit forks
   the conversation at that message (the original stays untouched in its
   branch) and the edited text re-sends as the first message of the new
   branch. Retry stays in the run's own branch — the server returns it so the
   view never drifts. */
function attachMessageActions(node, message, linkedInDraftId = null) {
  const row = document.createElement('div');
  row.className = 'msg-actions';
  // Every assistant answer can be heard aloud — free, via the browser.
  if (message.role === 'assistant' && message.content && 'speechSynthesis' in window) {
    row.append(speakButton(message.content));
  }
  if (message.role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'msg-btn';
    editBtn.textContent = '✎ Edit';
    editBtn.title = 'Edit this message — forks the conversation';
    editBtn.addEventListener('click', () => openInlineEditor(node, message));
    row.append(editBtn);
  } else if (message.runId && message.runStatus === 'awaiting_plan') {
    // A plan waiting for approval: jump straight to its card to review it.
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'msg-btn';
    reviewBtn.textContent = '☰ Review plan';
    reviewBtn.title = 'Review the proposed plan — approve or edit it';
    reviewBtn.addEventListener('click', async () => {
      reviewBtn.disabled = true;
      try {
        const { run } = await api(`/api/runs/${message.runId}`);
        if (!run || run.status !== 'awaiting_plan') {
          toast('This plan was already decided.');
          reviewBtn.disabled = false;
          return;
        }
        state.conversationId = run.conversationId;
        row.remove();
        attach(run.id, 0);
      } catch (err) {
        reviewBtn.disabled = false;
        toast(err.message || 'Could not open the plan.');
      }
    });
    row.append(reviewBtn);
  } else if (message.runId && (message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'paused')) {
    // A paused run, or one the server killed mid-mission, resumes from its
    // first unfinished step. Everything else gets the plain retry.
    const resumable = message.runStatus === 'paused' || message.runErrorType === 'interrupted';
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'msg-btn';
    actionBtn.textContent = resumable ? '▶ Resume' : '↻ Retry';
    actionBtn.title = resumable ? 'Continue from the last finished step' : 'Run this task again';
    actionBtn.addEventListener('click', async () => {
      actionBtn.disabled = true;
      try {
        const endpoint = resumable ? 'resume' : 'retry';
        const { run, branchId } = await api(`/api/runs/${message.runId}/${endpoint}`, { method: 'POST' });
        if (branchId) state.branchId = branchId;
        state.conversationId = run.conversationId;
        row.remove();
        setRunning(true);
        attach(run.id, 0);
        loadConversations();
        loadBudget();
      } catch (err) {
        actionBtn.disabled = false;
        toast(err.body?.message || err.message || (resumable ? 'Could not resume.' : 'Could not retry.'));
      }
    });
    row.append(actionBtn);
  }
  // The run's outputs (files, preview, plan, proof) in a slide-over panel.
  if (message.role === 'assistant' && message.runId &&
      (message.runStatus === 'completed' || message.runStatus === 'failed' || message.runStatus === 'paused')) {
    const outputsBtn = document.createElement('button');
    outputsBtn.type = 'button';
    outputsBtn.className = 'msg-btn';
    outputsBtn.textContent = '⧉ Outputs';
    outputsBtn.title = 'Open this run\u2019s outputs in a side panel';
    outputsBtn.addEventListener('click', () => openOutputs(message.runId));
    row.append(outputsBtn);
  }
  // A ```linkedin-post block the agent filed as a pending draft. Publishing
  // is always the operator's tap — never automatic.
  if (linkedInDraftId && message.role === 'assistant') row.append(linkedInPublishButton(linkedInDraftId));
  if (!row.children.length) return;
  node.append(row);
}

/* Swap a user message for an editor in place. Saving forks the conversation
   at that message and re-sends the edited text into the new branch. */

/** One-tap publish for a pending LinkedIn draft. Disabled while posting. */
function linkedInPublishButton(draftId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-btn';
  const label = 'in Publish to LinkedIn';
  btn.textContent = label;
  btn.title = 'Publish this draft to your LinkedIn profile';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      await api(`/api/linkedin/drafts/${encodeURIComponent(draftId)}/publish`, { method: 'POST' });
      btn.textContent = '✓ Published';
      toast('Published on LinkedIn.');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      toast(err.body?.message || err.message || 'Publish failed.');
    }
  });
  return btn;
}
function openInlineEditor(node, message) {
  if (node.querySelector('.inline-editor')) return;
  const original = message.content;
  node.textContent = '';
  node.classList.add('editing');

  const editor = document.createElement('div');
  editor.className = 'inline-editor';
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = original;
  const btns = document.createElement('div');
  btns.className = 'inline-editor-btns';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'msg-btn primary';
  save.textContent = 'Save & resend';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'msg-btn';
  cancel.textContent = 'Cancel';
  btns.append(save, cancel);
  editor.append(ta, btns);
  node.append(editor);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => {
    node.classList.remove('editing');
    node.textContent = original;
  };
  cancel.addEventListener('click', close);
  save.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text || text === original) { close(); return; }
    save.disabled = true;
    cancel.disabled = true;
    try {
      // Fork first, then show the new branch: the original message must not
      // be in the view the edited text lands in.
      const { branch } = await api(`/api/conversations/${state.conversationId}/branches`, {
        method: 'POST',
        body: JSON.stringify({ messageId: message.id }),
      });
      state.branchId = branch.id;
      await openConversation(state.conversationId, branch.id);
      await submitPrompt(text);
    } catch (err) {
      close();
      toast(err.body?.message || err.message || 'Could not fork the conversation.');
    }
  });
}

/* The button group appended to a finished run's notice. */
function runActionButtons(card, { retry = false, resume = false, share = false, outputs = false, notice = null } = {}) {
  const group = document.createElement('span');
  group.className = 'run-btns';
  if (outputs) {
    // The run's outputs (files, preview, plan, proof) in a slide-over panel
    // instead of cramped inline cards.
    const outputsBtn = document.createElement('button');
    outputsBtn.type = 'button';
    outputsBtn.className = 'retry-btn';
    outputsBtn.textContent = '⧉ Outputs';
    outputsBtn.title = 'Open this run\u2019s outputs in a side panel';
    outputsBtn.addEventListener('click', () => openOutputs(card.runId));
    group.append(outputsBtn);
  }
  if (resume) {
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'retry-btn';
    resumeBtn.textContent = 'Resume from last finished step';
    resumeBtn.addEventListener('click', () => resumeRun(card, { button: resumeBtn, notice }));
    group.append(resumeBtn);
  }
  if (retry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Retry this task';
    retryBtn.addEventListener('click', () => retryRun(card, { button: retryBtn, notice }));
    group.append(retryBtn);
  }
  if (share) {
    // Shareable replay: one tap enables the public link and copies it; the
    // operator can copy it again or revoke it from the same spot.
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'retry-btn';
    shareBtn.textContent = '🔗 Share replay';
    shareBtn.addEventListener('click', () => shareReplay(card, shareBtn, group));
    group.append(shareBtn);
  }
  return group;
}

/* Share a finished run as a public read-only replay page. Enabling is
   idempotent server-side, so tapping twice just copies the same link again.
   A "Revoke link" button appears once shared; revoking makes the URL 404. */
async function shareReplay(card, button, group) {
  button.disabled = true;
  try {
    const { url } = await api(`/api/runs/${card.runId}/share`, { method: 'POST' });
    try {
      await navigator.clipboard.writeText(url);
      toast('Replay link copied — anyone with the link can view it.');
    } catch {
      toast(`Replay link: ${url}`);
    }
    button.textContent = '🔗 Copy replay link';
    if (!group.querySelector('[data-revoke-share]')) {
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'retry-btn';
      revokeBtn.textContent = 'Revoke link';
      revokeBtn.setAttribute('data-revoke-share', '');
      revokeBtn.addEventListener('click', async () => {
        revokeBtn.disabled = true;
        try {
          await api(`/api/runs/${card.runId}/share`, { method: 'DELETE' });
          toast('Replay link revoked.');
          button.textContent = '🔗 Share replay';
          revokeBtn.remove();
        } catch {
          toast('Could not revoke the link.');
          revokeBtn.disabled = false;
        }
      });
      group.append(revokeBtn);
    }
  } catch {
    toast('Could not create the replay link.');
  }
  button.disabled = false;
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
    for (const artifact of artifacts) {
      card.files.append(artifactChip(artifact));
      if (artifact.previewable) card.files.append(previewButton(artifact));
    }
  } catch { /* the run is what matters; a missing file list is not fatal */ }
}

/* Fetch an artifact's bytes and save them locally. Shared by the inline file
   chips and the outputs panel's Files section. */
async function downloadArtifact(artifact, chip) {
  chip?.classList.add('busy');
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
    chip?.classList.remove('busy');
  }
}

function artifactChip(artifact) {
  const chip = document.createElement('button');
  chip.className = 'file';
  chip.type = 'button';
  chip.innerHTML = `${iconFor('package')}<span></span>`;
  const label = artifact.name + (artifact.size ? ` · ${formatBytes(artifact.size)}` : '');
  chip.querySelector('span').textContent = label;

  chip.addEventListener('click', () => downloadArtifact(artifact, chip));

  return chip;
}

/* A website the mission built gets a live preview, not just a download. The
   page is served by /api/artifacts/:id/preview and rendered in a sandboxed
   iframe: its own scripts and styles run, but the sandbox keeps it away from
   the app — allow-scripts only, never allow-same-origin, never
   allow-top-navigation. */
function previewButton(artifact) {
  const btn = document.createElement('button');
  btn.className = 'file preview-btn';
  btn.type = 'button';
  btn.innerHTML = `${iconFor('eye')}<span></span>`;
  btn.querySelector('span').textContent = `Preview ${artifact.name}`;
  btn.addEventListener('click', () => openPreview(artifact));
  return btn;
}

function openPreview(artifact) {
  closePreview();

  const overlay = document.createElement('div');
  overlay.className = 'preview-overlay';
  overlay.id = 'preview-overlay';

  const bar = document.createElement('div');
  bar.className = 'preview-bar';

  const title = document.createElement('span');
  title.className = 'preview-title';
  title.textContent = artifact.name;

  const close = document.createElement('button');
  close.className = 'preview-close';
  close.type = 'button';
  close.textContent = '✕ Close';
  close.addEventListener('click', closePreview);

  bar.append(title, close);

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.title = `Preview of ${artifact.name}`;
  // The sandbox is the whole security story for the parent: scripts inside
  // may run, but the page can never reach this document or navigate it.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = artifact.previewUrl || `/api/artifacts/${artifact.id}/preview/`;

  overlay.append(bar, frame);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePreview();
  });
  document.body.append(overlay);
  document.addEventListener('keydown', previewEscape);
}

function previewEscape(event) {
  if (event.key === 'Escape') closePreview();
}

function closePreview() {
  const overlay = document.getElementById('preview-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', previewEscape);
}

/* ------------------------------------------------------- outputs panel -- */

/**
 * Claude-style slide-over: a run's outputs (files, live website preview,
 * plan, verification proof) open from the right edge instead of cramped
 * inline cards. Sections appear only when the run has that content. The
 * operator opens it — it never auto-opens.
 */
let panel = createPanelState();
let panelData = null; // { run, artifacts } for the run the panel shows
let panelVisible = []; // section ids with content, in tab order
let panelPreviewId = null; // which previewable artifact the Preview tab shows

async function openOutputs(runId) {
  if (!runId) return;
  panel = openPanelState(panel, runId);
  panelData = null;
  panelVisible = [];
  panelPreviewId = null;

  el.panel.classList.add('open');
  el.panel.setAttribute('aria-hidden', 'false');
  el.panelBackdrop.hidden = false;
  requestAnimationFrame(() => el.panelBackdrop.classList.add('show'));
  document.addEventListener('keydown', panelEscape);
  el.panelTabs.hidden = true;
  el.panelTabs.innerHTML = '';
  el.panelBody.innerHTML = '<p class="empty-note">Loading…</p>';
  el.panelClose.focus();

  try {
    const [runRes, artRes] = await Promise.all([
      api(`/api/runs/${runId}`),
      api(`/api/runs/${runId}/artifacts`),
    ]);
    // A newer open() may have started while these fetched; drop the stale one.
    if (!panel.open || panel.runId !== runId) return;
    panelData = {
      run: runRes.run,
      artifacts: Array.isArray(artRes.artifacts) ? artRes.artifacts : [],
    };
    panelVisible = visibleSections({
      artifacts: panelData.artifacts,
      plan: panelData.run?.plan,
      verification: panelData.run?.verification,
    });
    panel = { ...panel, section: defaultSection(panelVisible) };
    renderPanelTabs();
    renderPanelBody();
  } catch {
    if (!panel.open || panel.runId !== runId) return;
    el.panelBody.innerHTML = '<p class="empty-note">Could not load this run.</p>';
  }
}

function closeOutputs() {
  panel = closePanelState(panel);
  el.panel.classList.remove('open');
  el.panel.setAttribute('aria-hidden', 'true');
  el.panelBackdrop.classList.remove('show');
  setTimeout(() => { el.panelBackdrop.hidden = true; }, 240);
  document.removeEventListener('keydown', panelEscape);
}

function panelEscape(event) {
  if (event.key === 'Escape') closeOutputs();
}

function renderPanelTabs() {
  el.panelTabs.innerHTML = '';
  el.panelTabs.hidden = panelVisible.length === 0;
  for (const id of panelVisible) {
    const def = PANEL_SECTIONS.find((s) => s.id === id);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'panel-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(panel.section === id));
    tab.textContent = def ? def.label : id;
    tab.addEventListener('click', () => {
      panel = selectPanelSection(panel, id);
      renderPanelTabs();
      renderPanelBody();
    });
    el.panelTabs.append(tab);
  }
}

function renderPanelBody() {
  const body = el.panelBody;
  body.innerHTML = '';
  if (!panelData) return;
  switch (panel.section) {
    case 'files':
      renderPanelFiles(body, panelData.artifacts);
      break;
    case 'preview':
      renderPanelPreview(body, panelData.artifacts);
      break;
    case 'plan':
      renderPanelPlan(body, panelData.run?.plan);
      break;
    case 'proof':
      renderPanelProof(body, panelData.run?.verification);
      break;
    default:
      body.innerHTML = '<p class="empty-note">This run produced no files, plan, or checks.</p>';
  }
}

function renderPanelFiles(body, artifacts) {
  for (const artifact of artifacts) {
    const row = document.createElement('div');
    row.className = 'panel-file';
    const name = document.createElement('span');
    name.className = 'panel-file-name';
    name.textContent = artifact.name;
    name.title = artifact.name;
    const size = document.createElement('span');
    size.className = 'panel-file-size';
    size.textContent = artifact.size ? formatBytes(artifact.size) : '';
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'msg-btn';
    dl.textContent = 'Download';
    dl.addEventListener('click', () => downloadArtifact(artifact, dl));
    row.append(name, size, dl);
    if (artifact.previewable) {
      const pv = document.createElement('button');
      pv.type = 'button';
      pv.className = 'msg-btn';
      pv.textContent = 'Preview';
      pv.addEventListener('click', () => {
        panelPreviewId = artifact.id;
        panel = selectPanelSection(panel, 'preview');
        renderPanelTabs();
        renderPanelBody();
      });
      row.append(pv);
    }
    body.append(row);
  }
}

function renderPanelPreview(body, artifacts) {
  const previewable = artifacts.filter((a) => a && a.previewable);
  if (previewable.length === 0) {
    body.innerHTML = '<p class="empty-note">No previewable website in this run.</p>';
    return;
  }
  if (!previewable.some((a) => a.id === panelPreviewId)) panelPreviewId = previewable[0].id;
  if (previewable.length > 1) {
    const pick = document.createElement('div');
    pick.className = 'panel-preview-pick';
    for (const a of previewable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-btn';
      b.textContent = a.name;
      b.disabled = a.id === panelPreviewId;
      b.addEventListener('click', () => {
        panelPreviewId = a.id;
        renderPanelBody();
      });
      pick.append(b);
    }
    body.append(pick);
  }
  const current = previewable.find((a) => a.id === panelPreviewId) ?? previewable[0];
  const frame = document.createElement('iframe');
  frame.className = 'panel-frame';
  frame.title = `Preview of ${current.name}`;
  // Same sandbox story as the fullscreen preview: scripts inside may run,
  // but the page can never reach this document or navigate it.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = current.previewUrl || `/api/artifacts/${current.id}/preview/`;
  body.append(frame);
}

function renderPanelPlan(body, plan) {
  const steps = Array.isArray(plan) ? plan : [];
  if (steps.length === 0) {
    body.innerHTML = '<p class="empty-note">No plan was recorded for this run.</p>';
    return;
  }
  for (const step of steps) {
    const row = document.createElement('div');
    row.className = 'panel-plan-row';
    const num = document.createElement('span');
    num.className = 'panel-plan-num';
    num.textContent = `${step.index ?? '·'}/${step.total ?? '·'}`;
    const label = document.createElement('span');
    label.textContent = String(step.label ?? '');
    row.append(num, label);
    body.append(row);
  }
}

function renderPanelProof(body, verification) {
  const checks = Array.isArray(verification) ? verification : [];
  if (checks.length === 0) {
    body.innerHTML = '<p class="empty-note">No checks were recorded for this run.</p>';
    return;
  }
  for (const check of checks) {
    const passed = check && check.passed === true;
    const row = document.createElement('div');
    row.className = 'panel-proof-row';
    const mark = document.createElement('span');
    mark.className = 'panel-proof-mark ' + (passed ? 'pass' : 'fail');
    mark.textContent = passed ? '✓' : '✗';
    const name = document.createElement('span');
    name.className = 'panel-proof-name';
    name.textContent = String(check && check.name ? check.name : 'check');
    const evidence = document.createElement('span');
    evidence.className = 'panel-proof-evidence';
    evidence.textContent = String(check && check.evidence ? check.evidence : '');
    row.append(mark, name, evidence);
    body.append(row);
  }
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
    auth_failed: 'The API key was rejected. Check the key in Settings or on Render.',
    agent_unavailable: 'That agent id no longer exists — Google date-stamps them.',
    idle_timeout: 'The agent went quiet, so the task was closed to free the slot.',
    budget_exceeded: "You have used today's runs. It resets at midnight UTC.",
    network_error: 'Lost the connection to the agent.',
    truncated: 'The agent finished without producing an answer.',
    orphaned: 'The server restarted mid-task. Nothing was lost — retry to continue.',
    interrupted: 'The server restarted mid-task. Finished steps are saved — resume to continue where it left off.',
    token_budget: 'Paused: the token budget ran out. Finished steps are saved — resume to continue with a higher budget.',
    verification_failed: 'The agent said it was done, but the checks failed. The failed checks are listed above — retry to run it again.',
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
    'artifact', 'memory.recall', 'plan.milestone',
    'run.plan_ready', 'run.plan_updated', 'run.plan_approved',
    'research.started', 'research.pass', 'verification.checked',
    'google.read',
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

  source.addEventListener('end', async () => {
    source.close();
    if (state.source === source) state.source = null;
    // The stream can end without a terminal event reaching the card — a
    // restart between replay and live, a dropped bus publish. Ask the server
    // for the truth instead of leaving the card spinning forever.
    if (!state.running || state.runId !== runId) return;
    try {
      const { run } = await api(`/api/runs/${runId}`);
      if (run && ['completed', 'failed', 'cancelled', 'paused'].includes(run.status)) {
        handleEvent(card, `run.${run.status}`, {
          errorType: run.errorType,
          errorMessage: run.errorMessage,
        });
      }
    } catch { /* keep waiting; a later refresh will reconcile */ }
  });

  source.addEventListener('error', () => {
    // EventSource reconnects on its own and replays from Last-Event-ID, so a
    // blip is invisible. Only say something if the run is known to be over.
    if (source.readyState === EventSource.CLOSED && state.running) {
      note('Connection lost — reopen to catch up. The task keeps running.');
    }
  });
}

// A backgrounded phone can miss a run's terminal event: the EventSource dies
// (or the OS pauses it) and its reconnect replays from a Last-Event-ID the
// server has already tidied away, leaving an empty timeline. On return to the
// foreground, ask the server for the truth — if the run finished while away,
// refresh the whole conversation instead of resuming the dead position.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.running || !state.runId) return;
  let run = null;
  try {
    ({ run } = await api(`/api/runs/${state.runId}`));
  } catch { return; } // keep the stream; a later event will reconcile
  if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
    closeStream();
    setRunning(false);
    state.runId = null;
    await openConversation(run.conversationId);
  }
});

/* ------------------------------------------------------------- composer -- */

function setRunning(on) {
  state.running = on;
  if (on) stopSpeaking(); // A new answer replaces whatever was being read.
  el.statusDot.hidden = !on;
  el.stop.hidden = !on;
  el.stop.disabled = false;
  el.topbarTitle.textContent = on ? 'Working…' : (state.conversations.find((c) => c.id === state.conversationId)?.title ?? 'WAIS');
  el.send.disabled = on || !el.prompt.value.trim();
}

/* A runaway task blocks every new one (the server answers 409 while one is
   active), so the stop button is part of the core loop, not a nicety. The
   cancelled event arrives on the stream and finishCard() resets the UI. */
el.stop.addEventListener('click', async () => {
  if (!state.runId || !state.running) return;
  el.stop.disabled = true;
  note('Stopping…');
  try {
    await api(`/api/runs/${state.runId}/cancel`, { method: 'POST' });
  } catch (err) {
    note('');
    toast(err.message || 'Could not stop the task.');
    el.stop.disabled = false;
  }
});

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

/* -------------------------------------------------------------- voice -- */
/* Mic input + spoken replies through the browser's free built-in speech
   APIs. No server endpoints, no keys, zero cost. The transcript always lands
   in the composer as editable text — it is never auto-sent. */

let voiceRecognition = null;

function speechRecognitionCtor() {
  const w = /** @type {any} */ (window);
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Speak plain text derived from a markdown answer. Silent when unsupported. */
function speakText(text, onDone) {
  if (!('speechSynthesis' in window)) {
    toast('Spoken replies are not supported in this browser.');
    return;
  }
  stopSpeaking();
  const plain = stripMarkdownForSpeech(text);
  if (!plain) return;
  const utter = new SpeechSynthesisUtterance(plain);
  if (onDone) utter.onend = onDone;
  window.speechSynthesis.speak(utter);
}

function setMicListening(btn, on) {
  btn.classList.toggle('listening', on);
  btn.title = on ? 'Listening… tap to stop' : 'Speak your message';
  btn.setAttribute('aria-label', btn.title);
}

function toggleListening(btn, SR) {
  if (voiceRecognition) {
    voiceRecognition.stop();
    return;
  }
  const rec = new SR();
  rec.interimResults = true;
  rec.onresult = /** @param {any} event */ (event) => {
    const parts = [];
    for (const r of event.results) {
      parts.push({ transcript: (r[0] && r[0].transcript) || '', isFinal: !!r.isFinal });
    }
    el.prompt.value = combineTranscripts(parts);
    el.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rec.onerror = /** @param {any} event */ (event) => {
    toast(recognitionErrorMessage(event && event.error));
  };
  rec.onend = () => {
    voiceRecognition = null;
    setMicListening(btn, false);
  };
  try {
    rec.start();
  } catch {
    toast(recognitionErrorMessage('audio-capture'));
    return;
  }
  voiceRecognition = rec;
  setMicListening(btn, true);
}

function setupVoiceInput() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn sm';
  btn.id = 'btn-mic';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>';
  const SR = speechRecognitionCtor();
  if (!SR) {
    btn.disabled = true;
    btn.title = 'Voice input is not supported in this browser';
    btn.setAttribute('aria-label', btn.title);
  } else {
    btn.title = 'Speak your message';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', () => toggleListening(btn, SR));
  }
  $('btn-attach').after(btn);
}

/** Per-answer Listen/Stop button for assistant messages. */
function speakButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-btn';
  const label = '🔊 Listen';
  btn.textContent = label;
  btn.title = 'Hear this answer spoken';
  btn.addEventListener('click', () => {
    if (btn.dataset.speaking === '1') {
      stopSpeaking();
      btn.dataset.speaking = '';
      btn.textContent = label;
      return;
    }
    document.querySelectorAll('.msg-btn[data-speaking="1"]').forEach((other) => {
      const o = /** @type {HTMLElement} */ (other);
      o.dataset.speaking = '';
      o.textContent = label;
    });
    btn.dataset.speaking = '1';
    btn.textContent = '⏹ Stop';
    speakText(text, () => {
      btn.dataset.speaking = '';
      btn.textContent = label;
    });
  });
  return btn;
}

/* Welcome-screen suggestion chips, built from SUGGESTIONS (web/welcome.js) —
   one source of truth shared with the tests. A tap fills the composer as
   editable text — it is never auto-sent. */
for (const suggestion of SUGGESTIONS) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = suggestion.label;
  chip.addEventListener('click', () => {
    fillComposerFromChip(el.prompt, el.send, suggestionFill(suggestion));
    autoGrow();
    el.prompt.focus();
    el.prompt.setSelectionRange(el.prompt.value.length, el.prompt.value.length);
  });
  el.chips.append(chip);
}

/* Deep research: a time-boxed mode for long investigations. The select and
   the number input sit inside the label, so their clicks must not toggle the
   checkbox — stop them there instead of restructuring the pill. */
el.researchMinutes.addEventListener('click', (event) => event.stopPropagation());
el.researchCustom.addEventListener('click', (event) => event.stopPropagation());

function researchBudgetMinutes() {
  if (!el.researchCheck.checked) return null;
  if (el.researchMinutes.value === 'custom') {
    const n = Math.floor(Number(el.researchCustom.value));
    // The server validates 5–480; clamp here so the note never promises
    // something the server will reject.
    return Number.isFinite(n) ? Math.min(480, Math.max(5, n)) : 30;
  }
  return Number(el.researchMinutes.value) || 15;
}

function refreshResearchPicker() {
  const on = el.researchCheck.checked;
  el.researchMinutes.hidden = !on;
  el.researchCustom.hidden = !on || el.researchMinutes.value !== 'custom';
  if (on) {
    const mins = researchBudgetMinutes();
    el.note.textContent = `Deep research: the agent keeps digging for up to ${mins} minute${mins === 1 ? '' : 's'}.`;
  } else if (!el.pingCheck.checked) {
    el.note.textContent = '';
  }
}

el.researchCheck.addEventListener('change', refreshResearchPicker);
el.researchMinutes.addEventListener('change', refreshResearchPicker);
el.researchCustom.addEventListener('input', refreshResearchPicker);

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = el.prompt.value.trim();
  if (!prompt || state.running) return;
  const notifyWhatsapp = el.pingCheck.checked;
  // Read before the reset below clears the picker.
  const deepResearch = el.researchCheck.checked;
  const budgetMinutes = researchBudgetMinutes();

  // The ping and the research mode are per task, not sticky preferences:
  // reset them with the composer.
  el.pingCheck.checked = false;
  el.researchCheck.checked = false;
  refreshResearchPicker();
  el.note.textContent = '';
  await submitPrompt(prompt, { notifyWhatsapp, deepResearch, budgetMinutes });
});

/* Start one run: the single path for the composer and for branch forks.
   The run is filed under the current branch, so a forked "what if" stays in
   its own branch instead of leaking back into the original thread. */
async function submitPrompt(prompt, { notifyWhatsapp = false, deepResearch = false, budgetMinutes = 15 } = {}) {
  el.prompt.value = '';
  autoGrow();
  el.send.disabled = true;
  showHero(false);
  renderAsk(prompt);
  scrollToEnd(true);

  try {
    const { run, budget } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        conversationId: state.conversationId,
        branchId: state.branchId,
        notifyWhatsapp,
        ...(deepResearch ? { deepResearch: true, researchBudgetMinutes: budgetMinutes } : {}),
      }),
    });
    state.conversationId = run.conversationId;
    if (budget) note(`${budget.remaining} of ${budget.limit} runs left today`);
    if (run.status === 'awaiting_plan') {
      // The mission waits for plan approval — nothing is running yet. The
      // stream replays 'run.plan_ready' and the card renders Approve / Edit.
      note('Plan ready — review it below, then approve to start.');
      attach(run.id, 0);
    } else {
      setRunning(true);
      attach(run.id, 0);
    }
    loadConversations();
    loadBudget();
  } catch (err) {
    // 409 means something is already running. That is a state, not a failure:
    // attach to it instead of showing an error.
    if (err.status === 409 && err.body?.activeRunId) {
      renderNotice('Another task is still running — showing it instead.', false, 'info');
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
}

el.pingCheck.addEventListener('change', () => {
  if (el.pingCheck.checked) {
    el.note.textContent = 'You’ll get a WhatsApp ping when this finishes.';
  } else {
    // The research picker owns the note otherwise.
    refreshResearchPicker();
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

/** The delegated settings listener is bound once per page load (see below). */
let settingsClickBound = false;

async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    renderSettings();
    renderLinkedInCard();
    renderGoogleCard();
    void renderBuildLine();
  } catch { /* the app works without the panel */ }
}

/**
 * The last row of Settings: which build this page is running.
 *
 * The operator spent an afternoon reporting bugs that had been fixed and
 * deployed hours earlier, because the phone was still executing the previous
 * build — and there was nothing on screen that could have told either of us
 * that. Now there is: the commit the server was built from, straight out of
 * /api/status. Rendered last and beside the app's own name, where a version
 * belongs.
 */
async function renderBuildLine() {
  document.getElementById('build-line')?.remove();
  let status;
  try {
    status = await api('/api/status');
  } catch {
    return;
  }
  const line = document.createElement('p');
  line.className = 'build-line';
  line.id = 'build-line';
  const commit = typeof status.commit === 'string' && status.commit !== 'unknown'
    ? status.commit
    : null;
  line.textContent = commit
    ? `WAIS · build ${commit}`
    : 'WAIS · development build';
  el.settingsBody.append(line);
}

/* The LinkedIn connection card in Settings. Plain language, because the
   OAuth dance has one hard step the operator must do by hand: create the
   LinkedIn developer app and paste the two keys below (they appear as
   regular secret rows). The redirect URL printed here must be registered
   in the app byte-for-byte. */
async function renderLinkedInCard() {
  const host = document.getElementById('linkedin-card');
  if (host) host.remove();
  let status;
  try {
    status = await api('/api/linkedin/status');
  } catch { return; }
  const card = document.createElement('div');
  card.className = 'secret';
  card.id = 'linkedin-card';

  let stateText = 'not connected';
  let stateClass = 'bad';
  if (!status.clientConfigured) {
    stateText = 'add your app keys below first';
  } else if (status.connected && !status.expired) {
    stateText = `connected as ${status.memberName || 'you'}`;
    stateClass = 'ok';
  } else if (status.expired) {
    stateText = 'connection expired — reconnect';
  }

  const expiryNote = status.connected && status.expiresAt
    ? `<p class="setting-note">Token expires ${new Date(status.expiresAt).toLocaleDateString()} — LinkedIn tokens last about 60 days and cannot auto-refresh, so you will tap Connect again then.</p>`
    : '';
  const appNote = status.clientConfigured
    ? ''
    : `<p class="setting-note">One-time setup (about 15 minutes, only you can do it): create a free app at <b>linkedin.com/developers/apps</b>, enable <b>Share on LinkedIn</b> and <b>Sign In with LinkedIn using OpenID Connect</b>, register this redirect URL exactly:<br><code>${escapeHtml(status.callbackUrl || '')}</code><br>then paste the Client ID and Client Secret into the two secret rows below.</p>`;

  card.innerHTML = `
    <div class="secret-main">
      <span class="secret-name">LinkedIn</span>
      <span class="secret-state ${stateClass}">${escapeHtml(stateText)}</span>
    </div>
    <div class="secret-actions">
      ${status.clientConfigured && !(status.connected && !status.expired)
        ? '<button class="primary" data-li="connect">Connect LinkedIn</button>' : ''}
      ${status.connected ? '<button data-li="refresh">Refresh</button><button class="danger" data-li="disconnect">Disconnect</button>' : ''}
    </div>
    ${expiryNote}${appNote}`;
  el.settingsBody.append(card);

  card.addEventListener('click', async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = /** @type {HTMLButtonElement | null} */ (target.closest('[data-li]'));
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.dataset.li === 'connect') {
        const { url } = await api('/api/linkedin/authorize');
        window.open(url, '_blank', 'noopener');
        toast('Finish the LinkedIn login in the new tab, then tap Refresh.');
      } else if (btn.dataset.li === 'disconnect') {
        await api('/api/linkedin/disconnect', { method: 'POST' });
        toast('LinkedIn disconnected.');
      }
      await renderLinkedInCard();
    } catch (err) {
      toast(err.body?.message || err.message || 'LinkedIn action failed.');
      btn.disabled = false;
    }
  });
}

/* The Google connection card in Settings (Gmail + Calendar, read-only).
   Plain language, because the OAuth dance has one hard step the operator
   must do by hand: create the Google Cloud OAuth client and paste the two
   keys below (they appear as regular secret rows). The redirect URL printed
   here must be registered in the client byte-for-byte. Google's refresh
   tokens keep this connected indefinitely — reconnect only if access is
   revoked at Google. */
async function renderGoogleCard() {
  const host = document.getElementById('google-card');
  if (host) host.remove();
  let status;
  try {
    status = await api('/api/google/status');
  } catch { return; }
  const card = document.createElement('div');
  card.className = 'secret';
  card.id = 'google-card';

  let stateText = 'not connected';
  let stateClass = 'bad';
  if (!status.clientConfigured) {
    stateText = 'add your app keys below first';
  } else if (status.connected) {
    stateText = `connected as ${status.memberEmail || 'you'}`;
    stateClass = 'ok';
  }

  const appNote = status.clientConfigured
    ? ''
    : `<p class="setting-note">One-time setup (about 15 minutes, only you can do it): at <b>console.cloud.google.com</b> create a project, enable the <b>Gmail API</b> and the <b>Google Calendar API</b>, then create an <b>OAuth client ID</b> (Web application) and register this redirect URL exactly:<br><code>${escapeHtml(status.callbackUrl || '')}</code><br>then paste the Client ID and Client Secret into the two secret rows below. Leave the app in Testing mode with your own Google account as a test user — Google shows an "unverified app" warning you can safely pass for your own account.</p>
       <p class="setting-note">The agent can only <b>read</b> your mail and calendar — it cannot send mail or create events.</p>`;

  card.innerHTML = `
    <div class="secret-main">
      <span class="secret-name">Google (Gmail + Calendar)</span>
      <span class="secret-state ${stateClass}">${escapeHtml(stateText)}</span>
    </div>
    <div class="secret-actions">
      ${status.clientConfigured && !status.connected
        ? '<button class="primary" data-go="connect">Connect Google</button>' : ''}
      ${status.connected ? '<button data-go="refresh">Refresh</button><button class="danger" data-go="disconnect">Disconnect</button>' : ''}
    </div>
    ${appNote}`;
  el.settingsBody.append(card);

  card.addEventListener('click', async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const btn = /** @type {HTMLButtonElement | null} */ (target.closest('[data-go]'));
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.dataset.go === 'connect') {
        const { url } = await api('/api/google/authorize');
        window.open(url, '_blank', 'noopener');
        toast('Finish the Google login in the new tab, then tap Refresh.');
      } else if (btn.dataset.go === 'disconnect') {
        await api('/api/google/disconnect', { method: 'POST' });
        toast('Google disconnected.');
      }
      await renderGoogleCard();
    } catch (err) {
      toast(err.body?.message || err.message || 'Google action failed.');
      btn.disabled = false;
    }
  });
}

function renderSettings() {
  const data = state.settings;
  if (!data) return;

  const rows = data.settings.map((setting) => {
    // Boolean settings render as an on/off toggle; everything else keeps the
    // existing text/number input, and the change listener below already picks
    // up checkboxes because they carry the same .setting-input class.
    const input = typeof setting.value === 'boolean'
      ? `<input class="setting-input setting-toggle" data-setting="${escapeHtml(setting.key)}"
        type="checkbox" ${setting.value ? 'checked' : ''} />`
      : `<input class="setting-input" data-setting="${escapeHtml(setting.key)}"
        type="${typeof setting.value === 'number' ? 'number' : 'text'}"
        value="${escapeHtml(String(setting.value))}" />`;
    return `
    <label class="setting-row">
      <span class="setting-label">
        ${escapeHtml(setting.label)}
        <em>${setting.source === 'stored' ? 'saved here' : `from ${escapeHtml(setting.envVar)}`}</em>
      </span>
      ${input}
    </label>`;
  });

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
          ${secret.name === 'gemini_api_key'
            ? `<button data-act="test" data-name="${escapeHtml(secret.name)}">Test</button>`
            : ''}
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
  // The body element survives every re-render, so the delegated click handler
  // is bound once. Binding it per render stacked identical listeners, which
  // made one tap fire two saves.
  if (!settingsClickBound) {
    settingsClickBound = true;
    el.settingsBody.addEventListener('click', onSettingsClick);
  }
}

async function saveSetting(input) {
  const key = input.dataset.setting;
  const raw = input.type === 'checkbox' ? input.checked : input.value;
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
    if (input.type === 'checkbox') input.checked = input.defaultChecked;
    else input.value = input.defaultValue;
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
  if (button.dataset.act === 'test' && name === 'gemini_api_key') void testGeminiKey(button);
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

/**
 * Test the stored Gemini key against the provider. The server returns the
 * diagnosis only — the key itself never comes back — so the summary shown
 * here is safe to display verbatim.
 */
async function testGeminiKey(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Testing…';
  try {
    const result = await api('/api/settings/verify/gemini-key', { method: 'POST' });
    if (result.ok) {
      toast(`Key works — ${result.key.summary} ${result.agent.summary}`, 9_000);
    } else {
      const failed = result.key.verdict !== 'ok' ? result.key : result.agent;
      toast(`Key test: ${failed ? failed.summary : 'unknown error'}`, 12_000);
    }
  } catch (err) {
    toast(err.message || 'Key test failed.', 9_000);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* -------------------------------------------------------------- scheduled -- */

/* Recurring tasks. The panel is deliberately boring: name, what to do, when,
   where the answer goes. Each 'run the task' fire spends one of the day's
   runs, and a fire that lands while the agent is busy just retries in a few
   minutes. A 'just message me' reminder costs nothing — at the scheduled
   time it only sends a WhatsApp note. */

async function loadScheduled() {
  try {
    const { tasks } = await api('/api/scheduled-tasks');
    state.scheduled = tasks;
    renderScheduled();
  } catch { /* the app works without the panel */ }
}

function describeTask(task) {
  if (task.cadence === 'interval') return `every ${task.intervalMinutes} min`;
  const at = task.timeOfDay || '';
  if (task.cadence === 'daily') return `daily at ${at}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[task.weekday ?? 0]}s at ${at}`;
}

function nextIn(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'due soon';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function renderScheduled() {
  const tasks = state.scheduled;
  if (!tasks) return;
  el.schedules.hidden = false;
  el.schedulesTitle.textContent = tasks.length ? `Scheduled (${tasks.length})` : 'Scheduled';

  const rows = tasks.map((task) => `
    <div class="memory-item">
      <span class="tag">${task.enabled ? 'on' : 'off'}</span>
      <b>${escapeHtml(task.name)}</b> — ${escapeHtml(describeTask(task))}
      → ${task.kind === 'message' ? 'WhatsApp message 💬' : task.deliver === 'whatsapp' ? 'WhatsApp' : 'here'}
      <span class="memory-note">${task.enabled ? `next ${nextIn(task.nextRunAt)}` : 'paused'}${task.lastRunAt ? ` · last ${relativeTime(task.lastRunAt)}` : ''}</span>
      <span class="secret-actions">
        <button data-sch-act="toggle" data-id="${escapeHtml(task.id)}">${task.enabled ? 'Pause' : 'Resume'}</button>
        <button class="danger" data-sch-act="delete" data-id="${escapeHtml(task.id)}">Delete</button>
      </span>
    </div>`);

  el.schedulesBody.innerHTML = `
    <form id="sch-new" class="setting-note">
      <input class="setting-input" id="sch-name" maxlength="80" placeholder="Name — e.g. Morning news" />
      <textarea class="setting-input" id="sch-prompt" maxlength="2000" rows="2"
        placeholder="What should the agent do each time?"></textarea>
      <div class="secret-actions" style="margin:6px 0">
        <select class="setting-input" id="sch-cadence">
          <option value="daily">Daily at…</option>
          <option value="interval">Every…</option>
          <option value="weekly">Weekly on…</option>
        </select>
        <input class="setting-input" id="sch-interval" type="number" min="5" max="10080" value="60"
          title="minutes" hidden />
        <input class="setting-input" id="sch-time" type="time" value="09:00" />
        <select class="setting-input" id="sch-weekday" hidden>
          <option value="1">Monday</option><option value="2">Tuesday</option>
          <option value="3">Wednesday</option><option value="4">Thursday</option>
          <option value="5">Friday</option><option value="6">Saturday</option>
          <option value="0">Sunday</option>
        </select>
        <select class="setting-input" id="sch-deliver" title="Where the answer goes">
          <option value="web">Answer here</option>
          <option value="whatsapp">Send to WhatsApp</option>
        </select>
        <select class="setting-input" id="sch-kind" title="What happens at the scheduled time">
          <option value="task">Run the task</option>
          <option value="message">Just message me</option>
        </select>
      </div>
      <button class="primary" type="submit">Schedule it</button>
    </form>
    ${rows.join('') || '<p class="memory-note">Nothing scheduled yet.</p>'}`;

  const cadence = el.schedulesBody.querySelector('#sch-cadence');
  const interval = el.schedulesBody.querySelector('#sch-interval');
  const time = el.schedulesBody.querySelector('#sch-time');
  const weekday = el.schedulesBody.querySelector('#sch-weekday');
  const syncFields = () => {
    interval.hidden = cadence.value !== 'interval';
    time.hidden = cadence.value === 'interval';
    weekday.hidden = cadence.value !== 'weekly';
  };
  cadence.addEventListener('change', syncFields);

  el.schedulesBody.querySelector('#sch-new').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = el.schedulesBody.querySelector('#sch-name').value.trim();
    const prompt = el.schedulesBody.querySelector('#sch-prompt').value.trim();
    if (!name || !prompt) {
      toast('Give it a name and tell it what to do.');
      return;
    }
    const kind = el.schedulesBody.querySelector('#sch-kind').value;
    const body = {
      name,
      prompt,
      cadence: cadence.value,
      deliver: el.schedulesBody.querySelector('#sch-deliver').value,
      kind,
    };
    if (cadence.value === 'interval') body.intervalMinutes = Number(interval.value);
    else body.timeOfDay = time.value;
    if (cadence.value === 'weekly') body.weekday = Number(weekday.value);
    try {
      const created = await api('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify(body) });
      toast(
        kind === 'message'
          ? `Reminder set — first message ${nextIn(created.task.nextRunAt)}.`
          : `Scheduled — first run ${nextIn(created.task.nextRunAt)}.`,
      );
      await loadScheduled();
    } catch (err) {
      toast(err.message || 'Could not schedule that.');
    }
  });

  // Bound once: renderScheduled re-runs on every change, and a second binding
  // would fire pause and delete twice.
  if (!el.schedulesBody.dataset.bound) {
    el.schedulesBody.dataset.bound = '1';
    el.schedulesBody.addEventListener('click', onScheduledClick);
  }
}

async function onScheduledClick(event) {
  const button = event.target.closest('button[data-sch-act]');
  if (!button) return;
  const { schAct: act, id } = button.dataset;
  button.disabled = true;
  try {
    if (act === 'delete') {
      await api(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Deleted.');
    } else {
      const task = state.scheduled.find((t) => t.id === id);
      await api(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      toast(task.enabled ? 'Paused.' : 'Resumed.');
    }
    await loadScheduled();
  } catch (err) {
    toast(err.message || 'That did not work.');
    button.disabled = false;
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
bindPanel(el.schedulesToggle, el.schedulesBody);

/* Settings is a page of its own, not a drawer section: it is where the keys,
   the WhatsApp link and the account connections live, and a phone user expects
   a page they can come back from. The back arrow and Android's own back gesture
   both land here — the page pushes one history entry when it opens, and the
   popstate below closes it — so nothing about it can trap the user. */
let settingsOnHistory = false;

function openSettings() {
  closeDrawer();
  void loadSettings();
  el.app.hidden = true;
  el.settingsScreen.hidden = false;
  el.settingsScreen.scrollTop = 0;
  if (!settingsOnHistory) {
    settingsOnHistory = true;
    history.pushState({ wais: 'settings' }, '');
  }
  requestAnimationFrame(() => el.settingsBack.focus());
}

function closeSettings({ fromHistory = false } = {}) {
  if (!settingsOnHistory) return;
  settingsOnHistory = false;
  el.settingsScreen.hidden = true;
  el.app.hidden = false;
  if (!fromHistory) history.back();
}

el.settingsOpen.addEventListener('click', openSettings);
el.settingsBack.addEventListener('click', () => closeSettings());
window.addEventListener('popstate', () => closeSettings({ fromHistory: true }));
$('btn-close-drawer').addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

/* Outputs panel: close button and backdrop tap. Esc is bound while open. */
el.panelClose.addEventListener('click', closeOutputs);
el.panelBackdrop.addEventListener('click', closeOutputs);

function newTask() {
  closeDrawer();
  closeStream();
  state.conversationId = null;
  state.branchId = null;
  state.runId = null;
  setRunning(false);
  renderThread([]);
  el.branchBar.hidden = true;
  showHero(true);
  el.topbarTitle.textContent = 'WAIS';
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
 * A deliberately small markdown subset: headings, lists, tables, fences,
 * inline code and emphasis. It escapes first, so model output can never inject
 * markup into the page — the cost of a full markdown library is not worth its
 * attack surface here.
 */

/* Tables: a run of `| cell |` lines whose second line is a separator row
   (`| --- | --- |`) renders as a real table instead of raw pipe text. */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isSeparatorRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every((c) => /-/.test(c) && /^[\s:|-]+$/.test(c));
}
function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
}
function renderTable(rows) {
  const head = tableCells(rows[0]).map((c) => `<th>${c}</th>`).join('');
  const body = rows.slice(2)
    .map((r) => `<tr>${tableCells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* Renders the lines of one block: table runs become <table>, everything else
   keeps the list/paragraph handling. */
function renderBlockLines(lines) {
  let html = '';
  let text = [];
  const flushText = () => {
    if (!text.length) return;
    if (text.every((l) => /^\s*[-*+]\s+/.test(l))) {
      html += `<ul>${text.map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
    } else if (text.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      html += `<ol>${text.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    } else {
      html += `<p>${inline(text.join('\n')).replace(/\n/g, '<br />')}</p>`;
    }
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i]) && isTableRow(lines[i + 1] || '') && isSeparatorRow(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      flushText();
      html += renderTable(lines.slice(i, j));
      i = j - 1;
    } else {
      text.push(lines[i]);
    }
  }
  flushText();
  return html;
}

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
      html += renderBlockLines(lines);
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

/* ----------------------------------------------------------------- theme -- */

/* Light / dark / system. The choice persists on this device; "system" follows
   the OS. The attribute is set on <html> as data-theme before first paint by
   the inline snippet in index.html — this only owns the toggle and OS
   changes. Zero network cost: everything is local. */
const THEME_KEY = 'codex-theme';
const THEME_ICONS = {
  light:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
  dark:
    '<svg viewBox="0 0 24 24"><path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/></svg>',
  system:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>',
};

function themePreference() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(pref) {
  const dark =
    pref === 'dark' ||
    (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#201e1b' : '#f5f3ef');
  const btn = $('btn-theme');
  if (btn) {
    btn.setAttribute('aria-label', `Theme: ${pref} — tap to change`);
    btn.innerHTML = THEME_ICONS[pref] || THEME_ICONS.system;
  }
}

function initTheme() {
  applyTheme(themePreference());
  const btn = $('btn-theme');
  if (btn) {
    btn.addEventListener('click', () => {
      const order = ['light', 'dark', 'system'];
      const next = order[(order.indexOf(themePreference()) + 1) % order.length];
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode: apply for this session only */
      }
      applyTheme(next);
    });
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (themePreference() === 'system') applyTheme('system');
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
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
  initTheme();
  setupVoiceInput();
  try {
    await api('/api/auth/session');
    await enter();
  } catch {
    showLogin();
  }
})();

window.addEventListener('pagehide', closeStream);
