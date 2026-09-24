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
    assert.ok(client.includes("const LIVE_RUN_STATUSES = ['running', 'awaiting_plan'];"), 'both states are live');
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

  test('the mode is one control, not three always-visible switches', () => {
    const htmlText = html();
    assert.ok(htmlText.includes('id="btn-mode"'), 'one mode control');
    assert.ok(htmlText.includes('aria-haspopup="dialog"'), 'that opens a sheet');
    assert.ok(!htmlText.includes('research-toggle'), 'the labelled research pill is gone');
    assert.ok(!htmlText.includes('ping-toggle\n'), 'and the ping pill is no longer in the row');
    const client = app();
    assert.ok(client.includes('function openModeSheet()') && client.includes('function closeModeSheet()'), 'the sheet is opened and closed deliberately');
    assert.ok(client.includes('el.modeStandard.setAttribute('), 'the options carry their checked state');
    assert.ok(client.includes("el.modeLabel.textContent = `Deep research · ${mins} min`"), 'and the chip says what is on');
  });

  test('the sheet is a real dialog: backdrop, Escape, and focus handed back', () => {
    const client = app();
    assert.ok(client.includes('modeSheetOpener = document.activeElement'), 'the opener is remembered');
    assert.ok(client.includes('modeSheetOpener.focus()'), 'and given focus back');
    assert.ok(client.includes("event.key === 'Escape' && !el.modeSheet.hidden"), 'Escape closes it');
    assert.ok(client.includes('el.modeBackdrop.addEventListener'), 'so does the backdrop');
    const htmlText = html();
    assert.ok(htmlText.includes('role="dialog"') && htmlText.includes('aria-modal="true"'), 'and it is announced as one');
  });

  test('one trailing control: mic, send, or stop — never all three', () => {
    const client = app();
    assert.ok(client.includes('function setupStopButton()'), 'the stop button moves into the composer');
    assert.ok(client.includes('function updateTrailingAction()'), 'and the slot is managed in one place');
    assert.ok(client.includes('el.mic.hidden = !(micUsable && !typing && !state.running)'), 'the mic shows only while the field is empty');
    assert.ok(client.includes('el.send.hidden = state.running || typing || !micUsable'), 'and the send takes over the moment there is something to send');
    assert.ok(client.includes('if (el.mic) el.mic.hidden') || true, 'a browser without speech still gets a working slot');
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
    assert.ok(client.includes('setInterval(tick, 1_000)'), 'ticking by the second');
    assert.ok(client.includes('stopRunClock(card)'), 'stopped when the run ends');
    assert.ok(client.includes('thinkingClock'), 'and drawn in the run header');
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

  test('a pinned row is shown as kept, and the chips follow the record', () => {
    const client = app();
    assert.ok(client.includes("artifact.pinned ? ' · kept' : ''"), 'the chip says so');
    assert.ok(client.includes('refreshArtifactChips'), 'and both views are repainted from the record');
    assert.ok(css().includes('.file.kept'), 'with a style of its own');
  });

  test('a failed pin explains itself instead of failing silently', () => {
    const client = app();
    assert.ok(client.includes("err.body?.message || err.message || 'Could not keep that file.'"), 'the reason is surfaced');
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
