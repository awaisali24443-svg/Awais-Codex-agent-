import { stripMarkdownForSpeech, combineTranscripts, recognitionErrorMessage } from './voice.js';
import { artifactKind, artifactMeta, markDead, sourcesFromText, sourcesSummary } from './records.js';
import { RESUME_ACTIONS, RUNNING_ACTIONS, SHORTCUT_GROUPS, buildResults, flatten, moveSelection, selectionAfter } from './palette.js';
import { SUGGESTIONS, suggestionFill, fillComposerFromChip } from './welcome.js';
import {
  statusForStep,
  nodeIconForStatus,
  hasExpandableDetail,
  formatStepTime,
  stripMilestones,
} from './timeline.js';
import {
  PANEL_DOCK_MIN_WIDTH,
  PANEL_SECTIONS,
  visibleSections,
  defaultSection,
  createPanelState,
  openPanelState,
  closePanelState,
  panelPlacement,
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
  drawerSearch: $('drawer-search'),
  screenApp: $('screen-app'),
  palette: $('palette'),
  paletteBackdrop: $('palette-backdrop'),
  paletteInput: $('palette-input'),
  paletteList: $('palette-list'),
  paletteClose: $('palette-close'),
  paletteButton: $('btn-search'),
  keysSheet: $('keys-sheet'),
  keysBackdrop: $('keys-backdrop'),
  keysList: $('keys-list'),
  keysClose: $('keys-close'),
  jump: $('jump-latest'),
  jumpLabel: $('jump-label'),
  budget: $('budget'),
  memory: $('memory'),
  memoryTitle: $('memory-title'),
  memoryBody: $('memory-body'),
  memoryToggle: $('memory-toggle'),
  settingsBody: $('settings-body'),
  settingsSearch: $('settings-search'),
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
  researchCheck: $('research-check'),
  researchMinutes: $('research-minutes'),
  researchCustom: $('research-custom'),
  researchDetail: $('research-detail'),
  researchCustomWrap: $('research-custom-wrap'),
  /** Bound when voice input is set up: null in a browser without the API. */
  mic: /** @type {HTMLButtonElement | null} */ (null),

  attach: $('btn-attach'),
  attachments: $('attachments'),
  fileInput: $('file-input'),
  modeChip: $('btn-mode'),
  modeLabel: $('mode-label'),
  modeTray: $('composer-tray'),
  modeClose: $('mode-close'),
  modeStandard: $('mode-standard'),
  modeResearch: $('mode-research'),
};

const state = {
  conversationId: null,
  branchId: null,
  runId: null,
  // Which chat the live run belongs to. The header says "Working…" while a run
  // is in flight, and the operator is free to open another chat to read
  // something while it works — knowing whose run this is keeps the two linked.
  runConversationId: null,
  // Set when a run finishes while the operator is reading further up, cleared
  // when they come back down. It is what turns the jump pill into news
  // ("New answer") instead of a position ("Jump to latest").
  freshAnswer: false,
  // 'running' | 'awaiting_plan' | 'finished' — the client's own view of the run
  // the header is reporting on.
  runStatus: null,
  source: null,
  running: false,
  conversations: [],
  budget: null,
  memory: null,
  settings: null,
  /** What the Settings search box is filtering by ('' when it is empty). */
  settingsQuery: '',
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

/**
 * Run a screen change as a transition when the browser can, and as a plain
 * change when it cannot. The View Transitions API is progressive on purpose:
 * an older browser gets the same screens with no animation, and a reader who
 * asked for reduced motion gets no animation either — the CSS switch in
 * theme.css turns the pseudo-elements off.
 */
function switchScreen(change) {
  const doc = /** @type {Document & { startViewTransition?: (cb: () => void) => unknown }} */ (document);
  if (typeof doc.startViewTransition === 'function' &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    doc.startViewTransition(change);
    return;
  }
  change();
}

function showLogin() {
  closeStream();
  switchScreen(() => {
    el.app.hidden = true;
    el.settingsScreen.hidden = true;
    el.login.hidden = false;
  });
  el.loginKey.value = '';
  setTimeout(() => el.loginKey.focus(), 60);
}

function showApp() {
  switchScreen(() => {
    el.login.hidden = true;
    el.settingsScreen.hidden = true;
    el.app.hidden = false;
  });
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

/* The statuses that mean a run is over. One list, because two copies drifted:
   the stream-end check learned about 'paused' and the foreground-return check
   did not, so a run that paused while the phone was backgrounded left the app
   saying "Working…" with a live stream that could never speak again. */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'paused'];

/* A run the operator can still watch or act on: either working, or waiting for
   a plan to be approved. Anything else is over, and its answer is on the
   thread already — so opening the chat it belongs to must not replay it. */
/* 'planning' is a live status too: the task exists, a card can show it, and the
   plan is being written. Leaving it out is how a task being planned looked
   exactly like no task at all after a reload. */
const LIVE_RUN_STATUSES = ['planning', 'running', 'awaiting_plan'];

/* The server caps an edited plan at 20 steps; the editor shows the same number
   rather than discovering the cap on Save. */
const MAX_PLAN_STEPS = 20;
function liveRun() {
  return !!state.runId && LIVE_RUN_STATUSES.includes(state.runStatus);
}

/* ----------------------------------------------------------------- boot -- */

async function enter() {
  showApp();
  renderThread([]);

  // The free tier sleeps when idle, and a cold start takes the better part of a
  // minute. Silence for that long reads as "the app is broken", so after a few
  // seconds the composer note says what is actually happening — and it says it
  // once, because the answer is the same every time it happens.
  const BOOT_NOTICE_MS = 4_000;
  let noticeShown = false;
  const bootNotice = setTimeout(() => {
    noticeShown = true;
    note('Waking the server — it sleeps when idle, so this can take up to a minute.');
  }, BOOT_NOTICE_MS);
  try {
    await Promise.allSettled([loadConversations(), loadBudget(), loadMemory(), loadSettings(), loadScheduled()]);
  } finally {
    clearTimeout(bootNotice);
    // Only the notice this timer put there is cleared: whatever the app said in
    // the meantime ("12 of 100 runs left today") is not this code's to remove.
    if (noticeShown) note('');
  }

  if (await ensureLiveRun()) return;

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
    // The drawer's search box is the one filter that has to reach past the
    // fifty rows the list is capped at, so it asks the server.
    const q = el.drawerSearch.value.trim();
    const { conversations } = await api(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    state.conversations = conversations;
    renderConversations();
  } catch { /* silent */ }
}

/**
 * The drawer's list.
 *
 * A row is how a task is recognised a week later, so it carries three things:
 * what it was called, the last thing said in it, and when that was. The old row
 * showed a title and a run count, which is a database row, not a memory.
 */
function renderConversations() {
  el.convos.innerHTML = '';
  const searching = el.drawerSearch.value.trim().length > 0;
  if (!state.conversations.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = searching ? 'Nothing matches that.' : 'No tasks yet.';
    el.convos.append(p);
    return;
  }

  let group = null;
  for (const convo of state.conversations) {
    // Grouped by day, the way every inbox does it: Today, Yesterday, then
    // everything else under one heading.
    const when = dayLabel(convo.updatedAt);
    if (when !== group) {
      group = when;
      const head = document.createElement('p');
      head.className = 'convo-group';
      head.textContent = when;
      el.convos.append(head);
    }

    const button = document.createElement('button');
    button.className = 'convo' + (convo.id === state.conversationId ? ' on' : '');

    const title = document.createElement('span');
    title.className = 'convo-title';
    title.textContent = convo.title;

    const meta = document.createElement('span');
    meta.className = 'convo-preview';
    const preview = convo.preview ?? `${convo.runCount} run${convo.runCount === 1 ? '' : 's'}`;
    meta.textContent = preview;

    const date = document.createElement('span');
    date.className = 'convo-date';
    date.textContent = relativeTime(convo.updatedAt);

    const body = document.createElement('span');
    body.className = 'convo-body';
    body.append(title, meta);

    button.append(body, date);
    button.addEventListener('click', () => {
      closeDrawer();
      openConversation(convo.id);
    });
    el.convos.append(button);
  }
}

/** "Today" / "Yesterday" / "Earlier" for the group headings. */
function dayLabel(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Earlier';
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (then >= midnight) return 'Today';
  if (then >= new Date(midnight.getTime() - 86_400_000)) return 'Yesterday';
  return 'Earlier';
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
  let ownsLiveRun = false;
  /** @type {Array<any>} */
  let messages = [];
  try {
    ({ messages } = await api(`/api/conversations/${id}/messages${qs}`));
    for (const message of messages) {
      // The question that started the live run is written down the moment the
      // run exists (the answer is not, until the run closes), so its runId is
      // how a thread knows the streaming card belongs to it.
      if (message.runId && message.runId === state.runId) ownsLiveRun = true;
      const node = message.role === 'user' ? renderAsk(message.content) : renderAnswer(message.content);
      // A reopened conversation shows the same sources the live one did; they
      // are in the stored answer, so nothing has to be fetched for them.
      if (message.role === 'assistant') {
        const slot = document.createElement('div');
        slot.className = 'sources-slot';
        node.append(slot);
        renderSources({ answerText: message.content, answerTail: '', sources: slot, deadSources: [], sourcesChecked: 0 });
        // What it cost, from the run the answer came from — the same line the
        // live card showed, so reopening an answer does not lose it.
        usageLine(node, message.usage ?? null, undefined, true);
      }
      attachMessageActions(node, message, draftByRun.get(message.runId));
    }
  } catch { /* silent */ }

  // Opening a chat is what removes the live card from the page — it is a DOM
  // node in the thread that just got replaced. So coming back has to put it
  // back: without this the operator returns to their finished question, no
  // answer arriving, no spinner, "Working…" in the header, and a locked
  // composer. The task looked lost while it was still running.
  // A conversation whose own messages say a run is still going gets that run
  // back, with no extra request and no dependence on `state.runId` — which after
  // a reload is null, and used to be the only thing this check looked at.
  const liveMessage = messages.find((m) => m.runId && LIVE_RUN_STATUSES.includes(m.runStatus));
  if (liveRun()) {
    if (ownsLiveRun) attach(state.runId, 0);
    else renderLiveRunElsewhere();
  } else if (liveMessage && !(await ensureLiveRun({ announce: false }))) {
    // The server no longer has it running (it finished, or the process that
    // owned it is gone): replay that run's own stream so the thread catches up
    // to whatever it actually became, instead of showing a question forever.
    attachLiveRun({ id: liveMessage.runId, conversationId: id, prompt: '' });
  }

  renderConversations();
  scrollToEnd(true);
}

/* "Working…" belongs to a run, not to the chat on screen. When those are two
   different chats, say so and offer the way back to the card. */
function renderLiveRunElsewhere() {
  const owner = state.conversations.find((c) => c.id === state.runConversationId);
  const where = owner ? `in "${owner.title}"` : 'in another chat';
  const what = state.runStatus === 'awaiting_plan' ? 'is waiting for your approval' : 'is still running';
  const notice = renderNotice(`A task ${where} ${what}.`, false, 'info');
  if (!owner) return;
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'retry-btn';
  show.textContent = 'Show it';
  show.addEventListener('click', () => openConversation(owner.id));
  notice.append(show);
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
  artifactChips.clear(); // the chips just left the DOM with the old thread
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
  node.innerHTML = answerHead() + markdown(text);
  el.thread.append(node);
  scrollToEnd();
  return node;
}

/**
 * The mark over an assistant turn. One small badge and the name — the same
 * thing every chat app does — so a thread scrolled back to the middle still
 * says who is speaking without a name on every line.
 */
function answerHead() {
  return `<div class="answer-head">
    <svg class="mark" viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="26" fill="#1c1a2c"/>
      <path d="M22.5 43 35.5 74.5 50 52.5 64.5 74.5 77.5 43" fill="none" stroke="#f6f2ea"
            stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="who">WAIS</span>
  </div>`;
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

/* The live card showing this run, if the thread already has one. */
function cardFor(runId) {
  if (!runId) return null;
  return el.thread.querySelector(`.run[data-run-id="${runId}"]`);
}

/**
 * Rebuild the card handle for a card that is already in the thread.
 *
 * attach() needs the same little object either way — the spinner, the steps
 * container, the answer, the files row. Rebuilding it from the DOM keeps a
 * re-attach from drawing a duplicate card, which is the whole point.
 */
function existingCard(runId) {
  const card = cardFor(runId);
  if (!card) return createRunCard(runId);
  const thinking = card.querySelector('.thinking');
  // A card being reused is being replayed from the start: the previous run's
  // fold-out summary goes, and the work unfolds with it.
  card.querySelector('.run-summary')?.remove();
  card.classList.remove('work-collapsed');
  thinking.open = true;
  stopRunClock({ card });
  return {
    card,
    files: card.querySelector('.files'),
    sources: card.querySelector('.sources-slot'),
    deadSources: [],
    sourcesChecked: 0,
    runId,
    plan: card.querySelector('.plan'),
    planIndex: new Map(),
    thinking,
    thinkingBody: thinking.querySelector('.thinking-body'),
    thinkingMeta: thinking.querySelector('.meta'),
    thinkingLabel: thinking.querySelector('.label'),
    thinkingClock: thinking.querySelector('.clock'),
    spinner: thinking.querySelector('.spinner'),
    steps: card.querySelector('.steps'),
    // A card being reused is being replayed from the start, so its accumulated
    // buffers are reset with it — otherwise the replayed thinking and answer
    // would be appended to text the card already showed.
    thinkingText: '',
    thinkingTail: '',
    answerText: '',
    answerTail: '',
    stepIndex: new Map(),
    elapsed: null,
    startedAt: Date.now(),
  };
}

/**
 * A small ghost control for a message's action row: an icon, an optional label,
 * and an aria-label so an icon-only button is still a sentence to a screen
 * reader. Everything in these rows goes through here so they cannot drift apart.
 */
function msgButton({ icon, label = '', title = '', aria = '' }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-btn' + (label ? '' : ' icon');
  btn.innerHTML = iconFor(icon) + (label ? `<span></span>` : '');
  if (label) btn.querySelector('span').textContent = label;
  if (title) btn.title = title;
  btn.setAttribute('aria-label', aria || label || title || icon);
  return btn;
}

/**
 * Copy text to the clipboard and say so on the button itself. `navigator.clipboard`
 * needs a secure context, which a phone on a cached shell may not have — the
 * textarea fallback is old, ugly, and the only thing that works there.
 */
async function copyToClipboard(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* fall through to the old way */ }
  if (!ok) {
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.append(scratch);
      scratch.select();
      ok = document.execCommand('copy');
      scratch.remove();
    } catch { ok = false; }
  }
  if (!btn) return ok;
  const was = btn.innerHTML;
  btn.dataset.done = ok ? '1' : '';
  btn.innerHTML = iconFor(ok ? 'check' : 'warn');
  setTimeout(() => { btn.innerHTML = was; btn.dataset.done = ''; }, 1_200);
  if (!ok) toast('Could not copy — select the text instead.');
  return ok;
}

/**
 * The clock in the run header. A task that has been working for two minutes and
 * a task that has been stuck for two minutes look identical otherwise, and the
 * number is also the only honest answer to "how long does this usually take".
 */
function startRunClock(card) {
  stopRunClock(card);
  const tick = () => {
    const seconds = (Date.now() - card.startedAt) / 1000;
    if (card.thinkingClock) card.thinkingClock.textContent = `${seconds.toFixed(0)}s`;
  };
  tick();
  card.timer = setInterval(tick, 1_000);
}

function stopRunClock(card) {
  if (card.timer) clearInterval(card.timer);
  card.timer = null;
  // The drafting clock is part of the same contract: whatever ends the run ends
  // every timer on its card, so a finished task cannot keep ticking in the
  // background of a page that has moved on.
  if (card.planClock) clearInterval(card.planClock);
  card.planClock = null;
}

/**
 * Fold the working away when a run is over.
 *
 * A finished task used to leave its whole timeline open — thinking, every tool
 * call, every milestone — with the answer below it, so the thing the operator
 * asked for was the last thing on the screen and the scroll to reach it grew
 * with every run. Now the working becomes one line ("6 steps · 42.1s") that
 * opens again on a tap. Nothing is deleted; it is folded.
 */
function foldWork(card) {
  if (card.card.querySelector('.run-summary')) return;
  const steps = card.steps.children.length;
  const what = steps === 1 ? '1 step' : `${steps} steps`;
  const line = document.createElement('button');
  line.type = 'button';
  line.className = 'run-summary';
  line.innerHTML = `${iconFor('list')}<span class="what"></span><span class="when"></span>` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  line.querySelector('.what').textContent = steps > 0 ? what : 'The working';
  line.querySelector('.when').textContent = card.elapsed ?? '';
  line.setAttribute('aria-expanded', 'false');
  line.title = 'Show or hide what the task did';
  line.addEventListener('click', () => {
    const collapsed = card.card.classList.toggle('work-collapsed');
    line.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  card.card.classList.add('work-collapsed');
  card.card.insertBefore(line, card.card.firstChild);
  // The reasoning collapses with the timeline; the summary is the handle back.
  if (card.thinking) card.thinking.open = false;
}

/**
 * Make sure a task that is running is on screen.
 *
 * The complaint that started this: "I submitted a task and waited for more than
 * three minutes — no live stream, just a retrying line." The stream was fine.
 * Finding it was not. Three holes, all here:
 *
 *   - the boot recovery asked `/api/runs/active` once, inside a silent `catch`;
 *     one failed request (a cold start, a phone waking, a dropped connection)
 *     and the app decided nothing was running, forever;
 *   - opening the conversation that owns a run re-attached only if `state.runId`
 *     was already set — which after a reload it never is;
 *   - not one of those paths hid the starter cards, so a reload mid-task showed
 *     the hero *and* the live card.
 *
 * So: one function, used from every entry point, which retries once before
 * giving up, says so when even that failed, and always leaves the screen
 * matching the server.
 */
async function ensureLiveRun({ attempts = 2, announce = true } = {}) {
  if (liveRun()) return true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { run } = await api('/api/runs/active');
      if (!run) return false;
      attachLiveRun(run);
      if (announce) toast('A task is still running — showing it live.');
      return true;
    } catch {
      // A sleeping instance refuses the first request of the day; one retry is
      // the difference between "nothing is running" and "I could not ask".
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const notice = renderNotice('Could not check whether a task is running.', false, 'warn');
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'retry-btn';
  again.textContent = 'Check again';
  again.addEventListener('click', () => {
    notice.remove();
    void ensureLiveRun({ announce: false });
  });
  notice.append(again);
  return false;
}

/** Put a run the server says is live on screen, in its own card. */
function attachLiveRun(run) {
  state.conversationId = run.conversationId;
  state.runConversationId = run.conversationId;
  showHero(false);
  // The question is written down the moment a run exists; a recovery that does
  // not find it in the thread draws it, and one that does leaves it alone.
  if (!cardFor(run.id)) renderAsk(run.prompt);
  setRunning(true);
  attach(run.id, 0);
}

/* A run in progress is drawn as one card: thinking, then steps, then answer. */
function createRunCard(runId = null) {
  const card = document.createElement('div');
  card.className = 'run';
  // Which run this card is about, so a recovery can find it again instead of
  // stacking a second card for the same task.
  if (runId) card.dataset.runId = runId;

  const thinking = document.createElement('details');
  thinking.className = 'thinking';
  thinking.open = true;
  thinking.innerHTML = `
    <summary class="thinking-head">
      <span class="spinner"></span>
      <span class="label">Thinking</span>
      <span class="clock"></span>
      <span class="meta"></span>
      <svg class="thinking-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </summary>
    <div class="thinking-body"><p class="thinking-wait"></p></div>`;
  // The panel is open from the first second, and for the first while it has
  // nothing in it — which is what an empty box with a chevron looks like: a
  // bug. It says what is true instead: the request is out, nothing is back yet.
  thinking.querySelector('.thinking-wait').textContent =
    'The request is out. Nothing has come back from the model yet.';

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
  // Filled at the end of the run, from the artifact record rather than from the
  // stream, so a replayed or reopened conversation shows the same files.
  const files = document.createElement('div');
  files.className = 'files';

  // The links the answer cites. Filled by renderSources, which runs when the
  // answer is complete — the strip is a summary, so it does not flicker
  // mid-stream.
  const sources = document.createElement('div');
  sources.className = 'sources-slot';

  // Where the task is looking, *while* it looks. Filled by `sources.seen`
  // events; the block at the end of the answer is a different thing — that one
  // is what the answer cited, and this one is what the task actually opened.
  const rail = document.createElement('div');
  rail.className = 'rail-slot';

  // The steps belong to the thinking, so they live *inside* it: a step drawn
  // outside the panel read as a second, competing box ("Still thinking —
  // retrying the request." with a tick, sitting under the panel that was
  // supposed to contain it). Folding the working away now folds all of it away,
  // which is what the fold is for.
  //
  // The plan stays outside on purpose: it is a decision with an Approve button,
  // and a decision must not be able to hide behind a collapsed panel.
  thinking.append(steps);
  card.append(thinking, plan, rail, answer, sources, files);
  el.thread.append(card);
  startRunClock(card);
  scrollToEnd();

  return {
    card,
    files,
    sources,
    rail,
    seenSources: [],
    runId,
    plan,
    planIndex: new Map(),
    thinking,
    thinkingBody: thinking.querySelector('.thinking-body'),
    thinkingMeta: thinking.querySelector('.meta'),
    thinkingLabel: thinking.querySelector('.label'),
    thinkingClock: thinking.querySelector('.clock'),
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
  // Once there is something to read, the placeholder goes for good.
  card.thinkingBody.querySelector('.thinking-wait')?.remove();
  if (text) {
    // The text node is written only when it changed: replacing it on every
    // token would restart selection and scroll inside the panel.
    const body = card.thinkingBody;
    const existing = body.lastChild;
    if (existing && existing.nodeType === Node.TEXT_NODE) existing.nodeValue = text;
    else body.append(document.createTextNode(text));
  }
  card.thinkingMeta.textContent = card.elapsed ?? (text ? `${Math.round(text.length / 4)} tok` : '');
}

/**
 * The links an answer cites, as a list under it.
 *
 * An answer that says "according to the RBI circular" and does not say where
 * is only trustworthy if you already trust it. The links are in the text — this
 * pulls them out, keeps the order, and shows what the server's link check found
 * (a dead source is a fact about the answer, not something to hide).
 *
 * Rebuilt rather than appended, because the answer streams: the same link may
 * be rewritten three times before the run ends.
 */
function renderSources(card) {
  const text = card.answerText + card.answerTail;
  const sources = markDead(sourcesFromText(text), card.deadSources ?? []);
  if (sources.length === 0) return;

  const box = document.createElement('div');
  box.className = 'sources';

  const head = document.createElement('div');
  head.className = 'sources-head';
  head.innerHTML = iconFor('globe') + '<span class="sources-title"></span><span class="sources-count"></span>';
  head.querySelector('.sources-title').textContent = 'Sources';
  head.querySelector('.sources-count').textContent = sourcesSummary(sources, card.sourcesChecked ?? 0);
  box.append(head);

  const list = document.createElement('div');
  list.className = 'sources-list';
  // On a phone, four is a glance and eleven is a scroll inside a scroll.
  const VISIBLE = 4;
  sources.slice(0, VISIBLE).forEach((source) => list.append(sourceRow(source)));
  box.append(list);

  if (sources.length > VISIBLE) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sources-more';
    more.textContent = `Show ${sources.length - VISIBLE} more`;
    more.addEventListener('click', () => {
      for (const source of sources.slice(VISIBLE)) list.append(sourceRow(source));
      more.remove();
    });
    box.append(more);
  }

  card.sources.replaceChildren(box);
}

/** One cited link: a badge for the domain, the name the answer gave it, the host. */
function sourceRow(source) {
  const row = document.createElement('a');
  row.className = 'source' + (source.dead ? ' dead' : '');
  row.href = source.url;
  row.target = '_blank';
  row.rel = 'noopener noreferrer';
  row.title = source.dead ? `${source.url} — this link did not respond when it was checked` : source.url;

  const badge = document.createElement('span');
  badge.className = 'source-badge';
  badge.textContent = source.badge;

  const body = document.createElement('span');
  body.className = 'source-body';
  const label = document.createElement('span');
  label.className = 'source-label';
  label.textContent = source.label;
  const domain = document.createElement('span');
  domain.className = 'source-domain';
  domain.textContent = source.dead ? `${source.domain} · did not respond` : source.domain;
  body.append(label, domain);

  row.append(badge, body);
  return row;
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
    // After the header, before the next row — and before the Approve / Edit
    // buttons when this is the last row, so the actions stay at the bottom.
    const actions = card.plan.querySelector('.plan-actions');
    const anchor = next !== undefined ? card.planIndex.get(next) : actions;
    card.plan.insertBefore(row, anchor ?? null);
  }

  row.querySelector('.plan-num').textContent = `${index}/${total}`;
  if (data.label) row.querySelector('.plan-label').textContent = String(data.label);
  if (data.done) row.classList.add('done');
  scrollToEnd();
}

/* --------------------------------------------------------- answer cost -- */

/**
 * What the answer cost, in one quiet line under it.
 *
 * Borrowed from the response metadata every model playground prints and no
 * chat app does: tokens in, tokens out, and how long it took. It earns its
 * place here because the operator is on a free tier — a number he can watch
 * while it is still explainable beats a quota warning at the end of the month.
 * Only what is actually known is shown: an engine that reports nothing prints
 * no line, and a live card counts its own seconds while the stored one uses
 * the server's.
 */
function usageLine(node, usage, startedAt, finished = true) {
  if (!node) return;
  node.querySelector?.('.msg-usage')?.remove();
  if (!usage && !startedAt) return;
  const parts = [];
  const seconds =
    typeof usage?.seconds === 'number'
      ? usage.seconds
      : typeof startedAt === 'number' && finished
        ? (Date.now() - startedAt) / 1000
        : null;
  if (typeof seconds === 'number' && seconds > 0) {
    parts.push(seconds >= 90 ? `${(seconds / 60).toFixed(1)} min` : `${seconds.toFixed(1)}s`);
  }
  const tin = typeof usage?.tokensIn === 'number' ? usage.tokensIn : null;
  const tout = typeof usage?.tokensOut === 'number' ? usage.tokensOut : null;
  if (tin !== null || tout !== null) parts.push(`${count(tin)} in · ${count(tout)} out`);
  if (parts.length === 0) return;
  const line = document.createElement('p');
  line.className = 'msg-usage';
  line.textContent = parts.join(' · ');
  node.append(line);
}

/** 1240 -> "1.2k". Token counts are read, not audited. */
function count(value) {
  if (value === null || value === undefined) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/* -------------------------------------------------------- source rail -- */

/** How many rows the rail shows while it is still moving. */
const RAIL_VISIBLE = 2;

function railLabel(entry) {
  if (entry.kind === 'search') return entry.query || '';
  try {
    const url = new URL(entry.url);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return entry.url || '';
  }
}

/**
 * The rail: where this task has looked so far.
 *
 * This is the piece of a long research task the operator most wants and least
 * gets — a task that is browsing looks exactly like a task that is stuck, and
 * the only honest answer to "what is it doing" is the list of places it has
 * actually been. Rows are deduped by the server, bounded there too, and the
 * newest is on top because during a run the newest is the news.
 *
 * The rail is a *picture of the run*, not a citation list: nothing here says
 * the answer used a page. That is what the Sources block under the answer is
 * for, and the two are allowed to disagree.
 */
function renderSourceRail(card) {
  const entries = card.seenSources ?? [];
  if (entries.length === 0) return;
  const sites = entries.filter((e) => e.kind === 'site').length;
  const searches = entries.length - sites;
  const parts = [];
  if (sites) parts.push(sites === 1 ? '1 site' : `${sites} sites`);
  if (searches) parts.push(searches === 1 ? '1 search' : `${searches} searches`);

  const box = document.createElement('div');
  box.className = 'rail' + (card.railCollapsed ? ' collapsed' : '');

  const head = document.createElement('div');
  head.className = 'rail-head';
  head.innerHTML = iconFor('globe') +
    '<span class="rail-title"></span><span class="rail-count"></span>';
  head.querySelector('.rail-title').textContent = card.railCollapsed ? 'Where it looked' : 'Looking at';
  head.querySelector('.rail-count').textContent = parts.join(' · ');

  const list = document.createElement('ol');
  list.className = 'rail-list';
  const rows = card.railExpanded ? entries : entries.slice(0, RAIL_VISIBLE);
  for (const entry of rows.slice().reverse()) list.append(railRow(entry));

  // One control, and it says what it will do: everything except the finished,
  // un-expanded rail is hiding rows, and a finished rail with nothing hidden
  // needs no control at all.
  const hidden = entries.length - rows.length;
  const canCollapse = card.railExpanded && entries.length > RAIL_VISIBLE;
  if (hidden > 0 || canCollapse) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rail-toggle';
    toggle.textContent = card.railExpanded ? 'Show less' : `Show all ${entries.length}`;
    toggle.addEventListener('click', () => {
      card.railExpanded = card.railExpanded ? false : true;
      renderSourceRail(card);
    });
    head.append(toggle);
  }

  box.append(head, list);
  card.rail.replaceChildren(box);
}

/** One place the task has been: a page it opened, or a question it asked. */
function railRow(entry) {
  const row = document.createElement('li');
  row.className = 'rail-row ' + (entry.kind === 'search' ? 'search' : 'site');
  const icon = entry.kind === 'search' ? 'search' : 'globe';
  row.innerHTML = iconFor(icon) + '<span class="rail-text"></span><span class="rail-via"></span>';
  const text = row.querySelector('.rail-text');
  text.textContent = railLabel(entry);
  if (entry.url) row.title = entry.url;
  if (entry.via) row.querySelector('.rail-via').textContent = entry.via;
  return row;
}

/** Called for every `sources.seen` frame; the server has already deduped. */
function addSeenSource(card, data) {
  if (!card.seenSources) card.seenSources = [];
  const entry = {
    kind: data?.kind === 'search' ? 'search' : 'site',
    url: typeof data?.url === 'string' ? data.url : null,
    query: typeof data?.query === 'string' ? data.query : null,
    via: typeof data?.via === 'string' ? data.via : '',
  };
  if (!entry.url && !entry.query) return;
  if (entry.url && card.seenSources.some((existing) => existing.url === entry.url)) return;
  card.seenSources.push(entry);
  renderSourceRail(card);
}

/* ------------------------------------------------------- plan preview -- */

/**
 * The card while the plan is being written.
 *
 * This is the answer to "three minutes with nothing on screen": a complex task
 * spends its first minute drafting a plan, and that minute used to happen before
 * the browser had anything to attach to. The card now appears with the run and
 * says what is going on, the steps land in it as the model names them, and the
 * engine's own heartbeat shows up inside the same panel.
 */
function renderPlanDrafting(card) {
  card.plan.hidden = false;
  card.planIndex.clear();
  card.plan.innerHTML = '';
  card.plan.classList.add('plan-card', 'plan-drafting');

  const head = document.createElement('div');
  head.className = 'plan-head';
  head.innerHTML = iconFor('list') +
    '<span class="plan-title"></span><span class="plan-note"></span>';
  head.querySelector('.plan-title').textContent = 'Working out the plan';
  head.querySelector('.plan-note').textContent =
    'Nothing runs until you approve it — the steps appear here as they are written.';
  card.plan.append(head);
}

/** The plan card beat: a clock, so a minute of drafting is visibly a minute. */
function draftingClock(card) {
  if (card.planClock) clearInterval(card.planClock);
  const tick = () => {
    const node = card.plan.querySelector('.plan-clock');
    if (!node) return;
    const seconds = Math.round((Date.now() - card.startedAt) / 1000);
    node.textContent = ` · ${seconds}s`;
  };
  card.planClock = setInterval(tick, 1_000);
}

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
  card.plan.classList.add('plan-card');

  // The one moment in the app where doing nothing is the safe option, so the
  // card says what it is and what is about to happen: a task that is waiting
  // for a tap looks identical to a task that is working, and only one of those
  // has an Approve button on it.
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.innerHTML = iconFor('list') +
    '<span class="plan-title"></span><span class="plan-note"></span>';
  head.querySelector('.plan-title').textContent = steps.length === 1 ? 'One step' : `The plan · ${steps.length} steps`;
  head.querySelector('.plan-note').textContent = 'Nothing has run yet — approve to start, or edit it first.';
  card.plan.append(head);

  for (const step of steps) {
    updatePlan(card, { index: step.index, total: step.total, label: step.label, done: false });
  }

  const actions = document.createElement('div');
  actions.className = 'plan-actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'msg-btn primary plan-approve';
  approve.innerHTML = iconFor('play') + '<span></span>';
  approve.querySelector('span').textContent = 'Approve & start';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'msg-btn';
  edit.innerHTML = iconFor('pencil') + '<span></span>';
  edit.querySelector('span').textContent = 'Edit';
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
 * Editing a plan that has not started yet.
 *
 * The first version of this let the operator rename steps, which is a real
 * thing to want and also the smallest possible edit: a plan you can only
 * rename is still the model's plan. So the editor works on the whole list —
 * a step moves up, moves down, or goes away, and a missing one can be added —
 * and sends the finished list to the server, which reindexes it 1..N and tells
 * every open view. Nothing here decides what a plan may contain; it collects
 * step labels and hands them over.
 */
function editPlan(card) {
  const actions = card.plan.querySelector('.plan-actions');
  if (!actions || actions.hidden) return;
  const rows = [...card.plan.querySelectorAll('.plan-row')];
  if (rows.length === 0) return;

  /** The editor's own copy: the checklist is left alone until Save. */
  let draft = rows.map((row) => row.querySelector('.plan-label')?.textContent ?? '');
  actions.hidden = true;

  const editor = document.createElement('div');
  editor.className = 'plan-editor';
  const list = document.createElement('div');
  list.className = 'plan-edit-list';
  const hint = document.createElement('p');
  hint.className = 'plan-hint';
  hint.textContent = 'Move, rewrite, drop or add steps — then start, and it follows this list.';
  const addRow = document.createElement('div');
  addRow.className = 'plan-add-row';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'plan-edit';
  addInput.maxLength = 140;
  addInput.placeholder = 'Add a step…';
  addInput.setAttribute('aria-label', 'New step');
  const addBtn = msgButton({ icon: 'plus', label: 'Add', title: 'Add this step as the last one' });
  addRow.append(addInput, addBtn);
  const footer = document.createElement('div');
  footer.className = 'plan-actions';
  const start = msgButton({ icon: 'play', label: 'Start the task', title: 'Save this plan and start running it' });
  start.classList.add('primary', 'plan-approve');
  const save = msgButton({ icon: 'check', label: 'Save plan', title: 'Keep this plan for review' });
  const cancel = msgButton({ icon: 'cross', label: 'Cancel', title: 'Leave the plan as it was' });
  footer.append(start, save, cancel);
  editor.append(hint, list, addRow, footer);
  card.plan.append(editor);

  /** Rebuild the rows: adding, dropping and moving all need a fresh list. */
  const redraw = (focus = -1) => {
    list.innerHTML = '';
    draft.forEach((label, i) => {
      const row = document.createElement('div');
      row.className = 'plan-edit-row';

      const up = msgButton({ icon: 'arrowUp', title: 'Move this step up', aria: `Move step ${i + 1} up` });
      up.className = 'plan-move';
      up.disabled = i === 0;
      const down = msgButton({ icon: 'arrowDown', title: 'Move this step down', aria: `Move step ${i + 1} down` });
      down.className = 'plan-move';
      down.disabled = i === draft.length - 1;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'plan-edit';
      input.maxLength = 140;
      input.value = label;
      input.setAttribute('aria-label', `Step ${i + 1}`);
      // Typing must not rebuild the list, or the caret jumps to the end of
      // the row on every letter.
      input.addEventListener('input', () => {
        draft[i] = input.value;
      });

      const remove = msgButton({ icon: 'trash', title: 'Drop this step', aria: `Drop step ${i + 1}` });
      remove.className = 'plan-remove';

      up.addEventListener('click', () => {
        if (i === 0) return;
        [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
        redraw(i - 1);
      });
      down.addEventListener('click', () => {
        if (i === draft.length - 1) return;
        [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
        redraw(i + 1);
      });
      remove.addEventListener('click', () => {
        // The server refuses an empty plan, and so does the editor: the last
        // step is not removable, which is friendlier than a 400 on Save.
        if (draft.length === 1) {
          toast('A plan needs at least one step.');
          return;
        }
        draft.splice(i, 1);
        redraw(Math.min(i, draft.length - 1));
      });

      row.append(up, down, input, remove);
      list.append(row);
    });
    addRow.hidden = draft.length >= MAX_PLAN_STEPS;
    if (focus >= 0) {
      const field = /** @type {HTMLInputElement | undefined} */ (list.querySelectorAll('.plan-edit')[focus]);
      field?.focus();
    }
  };

  const commit = async (thenStart) => {
    const labels = draft.map((label, i) => label.trim() || `Step ${i + 1}`).filter(Boolean);
    if (labels.length === 0) {
      toast('A plan needs at least one step.');
      return;
    }
    start.disabled = true;
    save.disabled = true;
    const ok = await savePlan(card, labels);
    if (!ok) {
      start.disabled = false;
      save.disabled = false;
      return;
    }
    if (thenStart) await approvePlan(card, start);
  };

  const add = () => {
    const label = addInput.value.trim();
    if (!label) {
      addInput.focus();
      return;
    }
    if (draft.length >= MAX_PLAN_STEPS) return;
    draft.push(label);
    addInput.value = '';
    redraw(draft.length - 1);
    addInput.focus();
  };

  addBtn.addEventListener('click', add);
  addInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  });
  start.addEventListener('click', () => void commit(true));
  save.addEventListener('click', () => void commit(false));
  cancel.addEventListener('click', () => {
    // The stream owns the checklist: asking for the plan again re-renders it
    // exactly as the server has it, which is the truth Cancel is promising.
    const plan = [...card.plan.querySelectorAll('.plan-row')].map((row, i) => {
      const label = row.querySelector('.plan-label')?.textContent ?? '';
      return { index: i + 1, total: rows.length, label };
    });
    editor.remove();
    actions.hidden = false;
    renderPlanPreview(card, plan.map((s, i) => ({ index: i + 1, total: plan.length, label: s.label })));
  });
  redraw();
  /** @type {HTMLInputElement | null} */ (list.querySelector('.plan-edit'))?.focus();
  scrollToEnd();
}

/**
 * Send a plan and (optionally) start it. The server reindexes and broadcasts
 * 'run.plan_updated', which re-renders the checklist — so a successful Save
 * has nothing left to do here.
 */
async function savePlan(card, labels) {
  try {
    await api(`/api/runs/${card.runId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ steps: labels }),
    });
    return true;
  } catch (err) {
    toast(err.body?.message || err.message || 'Could not save the plan.');
    return false;
  }
}

/* A mission step drawn as one node on the timeline. The node on the rail
   shows the step's status (spinner while running, check/dash/cross after);
   the body shows the name, a small timestamp, and an expandable detail. */
/** The engine's line while the model is silent. One row, always overwritten. */
const HEARTBEAT_RE = /^Nothing from the model yet — /;

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
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2.5 2.5 0 0 0-2.5 2.5V12"/>',
  thumbUp: '<path d="M7 21V10l4.5-7a2 2 0 0 1 3.5 1.4V9h3.6a2 2 0 0 1 2 2.4l-1.3 7A2 2 0 0 1 17.3 20H7Z"/><path d="M7 10H4v11h3"/>',
  thumbDown: '<path d="M17 3v11l-4.5 7A2 2 0 0 1 9 19.6V15H5.4a2 2 0 0 1-2-2.4l1.3-7A2 2 0 0 1 6.7 4H17Z"/><path d="M17 14h3V3h-3"/>',
  pencil: '<path d="M4 20h4l10-10-4-4L4 16Z"/><path d="m14 6 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z"/>',
  share: '<path d="M12 15V4M8.5 7.5 12 4l3.5 3.5"/><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  speaker: '<path d="M11 5 6.5 9H3v6h3.5L11 19Z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/>',
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
      // Every run replays its own start, so this is where the client learns
      // which chat the card belongs to — however the run was started.
      if (typeof data.conversationId === 'string') state.runConversationId = data.conversationId;
      state.runStatus = 'running';
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
      if (waiting && data.level !== 'warn') setStepStatus(waiting, 'done');
      // The engine's heartbeat while the model has said nothing. It is one row
      // that is rewritten, not a row per beat: "still working, 45s" is a state,
      // and forty-five rows in a timeline is not information either.
      if (HEARTBEAT_RE.test(message)) {
        addStep(card, 'heartbeat', { name: message, icon: 'info', status: 'note' });
        break;
      }
      // Keyed by the message, not by position: an engine that retries says the
      // same sentence every time, and five identical rows is not five pieces of
      // information. A warning is also not a result — it gets the `note`
      // status, which claims nothing, instead of the green check it used to get.
      addStep(card, `log:${message}`, {
        name: message,
        icon: data.level === 'info' ? 'info' : 'warn',
        status: data.level === 'info' ? 'done' : 'note',
      });
      break;
    }

    case 'plan.milestone':
      updatePlan(card, data);
      break;

    case 'run.plan_started':
      // The task is accepted and the plan is being drafted. Say so in the card
      // rather than letting the first minute of a complex task be a blank page.
      state.runStatus = 'planning';
      setRunning(true);
      renderPlanDrafting(card);
      draftingClock(card);
      break;

    case 'run.plan_ready':
    case 'run.plan_updated':
      // The planning pass proposed steps (or the operator edited them): the
      // run waits in 'awaiting_plan' and the card shows Approve / Edit. The
      // mission does not start until the operator taps Approve.
      state.runStatus = 'awaiting_plan'; // waiting for a human, not working
      if (card.planClock) clearInterval(card.planClock);
      card.planClock = null;
      renderPlanPreview(card, data.plan);
      break;

    case 'run.plan_approved':
      // The wait is over; 'run.started' follows on this same stream and the
      // execution milestones tick the approved steps off in place.
      state.runStatus = 'running';
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
        // What the operator needs to know is whether the agent kept its
        // workspace. The 32-character id it used to print here meant nothing to
        // anyone and looked like a rendering bug; it is still in the run record
        // for the times it is needed.
        addStep(card, 'env', {
          name: 'Sandbox ready',
          detail: data.continued ? 'continuing the earlier workspace' : 'a fresh workspace',
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

    case 'sources.seen':
      addSeenSource(card, data);
      break;

    case 'sources.checked': {
      const dead = Array.isArray(data.dead) ? data.dead : [];
      const checked = Number(data.checked) || 0;
      // The strip under the answer is the same fact in a more useful place:
      // which of the links this answer cites are real.
      card.deadSources = dead;
      card.sourcesChecked = checked;
      renderSources(card);
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
      card.usage = data?.usage ?? null;
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
  state.runStatus = 'finished'; // nothing to watch any more; the answer is here
  stopRunClock(card);
  if (card.thinkingClock) card.thinkingClock.textContent = '';
  card.spinner.classList.add('done');
  card.spinner.style.animation = 'none';
  card.spinner.setAttribute('class', 'spinner done');
  card.elapsed = `${((Date.now() - card.startedAt) / 1000).toFixed(1)}s`;
  card.thinkingLabel.textContent = 'Thinking';
  drawThinking(card);
  drawAnswer(card, false);
  // The card's own numbers: the seconds it has been counting, and whatever the
  // engine reported as the run closed.
  usageLine(card.card, card.usage ?? null, card.startedAt, true);

  // The rail stops moving with the task: it folds to one honest line —
  // "Where it looked · 8 sites" — because from here on the answer is the news,
  // and the pages it opened are background. It stays readable, one tap away,
  // for the case that matters: the answer's citations and the pages the task
  // actually read are two different lists, and only one of them can be made up.
  if (card.seenSources && card.seenSources.length > 0) {
    card.railCollapsed = true;
    renderSourceRail(card);
  }

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

  // A task the operator just watched deserves the same thumbs as a reopened
  // one — the rating is about the answer, not about how it was reached.
  if (outcome !== 'cancelled' && card.runId) {
    feedbackControls(card.answer, { target: { runId: card.runId } });
  }

  foldWork(card);
  renderSources(card);
  // If they are reading further up, this is news rather than a position.
  state.freshAnswer = !pinned;
  setRunning(false);
  updateJumpPill();
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
  const text = typeof message.content === 'string' ? message.content : '';

  // Copy is the one action every message has, both directions: the operator's
  // own question is as worth keeping as the answer.
  if (text) {
    const copyBtn = msgButton({ icon: 'copy', title: 'Copy this message' });
    copyBtn.addEventListener('click', () => copyToClipboard(text, copyBtn));
    row.append(copyBtn);
  }

  // Every answer can be heard aloud — free, via the browser itself.
  if (message.role === 'assistant' && text && 'speechSynthesis' in window) {
    row.append(speakButton(text));
  }

  if (message.role === 'user') {
    const editBtn = msgButton({ icon: 'pencil', title: 'Edit this message — forks the conversation' });
    editBtn.addEventListener('click', () => openInlineEditor(node, message));
    row.append(editBtn);
  } else if (message.runId && message.runStatus === 'awaiting_plan') {
    // A plan waiting for approval: jump straight to its card to review it.
    const reviewBtn = msgButton({ icon: 'list', label: 'Review plan', title: 'Approve or edit the proposed plan' });
    reviewBtn.classList.add('primary');
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
    // A paused run, or one the server killed mid-run, resumes from its first
    // unfinished step. Everything else gets the plain retry.
    const resumable = message.runStatus === 'paused' || message.runErrorType === 'interrupted';
    const actionBtn = msgButton({
      icon: resumable ? 'play' : 'refresh',
      label: resumable ? 'Resume' : 'Retry',
      title: resumable ? 'Continue from the last finished step' : 'Run this task again',
    });
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
    const outputsBtn = msgButton({ icon: 'panel', label: 'Outputs', title: 'Open this run\u2019s outputs in a side panel' });
    outputsBtn.addEventListener('click', () => openOutputs(message.runId));
    row.append(outputsBtn);
  }

  // A ```linkedin-post block the agent filed as a pending draft. Publishing
  // is always the operator's tap — never automatic.
  if (linkedInDraftId && message.role === 'assistant') row.append(linkedInPublishButton(linkedInDraftId));

  // Ratings live on the answer, at the end of its action row: one tap, no
  // dialog, and always in the same place.
  if (message.role === 'assistant' && message.id) {
    feedbackControls(node, { target: { messageId: message.id }, feedback: message.feedback ?? null });
  }

  // When it was said, on the same line as what can be done with it.
  if (message.createdAt) {
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = clockTime(message.createdAt);
    row.append(time);
  }

  if (!row.children.length) return;
  node.append(row);
}

/* ============================ rating an answer ==========================
   The research on this is unanimous and it is all about friction: the thumbs
   sit inline with the answer, one tap, always available; the *reason* is asked
   for only after a thumbs-down and from a short closed list, because a
   countable reason is the only kind anything can be done with; and the free
   text comes last, for the cases the codes do not fit. It is deliberately not
   a dialog — a form that opens a modal kills response rate. */

const FEEDBACK_REASONS = [
  ['wrong', 'Wrong information'],
  ['off_topic', 'Not what I asked for'],
  ['too_long', 'Too long or too vague'],
  ['broken', 'Something was broken'],
  ['other', 'Something else'],
];

/**
 * The thumbs, and the reason chips behind the thumbs-down.
 *
 * `target` is either a stored message ({ messageId }) or a run that has just
 * finished ({ runId }) — the live card has the run, not the row, and the server
 * knows which answer that run produced.
 */
function feedbackControls(node, options = {}) {
  // Typed loosely on purpose: this is called with a message row in one place
  // and a live run in another, and the checkJs pass reads the JSDoc, not the
  // call sites.
  const { target = {}, feedback = null } = /** @type {{ target?: { messageId?: string, runId?: string }, feedback?: { rating?: string, reason?: string, note?: string } | null }} */ (options);
  const box = document.createElement('div');
  box.className = 'feedback';

  const row = document.createElement('div');
  row.className = 'feedback-row';

  const up = msgButton({ icon: 'thumbUp', title: 'Good answer', aria: 'This answer was good' });
  const down = msgButton({ icon: 'thumbDown', title: 'Something was wrong with this answer', aria: 'Something was wrong with this answer' });
  const status = document.createElement('span');
  status.className = 'feedback-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  row.append(up, down, status);
  box.append(row);

  const endpoint = target.messageId
    ? `/api/messages/${encodeURIComponent(target.messageId)}/feedback`
    : `/api/runs/${encodeURIComponent(target.runId)}/feedback`;

  let rating = feedback?.rating ?? null;
  let reason = feedback?.reason ?? null;
  let why = null;
  let noteBox = null;

  /** The reasons, shown only once he has said something was wrong. */
  function buildWhy() {
    const panel = document.createElement('div');
    panel.className = 'feedback-why';

    const chips = document.createElement('div');
    chips.className = 'feedback-chips';
    for (const [id, label] of FEEDBACK_REASONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'feedback-chip' + (reason === id ? ' on' : '');
      chip.textContent = label;
      chip.setAttribute('aria-pressed', String(reason === id));
      chip.addEventListener('click', () => {
        for (const other of chips.children) {
          other.classList.remove('on');
          other.setAttribute('aria-pressed', 'false');
        }
        chip.classList.add('on');
        chip.setAttribute('aria-pressed', 'true');
        reason = id;
        void send('down', id, noteBox?.querySelector('input')?.value ?? null, { quiet: true });
      });
      chips.append(chip);
    }
    panel.append(chips);

    // A note is the third tier: available, never demanded.
    const note = document.createElement('div');
    note.className = 'feedback-note';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Anything else? (optional)';
    input.setAttribute('aria-label', 'What went wrong, in your own words');
    const sendNote = document.createElement('button');
    sendNote.type = 'button';
    sendNote.className = 'msg-btn';
    sendNote.textContent = 'Send note';
    sendNote.addEventListener('click', () => {
      if (!reason) { toast('Pick a reason first.'); return; }
      void send('down', reason, input.value, { quiet: true });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); sendNote.click(); }
    });
    note.append(input, sendNote);
    panel.append(note);
    noteBox = note;
    return panel;
  }

  function paint() {
    up.classList.toggle('on', rating === 'up');
    down.classList.toggle('on', rating === 'down');
    up.setAttribute('aria-pressed', String(rating === 'up'));
    down.setAttribute('aria-pressed', String(rating === 'down'));
    status.textContent = rating === 'up' ? 'Thanks — noted.' : rating === 'down' ? 'Noted.' : '';
    if (rating !== 'down' && why) { why.remove(); why = null; noteBox = null; }
    if (rating === 'down' && !why) box.append(buildWhy());
  }

  async function send(nextRating, nextReason = null, note = null, { quiet = false } = {}) {
    up.disabled = true;
    down.disabled = true;
    try {
      const body = { rating: nextRating };
      if (nextReason) body.reason = nextReason;
      const text = typeof note === 'string' ? note.trim() : '';
      if (text) body.note = text;
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      rating = nextRating;
      reason = nextReason;
      paint();
      if (!quiet) toast(nextRating === 'up' ? 'Noted — thanks.' : 'Noted.');
    } catch (err) {
      toast(err.body?.message || err.message || 'Could not keep that.');
    } finally {
      up.disabled = false;
      down.disabled = false;
    }
  }

  async function clear() {
    up.disabled = true;
    down.disabled = true;
    try {
      await api(endpoint, { method: 'DELETE' });
      rating = null;
      reason = null;
      paint();
    } catch (err) {
      toast(err.message || 'Could not take that back.');
    } finally {
      up.disabled = false;
      down.disabled = false;
    }
  }

  // Tapping the thumb that is already on takes the rating back, which is the
  // only undo this needs.
  up.addEventListener('click', () => (rating === 'up' ? void clear() : void send('up')));
  down.addEventListener('click', () => (rating === 'down' ? void clear() : void send('down')));

  paint();
  node.append(box);
  return box;
}


/** "14:32" for a timestamp the server sent, or nothing at all if it is junk. */
function clockTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* Swap a user message for an editor in place. Saving forks the conversation
   at that message and re-sends the edited text into the new branch. */

/** One-tap publish for a pending LinkedIn draft. Disabled while posting. */
function linkedInPublishButton(draftId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-btn';
  const label = 'Publish to LinkedIn';
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
    if (artifacts.length > 0) {
      const head = document.createElement('p');
      head.className = 'files-head';
      head.textContent = artifacts.length === 1 ? 'File' : `Files (${artifacts.length})`;
      card.files.append(head);
    }
    for (const artifact of artifacts) card.files.append(artifactCard(artifact));
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

/* Live chips, by artifact id: the answer's file row and the outputs panel show
   the same record, and pinning in one place has to be visible in the other. */
const artifactChips = new Map();

/** Repaint every chip for this artifact from the record that was just updated. */
function refreshArtifactChips(artifact) {
  for (const chip of artifactChips.get(artifact.id) ?? []) {
    const label = chip.querySelector('.result-line') ?? chip.querySelector('span');
    if (!label) continue;
    chip.classList.toggle('kept', !!artifact.pinned);
    // Same three facts in the same order whichever view is repainting: what it
    // is, how big it is, whether it is kept.
    label.textContent = artifactMeta(artifact, formatBytes);
  }
}

/**
 * A produced file, as a card.
 *
 * The old chip was a pill with a filename in it, which said "something exists"
 * and nothing else. A card says what the thing *is* — a web page, an Android
 * app, a spreadsheet — how big it is, whether it is being kept, and what can be
 * done with it right now: open a page in the preview, download it, keep it. The
 * filename is still the title, because the filename is what the operator sees
 * again in their downloads folder.
 */
function artifactCard(artifact) {
  const kind = artifactKind(artifact.name);
  const card = document.createElement('div');
  card.className = 'result' + (artifact.pinned ? ' kept' : '');
  card.dataset.artifactId = artifact.id;

  const mark = document.createElement('span');
  mark.className = 'result-mark';
  mark.innerHTML = iconFor(kind.icon);

  const body = document.createElement('div');
  body.className = 'result-body';

  const name = document.createElement('span');
  name.className = 'result-name';
  name.textContent = artifact.name;
  name.title = artifact.name;

  // The same line the other views repaint through refreshArtifactChips, so the
  // label format is kept in one place.
  const meta = document.createElement('span');
  meta.className = 'result-line';
  meta.textContent = artifactMeta(artifact, formatBytes);

  body.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  if (artifact.previewable) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'msg-btn';
    open.innerHTML = iconFor('eye') + '<span></span>';
    open.querySelector('span').textContent = 'Open';
    open.title = `Open ${artifact.name} in a preview`;
    open.addEventListener('click', () => openPreview(artifact));
    actions.append(open);
  }

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'msg-btn';
  download.innerHTML = iconFor('file') + '<span></span>';
  download.querySelector('span').textContent = 'Download';
  download.title = `Save ${artifact.name}`;
  download.addEventListener('click', () => downloadArtifact(artifact, download));
  actions.append(download);

  actions.append(keepButton(artifact));

  card.append(mark, body, actions);

  // Registering the card keeps every view of this file in step: pinning in the
  // panel repaints the card under the answer, and the other way round.
  const known = artifactChips.get(artifact.id) ?? [];
  known.push(card);
  artifactChips.set(artifact.id, known);

  return card;
}

/** Back-compat alias: the registry and its tests call this a chip. */
function artifactChip(artifact) {
  return artifactCard(artifact);
}

/**
 * Keep a file.
 *
 * A sandbox expires, the disk is wiped by the next deploy, and unpinned rows are
 * deleted after the retention window — so "I downloaded it once" and "it will
 * still be here next month" are different promises, and only the operator can
 * say which one is wanted. This is the button that makes the promise: the bytes
 * are copied into the database, and retention stops touching the row.
 *
 * Pinning happens on demand (the bytes have to be readable *now*), so a failure
 * is explained rather than silent: an expired sandbox cannot be pinned, and the
 * server says so with the reason.
 */
function keepButton(artifact) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-btn' + (artifact.pinned ? ' primary' : '');
  btn.textContent = artifact.pinned ? '✓ Kept' : 'Keep';
  btn.title = artifact.pinned
    ? 'Stored in the database — tap to stop keeping it'
    : 'Keep this file: stored in the database, safe from the retention sweep';

  btn.addEventListener('click', async () => {
    const pinning = !artifact.pinned;
    btn.disabled = true;
    btn.textContent = pinning ? 'Keeping…' : 'Removing…';
    try {
      const path = `/api/artifacts/${artifact.id}/${pinning ? 'pin' : 'unpin'}`;
      const result = await api(path, { method: 'POST' });
      artifact.pinned = pinning;
      if (pinning && result.artifact?.size) artifact.size = result.artifact.size;
      btn.textContent = pinning ? '✓ Kept' : 'Keep';
      btn.className = 'msg-btn' + (pinning ? ' primary' : '');
      btn.title = pinning
        ? 'Stored in the database — tap to stop keeping it'
        : 'Keep this file: stored in the database, safe from the retention sweep';
      toast(pinning ? `Keeping ${artifact.name} — it will not be deleted.` : `${artifact.name} is no longer kept.`);
      // The same file appears as a chip under the answer and as a row in the
      // outputs panel; both read this record, so both are refreshed from it.
      refreshArtifactChips(artifact);
      if (panelData) renderPanelBody();
    } catch (err) {
      btn.textContent = artifact.pinned ? '✓ Kept' : 'Keep';
      toast(err.body?.message || err.message || 'Could not keep that file.', 7_000);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/* A website the mission built gets a live preview, not just a download. The
   page is served by /api/artifacts/:id/preview and rendered in a sandboxed
   iframe: its own scripts and styles run, but the sandbox keeps it away from
   the app — allow-scripts only, never allow-same-origin, never
   allow-top-navigation. */
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
  // A split does not need a scrim: nothing is hidden underneath, so dimming the
  // thread would be dimming something the operator is meant to read beside it.
  if (panelMode() === 'docked') applyPanelPlacement();
  else {
    el.panelBackdrop.hidden = false;
    requestAnimationFrame(() => el.panelBackdrop.classList.add('show'));
  }
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
    renderPanelHead();
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
  // Give the column back to the thread.
  el.screenApp?.classList.remove('docked');
}

/** 'docked' when the window is wide enough for a real split, else 'overlay'. */
function panelMode() {
  return panelPlacement(window.innerWidth ?? PANEL_DOCK_MIN_WIDTH);
}

/**
 * Put the panel where it belongs right now: its own column above the
 * threshold, a slide-over below it. Called when the panel opens and on every
 * resize, so dragging a window narrower turns the split back into an overlay
 * instead of leaving a squeezed column.
 */
function applyPanelPlacement() {
  const docked = panel.open && panelMode() === 'docked';
  el.screenApp?.classList.toggle('docked', docked);
  if (docked) {
    el.panelBackdrop.classList.remove('show');
    el.panelBackdrop.hidden = true;
  } else if (panel.open) {
    el.panelBackdrop.hidden = false;
    requestAnimationFrame(() => el.panelBackdrop.classList.add('show'));
  }
}

window.addEventListener('resize', applyPanelPlacement);

function panelEscape(event) {
  if (event.key === 'Escape') closeOutputs();
}

/* Which run the panel is showing, in words: "Outputs" alone is a drawer with
   no address on it. The task's own title is the address. */
function renderPanelHead() {
  const title = panelData?.run?.prompt?.trim() || 'Outputs';
  el.panelTitle.textContent = 'Outputs';
  const existing = document.querySelector('.panel-subtitle');
  existing?.remove();
  const subtitle = document.createElement('p');
  subtitle.className = 'panel-subtitle';
  subtitle.textContent = title.length > 90 ? `${title.slice(0, 90)}…` : title;
  el.panelTitle.after(subtitle);
}

function renderPanelTabs() {
  el.panelTabs.innerHTML = '';
  el.panelTabs.hidden = panelVisible.length === 0;
  const counts = {
    files: panelData?.artifacts?.length ?? 0,
    preview: (panelData?.artifacts ?? []).filter((a) => a && a.previewable).length,
    plan: (panelData?.run?.plan ?? []).length,
    proof: (panelData?.run?.verification ?? []).length,
  };
  for (const id of panelVisible) {
    const def = PANEL_SECTIONS.find((s) => s.id === id);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'panel-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(panel.section === id));
    const count = counts[id] ?? 0;
    tab.textContent = count > 1 && def ? `${def.label} · ${count}` : (def ? def.label : id);
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
  // The panel shows the same card the answer shows — one component, two places,
  // so a file never looks like one thing in the thread and another in the panel.
  for (const artifact of artifacts) {
    body.append(artifactCard(artifact));
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
  // Optimistic: the replay that follows corrects it the moment the run turns
  // out to be waiting for approval, or already over.
  state.runStatus = 'running';

  // Reusing the existing card is what makes a re-attach safe: recovery paths
  // (returning to the foreground, tapping "Review plan") replay a run the
  // thread may already be showing, and a second card for one task would be a
  // duplicate, not a refresh.
  const card = cardFor(runId) ? existingCard(runId) : createRunCard(runId);
  scrollToEnd();
  const url = `/api/runs/${runId}/stream${after ? `?after=${after}` : ''}`;
  const source = new EventSource(url, { withCredentials: true });
  state.source = source;

  const durable = [
    'run.started', 'log', 'tool.call', 'tool.result',
    'thinking.snapshot', 'text.snapshot', 'run.environment',
    'artifact', 'memory.recall', 'plan.milestone',
    'run.plan_started', 'run.plan_ready', 'run.plan_updated', 'run.plan_approved',
    'research.started', 'research.pass', 'verification.checked',
    // The server has always sent this — it fetches every link in a research
    // answer and reports how many are dead — but it was never in this list, so
    // the work happened and the operator saw nothing. The `case` for it was
    // right there in handleEvent(), dead code waiting for a listener.
    'sources.seen', 'sources.checked',
    'google.read',
    'run.completed', 'run.failed', 'run.cancelled',
    // Pausing is a declared run status — `setRunStatus` accepts 'paused' and
    // writes `run.${status}` — and the handler below has always been here. What
    // was missing was this line: without it a paused task would sit there
    // looking like a hung one, exactly the bug `sources.checked` had.
    'run.paused',
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
      if (run && TERMINAL_STATUSES.includes(run.status)) {
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
  // Nothing attached at all: this is the phone waking up on a task started
  // somewhere else (a laptop, another tab, WhatsApp). Ask the server before
  // deciding there is nothing to show.
  if (!state.runId) {
    void ensureLiveRun({ attempts: 1, announce: false });
    return;
  }
  let run = null;
  try {
    ({ run } = await api(`/api/runs/${state.runId}`));
  } catch { return; } // keep the stream; a later event will reconcile
  if (!run) return;

  // A planning run waits for a human, and the run card is the only place to
  // approve it. If the plan became ready while the phone was away, the stream
  // that carried `run.plan_ready` died with the tab: the card sits there with no
  // Approve button, nothing says the server is waiting, and the only visible
  // action is Stop — which cancels the task. So replay the run into its card.
  if (run.status === 'awaiting_plan') {
    const streamDead = !state.source || state.source.readyState !== EventSource.OPEN;
    if (streamDead || !cardFor(run.id)) {
      setRunning(false); // nothing is running: the browser is waiting for a tap
      attach(run.id, 0);
    }
    return;
  }

  if (!state.running) return;
  if (TERMINAL_STATUSES.includes(run.status)) {
    // 'paused' belongs here: the run is waiting for the operator, not working,
    // and no further event is coming. Leaving the stream open and the composer
    // locked is how a paused task came to look exactly like a hung one.
    closeStream();
    setRunning(false);
    state.runId = null;
    await openConversation(run.conversationId);
  }
});

/* ------------------------------------------------------------- composer -- */

function setRunning(on) {
  state.running = on;
  // A finished run owns no chat: the answer is on the thread by then, and a
  // stale owner would point the next "still running" note at the wrong one.
  if (!on) state.runConversationId = null;
  if (on) stopSpeaking(); // A new answer replaces whatever was being read.
  el.statusDot.hidden = !on;
  el.stop.hidden = !on;
  el.stop.disabled = false;
  el.topbarTitle.textContent = on
    ? (state.runStatus === 'planning' ? 'Planning…' : 'Working…')
    : (state.conversations.find((c) => c.id === state.conversationId)?.title ?? 'WAIS');
  el.send.disabled = on || !el.prompt.value.trim();
  // While a task runs the trailing control is Stop — in the composer's own
  // corner, where the thumb already is, rather than only in the top bar.
  el.stop.hidden = !on;
  updateTrailingAction();
  updateJumpPill();
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
  updateTrailingAction();
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

/* The stop button lives in the composer's trailing slot: it is the control an
   operator reaches for in a hurry, and the top bar corner is the hardest place
   on a phone to reach. */
function setupStopButton() {
  if (el.stop.parentElement !== el.send.parentElement) el.send.after(el.stop);
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
  // The trailing slot, not the row's left side: one control on the right that
  // is a mic while the field is empty, a send once there is something to send,
  // and a stop while a task runs.
  el.send.before(btn);
  el.mic = btn;
  updateTrailingAction();
}

/**
 * One trailing control, three jobs. A phone has room for one thumb-sized
 * control at the right edge of the composer, so the app spends it on whatever
 * the operator could want at this exact moment and never on all three at once.
 */
function updateTrailingAction() {
  const typing = el.prompt.value.trim().length > 0;
  const micUsable = !!el.mic && !el.mic.disabled;
  // The mic has the slot only while there is nothing to send and nothing
  // running. The send button then takes it the moment there is something to
  // send — including the moment the operator starts typing, which is the whole
  // point of the button.
  const micHasSlot = micUsable && !typing && !state.running;
  if (el.mic) el.mic.hidden = !micHasSlot;
  // The bug this line was: `|| typing` hid the send button exactly when it was
  // needed, so a typed task had no visible way out of the field.
  el.send.hidden = state.running || micHasSlot;
}

/** Per-answer Listen/Stop button for assistant messages. */
function speakButton(text) {
  const btn = msgButton({ icon: 'speaker', title: 'Hear this answer spoken' });
  const reset = () => { btn.dataset.speaking = ''; btn.innerHTML = iconFor('speaker'); };
  btn.addEventListener('click', () => {
    if (btn.dataset.speaking === '1') {
      stopSpeaking();
      reset();
      return;
    }
    document.querySelectorAll('.msg-btn[data-speaking="1"]').forEach((other) => {
      const o = /** @type {HTMLElement} */ (other);
      o.dataset.speaking = '';
      o.innerHTML = iconFor('speaker');
    });
    btn.dataset.speaking = '1';
    btn.innerHTML = iconFor('cross');
    btn.setAttribute('aria-label', 'Stop reading aloud');
    speakText(text, reset);
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
  // A starter that says what it does is a starter someone taps. The label is
  // the card's title; the fill it drops into the composer is the promise.
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = suggestion.label;
  const hint = document.createElement('span');
  hint.className = 'chip-hint';
  hint.textContent = suggestion.hint ?? '';
  chip.append(label, hint);
  if (!hint.textContent) hint.remove();
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
  el.researchDetail.hidden = !on;
  el.researchCustomWrap.hidden = !on || el.researchMinutes.value !== 'custom';
  el.modeStandard.setAttribute('aria-checked', on ? 'false' : 'true');
  el.modeResearch.setAttribute('aria-checked', on ? 'true' : 'false');
  el.modeChip.dataset.mode = on ? 'research' : 'standard';
  if (on) {
    const mins = researchBudgetMinutes();
    el.modeLabel.textContent = `Deep research · ${mins} min`;
    el.note.textContent = `The agent keeps digging for up to ${mins} minute${mins === 1 ? '' : 's'}.`;
  } else {
    el.modeLabel.textContent = 'Standard';
    if (!el.pingCheck.checked) el.note.textContent = '';
  }
}

el.researchCheck.addEventListener('change', refreshResearchPicker);
el.researchMinutes.addEventListener('change', refreshResearchPicker);
el.researchCustom.addEventListener('input', refreshResearchPicker);

/* ------------------------------------------------------ how hard it works -- */

/* The mode controls live in the composer and unfold in place.
   They used to be a bottom sheet over the page, which is a modal for a
   two-option choice — the kind of thing that arrives uninvited, traps focus,
   and makes the operator dismiss something before they can type. Nothing here
   opens on its own; the chip is the only way in, and the tray closes when a
   mode is chosen or the chip is tapped again. */

function openModeTray() {
  if (!el.modeTray.hidden) return;
  el.modeTray.hidden = false;
  el.modeChip.setAttribute('aria-expanded', 'true');
}

function closeModeTray() {
  if (el.modeTray.hidden) return;
  el.modeTray.hidden = true;
  el.modeChip.setAttribute('aria-expanded', 'false');
}

function toggleModeTray() {
  if (el.modeTray.hidden) openModeTray();
  else closeModeTray();
}

el.modeChip.addEventListener('click', toggleModeTray);
el.modeClose.addEventListener('click', closeModeTray);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.modeTray.hidden) closeModeTray();
});

/* Standard is a complete choice, so it folds the tray away. Deep research is
   not — it asks for a budget — so the tray stays open until the budget is set
   or the chip is tapped again. */
el.modeStandard.addEventListener('click', () => {
  el.researchCheck.checked = false;
  refreshResearchPicker();
  closeModeTray();
});
el.modeResearch.addEventListener('click', () => {
  el.researchCheck.checked = true;
  refreshResearchPicker();
});
el.pingCheck.addEventListener('change', refreshResearchPicker);

/* ---------------------------------------------------------- attachments -- */

/**
 * What the composer will send with the prompt.
 *
 * Text files only, read in the browser and carried inside the request: the
 * sandbox is not needed to look at a note, and a file that never leaves the
 * phone cannot leak. The caps are the server's caps, repeated here so the
 * operator is told before a 200 KB upload rather than after it.
 */
const ATTACH_LIMIT = 3;
const ATTACH_BYTES = 200_000;
const ATTACH_TOTAL = 400_000;
let attachments = [];

function attachmentBytes(list = attachments) {
  return list.reduce((sum, a) => sum + a.text.length, 0);
}

function renderAttachments(message = '') {
  el.attachments.innerHTML = '';
  el.attachments.hidden = attachments.length === 0 && !message;
  if (message) {
    const bad = document.createElement('p');
    bad.className = 'attach-error';
    bad.textContent = message;
    el.attachments.append(bad);
  }
  for (const file of attachments) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.innerHTML = iconFor('file') + '<span class="name"></span><span class="size"></span>' +
      '<button type="button" aria-label="Remove this file"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    chip.querySelector('.name').textContent = file.name;
    chip.querySelector('.size').textContent = formatBytes(file.text.length);
    chip.querySelector('button').addEventListener('click', () => {
      attachments = attachments.filter((a) => a !== file);
      renderAttachments();
    });
    el.attachments.append(chip);
  }
}

function clearAttachments() {
  attachments = [];
  el.fileInput.value = '';
  renderAttachments();
}

el.attach.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async () => {
  const chosen = [...(el.fileInput.files ?? [])];
  const refused = [];
  for (const file of chosen) {
    if (attachments.length >= ATTACH_LIMIT) { refused.push(`${file.name}: only ${ATTACH_LIMIT} files per task`); continue; }
    if (file.size > ATTACH_BYTES) { refused.push(`${file.name}: larger than ${formatBytes(ATTACH_BYTES)}`); continue; }
    if (attachmentBytes() + file.size > ATTACH_TOTAL) { refused.push(`${file.name}: the files add up to more than ${formatBytes(ATTACH_TOTAL)}`); continue; }
    try {
      const text = await file.text();
      // A file that decodes to replacement characters is not text — say so
      // rather than sending the model a page of uFFFD.
      if (text.includes('\uFFFD')) { refused.push(`${file.name}: not a text file`); continue; }
      attachments.push({ name: file.name.slice(0, 120), text });
    } catch {
      refused.push(`${file.name}: could not be read`);
    }
  }
  el.fileInput.value = '';
  renderAttachments(refused.join(' · '));
});

el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = el.prompt.value.trim();
  if (!prompt || state.running) return;
  const notifyWhatsapp = el.pingCheck.checked;
  // Read before the reset below clears the picker.
  const deepResearch = el.researchCheck.checked;
  const budgetMinutes = researchBudgetMinutes();

  const files = attachments.map(({ name, text }) => ({ name, text }));

  // The ping, the research mode and the files are per task, not sticky
  // preferences: they are reset with the composer.
  el.pingCheck.checked = false;
  el.researchCheck.checked = false;
  refreshResearchPicker();
  el.note.textContent = '';
  clearAttachments();
  await submitPrompt(prompt, { notifyWhatsapp, deepResearch, budgetMinutes, files });
});

/**
 * "Starting the task…" while the request is in flight, and the honest reason it
 * is taking a while once it has. `done()` takes it away — the real card replaces
 * it, so it must never linger as a second thing on the thread.
 */
function pendingRunNotice() {
  const notice = renderNotice('Starting the task…', false, 'info');
  const label = notice.querySelector('span');
  const slow = setTimeout(() => {
    if (label) label.textContent = 'Still starting — a complex task drafts its plan first, which can take a minute.';
  }, 6_000);
  return {
    done() {
      clearTimeout(slow);
      notice.remove();
    },
  };
}

/* Start one run: the single path for the composer and for branch forks.
   The run is filed under the current branch, so a forked "what if" stays in
   its own branch instead of leaking back into the original thread. */
async function submitPrompt(prompt, { notifyWhatsapp = false, deepResearch = false, budgetMinutes = 15, files = [] } = {}) {
  el.prompt.value = '';
  autoGrow();
  el.send.disabled = true;
  showHero(false);
  renderAsk(prompt);
  scrollToEnd(true);

  // The POST does not return until the run exists, and a complex task drafts its
  // plan inside that request — up to a minute on a slow model. Without this the
  // operator sees their own message and then nothing at all, which is
  // indistinguishable from the app being broken.
  const pending = pendingRunNotice();

  try {
    const { run, budget } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        conversationId: state.conversationId,
        branchId: state.branchId,
        notifyWhatsapp,
        ...(files.length ? { attachments: files } : {}),
        ...(deepResearch ? { deepResearch: true, researchBudgetMinutes: budgetMinutes } : {}),
      }),
    });
    state.conversationId = run.conversationId;
    if (budget) note(`${budget.remaining} of ${budget.limit} runs left today`);
    if (run.status === 'awaiting_plan') {
      // The task waits for plan approval — nothing is running yet. The stream
      // replays 'run.plan_ready' and the card renders Approve / Edit.
      note('Plan ready — review it below, then approve to start.');
      attach(run.id, 0);
    } else if (run.status === 'planning') {
      // The plan is being drafted now, and the drafting streams into the card.
      state.runStatus = 'planning';
      note('Drafting the plan — the steps will appear as they are written.');
      setRunning(true);
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
  } finally {
    pending.done();
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

/* Every state a credential can be in: the pill on its card, and the sentence
   that explains it. `short` is what fits in the pill ("Connected"), `text` is
   the long form the tests and the WhatsApp note read. */
const SECRET_STATE = {
  stored: (secret) => ({
    text: `saved here · ${secret.fingerprint}`,
    short: 'Connected',
    className: 'ok',
  }),
  environment: (secret) => ({
    text: `from ${secret.envVar} in the environment`,
    short: 'Connected',
    className: 'ok',
  }),
  missing: () => ({ text: 'not set', short: 'Not set', className: 'muted' }),
  unreadable: () => ({
    text: 'cannot decrypt — MASTER_KEY changed',
    short: 'Needs attention',
    className: 'bad',
  }),
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
  const host = document.getElementById('build-line');
  if (!host) return;
  let status;
  try {
    status = await api('/api/status');
  } catch {
    return;
  }
  const commit = typeof status.commit === 'string' && status.commit !== 'unknown' ? status.commit : null;
  host.innerHTML =
    `<span class="setting-main">
       <span class="setting-label">${commit ? `WAIS · build ${escapeHtml(commit)}` : 'WAIS · development build'}</span>
       <span class="setting-desc">The last line to check when a fix seems to be missing: a phone can still be running the previous build for a minute after a deploy.</span>
     </span>`;
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

/**
 * What the operator said about answers, shown back to him.
 *
 * Collecting a rating and never showing it is how a feedback button becomes
 * furniture — the research is blunt about it: "if you ask for it and nothing
 * visibly improves, users stop giving it". So the page that holds the knobs
 * also holds the record: how many of each, and the last few thumbs-down with
 * the task they were about.
 */
async function loadFeedbackSummary() {
  let summary;
  try {
    summary = await api('/api/feedback/summary?limit=3');
  } catch {
    return; // the page is still usable without it
  }
  const total = (summary.up ?? 0) + (summary.down ?? 0);
  const existing = el.settingsBody.querySelector('.settings-feedback');
  existing?.remove();
  if (!total) return;

  const body = document.createElement('div');
  body.className = 'settings-feedback';
  const list = document.createElement('div');
  list.className = 'settings-list';

  const head = document.createElement('div');
  head.className = 'feedback-summary-row';
  head.innerHTML = `<span class="feedback-summary-mark">${iconFor('thumbUp')}</span><span class="feedback-summary-body"></span>`;
  head.querySelector('.feedback-summary-body').textContent =
    `${summary.up} good · ${summary.down} not good — the last few are below.`;
  list.append(head);

  for (const row of summary.recent ?? []) {
    if (row.rating !== 'down') continue;
    const line = document.createElement('div');
    line.className = 'feedback-summary-row';
    line.innerHTML = `<span class="feedback-summary-mark">${iconFor('thumbDown')}</span><span class="feedback-summary-body"><span class="feedback-summary-task"></span><span class="feedback-summary-why"></span></span>`;
    line.querySelector('.feedback-summary-task').textContent = row.task || 'A task';
    const why = [row.reasonLabel, row.note].filter(Boolean).join(' — ');
    line.querySelector('.feedback-summary-why').textContent = why;
    list.append(line);
  }

  body.append(list);
  el.settingsBody.append(section('What you told me', body.outerHTML));
}

/** A titled block on the settings page. */
function section(title, body) {
  return `<section class="settings-section">
    <h2 class="settings-heading">${escapeHtml(title)}</h2>
    ${body}
  </section>`;
}

function renderSettings() {
  const data = state.settings;
  if (!data) return;

  const query = state.settingsQuery.trim().toLowerCase();
  const matches = (...haystack) => !query || haystack.some((h) => String(h).toLowerCase().includes(query));

  /* ---- how it runs ------------------------------------------------------
     A setting is a question ("what is the run budget?"), the answer (its
     current value) and the reason it exists (the description the server has
     always sent and this page always threw away). The control opens under the
     row instead of standing next to the label, which is what made the page a
     wall of inputs on a phone. */
  const settingRows = data.settings.map((setting) => {
    const value = typeof setting.value === 'boolean' ? (setting.value ? 'On' : 'Off') : String(setting.value);
    const source = setting.source === 'stored' ? 'saved here' : `from ${setting.source === 'environment' ? setting.envVar : 'the default'}`;
    if (!matches(setting.label, setting.description, setting.key, value)) return '';

    if (typeof setting.value === 'boolean') {
      return `
      <div class="setting-row" data-key="${escapeHtml(setting.key)}">
        <label class="setting-toggle-row">
          <span class="setting-main">
            <span class="setting-label">${escapeHtml(setting.label)}</span>
            <span class="setting-desc">${escapeHtml(setting.description)}</span>
          </span>
          <input class="setting-input setting-toggle" data-setting="${escapeHtml(setting.key)}"
            type="checkbox" ${setting.value ? 'checked' : ''} />
        </label>
        <p class="setting-source">${escapeHtml(source)}</p>
      </div>`;
    }

    return `
    <div class="setting-row" data-key="${escapeHtml(setting.key)}">
      <button type="button" class="setting-summary" aria-expanded="false"
              aria-label="Edit ${escapeHtml(setting.label)}">
        <span class="setting-main">
          <span class="setting-label">${escapeHtml(setting.label)}</span>
          <span class="setting-desc">${escapeHtml(setting.description)}</span>
        </span>
        <span class="setting-value"></span>
        <svg class="setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="setting-editor" hidden>
        <input class="setting-input" data-setting="${escapeHtml(setting.key)}"
          type="${typeof setting.value === 'number' ? 'number' : 'text'}"
          value="${escapeHtml(String(setting.value))}"
          aria-label="${escapeHtml(setting.label)}" />
        <p class="setting-source">${escapeHtml(source)} — changes save as soon as you leave the field.</p>
      </div>
    </div>`.replace('<span class="setting-value"></span>', `<span class="setting-value">${escapeHtml(value)}</span>`);
  });

  /* ---- connections ------------------------------------------------------
     The pattern is Claude's connectors directory, which gets this right: a
     named thing, what it lets the app do, its state, and one obvious action —
     instead of a bare "Replace" beside a hash. */
  const connectionFor = (secret) => {
    const state_ = (SECRET_STATE[secret.source] || SECRET_STATE.missing)(secret);
    if (!matches(secret.label, secret.description, secret.name, state_.text)) return '';
    const detail = [
      secret.fingerprint ? `${secret.fingerprint}` : null,
      secret.source === 'stored' ? 'saved here' : secret.source === 'environment' ? `from ${secret.envVar}` : null,
      secret.updatedAt ? `updated ${relativeTime(secret.updatedAt)}` : null,
    ].filter(Boolean).join(' · ');
    return `
    <article class="connection" data-secret="${escapeHtml(secret.name)}">
      <div class="connection-head">
        <span class="connection-name">${escapeHtml(secret.label)}</span>
        <span class="pill ${state_.className}">${escapeHtml(state_.short)}</span>
      </div>
      <p class="connection-desc">${escapeHtml(secret.description)}</p>
      ${detail ? `<p class="connection-detail">${escapeHtml(detail)}</p>` : ''}
      <div class="secret-actions">
        <button class="primary" data-act="set" data-name="${escapeHtml(secret.name)}">${secret.source === 'stored' || secret.source === 'unreadable' ? 'Replace key' : 'Add key'}</button>
        ${secret.name === 'gemini_api_key'
          ? `<button data-act="test" data-name="${escapeHtml(secret.name)}">Test it</button>`
          : ''}
        ${secret.source === 'stored'
          ? `<button class="danger" data-act="remove" data-name="${escapeHtml(secret.name)}">Remove</button>`
          : ''}
      </div>
    </article>`;
  };
  const connections = data.secrets.map(connectionFor);

  const whatsapp = data.whatsapp;
  const whatsappPill = !whatsapp
    ? null
    : whatsapp.state === 'running'
      ? { className: 'ok', short: 'Connected' }
      : whatsapp.state === 'error'
        ? { className: 'bad', short: 'Not connecting' }
        : { className: 'muted', short: 'Off' };
  const whatsappNote = !whatsapp
    ? '<p class="connection-desc">The phone channel is not configured.</p>'
    : whatsapp.state === 'running'
      ? `<p class="connection-desc"><b>Connected${whatsapp.agentId ? ` as ${escapeHtml(whatsapp.agentId)}` : ''}.</b> Text the agent a task from your phone and it answers here too.</p>`
      : whatsapp.state === 'error'
        ? `<p class="connection-desc"><b>WhatsApp cannot connect.</b> ${escapeHtml(whatsapp.lastError || 'The platform refused the key.')} Generate a new API key in WhatsApp → Settings → Agents, and replace it here.</p>`
        : `<p class="connection-desc">${escapeHtml(whatsapp.detail || 'WhatsApp is not connected.')}</p>`;

  const encryptionNote = data.encryption.available
    ? '<p class="setting-source">Keys are encrypted with MASTER_KEY before they are stored, and never sent back to this screen — only a short fingerprint is.</p>'
    : `<p class="setting-source bad">${escapeHtml(data.encryption.hint || 'Storing secrets is unavailable.')}</p>`;

  const keysSet = data.secrets.filter((s) => s.source === 'stored' || s.source === 'environment').length;
  const visibleSettings = settingRows.filter(Boolean);
  const visibleConnections = connections.filter(Boolean);

  const emptyNote = '<p class="settings-empty">Nothing matches that.</p>';

  el.settingsBody.innerHTML =
    '<p class="settings-lead">Everything on this page applies the moment you change it. Nothing here needs a restart.</p>' +
    (visibleSettings.length
      ? section(
          `How it runs · ${visibleSettings.length}`,
          `<div class="settings-list">${visibleSettings.join('')}</div>`,
        )
      : query ? '' : '') +
    (visibleConnections.length
      ? section(
          `Connections · ${keysSet} of ${data.secrets.length} set`,
          `<div class="settings-list">${visibleConnections.join('')}</div>` + encryptionNote,
        )
      : query ? '' : '') +
    (matches('whatsapp', 'phone', whatsappNote) && !query
      ? section('The phone channel', `<div class="settings-list"><div class="setting-row">${whatsappPill ? `<div class="connection-head"><span class="connection-name">WhatsApp</span><span class="pill ${whatsappPill.className}">${whatsappPill.short}</span></div>` : ''}${whatsappNote}</div></div>`)
      : '') +
    (!query || matches('build', 'version', 'commit')
      ? section('About this build', '<div class="settings-list"><div class="setting-row" id="build-line"></div></div>')
      : '') +
    (!visibleSettings.length && !visibleConnections.length && query ? emptyNote : '');

  for (const input of el.settingsBody.querySelectorAll('.setting-input')) {
    input.addEventListener('change', () => saveSetting(input));
  }
  for (const summary of el.settingsBody.querySelectorAll('.setting-summary')) {
    summary.addEventListener('click', () => {
      const row = summary.closest('.setting-row');
      const editor = row.querySelector('.setting-editor');
      const open = summary.getAttribute('aria-expanded') === 'true';
      summary.setAttribute('aria-expanded', String(!open));
      editor.hidden = open;
      if (!open) editor.querySelector('.setting-input').focus();
    });
  }
  // The body element survives every re-render, so the delegated click handler
  // is bound once. Binding it per render stacked identical listeners, which
  // made one tap fire two saves.
  if (!settingsClickBound) {
    settingsClickBound = true;
    el.settingsBody.addEventListener('click', onSettingsClick);
  }
  void renderBuildLine();
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
  const row = button.closest('.connection');
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

  // The list first, the create-form behind a tap. Opening "Scheduled" used to
  // land the operator in six empty inputs — a form where the tasks should be —
  // which is most of why the drawer read as broken.
  el.schedulesBody.innerHTML = `
    ${rows.join('') || '<p class="memory-note">Nothing scheduled yet.</p>'}
    <button type="button" class="cta subtle" id="sch-new-toggle">New schedule</button>
    <div id="sch-form-wrap" hidden>
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
    </div>`;

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
    // loadScheduled re-renders the panel, which closes the form by itself.
  });

  // Bound once: renderScheduled re-runs on every change, and a second binding
  // would fire pause and delete twice.
  if (!el.schedulesBody.dataset.bound) {
    el.schedulesBody.dataset.bound = '1';
    el.schedulesBody.addEventListener('click', onScheduledClick);
  }
}

async function onScheduledClick(event) {
  const reveal = /** @type {HTMLElement | null} */ (event.target.closest('#sch-new-toggle'));
  if (reveal) {
    const wrap = el.schedulesBody.querySelector('#sch-form-wrap');
    if (wrap) wrap.hidden = !wrap.hidden;
    reveal.textContent = wrap && !wrap.hidden ? 'Cancel' : 'New schedule';
    if (wrap && !wrap.hidden) el.schedulesBody.querySelector('#sch-name')?.focus();
    return;
  }
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

/* Typing in the drawer searches as you type, and a slow reply must not overwrite
   a newer one: the sequence number is the whole debounce. */
let conversationSearchSeq = 0;
async function searchConversations() {
  const mine = ++conversationSearchSeq;
  try {
    const q = el.drawerSearch.value.trim();
    const { conversations } = await api(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (mine !== conversationSearchSeq) return; // a newer keystroke won
    state.conversations = conversations;
    renderConversations();
  } catch { /* silent: the list keeps what it had */ }
}

el.drawerSearch.addEventListener('input', () => {
  clearTimeout(el.drawerSearch.dataset.timer ? Number(el.drawerSearch.dataset.timer) : 0);
  const timer = setTimeout(searchConversations, 180);
  el.drawerSearch.dataset.timer = String(timer);
});

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
  void loadFeedbackSummary();
  switchScreen(() => {
    el.app.hidden = true;
    el.settingsScreen.hidden = false;
  });
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
  switchScreen(() => {
    el.settingsScreen.hidden = true;
    el.app.hidden = false;
  });
  if (!fromHistory) history.back();
}

el.settingsSearch.addEventListener('input', () => {
  state.settingsQuery = el.settingsSearch.value;
  renderSettings();
});
// Leaving the page clears the filter, so coming back never hides rows behind a
// search the operator has forgotten about.
el.settingsOpen.addEventListener('click', () => {
  el.settingsSearch.value = '';
  state.settingsQuery = '';
});
el.settingsBack.addEventListener('click', () => closeSettings());
window.addEventListener('popstate', () => closeSettings({ fromHistory: true }));
$('btn-close-drawer').addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

/* Outputs panel: close button and backdrop tap. Esc is bound while open. */
el.panelClose.addEventListener('click', closeOutputs);
el.panelBackdrop.addEventListener('click', closeOutputs);

function newTask() {
  state.freshAnswer = false;
  closeDrawer();
  // Starting a new task while one is running is not something the server allows
  // (it answers 409 while a run is active), so this button must not pretend the
  // running one is gone. It used to clear the thread, drop the stream and show
  // the starter cards *while the task was still working* — the live card
  // vanished, nothing was streaming, and the app looked idle and broken.
  if (liveRun()) {
    void ensureLiveRun({ announce: false });
    toast('Your task is still running — showing it live. Stop it to start another.');
    return;
  }
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

/** Forget this browser. Named so the palette and the button cannot drift apart. */
async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  closeDrawer();
  showLogin();
}

$('btn-signout').addEventListener('click', signOut);

/* ---------------------------------------------------------------- scroll -- */

let pinned = true;
el.stream.addEventListener('scroll', () => {
  const distance = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
  pinned = distance < 90;
  updateJumpPill();
}, { passive: true });

/**
 * The way back to the bottom.
 *
 * Following the stream stops the moment the operator scrolls up — otherwise
 * reading a paragraph while a task works is impossible. That made the bottom
 * unreachable except by hand-scrolling, which on a phone is a long drag. This
 * pill appears where the eye already is, says what is happening up there, and
 * returns in one tap.
 */
function updateJumpPill() {
  const pill = el.jump;
  if (!pill) return;
  const away = !pinned && (state.running || state.freshAnswer);
  pill.hidden = !away;
  if (!away) return;
  const done = !state.running;
  pill.classList.toggle('done', done);
  el.jumpLabel.textContent = done ? 'New answer — jump to it' : 'Working… jump to latest';
}

function jumpToLatest() {
  pinned = true;
  state.freshAnswer = false;
  el.jump.hidden = true;
  el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'smooth' });
}

el.jump?.addEventListener('click', jumpToLatest);

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
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // A bare URL is a link too. Models write them half the time, and text that
    // looks like a link but is not one reads as broken. Trailing punctuation is
    // left out, and the markdown-link form is skipped so nothing is linked twice.
    .replace(/(?<!href="|>)(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
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

/* ============================== the palette =============================
   One box for everything, on the keyboard. The research on this pattern is
   clear about the parts that matter: it holds actions *and* tasks, it is
   grouped and ranked (never a flat list), it teaches its own shortcuts, it is
   the same box on every screen, and on a phone — where there is no ⌘ — it has
   a visible way in.

   This half is only the wiring. Which rows appear, what order they are in, and
   where the highlight goes are pure functions in web/palette.js, because those
   are the decisions worth testing. */

let paletteOpen = false;
let paletteRows = [];
let paletteIndex = -1;
let paletteSeq = 0;
let paletteTimer = null;
let paletteReturnFocus = null;
/* A run this tab is not watching — closed tab, second device — is worth one
   row in the palette: it is the one thing here that changes on its own. */
let paletteRunningElsewhere = null;

function paletteRoot() {
  return el.palette;
}

function isPaletteOpen() {
  return paletteOpen;
}

function openPalette({ from = null } = {}) {
  if (paletteOpen) return;
  // Not on the login screen: every row there is an action for a session that
  // does not exist yet.
  if (!el.login.hidden) return;
  paletteOpen = true;
  paletteReturnFocus = from ?? document.activeElement;
  el.palette.hidden = false;
  el.paletteBackdrop.hidden = false;
  requestAnimationFrame(() => {
    el.paletteBackdrop.classList.add('show');
    el.palette.classList.add('open');
  });
  el.paletteInput.value = '';
  paletteIndex = -1;
  void refreshPalette('');
  // The input keeps focus the whole time: this is a combobox, and the list is
  // announced through aria-activedescendant rather than by moving focus.
  el.paletteInput.focus();
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  el.palette.classList.remove('open');
  el.paletteBackdrop.classList.remove('show');
  setTimeout(() => {
    el.palette.hidden = true;
    el.paletteBackdrop.hidden = true;
  }, 180);
  paletteRows = [];
  paletteIndex = -1;
  if (paletteReturnFocus && document.contains(paletteReturnFocus)) paletteReturnFocus.focus();
  paletteReturnFocus = null;
}

/** 140 ms behind the last keystroke: one request per pause, not per letter. */
function paletteTyped() {
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(() => void refreshPalette(el.paletteInput.value), 140);
}

async function refreshPalette(query) {
  const seq = ++paletteSeq;
  let conversations = [];
  let active = null;
  try {
    const q = String(query ?? '').trim();
    const [list, activeRun] = await Promise.all([
      api(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
      api('/api/runs/active').catch(() => ({ run: null })),
    ]);
    conversations = Array.isArray(list.conversations) ? list.conversations : [];
    active = activeRun?.run ?? null;
  } catch {
    // The palette still works without the task list: the actions are local.
  }
  if (seq !== paletteSeq || !paletteOpen) return; // a later keystroke won

  paletteRunningElsewhere = active && active.id !== state.runId ? active : null;
  const groups = buildResults({
    // Only offered while there is something to stop.
    actions: liveRun() ? RUNNING_ACTIONS : paletteRunningElsewhere ? RESUME_ACTIONS : [],
    conversations,
    query,
    activeConversationId: state.conversationId,
  });
  paletteRows = flatten(groups);
  paletteIndex = selectionAfter(paletteIndex, paletteRows.length);
  renderPalette(groups);
}

function renderPalette(groups) {
  el.paletteList.innerHTML = '';
  if (paletteRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'palette-empty';
    empty.setAttribute('role', 'status');
    // Written as a sentence, because a screen reader reads this out.
    empty.textContent = 'Nothing matches that yet. Try a word from a task, or a command like settings.';
    el.paletteList.append(empty);
    el.paletteInput.setAttribute('aria-activedescendant', '');
    return;
  }

  let index = -1;
  for (const group of groups) {
    const label = document.createElement('div');
    label.className = 'palette-group';
    label.textContent = group.label;
    el.paletteList.append(label);

    for (const row of group.rows) {
      index += 1;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'palette-row' + (row.kind === 'task' ? ' task' : '');
      option.id = `palette-row-${index}`;
      option.setAttribute('role', 'option');
      option.dataset.index = String(index);
      option.setAttribute('aria-selected', String(index === paletteIndex));

      const main = document.createElement('span');
      main.className = 'palette-main';
      const title = document.createElement('span');
      title.className = 'palette-label';
      title.textContent = row.label;
      main.append(title);
      if (row.hint) {
        const hint = document.createElement('span');
        hint.className = 'palette-hint';
        // A match inside a task shows the line it matched — "here is why this
        // is in the list".
        hint.textContent = row.matched === 'preview' ? `…${row.hint}` : row.hint;
        main.append(hint);
      }
      option.append(main);

      if (row.keys) {
        const keys = document.createElement('span');
        keys.className = 'palette-keys';
        for (const key of row.keys) {
          const chip = document.createElement('kbd');
          chip.textContent = key;
          keys.append(chip);
        }
        option.append(keys);
      }
      if (row.active) {
        const here = document.createElement('span');
        here.className = 'palette-here';
        here.textContent = 'open now';
        option.append(here);
      }

      option.addEventListener('click', () => runPaletteRow(index));
      el.paletteList.append(option);
    }
  }
  highlightPalette();
}

function highlightPalette() {
  const options = el.paletteList.querySelectorAll('.palette-row');
  options.forEach((option) => {
    const on = Number(option.dataset.index) === paletteIndex;
    option.setAttribute('aria-selected', String(on));
    option.classList.toggle('on', on);
    if (on) option.scrollIntoView({ block: 'nearest' });
  });
  const current = options[paletteIndex];
  el.paletteInput.setAttribute('aria-activedescendant', current ? current.id : '');
}

function movePalette(delta) {
  paletteIndex = moveSelection(paletteIndex, paletteRows.length, delta);
  highlightPalette();
}

async function runPaletteRow(index) {
  const row = paletteRows[index];
  if (!row) return;
  closePalette();
  switch (row.kind) {
    case 'task':
      await openConversation(row.id);
      return;
    case 'action':
      runPaletteAction(row.id);
      return;
    default:
      return;
  }
}

function runPaletteAction(id) {
  switch (id) {
    case 'new-task':
      newTask();
      return;
    case 'settings':
      openSettings();
      return;
    case 'theme':
      cycleTheme();
      return;
    case 'drawer':
      openDrawer();
      el.drawerSearch?.focus();
      return;
    case 'signout':
      void signOut();
      return;
    case 'stop':
      el.stop?.click();
      return;
    case 'resume':
      resumeRunningTask();
      return;
    case 'shortcuts':
      openKeys();
      return;
    default:
      return;
  }
}

function paletteKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    movePalette(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    movePalette(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (paletteIndex < 0 && paletteRows.length > 0) paletteIndex = 0;
    void runPaletteRow(paletteIndex);
    return;
  }
  if (event.key === 'Tab') {
    // The input keeps focus: Tab in a combobox moves through the listbox.
    event.preventDefault();
    movePalette(event.shiftKey ? -1 : 1);
  }
}

/** Pick up the run this tab is not watching — same path as the boot recovery. */
function resumeRunningTask() {
  const run = paletteRunningElsewhere;
  if (!run) return;
  paletteRunningElsewhere = null;
  state.conversationId = run.conversationId;
  renderAsk(run.prompt);
  attach(run.id, 0);
  setRunning(true);
  toast('A task is already running — showing it live.');
}

/** ⌘K on a Mac, Ctrl+K everywhere else — and the same keys close it again. */
function paletteShortcut(event) {
  if (!(event.key === 'k' || event.key === 'K')) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  if (paletteOpen) closePalette();
  else openPalette();
}

document.addEventListener('keydown', paletteShortcut);

/* ========================= keyboard shortcuts ===========================
   The cheat sheet behind `?`, and the two Escape gaps next to it.

   The list is data (SHORTCUT_GROUPS in web/palette.js) so it can be walked by
   a test; this file only draws it. */

let keysOpen = false;
let keysReturnFocus = null;

function openKeys(from = null) {
  if (keysOpen) return;
  keysOpen = true;
  keysReturnFocus = from ?? document.activeElement;
  el.keysSheet.hidden = false;
  el.keysBackdrop.hidden = false;
  if (el.keysList.childElementCount === 0) renderKeys();
  requestAnimationFrame(() => {
    el.keysBackdrop.classList.add('show');
    el.keysSheet.classList.add('open');
  });
  /** @type {HTMLButtonElement | null} */ (el.keysClose)?.focus();
}

function closeKeys() {
  if (!keysOpen) return;
  keysOpen = false;
  el.keysSheet.classList.remove('open');
  el.keysBackdrop.classList.remove('show');
  setTimeout(() => {
    el.keysSheet.hidden = true;
    el.keysBackdrop.hidden = true;
  }, 180);
  if (keysReturnFocus && document.contains(keysReturnFocus)) keysReturnFocus.focus();
  keysReturnFocus = null;
}

function renderKeys() {
  el.keysList.innerHTML = '';
  for (const group of SHORTCUT_GROUPS) {
    const head = document.createElement('div');
    head.className = 'palette-group';
    head.textContent = group.label;
    el.keysList.append(head);

    for (const row of group.rows) {
      const line = document.createElement('div');
      line.className = 'keys-row';
      const keys = document.createElement('span');
      keys.className = 'keys-keys';
      for (const key of row.keys) {
        const chip = document.createElement('kbd');
        chip.textContent = key;
        keys.append(chip);
      }
      const label = document.createElement('span');
      label.className = 'keys-label';
      label.textContent = row.label;
      line.append(keys, label);
      el.keysList.append(line);
    }
  }
}

/**
 * `?` opens the list — but never while the operator is typing.
 *
 * That guard is the whole difference between a shortcut and a bug: `?` is a
 * character people type, and a cheat sheet that appears in the middle of a
 * sentence is worse than no cheat sheet at all.
 */
function keysShortcut(event) {
  if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = /** @type {HTMLElement | null} */ (event.target);
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
  if (!el.login.hidden) return; // the login screen runs no shortcuts
  event.preventDefault();
  if (keysOpen) closeKeys();
  else openKeys();
}

document.addEventListener('keydown', keysShortcut);
el.keysClose?.addEventListener('click', () => closeKeys());
el.keysBackdrop?.addEventListener('click', () => closeKeys());

/**
 * Escape closes the drawer — the one overlay that was missing it. A drawer you
 * can only close with the mouse is a drawer that punishes the keyboard, and the
 * app has a command palette precisely because the keyboard matters here.
 *
 * Settings is a screen rather than an overlay, so Escape goes *back* from it,
 * the same thing the phone's back gesture and the header back arrow do.
 */
function escapeShortcut(event) {
  if (event.key !== 'Escape') return;
  if (keysOpen) {
    event.preventDefault();
    closeKeys();
    return;
  }
  if (el.palette.hidden === false) return; // the palette owns its own Escape
  if (!el.settingsScreen.hidden) {
    event.preventDefault();
    closeSettings();
    return;
  }
  if (!el.drawer.hidden || el.drawer.classList.contains('open')) {
    event.preventDefault();
    closeDrawer();
  }
}

document.addEventListener('keydown', escapeShortcut);

el.paletteInput?.addEventListener('input', paletteTyped);
el.paletteInput?.addEventListener('keydown', paletteKeydown);
el.paletteClose?.addEventListener('click', closePalette);
el.paletteBackdrop?.addEventListener('click', closePalette);
el.paletteButton?.addEventListener('click', (event) => openPalette({ from: event.currentTarget }));

/* ----------------------------------------------------------------- theme -- */

/* Light / dark / system. The choice persists on this device; "system" follows
   the OS. The attribute is set on <html> as data-theme before first paint by
   the inline snippet in index.html — this only owns the toggle and OS
   changes. Zero network cost: everything is local. */
const THEME_KEY = 'codex-theme';
/* The class is part of the icon, not decoration: a bare inline SVG in a flex
   row has no intrinsic size and grows to fill the container — which is how this
   row once rendered as a moon the width of the drawer. */
const THEME_ICONS = {
  light:
    '<svg class="drawer-row-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>',
  dark:
    '<svg class="drawer-row-icon" viewBox="0 0 24 24"><path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/></svg>',
  system:
    '<svg class="drawer-row-icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>',
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
  // One place to read the current theme, and it says so twice: the drawer row
  // prints the state in words, and its mark changes to match (sun, moon, or
  // monitor for "follow the system"), which an icon alone could never do.
  // The mark is swapped, the label node is left where it is: rebuilding the row
  // would throw away the focused element under the operator's finger.
  const mark = $('btn-theme-2')?.querySelector('svg');
  if (mark) mark.outerHTML = THEME_ICONS[pref] || THEME_ICONS.system;
  const label = $('theme-label');
  if (label) label.textContent = `Theme: ${pref}`;
}

/** Light → dark → follow the system → light. One behaviour, several ways in. */
function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(themePreference()) + 1) % order.length];
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode: apply for this session only */
  }
  applyTheme(next);
}

function initTheme() {
  applyTheme(themePreference());
  // Two ways in, one behaviour: the drawer's row, and the palette's "Switch
  // theme". (The top bar's icon is gone — on a phone it was the fifth control
  // in the row, and the drawer says it better.)
  const btn = $('btn-theme-2');
  if (btn) btn.addEventListener('click', cycleTheme);
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
  setupStopButton();
  setupVoiceInput();
  try {
    await api('/api/auth/session');
    await enter();
  } catch {
    showLogin();
  }
})();

window.addEventListener('pagehide', closeStream);
