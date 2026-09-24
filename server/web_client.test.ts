/**
 * The mobile client's furniture, pinned.
 *
 * Every case here is a bug the operator actually hit on a phone:
 *
 *  - the composer's token-estimate chip sat *after* the send button in a single
 *    line of `nowrap` content, so the row was wider than the phone. That made
 *    the whole page horizontally scrollable, and one sideways pan (or the
 *    keyboard scrolling the focused box into view) slid every message bubble
 *    off the left edge — the screenshots that started this.
 *  - Settings was a collapsible section inside the drawer: not a page, and not
 *    something the phone's back gesture could leave.
 *  - the finished task's action row carried an "Edit prompt" button, which
 *    reads as an action on the *answer*. Editing belongs to the operator's own
 *    message, where it already lives.
 *
 * These are structural assertions on the shipped markup, stylesheet and client,
 * in the same spirit as brand.test.ts: cheap, and they fail the moment someone
 * puts the row back together the way it was.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const html = () => read('web/index.html');
const css = () => read('web/styles.css');
const app = () => read('web/app.js');

describe('the run timer is one clock in three places', () => {
  test('the top bar carries it, so scrolling the panel away cannot hide it', () => {
    assert.ok(html().includes('id="run-timer"'), 'the bar has a slot for it');
    assert.ok(html().includes('role="timer"'), 'and announces itself as a timer');
    const client = app();
    assert.ok(client.includes("runTimer: $('run-timer')"), 'the client holds it');
    assert.ok(client.includes('if (card.runId && card.runId === state.runId) showRunTimer(text);'));
    assert.ok(
      client.includes('if (card.runId && card.runId === state.runId) showRunTimer(null);'),
      'and the finished task clears it',
    );
    assert.ok(client.includes('if (!on) showRunTimer(null);'), 'a stopped task never leaves one ticking');
    assert.ok(css().includes('.run-timer'), 'set in the same figures as the panel clock');
  });

  test('the tab shows the time, because the operator leaves the tab', () => {
    const client = app();
    assert.ok(
      client.includes("document.title = text ? `${text} · WAIS` : 'WAIS';"),
      'the tab says the time while the task runs and the product name when it is done',
    );
  });

  test('an old card replaying does not drive the clock', () => {
    // The trap: a reopened conversation replays cards from finished tasks, and
    // each one has its own clock. Only the live run owns the bar and the tab.
    const client = app();
    assert.ok(
      client.includes('card.runId === state.runId'),
      'ownership is checked, not assumed',
    );
    const css2 = css();
    assert.ok(!css2.includes('.run-timer { animation'), 'and the number does not twitch');
  });
});

describe('a picture in the composer', () => {
  test('the picker offers images, and the client carries them as base64', () => {
    assert.ok(html().includes('image/*'), 'the file picker offers pictures');
    const client = app();
    assert.ok(client.includes('readAsDataURL'), 'read in the browser, never uploaded to be looked at');
    assert.ok(client.includes("if (file.type.startsWith('image/'))"), 'pictures take their own path');
    assert.ok(
      client.indexOf("file.type.startsWith('image/')") < client.indexOf('not a text file'),
      'and a PNG is not read as text first and refused for being binary',
    );
    assert.ok(client.includes('images.push({ name: file.name.slice(0, 120), mimeType: mime, data })'));
    assert.ok(client.includes("...(pictures.length ? { images: pictures } : {})"), 'sent with the prompt');
  });

  test('the caps are the server\u2019s caps, refused with a sentence naming the file', () => {
    const client = app();
    assert.ok(client.includes('const IMAGE_LIMIT = 3;'), 'three pictures');
    assert.ok(client.includes('const IMAGE_BYTES = 2_000_000;'), 'and the same per-image ceiling');
    assert.ok(client.includes('const IMAGE_TOTAL = 4_000_000;'), 'and the same total');
    for (const phrase of ['only ${IMAGE_LIMIT} images per task', 'larger than ${formatBytes(IMAGE_BYTES)}', 'the pictures add up to more than']) {
      assert.ok(client.includes(phrase), `and it says so: ${phrase}`);
    }
  });

  test('a picture shows as a thumbnail with its name, and can be taken back off', () => {
    const client = app();
    assert.ok(client.includes('<img class="thumb" alt="" />'), 'a thumbnail, not a filename');
    assert.ok(client.includes('thumb.src = `data:${picture.mimeType};base64,${picture.data}`'), 'drawn from the bytes already in hand');
    assert.ok(client.includes("aria-label=\"Remove this picture\""), 'removable');
    assert.ok(client.includes('images = images.filter((i) => i !== picture);'), 'and removing it removes it');
    assert.ok(css().includes('.attach-chip .thumb'), 'sized like a chip, not a photo');
  });

  test('a task with no picture sends exactly what it sent before', () => {
    const client = app();
    assert.ok(client.includes("...(files.length ? { attachments: files } : {}),"), 'files unchanged');
    assert.ok(!client.includes('images: pictures, }'), 'and no empty images array is invented');
  });
});

describe('the composer fits a phone', () => {
  test('no token cap and no estimate chip', () => {
    for (const marker of ['token-cap', 'estimate-line', 'estimate-text', 'cap-toggle']) {
      assert.ok(!html().includes(marker), `index.html still carries ${marker}`);
      assert.ok(!css().includes(marker), `styles.css still styles ${marker}`);
      assert.ok(!app().includes(marker), `app.js still reads ${marker}`);
    }
  });

  test('no run can be capped: the client never sends a token budget', () => {
    assert.ok(!app().includes('tokenBudget'), 'the client sends no token budget');
  });

  test('the composer row wraps instead of overflowing', () => {
    const row = css().slice(css().indexOf('.composer-row {'));
    const rule = row.slice(0, row.indexOf('}'));
    assert.ok(rule.includes('flex-wrap: wrap'), 'a rigid row is what shoved the page sideways');
  });

  test('the finished-task action row wraps too', () => {
    // Three pills wide on a phone — the other half of the sideways-drift bug.
    const cssText = css();
    const notice = cssText.slice(cssText.indexOf('.notice {'));
    assert.ok(notice.slice(0, notice.indexOf('}')).includes('flex-wrap: wrap'), 'the notice wraps');
    const buttons = cssText.slice(cssText.indexOf('.run-btns {'));
    assert.ok(buttons.slice(0, buttons.indexOf('}')).includes('flex-wrap: wrap'), 'and so do its buttons');
  });

  test('nothing can scroll the page sideways', () => {
    const body = css().slice(css().indexOf('html, body {'));
    assert.ok(
      body.slice(0, body.indexOf('}')).includes('overflow-x: clip'),
      'body clips horizontal overflow (clip, not hidden: hidden breaks the sticky composer)',
    );
  });

  test('the older-engine fallback does not break the sticky composer', () => {
    // `overflow-x: hidden` on body turns it into a scroll container and freezes
    // `position: sticky`; on html it propagates to the viewport and is safe. So
    // the fallback must be scoped to engines without `clip`, and must name html.
    const cssText = css();
    const scoped = cssText.slice(cssText.indexOf('@supports not (overflow: clip)'));
    const rule = scoped.slice(0, scoped.indexOf('}'));
    assert.ok(rule.includes('html { overflow-x: hidden'), 'the fallback is html-scoped');
    assert.ok(!rule.includes('body'), 'and never touches body');
  });
});

describe('settings is a page, not a drawer section', () => {
  test('it is a third screen with a back control', () => {
    const page = html();
    assert.ok(page.includes('id="screen-settings"'), 'the settings screen exists');
    assert.ok(page.includes('id="btn-settings-back"'), 'and has a way back');
    assert.ok(page.includes('id="settings-body"'), 'the body kept its id, so the panel code is unchanged');
  });

  test('the drawer links to it rather than expanding in place', () => {
    const page = html();
    assert.ok(page.includes('id="btn-settings"'), 'the drawer has the entry point');
    assert.ok(!page.includes('settings-toggle'), 'the old collapsible toggle is gone');
  });

  test('the back gesture closes it', () => {
    const client = app();
    assert.ok(client.includes("history.pushState({ wais: 'settings' }"), 'opening pushes one history entry');
    assert.ok(client.includes("window.addEventListener('popstate'"), 'and back closes the page');
    assert.ok(client.includes('function closeSettings'), 'closeSettings exists');
  });

  test('showing the app or the login hides the settings page', () => {
    const client = app();
    const showLogin = client.slice(client.indexOf('function showLogin()'), client.indexOf('function showApp()'));
    const showApp = client.slice(client.indexOf('function showApp()'), client.indexOf('function showApp()') + 400);
    assert.ok(showLogin.includes('el.settingsScreen.hidden = true'), 'login hides it');
    assert.ok(showApp.includes('el.settingsScreen.hidden = true'), 'the app screen hides it');
  });
});

describe('every event the server writes is listened to', () => {
  test('no event is emitted into the void', () => {
    // `sources.checked` was written on every research run — the server fetches
    // each link in the answer and reports how many are dead — and the client
    // never subscribed to it, so the work happened and the operator saw
    // nothing. The `case` was sitting in handleEvent() the whole time.
    const fsmod = read('web/app.js');
    const durable = fsmod.slice(fsmod.indexOf('const durable = ['), fsmod.indexOf('for (const name of durable)'));
    const listened = new Set([...durable.matchAll(/'([\w.]+)'/g)].map((m) => m[1]));
    const handled = new Set([...fsmod.matchAll(/case '([\w.]+)':/g)].map((m) => m[1]));

    const serverDir = path.join(ROOT, 'server');
    const emitted = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          for (const m of fs.readFileSync(full, 'utf-8').matchAll(/writer\.write\(\s*'([\w.]+)'/g)) {
            emitted.add(m[1]);
          }
        }
      }
    };
    walk(serverDir);

    assert.ok(emitted.size >= 10, 'the scan found the server\u2019s events');
    for (const name of emitted) {
      assert.ok(listened.has(name), `the client never listens for ${name}`);
      assert.ok(handled.has(name), `the client listens for ${name} but has no case for it`);
    }
  });

  test('no case is left without a listener', () => {
    // The same bug from the other end. `run.paused` had a handler and a status
    // the server declares it can emit — `setRunStatus` takes 'paused' and writes
    // `run.${status}`, and the resume endpoint treats a paused run as
    // resumable — but nothing subscribed to it, so pausing a task would have
    // looked exactly like a hang.
    const fsmod = read('web/app.js');
    const durable = fsmod.slice(fsmod.indexOf('const durable = ['), fsmod.indexOf('for (const name of durable)'));
    const listened = new Set([
      ...[...durable.matchAll(/'([\w.]+)'/g)].map((m) => m[1]),
      ...[...fsmod.matchAll(/source\.addEventListener\('([\w.]+)'/g)].map((m) => m[1]),
    ]);
    const handled = [...fsmod.matchAll(/case '([a-z][\w.]*\.[\w.]+)':/g)].map((m) => m[1]);
    assert.ok(handled.length >= 15, `the scan found the client's cases (${handled.length})`);
    for (const name of handled) {
      assert.ok(listened.has(name), `handleEvent handles ${name} but nothing listens for it`);
    }
  });
});

describe('a sleeping server does not look like a broken app', () => {
  test('the boot says so when it is slow', () => {
    const client = app();
    const boot = client.slice(client.indexOf('async function enter()'));
    assert.ok(boot.includes('BOOT_NOTICE_MS'), 'there is a threshold');
    assert.ok(/Waking the server/.test(boot), 'and something honest to say');
    assert.ok(boot.includes('if (noticeShown) note('), 'cleared when the answer arrives, without wiping a newer note');
  });

  test('starting a task says so while the request is in flight', () => {
    // POST /api/runs does not answer until the run exists — and a complex task
    // drafts its plan inside that request. The operator saw their own message and
    // then nothing, which reads exactly like the app being broken.
    const client = app();
    assert.ok(client.includes('function pendingRunNotice'), 'there is a placeholder');
    assert.ok(client.includes("renderNotice('Starting the task…'"), 'with something to say');
    assert.ok(client.includes('drafts its plan first'), 'and a reason once it is taking a while');
    assert.ok(client.includes('pending.done()'), 'and it is taken away when the run exists');
  });

  test('a navigation never waits on the network forever', () => {
    // Network-first with no ceiling means a blank page for the ~50 s a free-tier
    // cold start takes. The cached shell is shown after the ceiling; the request
    // itself is not aborted, so the cache still updates.
    const sw = read('web/sw.js');
    assert.ok(sw.includes('NAVIGATION_TIMEOUT_MS'), 'there is a ceiling');
    assert.ok(sw.includes('settleWithin(network, NAVIGATION_TIMEOUT_MS)'), 'the navigation races it');
    assert.ok(sw.includes("await caches.match('/index.html')"), 'with the shell as the fallback');
  });
});

describe('a plan that arrived while the phone was away is recoverable', () => {
  test('returning to the foreground replays a waiting plan into its card', () => {
    // The run card is the only place to approve a plan. If `run.plan_ready`
    // arrived while the phone was backgrounded, the stream carrying it died with
    // the tab — and the card then shows no Approve button, no explanation, and a
    // Stop button that cancels the task. Coming back has to recover it.
    const client = app();
    const vis = client.slice(client.indexOf("addEventListener('visibilitychange'"));
    const handler = vis.slice(0, vis.indexOf("});", vis.indexOf('awaiting_plan')));
    assert.ok(handler.includes("run.status === 'awaiting_plan'"), 'the waiting state is recognised');
    assert.ok(handler.includes('attach(run.id, 0)'), 'and the run is replayed into its card');
    assert.ok(handler.includes('setRunning(false)'), 'with the composer unlocked, since nothing is running');
  });

  test('a re-attach reuses the card instead of stacking a second one', () => {
    const client = app();
    assert.ok(client.includes('function cardFor(runId)'), 'cards are findable by run');
    assert.ok(client.includes('card.dataset.runId = runId'), 'because they carry the id');
    assert.ok(client.includes('function existingCard(runId)'), 'and a handle can be rebuilt');
    assert.ok(client.includes('cardFor(runId) ? existingCard(runId) : createRunCard(runId)'), 'attach prefers the existing card');
  });

  test('a reused card starts its replay from a clean slate', () => {
    // Otherwise the replayed thinking and answer append to what the card already
    // showed, and the operator reads the same paragraph twice.
    const client = app();
    const existing = client.slice(client.indexOf('function existingCard'), client.indexOf('function createRunCard'));
    assert.ok(existing.includes("thinkingText: ''"), 'thinking buffer reset');
    assert.ok(existing.includes("answerText: ''"), 'answer buffer reset');
    assert.ok(existing.includes('stepIndex: new Map()'), 'step index reset');
  });
});

describe('a task still working survives a look at another chat', () => {
  test('reopening the chat its card belongs to brings the card back', () => {
    // The live card is a DOM node, and opening a chat replaces the whole thread
    // — so walking to another chat and back left the operator with their own
    // question, no answer arriving, no spinner, "Working…" in the header and a
    // locked composer. A running task that looks lost is worse than one that
    // looks stuck: there is nothing to press either.
    const client = app();
    assert.ok(client.includes('function liveRun()'), 'there is one definition of "still live"');
    assert.ok(
      client.includes('if (message.runId && message.runId === state.runId) ownsLiveRun = true;'),
      'the thread recognises the run it owns',
    );
    assert.ok(client.includes('if (ownsLiveRun) attach(state.runId, 0);'), 'and replays it into a card again');
    assert.ok(client.includes('if (liveRun()) {'), 'the guard asks whether the run is live, not whether the composer is locked');
  });

  test('waiting for a plan to be approved counts as live', () => {
    // A plan waiting for a tap is not "running", but it is not over either: its
    // card is the only place to approve it.
    const client = app();
    assert.ok(
      client.includes("const LIVE_RUN_STATUSES = ['planning', 'running', 'awaiting_plan'];"),
      'all three states are live — including a plan still being drafted',
    );
    assert.ok(/state\.runStatus = 'awaiting_plan';/.test(client), 'a waiting plan is recorded');
    assert.ok(/state\.runStatus = 'finished';/.test(client), 'and finishing clears it');
  });

  test('another chat says where the running task is, and offers the way back', () => {
    const client = app();
    assert.ok(client.includes('function renderLiveRunElsewhere()'), 'there is a note for it');
    assert.ok(client.includes('is waiting for your approval'), 'worded for a plan that waits');
    assert.ok(client.includes('is still running'), 'and for one that works');
    assert.ok(client.includes("show.textContent = 'Show it'"), 'with a way to reach the card');
    assert.ok(client.includes('openConversation(owner.id)'), 'which opens the chat that owns the run');
  });

  test('the card learns which chat owns it from the run itself', () => {
    // Every path that goes live — first send, retry, resume, plan approval,
    // recovery — replays `run.started`, so the owner is never guessed.
    const client = app();
    const started = client.slice(client.indexOf("case 'run.started'"), client.indexOf("case 'log'"));
    assert.ok(
      started.includes("if (typeof data.conversationId === 'string') state.runConversationId = data.conversationId;"),
      'the owning chat comes from the run, not from wherever the operator happens to be',
    );
  });
});

describe('the composer is one card, like every chat app that got this right', () => {
  test('the field and its controls are one card, not a field beside a row of pills', () => {
    // Three labelled toggles beside the field is what squeezed it to nothing on
    // a 390px phone. The field goes on top; one row of controls goes under it.
    const cssText = css();
    const card = cssText.slice(cssText.indexOf('.composer {'));
    const rule = card.slice(0, card.indexOf('}'));
    assert.ok(rule.includes('flex-direction: column'), 'the card stacks');
    assert.ok(rule.includes('max-width: 680px'), 'and shares the thread’s measure');
    const htmlText = html();
    assert.ok(htmlText.indexOf('id="prompt"') < htmlText.indexOf('class="composer-row"'), 'field first, controls under it');
    assert.ok(cssText.includes('.composer:focus-within'), 'the card shows it has focus');
  });

  test('the mode is one control that unfolds in the composer — there is no modal', () => {
    const htmlText = html();
    assert.ok(htmlText.includes('id="btn-mode"'), 'one mode control');
    assert.ok(htmlText.includes('aria-controls="composer-tray"'), 'that unfolds the tray it names');
    assert.ok(htmlText.includes('id="composer-tray"'), 'which lives in the composer');
    // The complaint that retired the sheet: it arrived on its own over a task
    // the operator had not asked a question about. A modal cannot arrive if
    // there is no modal.
    assert.ok(!htmlText.includes('id="mode-sheet"'), 'the modal sheet is gone');
    assert.ok(!htmlText.includes('sheet-backdrop'), 'and so is its backdrop');
    assert.ok(!htmlText.includes('aria-haspopup="dialog"'), 'the chip no longer promises a dialog');
    assert.ok(!htmlText.includes('research-toggle'), 'the labelled research pill is still gone');
    const client = app();
    assert.ok(client.includes('function toggleModeTray()'), 'the tray opens and closes on the chip');
    assert.ok(!client.includes('openModeSheet'), 'nothing else can open it');
    assert.ok(client.includes('el.modeStandard.setAttribute('), 'the options carry their checked state');
    assert.ok(client.includes("el.modeLabel.textContent = `Deep research · ${mins} min`"), 'and the chip says what is on');
    assert.ok(css().includes('.composer-tray'), 'the tray is a block in the composer, not an overlay');
  });

  test('one trailing control: mic, send, or stop — and the send button is never missing', () => {
    const client = app();
    assert.ok(client.includes('function setupStopButton()'), 'the stop button moves into the composer');
    assert.ok(client.includes('function updateTrailingAction()'), 'and the slot is managed in one place');
    assert.ok(client.includes('const micHasSlot = micUsable && !typing && !state.running;'), 'the mic holds the slot only while there is nothing to send');
    assert.ok(client.includes('el.send.hidden = state.running || micHasSlot;'), 'so typing brings the send button out, where it used to vanish');
    // The old line hid the button *because* the operator was typing. It was
    // covered by a test that asserted the same wrong sentence, which is how a
    // missing send button survived a round of its own bug fixes.
    assert.ok(!client.includes('el.send.hidden = state.running || typing'), 'the inverted rule is gone for good');
    assert.ok(client.includes('const micUsable = !!el.mic && !el.mic.disabled;'), 'the slot is never left empty when the mic cannot work');
  });

  test('a file can actually be attached, and the browser refuses what the server would', () => {
    const client = app();
    assert.ok(client.includes('el.attach.addEventListener'), 'the plus opens the picker');
    assert.ok(client.includes('const ATTACH_LIMIT = 3'), 'three files');
    assert.ok(client.includes('const ATTACH_BYTES = 200_000'), '200 KB each');
    assert.ok(client.includes("text.includes('\\uFFFD')"), 'a binary is refused here, not sent');
    assert.ok(client.includes('file.text()'), 'read in the browser');
    assert.ok(client.includes('...(files.length ? { attachments: files } : {})'), 'and carried in the request');
    assert.ok(client.includes('clearAttachments()'), 'the chips clear with the task');
  });

  test('the field is 16px so iOS never zooms the page', () => {
    const cssText = css();
    const field = cssText.slice(cssText.indexOf('.composer textarea {'));
    assert.ok(field.slice(0, field.indexOf('}')).includes('font-size: 16px'), 'anything smaller and the page zooms on focus');
  });
});

describe('the conversation reads like a conversation', () => {
  test('the operator\u2019s message is a bubble, the answer is prose at a measure', () => {
    // A black slab of paper-white text for every question was heavier than
    // anything else on the screen — backwards, since the answer is what is being
    // read. Questions are a warm tint of the ink; answers are plain prose, held
    // to a reading width so a long answer is a document and not a wall.
    const css = read('web/styles.css');
    const ask = css.slice(css.indexOf('.ask {'));
    assert.ok(ask.slice(0, ask.indexOf('}')).includes('var(--bubble-user)'), 'the bubble is tinted, not solid ink');
    const answer = css.slice(css.indexOf('.answer {'));
    assert.ok(answer.slice(0, answer.indexOf('}')).includes('max-width: var(--measure)'), 'answers are measured');
    const tokens = read('web/theme.css');
    assert.ok(tokens.includes('--measure:'), 'the measure is a token');
    assert.ok(tokens.includes('--bubble-user:'), 'and so is the bubble');
    assert.ok(tokens.includes('color-mix(in srgb, #ffffff 9%, var(--surface))'), 'the dark theme re-mixes it rather than re-declaring a colour');
  });

  test('an assistant turn says who is speaking', () => {
    const client = app();
    assert.ok(client.includes('function answerHead()'), 'there is a mark');
    assert.ok(client.includes('answerHead() + markdown(text)'), 'drawn over every answer');
  });

  test('message actions get out of the way until they are wanted', () => {
    // Rows of bordered pills under every message made the thread look like a
    // settings screen. They are now quiet ghost controls, revealed on hover or
    // focus — and always visible on a touch screen, where there is no hover.
    const css = read('web/styles.css');
    const block = css.slice(css.indexOf('.msg-actions {'));
    const rule = block.slice(0, block.indexOf('}'));
    assert.ok(rule.includes('opacity: 0'), 'hidden by default');
    assert.ok(css.includes('.ask:hover .msg-actions, .answer:hover .msg-actions'), 'shown on hover');
    assert.ok(css.includes('.msg-actions:focus-within'), 'and when something inside has focus');
    assert.ok(css.includes('@media (hover: none) { .msg-actions { opacity: 1; } }'), 'but never hidden from a thumb');
  });

  test('copy is one tap, with a fallback for a context without clipboard access', () => {
    const client = app();
    assert.ok(client.includes('async function copyToClipboard('), 'there is a copy helper');
    assert.ok(client.includes('navigator.clipboard?.writeText'), 'the modern path');
    assert.ok(client.includes("document.execCommand('copy')"), 'and the one that works on http');
    assert.ok(client.includes("msgButton({ icon: 'copy'"), 'offered on every message');
  });

  test('a finished run folds its working into one line', () => {
    const client = app();
    assert.ok(client.includes('function foldWork('), 'there is a fold');
    assert.ok(client.includes("line.className = 'run-summary'"), 'one line stands in for the timeline');
    assert.ok(client.includes("card.card.classList.add('work-collapsed')"), 'and the timeline is closed');
    assert.ok(client.includes("line.setAttribute('aria-expanded'"), 'with a state a screen reader can hear');
    const css = read('web/styles.css');
    assert.ok(css.includes('.run.work-collapsed .thinking'), 'the fold actually hides the working');
  });

  test('the working shows a clock while it works', () => {
    const client = app();
    assert.ok(client.includes('function startRunClock('), 'there is a clock');
    assert.ok(client.includes('setInterval(tick, 250)'), 'ticking faster than the second it shows, so the second rolls over when it changes');
    assert.ok(client.includes('stopRunClock(card)'), 'stopped when the run ends');
    assert.ok(client.includes('thinkingClock'), 'and drawn in the run header');
    // A stopwatch, not a counter: the number the operator reads is the one the
    // tools they already use show next to a spinner.
    assert.ok(client.includes('formatTimer(elapsed)'), 'formatted as a clock');
    const clockBlock = css().slice(css().indexOf('.thinking-head .clock'));
    assert.ok(
      clockBlock.slice(0, clockBlock.indexOf('}')).includes('font-variant-numeric: tabular-nums'),
      'and set in figures that do not jog sideways every second',
    );
    assert.ok(client.includes("import {"), 'from the pure module the tests drive directly');
  });

  test('a message arrives rather than appears', () => {
    const css = read('web/styles.css');
    assert.ok(css.includes('@keyframes rise'), 'there is an entrance');
    assert.ok(css.includes('.thread > * { animation: rise'), 'used by every turn');
    const tokens = read('web/theme.css');
    assert.ok(tokens.includes('@media (prefers-reduced-motion: reduce)'), 'every animation is switched off');
    assert.ok(tokens.includes('transition-duration: .001ms !important'), 'for a device that asked for no motion');
  });
});

describe('the drawer is the front door', () => {
  test('search is on top, one obvious way to start, actions at the foot', () => {
    const htmlText = html();
    const search = htmlText.indexOf('id="drawer-search"');
    const fresh = htmlText.indexOf('id="btn-new-2"');
    const list = htmlText.indexOf('id="convos"');
    const foot = Math.max(htmlText.indexOf('id="drawer-actions"'), htmlText.indexOf('class="drawer-actions"'));
    assert.ok(search > 0 && search < fresh, 'search sits above the list');
    assert.ok(fresh < list, 'and “New task” is the first thing after it');
    assert.ok(foot > list, 'settings, theme and sign-out live at the bottom, where a thumb rests');
    assert.ok(htmlText.includes('aria-label="Recent tasks"'), 'the list is a labelled region');
  });

  test('a row remembers the task: title, last thing said, and when', () => {
    const client = app();
    assert.ok(client.includes('convo.preview'), 'the row shows the last message');
    assert.ok(client.includes("meta.className = 'convo-preview'"), 'on its own line under the title');
    assert.ok(client.includes("date.className = 'convo-date'"), 'with the date kept to one side');
    assert.ok(client.includes('function dayLabel('), 'and the list is grouped by day');
  });

  test('search asks the server, not just the loaded page', () => {
    // The list is capped at fifty rows; filtering only what is in the browser
    // would find nothing older than that.
    const client = app();
    assert.ok(client.includes('function searchConversations()'), 'there is a search');
    assert.ok(client.includes('/api/conversations${q ? `?q=${encodeURIComponent(q)}`'), 'which sends the query');
    assert.ok(client.includes('if (mine !== conversationSearchSeq) return;'), 'and drops a reply a newer keystroke has overtaken');
  });

  test('the empty state is a menu, not a sentence', () => {
    const welcome = read('web/welcome.js');
    assert.ok(welcome.includes('hint:'), 'every starter says what it does');
    const client = app();
    assert.ok(client.includes("label.className = 'chip-label'"), 'the card has a title');
    assert.ok(client.includes("hint.className = 'chip-hint'"), 'and a line under it');
  });

  test('screen changes animate where the browser can, and not where it should not', () => {
    const client = app();
    assert.ok(client.includes('function switchScreen('), 'one place changes screens');
    assert.ok(client.includes('doc.startViewTransition'), 'using the platform transition');
    assert.ok(client.includes("matchMedia('(prefers-reduced-motion: reduce)')"), 'skipped entirely for a reader who asked for less motion');
    const cssText = css();
    assert.ok(cssText.includes('::view-transition-new(root)'), 'and the animation is declared');
    assert.ok(cssText.includes('@keyframes draw'), 'the welcome mark draws itself in');
  });
});

describe('a kept file can actually be kept', () => {
  test('the panel and the answer both offer a Keep button', () => {
    const client = app();
    assert.ok(client.includes('function keepButton'), 'the button exists');
    assert.ok(client.includes('keepButton(artifact)'), 'and is used');
    assert.ok(client.includes('/api/artifacts/${artifact.id}/'), 'it calls the artifact routes');
    assert.ok(client.includes("pinning ? 'pin' : 'unpin'"), 'pin to keep, unpin to stop keeping');
  });

  test('a kept file is shown as kept everywhere it appears', () => {
    const client = app();
    // The card's second line is built by artifactMeta, which is the same
    // function the repaint uses — so the answer's card, the panel's card and
    // whatever the operator just tapped can never disagree.
    assert.ok(client.includes('artifactMeta(artifact, formatBytes)'), 'the meta line says it is kept');
    assert.ok(client.includes('refreshArtifactChips'), 'and every view is repainted from the record');
    assert.ok(css().includes('.result.kept'), 'with a style of its own');
    assert.ok(client.includes("card.className = 'result' + (artifact.pinned ? ' kept' : '')"), 'on the card itself');
  });

  test('a failed pin explains itself instead of failing silently', () => {
    const client = app();
    assert.ok(client.includes("err.body?.message || err.message || 'Could not keep that file.'"), 'the reason is surfaced');
  });
});

describe('the panel is a column when there is room for one', () => {
  test('above the threshold the thread narrows instead of being covered', () => {
    const client = app();
    assert.ok(client.includes('PANEL_DOCK_MIN_WIDTH,'), 'the threshold comes from the layout module');
    assert.ok(client.includes('panelPlacement(window.innerWidth ?? PANEL_DOCK_MIN_WIDTH)'), 'and the width decides');
    assert.ok(client.includes("el.screenApp?.classList.toggle('docked', docked)"), 'the app gets a docked mode');
    assert.ok(client.includes('window.addEventListener(\'resize\', applyPanelPlacement)'), 'and follows a resize');
    assert.ok(css().includes('.app.docked { padding-right: var(--panel-w); }'), 'the column is reserved, not overlaid');
    assert.ok(css().includes('.app.docked .panel-backdrop { display: none !important; }'), 'with no scrim');
  });

  test('a split keeps no scrim to click through, and gives the column back', () => {
    const client = app();
    assert.ok(client.includes("if (panelMode() === 'docked') applyPanelPlacement();"), 'opening decides the mode');
    assert.ok(client.includes("el.screenApp?.classList.remove('docked')"), 'closing hands the width back');
    assert.ok(css().includes('@media (min-width: 1100px)'), 'the split is declared for wide windows only');
  });

  test('the jump pill sits above the composer at every width', () => {
    // It is positioned against the composer wrapper; outside it, `bottom: 100%`
    // resolves against the screen and puts it off the top of the viewport.
    const page = html();
    const wrap = page.indexOf('class="composer-wrap"');
    const pill = page.indexOf('id="jump-latest"');
    const form = page.indexOf('id="composer"');
    assert.ok(wrap > -1 && pill > wrap && pill < form, 'the pill lives inside the composer wrapper');
    assert.ok(css().includes('bottom: calc(100% + 8px);'), 'and clears the composer');
  });
});

describe('reading while it works', () => {
  test('the stream stops following the bottom when the operator scrolls up', () => {
    // Auto-scrolling through a paragraph somebody is reading is the single most
    // common way a chat UI becomes unusable.
    const client = app();
    assert.ok(client.includes('pinned = distance < 90;'), 'a scroll away from the bottom unpins the stream');
    assert.ok(client.includes('if (!force && !pinned) return;'), 'and nothing drags it back while they read');
  });

  test('there is one tap back to the bottom, and it says what is happening', () => {
    const client = app();
    assert.ok(client.includes('function updateJumpPill()'), 'the pill has one owner');
    assert.ok(client.includes("el.jumpLabel.textContent = done ? 'New answer — jump to it' : 'Working… jump to latest'"), 'it reports the truth');
    assert.ok(client.includes('function jumpToLatest()'), 'and one tap returns');
    assert.ok(client.includes("el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'smooth' })"), 'smoothly, to the end');
    assert.ok(client.includes('state.freshAnswer = !pinned;'), 'a finish while reading up there is news');
    assert.ok(html().includes('id="jump-latest"'), 'and the pill is in the markup');
    assert.ok(css().includes('.jump {'), 'with a style of its own');
  });
});

describe('an answer says what it cost', () => {
  test('one quiet line, only under the answer, only with real numbers', () => {
    const client = app();
    assert.ok(client.includes('function usageLine('), 'there is one place that draws it');
    assert.ok(client.includes("usageLine(node, message.usage ?? null, undefined, true);"), 'a reopened answer keeps its numbers');
    assert.ok(client.includes('usageLine(card.card, card.usage ?? null, card.startedAt, true);'), 'and a live one gets them as it closes');
    // The line lives inside the answer branch of the message loop, not the
    // question branch: a cost line under "make me a landing page" would be a
    // number about someone else's work.
    const answerBranch = client.slice(
      client.indexOf("if (message.role === 'assistant') {"),
      client.indexOf('attachMessageActions(node, message'),
    );
    assert.ok(answerBranch.includes('usageLine(node, message.usage ?? null, undefined, true);'), 'the cost line is inside the answer branch');
    const questionBranch = client.slice(client.indexOf('const node = message.role'), client.indexOf("if (message.role === 'assistant') {"));
    assert.ok(!questionBranch.includes('usageLine('), 'and not in the question branch');
    // Unknown is drawn as nothing at all: an engine that reports no tokens
    // must not produce a footer claiming zero.
    assert.ok(client.includes('if (parts.length === 0) return;'), 'no numbers, no line');
    assert.ok(client.includes("if (value === null || value === undefined) return '—';"), 'and an unknown half is a dash, never a zero');
  });

  test('seconds are seconds, minutes are minutes', () => {
    const client = app();
    assert.ok(client.includes('seconds >= 90 ?'), 'a long run switches to minutes');
    assert.ok(css().includes('.msg-usage'), 'and the line is styled as the quietest thing on the card');
  });
});

describe('a task that goes looking says where', () => {
  test('the rail fills during the run, from the run\u2019s own events', () => {
    const client = app();
    assert.ok(client.includes('function addSeenSource('), 'frames become rows');
    assert.ok(client.includes("case 'sources.seen':"), 'and the event that feeds it is handled');
    // In the buffered list too: a reconnect replays into the same rail.
    assert.ok(client.includes("'sources.seen', 'sources.checked',"), 'the event is durable, so it replays');
    assert.ok(client.includes('const rail = document.createElement'), 'the card has somewhere to put it');
    assert.ok(client.includes('card.append(thinking, plan, rail, answer, sources, files);'), 'above the answer, where the working is');
    assert.ok(client.includes('thinking.append(steps);'), 'and the steps are part of the panel that is working');
  });

  test('it is a rail, not a transcript: newest first, few rows, one tap wider', () => {
    const client = app();
    assert.ok(client.includes('const RAIL_VISIBLE = 2;'), 'two rows while it moves');
    assert.ok(client.includes('for (const entry of rows.slice().reverse()) list.append(railRow(entry));'), 'newest on top, because that is the news');
    assert.ok(client.includes('entries.slice(0, RAIL_VISIBLE)'), 'the rest wait behind the toggle');
    assert.ok(client.includes("toggle.textContent = card.railExpanded ? 'Show less' : `Show all ${entries.length}`;"), 'one control, and it says what it does');
  });

  test('a search is shown as the question, never as a page', () => {
    const client = app();
    assert.ok(client.includes("const icon = entry.kind === 'search' ? 'search' : 'globe';"), 'the two kinds are drawn differently');
    assert.ok(client.includes("if (entry.kind === 'search') return entry.query || '';"), 'a search row is its query');
    assert.ok(client.includes("if (!entry.url && !entry.query) return;"), 'an empty frame draws nothing');
    assert.ok(client.includes("if (entry.url && card.seenSources.some((existing) => existing.url === entry.url)) return;"), 'and a repeated page is not a new row');
  });

  test('the rail folds away when the answer arrives', () => {
    // The answer is the news at that point; the pages it opened are one line
    // of background, still readable, because a task's reading list and its
    // citations are not the same list.
    const client = app();
    assert.ok(client.includes('card.railCollapsed = true;'), 'finishing collapses it');
    assert.ok(client.includes("head.querySelector('.rail-title').textContent = card.railCollapsed ? 'Where it looked' : 'Looking at';"), 'and the heading changes tense');
    assert.ok(css().includes('.rail.collapsed .rail-list { display: none; }'), 'collapsed means the rows are hidden');
    assert.ok(css().includes('.rail-row svg'), 'with the rail styled as its own quiet thing');
  });
});

describe('the keyboard is a first-class citizen, and it shows its work', () => {
  test('? opens an honest list of what the keys do', () => {
    const client = app();
    assert.ok(html().includes('id="keys-sheet"'), 'there is a sheet');
    assert.ok(html().includes('aria-label="Keyboard shortcuts"'), 'announced as what it is');
    assert.ok(client.includes('function renderKeys('), 'and drawn from data, not from markup');
    assert.ok(client.includes('SHORTCUT_GROUPS'), 'the data lives in palette.js, where a test can walk it');
    assert.ok(css().includes('.keys-keys'), 'with the keys in a fixed column so the list scans');
  });

  test('? never fires while he is typing', () => {
    // The difference between a shortcut and a bug: `?` is a character, and a
    // cheat sheet that opens mid-sentence is worse than none.
    const client = app();
    assert.ok(client.includes("if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;"), 'typing wins over the shortcut');
    assert.ok(client.includes("if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;"), 'plain ? only');
    assert.ok(client.includes('if (!el.login.hidden) return; // the login screen runs no shortcuts'), 'and nothing fires signed out');
  });

  test('every shortcut listed is a shortcut the app really has', () => {
    // A cheat sheet that lists a key nobody implemented is worse than no cheat
    // sheet: it teaches the operator to distrust the list.
    const client = app();
    const groups = read('web/palette.js');
    assert.ok(groups.includes('export const SHORTCUT_GROUPS'), 'the list is data');
    assert.ok(client.includes("event.key !== '?'"), '? is handled');
    assert.ok(client.includes("event.key === 'k' || event.key === 'K'"), 'the palette key is handled');
    assert.ok(client.includes("event.key === 'ArrowDown'"), 'the arrows are handled');
    assert.ok(client.includes("event.key === 'Enter'"), 'Enter is handled');
    assert.ok(client.includes("if (event.key === 'Tab')"), 'Tab is handled');
    assert.ok(client.includes("if (event.key === 'Escape')"), 'Escape is handled');
    assert.ok(client.includes("if (event.key === 'Enter' && !event.shiftKey && !event.isComposing)"), 'and Shift+Enter is left for a new line');
  });

  test('Escape closes everything that can be open', () => {
    const client = app();
    // The drawer and Settings were the two that had no Escape handler at all.
    assert.ok(client.includes('function escapeShortcut('), 'one handler owns Escape');
    assert.ok(client.includes('closeKeys();'), 'the cheat sheet closes');
    assert.ok(client.includes('closeSettings();'), 'Settings goes back');
    assert.ok(client.includes('closeDrawer();'), 'and the drawer closes');
    // The palette keeps its own, which is why this one steps aside for it.
    assert.ok(client.includes('if (el.palette.hidden === false) return; // the palette owns its own Escape'), 'without fighting the palette');
    // The sheet is reachable from the palette as well as from the key: a list
    // only a keyboard can open is a list half the devices cannot read.
    assert.ok(client.includes("case 'shortcuts':"), 'the palette carries a row for it');
  });
});

describe('a plan is a list, and it is edited like one', () => {
  test('a step moves, rewrites, drops, and can be added', () => {
    // Borrowed from the research plan that Deep Research shows before it runs,
    // and taken one step further: renaming is the smallest possible edit, and
    // a plan you can only rename is still the model's plan.
    const client = app();
    assert.ok(client.includes('function editPlan('), 'the checklist can be opened for editing');
    assert.ok(client.includes('function savePlan('), 'and sent back');
    assert.ok(client.includes("msgButton({ icon: 'arrowUp'"), 'rows move up');
    assert.ok(client.includes("msgButton({ icon: 'arrowDown'"), 'and down');
    assert.ok(client.includes("msgButton({ icon: 'trash'"), 'a step can be dropped');
    assert.ok(client.includes("addInput.placeholder = 'Add a step…'"), 'and one can be typed in');
    assert.ok(client.includes('draft.splice(i, 1)'), 'dropping removes it from the draft');
    assert.ok(client.includes('[draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]'), 'moving swaps in the draft');
    for (const icon of ['plus', 'trash', 'arrowUp', 'arrowDown']) {
      assert.ok(client.includes(`${icon}:`), `the ${icon} icon exists`);
    }
  });

  test('the editor cannot produce a plan the server would refuse', () => {
    const client = app();
    const server = read('server/routes/runs.ts');
    // Same cap on both sides, and the last step is not removable — a 400 in
    // the face of the operator is a worse teacher than a button that does nothing.
    assert.ok(client.includes('const MAX_PLAN_STEPS = 20;'), 'the editor knows the cap');
    assert.ok(server.includes('.slice(0, 20)'), 'the server enforces the same cap');
    assert.ok(client.includes("toast('A plan needs at least one step.')"), 'and the empty plan is refused before it is sent');
    assert.ok(client.includes('if (draft.length === 1)'), 'the last step refuses to leave');
  });

  test('starting the task saves the plan first, so what runs is what was approved', () => {
    const client = app();
    assert.ok(client.includes('const ok = await savePlan(card, labels);'), 'the editor saves');
    assert.ok(client.includes('if (thenStart) await approvePlan(card, start);'), 'and only then approves');
    assert.ok(client.includes("msgButton({ icon: 'play', label: 'Start the task'"), 'one button does both');
    assert.ok(css().includes('.plan-edit-row'), 'the rows are styled as a list');
    assert.ok(css().includes('.plan-remove:hover'), 'and dropping a step reads as destructive');
  });
});

describe('everything is a keystroke away', () => {
  test('one box, opened from the keyboard and from a visible button', () => {
    // ⌘K for the operator at his desk; the button because a phone has no ⌘
    // key, and a palette that only a keyboard can open is a palette half the
    // time cannot use.
    const markup = html();
    assert.ok(markup.includes('id="palette-input"'), 'there is one input');
    assert.ok(markup.includes('role="combobox"'), 'and it is a combobox, not a search field');
    assert.ok(markup.includes('aria-controls="palette-list"') && markup.includes('role="listbox"'), 'wired to its own listbox');
    assert.ok(markup.includes('id="btn-search"'), 'with a button in the top bar');
    const client = app();
    assert.ok(client.includes("event.key === 'k' || event.key === 'K'"), 'the key is K');
    assert.ok(client.includes('event.metaKey || event.ctrlKey'), 'on both platforms');
    assert.ok(client.includes('if (paletteOpen) closePalette();'), 'and the same keys close it');
  });

  test('the list it draws is the one that was tested', () => {
    // The ranking, the grouping and the wrap-around live in web/palette.js,
    // where palette.test.ts can reach them; app.js only draws what it returns.
    const client = app();
    assert.ok(
      client.includes("import { RESUME_ACTIONS, RUNNING_ACTIONS, SHORTCUT_GROUPS, buildResults, flatten, moveSelection, selectionAfter } from './palette.js';"),
      'the palette logic is imported, not reimplemented',
    );
    // "Resume" is the row that matters most after a closed tab: the task is
    // still running, this tab just stopped watching it.
    assert.ok(client.includes("paletteRunningElsewhere = active && active.id !== state.runId ? active : null;"), 'a run owned elsewhere is noticed');
    assert.ok(client.includes('case \'resume\':'), 'and offered');
    assert.ok(client.includes('attach(run.id, 0);'), 'through the same attach path as the boot recovery');
    assert.ok(!client.includes('function paletteScore('), 'no second copy of the ranking');
  });

  test('it is quick, and it teaches its own keys', () => {
    const client = app();
    assert.ok(client.includes('clearTimeout(paletteTimer)'), 'keystrokes are debounced');
    assert.ok(client.includes('setTimeout(() => void refreshPalette(el.paletteInput.value), 140)'), 'by ~140 ms, so nothing waits on a request');
    assert.ok(client.includes("if (event.key === 'Escape')"), 'Escape closes');
    assert.ok(client.includes('movePalette(1)') && client.includes('movePalette(-1)'), 'the arrows move the highlight');
    assert.ok(client.includes("if (event.key === 'Enter')"), 'Enter runs what is highlighted');
    assert.ok(client.includes("if (event.key === 'Tab')"), 'Tab stays inside the combobox');
    assert.ok(html().includes('<kbd>'), 'and the footer prints them');
    // No dialog element: this is a layer over the thread, and the click-away
    // has to work on a phone as well.
    assert.ok(html().includes('id="palette-backdrop"'), 'with a backdrop to tap out of');
    // And not on the login screen, where every row would be an action for a
    // session that does not exist yet.
    assert.ok(client.includes('if (!el.login.hidden) return;'), 'the palette waits until there is a session');
  });
});

describe('the card tells the truth while the model is silent', () => {
  test('the thinking panel is never an empty box', () => {
    const client = app();
    assert.ok(client.includes('thinking-wait'), 'there is a line for the wait');
    assert.ok(
      client.includes('The request is out. Nothing has come back from the model yet.'),
      'and it says the true thing',
    );
    assert.ok(client.includes("card.thinkingBody.querySelector('.thinking-wait')?.remove();"), 'it goes when the text arrives');
    assert.ok(css().includes('.thinking-wait'), 'and it is styled as the quietest thing in the panel');
  });

  test('a retry is a note, and repeats collapse into one row', () => {
    const client = app();
    assert.ok(client.includes("status: data.level === 'info' ? 'done' : 'note',"), 'only an info line claims a result');
    // Keyed by message, not by position: an engine that retries says the same
    // sentence every ten seconds, and five identical rows is not five facts.
    assert.ok(client.includes('addStep(card, `log:${message}`, {'), 'log rows are keyed by the line itself');
    assert.ok(!client.includes('addStep(card, `log:${card.steps.children.length}`'), 'not by their position in the list');
    assert.ok(css().includes('.step[data-status="note"]'), 'a note is drawn without the tick styling');
  });

  test('the heartbeat is one row that is rewritten, not a row per beat', () => {
    const client = app();
    assert.ok(client.includes('const HEARTBEAT_RE = /^Nothing from the model yet — /'), 'the engine\'s silence line is recognised');
    assert.ok(
      client.includes("addStep(card, 'heartbeat', { name: message, icon: 'info', status: 'note' });"),
      'and it has a fixed key, so three minutes of silence is one line, not twelve',
    );
  });

  test('the engine says when the model has gone quiet', () => {
    // The server half of that: a model that is thinking streams nothing, and
    // silence used to be the only thing the operator got for minutes.
    const engine = read('server/engine/antigravity.ts');
    assert.ok(engine.includes('heartbeatMs?: number;'), 'the interval is configurable for tests');
    assert.ok(engine.includes('Nothing from the model yet — ${silent}s in.'), 'the line is emitted from the read loop');
    assert.ok(engine.includes('clearInterval(beat);'), 'and the timer dies with the socket');
  });
});

describe('the plan is drafted in the open', () => {
  test('the drafting is a live card, not a blank page', () => {
    const client = app();
    // "A couple of minutes with no live stream" had a root cause: the planning
    // pass ran inside the accepting request, so the browser had nothing to
    // attach to and nothing to show while the model thought.
    assert.ok(client.includes("case 'run.plan_started':"), 'the card is told the pass began');
    assert.ok(client.includes('function renderPlanDrafting(card)'), 'and has a state for it');
    assert.ok(client.includes('function draftingClock(card)'), 'with a clock, so a minute looks like a minute');
    assert.ok(client.includes("'Working out the plan'"), 'and it says what it is doing');
    assert.ok(client.includes('Nothing runs until you approve it'), 'and that nothing runs yet');
    assert.ok(client.includes("state.runStatus = 'planning';"), 'the status is tracked, not guessed');
  });

  test('planning is a live run, so a reload finds it', () => {
    const client = app();
    assert.ok(
      client.includes("const LIVE_RUN_STATUSES = ['planning', 'running', 'awaiting_plan'];"),
      'a task being planned is a task that is running',
    );
    assert.ok(client.includes("state.runStatus === 'planning' ? 'Planning…'"), 'and the header says planning, not working');
    // The POST no longer comes back with a plan: it comes back with a task.
    assert.ok(client.includes("} else if (run.status === 'planning') {"), 'the composer handles that answer');
    assert.ok(client.includes('const micHasSlot'), 'and the send button is unaffected by any of it');
  });
});

describe('the card is one box, and the page knows a task is running', () => {
  test('the steps are inside the thinking panel', () => {
    const client = app();
    // The screenshot: a "Still thinking — retrying the request." step with a
    // green tick, drawn outside the panel that was supposed to contain it.
    assert.ok(client.includes('thinking.append(steps);'), 'the steps are appended to the panel');
    assert.ok(client.includes('card.append(thinking, plan, rail, answer, sources, files);'), 'and the plan stays outside it');
    // The plan carries the Approve button: a decision must never hide behind a
    // collapsed panel.
    assert.ok(!client.includes('thinking.append(plan'), 'the plan is not folded into the working');
    const cssText = css();
    assert.ok(cssText.includes('.thinking > .steps'), 'the steps are drawn as part of the panel');
  });

  test('"New task" cannot abandon a task that is still running', () => {
    const client = app();
    const fn = client.slice(client.indexOf('function newTask()'), client.indexOf("$('btn-new').addEventListener"));
    assert.ok(fn.includes('if (liveRun()) {'), 'it checks for a live run first');
    assert.ok(fn.includes('Your task is still running — showing it live.'), 'and says why it will not start another');
    assert.ok(fn.indexOf('if (liveRun())') < fn.indexOf('renderThread([])'), 'before it clears the thread');
  });
});

describe('the drawer is a front door, not a form', () => {
  test('the tasks come before the plumbing', () => {
    const htmlText = html();
    const convos = htmlText.indexOf('id="convos"');
    const schedules = htmlText.indexOf('id="schedules"');
    const settingsRow = htmlText.indexOf('id="btn-settings"');
    assert.ok(convos > 0 && schedules > 0 && settingsRow > 0, 'all three exist');
    // Recent tasks are what the drawer is for; they used to sit under two
    // collapsed panels and a settings row, below the fold on a phone.
    assert.ok(convos < schedules, 'tasks above Scheduled');
    assert.ok(convos < settingsRow, 'and above Settings');
  });

  test('opening Scheduled shows tasks, not six empty inputs', () => {
    const client = app();
    assert.ok(client.includes('id="sch-new-toggle"'), 'the create-form is behind a button');
    assert.ok(client.includes('<div id="sch-form-wrap" hidden>'), 'and closed when the panel renders');
    // The list has to be written before the form's wrapper, or the form is the
    // first thing the eye lands on.
    const body = client.slice(client.indexOf('el.schedulesBody.innerHTML'));
    assert.ok(body.indexOf('rows.join') < body.indexOf('sch-new-toggle'), 'rows first, form after');
  });
});

describe('the direction is asked on the plan card, before anything is built', () => {
  test('the plan carries the proposal and the alternates', () => {
    const client = app();
    assert.ok(client.includes('function directionAsk(card, direction)'), 'the ask is built in one place');
    assert.ok(client.includes('function renderPlanPreview(card, plan, direction = null)'), 'the plan renderer takes the direction');
    assert.ok(client.includes("if (data.direction) card.directionAskPayload = data.direction;"), 'kept on the card, so a repaint does not lose the ask');
    assert.ok(client.includes('renderPlanPreview(card, data.plan, card.directionAskPayload ?? null);'), 'and handed to it');
    assert.ok(client.includes('if (direction) card.plan.insertBefore(directionAsk(card, direction), actions);'), 'the ask sits above Approve');
    // The proposal is stated in full, because "let WAIS choose" is only a real
    // option if the operator can see what WAIS would choose.
    assert.ok(client.includes('head.textContent = `Direction: ${direction.name} — ${direction.blurb} (${direction.why}).`;'), 'the proposal and the reason are named');
    assert.ok(client.includes("directionChip(card, 'auto', 'Let WAIS choose'"), 'including the option to accept it');
  });

  test('choosing records it before approval, and shows it as chosen', () => {
    const client = app();
    assert.ok(client.includes('async function chooseDirection(card, body, wrap)'), 'a chip records the choice');
    assert.ok(client.includes('`/runs/${card.runId}/direction`'), 'at the direction route, before the plan is approved');
    assert.ok(client.includes("markDirectionChosen(wrap, body.auto ? 'auto' : body.id);"), 'by id');
    assert.ok(client.includes("chip.setAttribute('aria-pressed', chosen ? 'true' : 'false');"), 'one chip pressed, the rest released');
    assert.ok(css().includes('.direction-chip[aria-pressed="true"]'), 'and the chosen chip looks chosen');
    assert.ok(client.includes('card.directionChosen'), 'a replay remembers the choice instead of asking again');
  });

  test('the ask is not a second gate: approving is still what starts the build', () => {
    const client = app();
    // The direction is recorded, not acted on. Nothing here may start a run.
    const askBlock = client.slice(client.indexOf('async function chooseDirection'), client.indexOf('function markDirectionChosen'));
    assert.ok(!/approvePlan|executor|\/approve/.test(askBlock), 'choosing a direction never approves the plan');
  });
});

describe('a built page says its direction and offers its next moves', () => {
  test('the direction arrives as an event, not a log line', () => {
    const client = app();
    // Structured, so the alternates it carries can be offered later; a log line
    // is a sentence the client could only print.
    assert.ok(client.includes("case 'design.direction':"), 'the client listens for it');
    assert.ok(client.includes("'design.direction',"), 'and it is durable, so a reload still knows the direction');
    assert.ok(client.includes("addStep(card, 'design', {"), 'it reads as a row among the work, not a banner');
    assert.ok(client.includes("icon: 'spark',"), 'with its own mark');
    assert.ok(client.includes("import { directionLine, refinementChips } from './refine.js';"), 'and the sentences come from the pure module, not from here');
    assert.ok(client.includes("name: directionLine(data),"), 'so the row and the tests cannot disagree');
  });

  test('a finished build offers its next moves where the result is', () => {
    const client = app();
    assert.ok(client.includes('function refineRow(card)'), 'the chips are built in one place');
    assert.ok(client.includes("if (card.direction) noticeNode.append(refineRow(card));"), 'only for a build, and only when done');
    assert.ok(client.includes("btn.className = 'chip refine-chip';"), 'they reuse the composer pill');
    assert.ok(client.includes('btn.dataset.prompt = chip.prompt;'), 'each carrying its prepared prompt');
    // A chip fills the composer; nothing is sent by tapping it.
    assert.ok(client.includes("const refine = /** @type {HTMLElement | null} */ (target.closest('.refine-chip'));"), 'the click is delegated');
    assert.ok(client.includes('fillComposerFromChip(el.prompt, el.send, prompt);'), 'and it only fills');
    assert.ok(!/sendMessage\(|requestSubmit\(\);[\s\S]{0,80}refine-chip/.test(client), 'never auto-sent');
    assert.ok(css().includes('.refine {'), 'the row wraps');
  });
});

describe('a running task shows a spinner and a timer that do not lie', () => {
  test('the clock is seeded from the task, not from when the card appeared', () => {
    // The failure this prevents: a reconnect three minutes in restarted the
    // clock at 0:00, so the timer reported the age of the *screen*.
    const client = app();
    const started = client.slice(client.indexOf("case 'run.started'"), client.indexOf("case 'log'"));
    assert.ok(started.includes("const startedAt = Date.parse(String(data.startedAt ?? ''));"), 'the run says when it started');
    assert.ok(started.includes('if (Number.isFinite(startedAt) && startedAt <= Date.now())'), 'and a nonsense or future time is refused rather than drawn');
    assert.ok(started.includes('card.startedAt = startedAt;'), 'the card adopts it');
  });

  test('the phase sits beside the timer, where the body cannot scroll it away', () => {
    const client = app();
    assert.ok(client.includes('card.phaseChip.textContent = phase ?? \'\';'), 'the head shows the phase');
    assert.ok(client.includes('card.phaseChip.hidden = !phase;'), 'and hides it when there is none');
    assert.ok(client.includes("setPhase(card, `Step ${data.index} of ${data.total}`);"), 'a milestone names the step');
    assert.ok(css().includes('.thinking-head .phase'), 'it is styled as a fact beside the clock');
  });

  test('the finished card keeps the number and stops twitching', () => {
    const client = app();
    assert.ok(
      client.includes('if (card.thinkingClock) card.thinkingClock.textContent = formatTimer(Date.now() - card.startedAt);'),
      'frozen at the final time rather than cleared',
    );
    assert.ok(client.includes('card.phaseChip.hidden = true;'), 'and the phase goes when there is no phase');
    const cssText = css();
    assert.ok(cssText.includes('.spinner.done'), 'the spinner stops being a spinner');
    assert.ok(cssText.includes('@keyframes spin'), 'and it was spinning while the task ran');
    assert.ok(client.includes('role="timer"'), 'the clock announces itself as a timer, not as live text');
  });
});

describe('the wait line, and the raw view behind it', () => {
  test('an empty panel says what is happening, for how long, and whether the model is talking', () => {
    const client = app();
    assert.ok(client.includes('function updateWaitLine(card)'), 'the line is redrawn, not written once');
    assert.ok(client.includes('function setPhase(card, phase)'), 'and it knows the phase');
    assert.ok(client.includes("setPhase(card, 'Drafting the plan');"), 'set when the plan is being drafted');
    assert.ok(client.includes('setPhase(card, `Step ${data.index} of ${data.total}`);'), 'and when a milestone names the step');
    assert.ok(client.includes('waitLine({'), 'through the pure helper that is tested without a browser');
    // The clock already ticked the seconds; the wait line is where that number
    // becomes a sentence.
    assert.ok(client.includes('updateWaitLine(card);\n  };'), 'the clock keeps it honest');
  });

  test('a silent model is said on the head, where it cannot be scrolled away', () => {
    const client = app();
    assert.ok(client.includes("class=\"thinking-quiet\" hidden"), 'there is a place for it');
    assert.ok(client.includes('chip.textContent = `quiet ${elapsedWords(card.quiet)}`;'), 'it counts the silence');
    assert.ok(client.includes('card.quiet = quietSeconds(message);'), 'read from the engine heartbeat');
    assert.ok(
      client.includes('if (card.quiet !== null) { card.quiet = null; updateWaitLine(card); }'),
      'and cleared the moment the model talks again',
    );
    assert.ok(css().includes('.thinking-quiet'), 'it is styled like a fact, not like an alarm');
  });

  test('the raw view shows every frame, off by default', () => {
    const client = app();
    assert.ok(client.includes('function noteFrame(card, name, data)'), 'every frame is captured');
    assert.ok(client.includes('pushFrame(card.frames,'), 'through the bounded queue');
    assert.ok(client.includes('card.framesDropped += next.overflow;'), 'and what fell out is counted, never hidden');
    assert.ok(client.includes("if (card) noteFrame(card, event, data);\n  switch (event) {"), 'captured before it is handled, so unhandled frames still appear');
    assert.ok(client.includes('function renderRaw(card)'), 'the view renders it');
    assert.ok(client.includes('Showing the last ${card.frames.length} of ${card.framesSeen} frames received.'), 'saying plainly when it is showing a tail');
    assert.ok(client.includes('function setRaw(card, on)'), 'and can be turned on');
    assert.ok(client.includes("card.raw.hidden = !on;"), 'with the view hidden until it is');
    assert.ok(client.includes('const handle = cardEl ? cardHandles.get(cardEl) : undefined;'), 'the switch finds the live handle for that card');
    assert.ok(css().includes('.raw-payload'), 'the payload has a style');
    assert.ok(css().includes('.trace-raw-toggle[aria-pressed="true"]'), 'and the switch shows its own state');
  });
});

describe('the trace is a feed, and it says which channel it is reading', () => {
  test('a reason gets its own row', () => {
    const client = app();
    // The model is asked (on complex tasks only) to say why before each tool
    // call. Those lines are lifted out of the prose by the server and arrive as
    // `decision` events, and a reason must never read like a thought.
    assert.ok(client.includes("case 'decision':"), 'the client listens for it');
    assert.ok(client.includes("addTraceRow(card, String(data.text ?? ''), 'decision')"), 'and draws it as a decision');
    assert.ok(client.includes("'decision',"), 'and it is durable, so a reconnect replays it');
    assert.ok(client.includes('function addTraceRow(card, text, kind = \'thought\', at = null)'), 'one function draws every kind');
    assert.ok(client.includes("row.dataset.kind = kind;"), 'the kind is on the row, so CSS can speak to it');
    assert.ok(client.includes("flag.textContent = 'why';"), 'with a flag that marks it as a reason');
  });

  test('the feed is rows cut from the stream, not one paragraph', () => {
    const client = app();
    assert.ok(client.includes("import {"), 'the pure row logic is imported');
    assert.ok(client.includes('takeTraceRows'), 'from timeline.js, where it is tested without a browser');
    assert.ok(client.includes('function drainTrace(card)'), 'fragments are drained into rows');
    assert.ok(client.includes('function flushTrace(card)'), 'and the tail is flushed when the run ends');
    assert.ok(client.includes('flushTrace(card);\n  stopRunClock(card);'), 'the card folds its last thought in before it stops');
    assert.ok(client.includes("card.trace = thinking.querySelector('.trace')") || client.includes("trace: thinking.querySelector('.trace')"), 'the feed has its own element');
    assert.ok(client.includes('class="trace" aria-live="polite"'), 'which announces itself to a screen reader');
    // The caret is what says "still writing" — and only the live row has it.
    assert.ok(client.includes("card.traceLive.dataset.live = card.thinkingTail ? 'true' : 'false';"), 'the caret follows the live row');
    const cssText = css();
    assert.ok(cssText.includes('.trace-row[data-live="true"] .trace-text::after'), 'the caret is drawn in CSS');
    assert.ok(cssText.includes('@keyframes caret-blink'), 'and blinks');
    assert.ok(cssText.includes('.trace-flag'), 'the decision flag has a style of its own');
  });

  test('the panel head never calls narration reasoning', () => {
    const client = app();
    assert.ok(client.includes('function setThinkingKind(card, kind)'), 'the kind is tracked');
    assert.ok(client.includes('card.thinkingLabel.textContent = thinkingLabel(kind);'), 'and written where the operator reads it');
    assert.ok(client.includes("thinkingLabel(kind)"), 'through the pure helper');
    assert.ok(!/card\.thinkingLabel\.textContent = 'Reasoning'/.test(client), 'never hard-coded to the nicer word');
  });

  test('a reconnect redraws the feed instead of stacking a second one', () => {
    const client = app();
    // A snapshot longer than what the screen holds means fragments were lost;
    // cutting the authoritative text into rows again is deterministic.
    assert.ok(client.includes('function rebuildTrace(card, full)'), 'there is a rebuild path');
    assert.ok(
      client.includes('if (full.length > card.thinkingText.length + card.thinkingTail.length) {'),
      'taken only when the snapshot holds words the screen never saw',
    );
    assert.ok(client.includes("card.trace.innerHTML = '';"), 'and it starts from an empty feed');
    assert.ok(client.includes('traceRows: 0,'), 'with the row count reset, on both card handles');
  });
});

describe('the drawer reads like a list, not a wall', () => {
  test('the row you are on is marked', () => {
    const cssText = css();
    assert.ok(cssText.includes('.convo.on::before'), 'the active row carries a marker');
    const rule = cssText.slice(cssText.indexOf('.convo.on::before'));
    assert.ok(rule.slice(0, rule.indexOf('}')).includes('background: var(--accent)'), 'in the accent colour');
    assert.ok(cssText.includes('.convo-group'), 'and recents are grouped under day headings');
  });

  test('the two fields people type into keep their keyboard ring', () => {
    // `outline: 0` is `outline: none`: it hid the focus ring on the composer and
    // the drawer search box, and the older scan only looked for the second
    // spelling. ui_audit.test.ts now catches both; this pins the fix.
    const cssText = css();
    assert.ok(!/\.composer textarea \{[^}]*outline: 0/.test(cssText), 'the composer');
    assert.ok(!/\.drawer-search input \{[^}]*outline: 0/.test(cssText), 'and the drawer search box');
  });
});

describe('Settings is a directory, not a form', () => {
  // The redesign takes its shape from a connectors directory (Claude's, and the
  // ones it borrowed from): one searchable list, each item showing what it is,
  // what state it is in, and one obvious thing to do about it — instead of a
  // wall of inputs whose labels only make sense if you already know the keys.

  test('there is one search box, and it filters the page', () => {
    const page = read('web/index.html');
    assert.ok(page.includes('id="settings-search"'), 'the box exists');
    const bodyStart = page.indexOf('id="settings-body"');
    assert.ok(page.indexOf('id="settings-search"') < bodyStart, 'and sits above the content');
    assert.ok(
      page.indexOf('id="settings-body"') > page.indexOf('id="settings-search"'),
      // Re-creating the input on every keystroke loses focus and, on a phone,
      // the keyboard — so the list is what gets re-rendered, not the box.
      'the list is re-rendered, the box is not',
    );
    const client = app();
    assert.ok(client.includes("state.settingsQuery = el.settingsSearch.value;"), 'typing filters');
    assert.ok(client.includes('if (!matches(setting.label, setting.description, setting.key, value)) return'),
      'a setting is matched on its words, not just its key');
    assert.ok(client.includes('if (!matches(secret.label, secret.description, secret.name, state_.text)) return'),
      'so is a connection');
    assert.ok(client.includes("el.settingsSearch.value = '';"), 'and opening the page clears the filter');
    assert.ok(client.includes('<p class="settings-empty">Nothing matches that.</p>'), 'an empty result says so');
  });

  test('a connection says what it is, and what state it is in', () => {
    const client = app();
    assert.ok(client.includes('class="connection-name"'), 'the name');
    assert.ok(client.includes('class="connection-desc"'), 'what it lets the app do');
    assert.ok(client.includes('class="pill ${state_.className}"'), 'its state, as a pill');
    assert.ok(client.includes("short: 'Connected'"), 'connected');
    assert.ok(client.includes("short: 'Not set', className: 'muted'"), 'not set is honest, not alarming');
    assert.ok(client.includes("short: 'Needs attention'"), 'and an undecryptable key is called out, not hidden');
    assert.ok(client.includes('class="connection-detail"'), 'with the fingerprint, never the key');
  });

  test('connections are shelved, and nothing can fall off the shelf', () => {
    const client = app();
    assert.ok(client.includes('const SECRET_GROUPS = ['), 'there is a category map');
    assert.ok(client.includes("{ title: 'The engine', names: ['gemini_api_key'] }"), 'the engine');
    assert.ok(client.includes("{ title: 'Your phone', names: ['whatsapp_token', 'whatsapp_to'] }"), 'the phone channel');
    assert.ok(client.includes("{ title: 'Code and files', names: ['github_pat'] }"), 'the code host');
    assert.ok(client.includes("{ title: 'Accounts you link'"), 'and the accounts people link');
    // A secret added on the server must still render, or it would be invisible.
    assert.ok(client.includes("{ title: 'More connections', secrets: data.secrets.filter((secret) => !grouped.has(secret.name)) }"),
      'anything unnamed by the map still has a shelf');
    assert.ok(client.includes('class="settings-group-heading"'), 'and each shelf is labelled');
  });

  test('each item offers one primary action', () => {
    const client = app();
    assert.ok(client.includes('<button class="primary" data-act="set"'), 'the one thing to do is the loud one');
    assert.ok(client.includes("? 'Replace key' : 'Add key'"), 'and it says which of the two it is');
    assert.ok(client.includes('data-act="test"'), 'testing the key is secondary');
    assert.ok(client.includes('data-act="remove"'), 'so is removing it');
    const actions = css().slice(css().indexOf('.secret-actions {'));
    assert.ok(actions.slice(0, actions.indexOf('}')).includes('flex-wrap: wrap'), 'and they never crush each other');
  });

  test('a setting shows the reason it exists, and the answer', () => {
    const client = app();
    // The server has always sent `description`; the old page ignored it, so the
    // panel was a list of keys and values nobody but the author could read.
    assert.ok(client.includes('escapeHtml(setting.description)'), 'the description is shown');
    assert.ok(client.includes('class="setting-value"'), 'with the current value on the row');
    assert.ok(client.includes('class="setting-editor" hidden'), 'and the editor closed until asked for');
    assert.ok(client.includes("editor.querySelector('.setting-input').focus()"), 'opening it puts the cursor in the field');
    assert.ok(client.includes('changes save as soon as you leave the field'), 'saving is explained where it happens');
  });

  test('the page is a single scroll, with rows you can hit', () => {
    const cssText = css();
    const search = cssText.slice(cssText.indexOf('.settings-search {'));
    assert.ok(!/overflow(-y)?:\s*(auto|scroll)/.test(search.slice(0, search.indexOf('}'))), 'the filter does not scroll on its own');
    const connection = cssText.slice(cssText.indexOf('.connection {'));
    assert.ok(!/overflow(-y)?:\s*(auto|scroll)/.test(connection.slice(0, connection.indexOf('}'))), 'nor a connection card');
    assert.ok(cssText.includes('.setting-summary, .setting-toggle-row { min-height: 44px; }'), 'and a row is a 44px target');
  });
});

describe('Settings is a page you can read on a phone', () => {
  test('nothing in a settings card is clipped', () => {
    const cssText = css();
    // `.settings-list` clips to keep its rounded corners, so every child has to
    // be allowed to shrink; and the three key actions wrap instead of compressing
    // "Replace" until it loses letters.
    assert.ok(cssText.includes('.setting-row > *, .secret > *, .settings-list > * { min-width: 0; }'), 'rows can shrink');
    const actions = cssText.slice(cssText.indexOf('.secret-actions {'));
    assert.ok(actions.slice(0, actions.indexOf('}')).includes('flex-wrap: wrap'), 'key actions wrap');
    const button = cssText.slice(cssText.indexOf('.secret-actions button {'));
    assert.ok(button.slice(0, button.indexOf('}')).includes('min-width: fit-content'), 'and a button is never narrower than its label');
  });

  test('each block says what it is, and the page says when it applies', () => {
    const client = app();
    assert.ok(client.includes('`How it runs · ${visibleSettings.length}`'), 'the settings block');
    assert.ok(client.includes('`Connections · ${keysSet} of ${data.secrets.length} set`'), 'the connections block');
    assert.ok(client.includes("section('The phone channel'"), 'the WhatsApp block');
    assert.ok(client.includes('class="settings-lead"'), 'with a line saying changes apply immediately');
    assert.ok(client.includes("? 'Replace key' : 'Add key'"), 'and a key action that says what it replaces');
    assert.ok(client.includes('class="pill ${state_.className}"'), 'each connection shows its state as a pill');
  });
});

describe('a running task cannot hide from you', () => {
  // This is the bug the operator photographed: a submitted task, a three-minute
  // wait, no live stream on screen — only a "retrying" line. The stream was
  // fine; finding it was not. These are the three holes, pinned.
  test('every way into the app can find a live run', () => {
    const client = app();
    assert.ok(client.includes('async function ensureLiveRun('), 'there is one recovery path');
    assert.ok(client.includes('async function ensureLiveRun({ attempts = 2, announce = true } = {}) {'), 'and it retries before giving up');
    // The boot recovery used to be a single request inside a silent catch:
    // one cold-start failure and the app decided nothing was running forever.
    assert.ok(client.includes("const notice = renderNotice('Could not check whether a task is running.'"), 'a failed check says so instead of pretending');
    assert.ok(client.includes("again.textContent = 'Check again'"), 'and offers the retry');
    assert.ok(!/catch \{ \/\* not fatal: just means nothing is running \*\/ \}/.test(client), 'the silent version is gone');
    // Recovery hides the starter cards. Without this a reload mid-task showed
    // the hero *and* the live card, which is the screenshot.
    assert.ok(client.includes('showHero(false);\n  // The question is written down'), 'recovery hides the hero');
  });

  test('opening a conversation puts its live run back', () => {
    const client = app();
    // It no longer depends on `state.runId`, which is null after a reload.
    assert.ok(
      client.includes("const liveMessage = messages.find((m) => m.runId && LIVE_RUN_STATUSES.includes(m.runStatus));"),
      'the thread reads the run state out of its own messages',
    );
    assert.ok(client.includes('} else if (liveMessage && !(await ensureLiveRun({ announce: false })))'), 'and re-attaches, or catches up if it has since ended');
    // And the messages array has to survive the try block for that to work.
    assert.ok(client.includes('let messages = [];'), 'the message list is in scope');
  });

  test('the phone re-checks when it comes back to the app', () => {
    const client = app();
    assert.ok(/visibilitychange/.test(client), 'waking the app is an entry point too');
    // With nothing attached, a wake-up asks the server instead of returning
    // early on `!state.runId` — which is how a task started on the laptop stayed
    // invisible on the phone.
    assert.ok(
      client.includes('if (!state.runId) {\n    void ensureLiveRun({ attempts: 1, announce: false });'),
      'and asks even when it has no run of its own',
    );
  });
});

describe('the live stream stays in one card', () => {
  // The operator's question, answered in the code: when a task streams, its
  // events go into the card for *that run* — and a card is found by run id, so
  // a reconnect, a return to the foreground, or a second look at a running task
  // replays into the card that is already there instead of drawing another one.
  test('a run has exactly one card, found by its id', () => {
    const client = app();
    assert.ok(client.includes('if (runId) card.dataset.runId = runId;'), 'the card is keyed by the run');
    assert.ok(client.includes('return el.thread.querySelector(`.run[data-run-id="${runId}"]`);'), 'and looked up by it');
    assert.ok(
      client.includes('const card = cardFor(runId) ? existingCard(runId) : createRunCard(runId);'),
      'attaching reuses the card it already has, and only creates one when there is none',
    );
    assert.ok(client.includes('function existingCard(runId)'), 'the reused card is rebuilt from the DOM');
  });

  test('every way back into a run goes through that one guard', () => {
    const client = app();
    // A reconnect, a foreground return, "Review plan", a resume after the
    // server restarted — each of them replays a run the thread may already be
    // showing.
    const attaches = client.split('attach(').length - 1;
    assert.ok(attaches >= 8, `all re-entry points use attach() (${attaches} call sites)`);
    assert.ok(client.includes('if (ownsLiveRun) attach(state.runId, 0);'), 'including reopening its conversation');
  });
});

describe('an answer can be rated without leaving the answer', () => {
  test('the thumbs are inline, and the reasons come after the thumbs-down', () => {
    const client = app();
    assert.ok(client.includes('function feedbackControls('), 'there are rating controls');
    assert.ok(client.includes("target: { messageId: message.id }"), 'on every stored answer');
    assert.ok(client.includes('target: { runId: card.runId }'), 'and on the card that just finished');
    // One tap, then the reason — never a dialog.
    assert.ok(client.includes("down.addEventListener('click', () => (rating === 'down' ? void clear() : void send('down')))"), 'tapping the thumb again takes it back');
    assert.ok(client.includes('function buildWhy()'), 'the reasons are built on demand');
    assert.ok(!client.includes('showModal()'), 'with no dialog anywhere near the rating');
  });

  test('the reasons are the server\u2019s closed list, not prose', () => {
    const client = app();
    const server = read('server/feedback.ts');
    for (const id of ['wrong', 'off_topic', 'too_long', 'broken', 'other']) {
      assert.ok(server.includes(`id: '${id}'`), `${id} exists on the server`);
      assert.ok(client.includes(`['${id}', '`), `${id} is offered by the client`);
    }
    // A closed list is what makes the reasons countable; a free-text box would
    // have made this table unreadable a week in.
    assert.ok(client.includes("if (!reason) { toast('Pick a reason first.'); return; }"), 'a note without a reason is refused');
  });

  test('the settings page shows what he said', () => {
    // "Do not ignore the feedback you collect" — the loop has to be visible.
    const client = app();
    assert.ok(client.includes('async function loadFeedbackSummary()'), 'the summary is fetched');
    assert.ok(client.includes("section('What you told me'"), 'and shown as its own block');
    assert.ok(client.includes('/api/feedback/summary?limit=3'), 'with a small limit, not the whole history');
    assert.ok(css().includes('.feedback-chip.on'), 'the chosen reason is visibly chosen');
  });
});

describe('the decision points are the loudest thing on the screen', () => {
  test('a waiting plan says what it is and what happens next', () => {
    // Approving is the only irreversible tap in the app, and a plan waiting for
    // one looked exactly like a plan being worked on.
    const client = app();
    assert.ok(client.includes("card.plan.classList.add('plan-card')"), 'the plan is its own card');
    assert.ok(client.includes('plan-head'), 'with a heading');
    assert.ok(client.includes('Nothing has run yet'), 'that says nothing has started');
    assert.ok(client.includes('`The plan · ${steps.length} steps`'), 'and how big the plan is');
    assert.ok(client.includes("approve.className = 'msg-btn primary plan-approve'"), 'approve is the primary action');
    assert.ok(client.includes("edit.querySelector('span').textContent = 'Edit'"), 'with edit beside it, not equal to it');
  });

  test('plan rows stay in order, above the buttons', () => {
    // The rows are inserted by number, and the actions moved to the bottom —
    // a step appended after Approve would read as a footnote to the button.
    const client = app();
    assert.ok(client.includes("const actions = card.plan.querySelector('.plan-actions');"), 'the anchor is found');
    assert.ok(client.includes('const anchor = next !== undefined ? card.planIndex.get(next) : actions;'), 'and rows go before it');
  });

  test('settings is grouped by question, not listed by key', () => {
    const client = app();
    assert.ok(client.includes('function section(title, body)'), 'there are sections');
    assert.ok(client.includes('`How it runs · ${visibleSettings.length}`'), 'how it runs, with how many');
    assert.ok(client.includes('`Connections · ${keysSet} of ${data.secrets.length} set`'), 'the connections, with how many are set');
    assert.ok(client.includes("section('The phone channel'"), 'the phone channel');
    assert.ok(client.includes("section('About this build'"), 'and the build this page is running');
    assert.ok(css().includes('.settings-heading'), 'with a heading style of its own');
  });

  test('a shared replay looks like the app it came from', () => {
    const share = read('server/share.ts');
    assert.ok(share.includes('--paper:#f5f3ef'), 'the same palette');
    assert.ok(share.includes('prefers-color-scheme: dark'), 'that follows the reader\u2019s theme');
    assert.ok(share.includes('class="mark"'), 'and the same mark');
    assert.ok(!/<script/.test(share), 'with no script at all: a shared link is opened by strangers');
  });
});

describe('a produced file is a card, and an answer shows its sources', () => {
  test('the card says what the file is, how big, and what can be done with it', () => {
    const client = app();
    assert.ok(client.includes('function artifactCard('), 'there is a card');
    assert.ok(client.includes('artifactKind(artifact.name)'), 'the kind comes from the name');
    assert.ok(client.includes('artifactMeta(artifact, formatBytes)'), 'the second line comes from one helper');
    assert.ok(client.includes("open.querySelector('span').textContent = 'Open'"), 'a page can be opened');
    assert.ok(client.includes("download.querySelector('span').textContent = 'Download'"), 'and saved');
    assert.ok(client.includes('keepButton(artifact)'), 'and kept');
    // The panel and the thread draw the same component, not two similar rows.
    assert.ok(client.includes('body.append(artifactCard(artifact))'), 'the panel uses it too');
    assert.ok(!client.includes("row.className = 'panel-file'"), 'and the old row layout is gone');
  });

  test('the panel says which task it is showing', () => {
    const client = app();
    assert.ok(client.includes('function renderPanelHead()'), 'the panel has a head');
    assert.ok(client.includes('panel-subtitle'), 'with the task under the title');
    assert.ok(client.includes('const counts = {'), 'and each tab counts what is inside it');
  });

  test('an answer shows the links it cites, checked and marked', () => {
    const client = app();
    assert.ok(client.includes('function renderSources(card)'), 'there is a sources strip');
    assert.ok(client.includes('sourcesFromText(text)'), 'built from the answer text');
    assert.ok(client.includes('markDead(sourcesFromText(text), card.deadSources ?? [])'), 'with what the link check found');
    assert.ok(client.includes("head.querySelector('.sources-title').textContent = 'Sources'"), 'under a heading');
    assert.ok(client.includes("more.textContent = `Show ${sources.length - VISIBLE} more`"), 'and only the first few until asked');
    assert.ok(client.includes("row.rel = 'noopener noreferrer'"), 'opened safely');
  });

  test('a reopened task shows its sources too', () => {
    // The links are in the stored answer, so nothing has to be fetched and a
    // week-old task reads the same as the day it ran.
    const client = app();
    const open = client.slice(client.indexOf('async function openConversation'));
    assert.ok(open.includes('renderSources({ answerText: message.content'), 'history answers get the strip');
  });

  test('a bare URL in the prose is a link, not text', () => {
    const client = app();
    const fn = client.slice(client.indexOf('function inline(text)'), client.indexOf('function inline(text)') + 900);
    assert.ok(fn.includes('bare URL is a link'), 'bare URLs are linkified');
    assert.ok(fn.includes("rel=\"noopener noreferrer\""), 'safely');
  });
});

describe('actions belong to the operator, not to the answer', () => {
  test('the finished-task row has no Edit prompt button', () => {
    const client = app();
    assert.ok(!client.includes('Edit prompt'), 'the button is gone');
    assert.ok(!client.includes('function editPrompt'), 'and so is its handler');
  });

  test('the operator can still edit their own message', () => {
    // attachMessageActions puts the pencil on the user's bubble — the right
    // place for it; removing the button must not have removed that. The row is
    // icon-first now, so the assertion is on the action, not on its glyph.
    const client = app();
    assert.ok(client.includes("msgButton({ icon: 'pencil', title: 'Edit this message"), 'the pencil is on the user\u2019s own message');
    assert.ok(client.includes('openInlineEditor('));
  });
});

describe('a run that is over stops looking like a run in progress', () => {
  test('there is exactly one terminal-status list, and it includes paused', () => {
    // Two copies drifted: the stream-end check knew about 'paused' and the
    // foreground-return check did not, so a task that paused while the phone was
    // in the operator's pocket came back as "Working…" with a stream that would
    // never speak again.
    const client = app();
    const definitions = client.match(/const TERMINAL_STATUSES = \[[^\]]*\]/g) ?? [];
    assert.equal(definitions.length, 1, 'one definition, not a copy per call site');
    assert.match(definitions[0] ?? '', /'paused'/, 'and paused is in it');
    assert.ok(
      !/\['completed', 'failed', 'cancelled'\]\.includes/.test(client),
      'no call site still has its own shorter list',
    );
  });

  test('both the stream-end and the foreground-return checks use it', () => {
    const client = app();
    // stream end
    const end = client.slice(client.indexOf("source.addEventListener('end'"), client.indexOf("source.addEventListener('error'"));
    assert.ok(end.includes('TERMINAL_STATUSES.includes(run.status)'), 'the stream-end check uses the list');
    // return to foreground — the handler also recovers a waiting plan, so the
    // slice reaches to the end of the block rather than a fixed number of bytes.
    const vis = client.slice(client.indexOf("addEventListener('visibilitychange'"));
    assert.ok(vis.includes('TERMINAL_STATUSES.includes(run.status)'), 'and so does the visibility check');
  });
});

describe('the answer is the answer', () => {
  test('plan-protocol lines are stripped before the prose is drawn', () => {
    const client = app();
    assert.ok(client.includes('stripMilestones(card.answerText'), 'drawAnswer filters them');
  });

  test('a long rate-limit wait is visible instead of looking like a hang', () => {
    const client = app();
    assert.ok(/rate limited\|waiting/.test(client), 'the wait is recognised');
    assert.ok(client.includes("addStep(card, 'rate-limit'"), 'and shown as its own running step');
  });
});
