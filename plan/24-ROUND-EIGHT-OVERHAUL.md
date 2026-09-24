# Round eight — the regression report, audited, and what was changed

Seven phone screenshots, seven complaints, one sentence underneath them: *"I did
not see any change in the UI except bugs and breaking the old ones."*

This is the audit behind the fixes. Each complaint is one section: **what he
saw**, **what the code actually did**, **what changed**. Where a fix is mine to
own, it says so. Where the mechanism could not be established, it says that too.

Build: `78d5afc` was live at the time of writing; `12e6e2e` and `462e0af`
followed within the minute. Suite at the tip: 215 suites, 876 passing, 0
failing; lint clean. Nothing in this round is invisible to the tests — every
item below has at least one test that fails if it comes back.

---

## 1. The mode sheet arrived on its own

**What he saw.** "How should this task work?" — Standard / Deep research — over
the app on open, on refresh, on a new task. Unnecessary: *"I made this product
for deep searching and big and complex tasks."*

**What the code did.** `openModeSheet()` had exactly one caller: a click on the
mode chip. Every `hidden = false` in the client was enumerated (`web/app.js`),
and the sheet and its backdrop were unhidden in no other place; `[hidden]
{ display: none !important }` was present and correct (`web/styles.css:50`), so
nothing in CSS could reveal it either. **The auto-open could not be reproduced
in the code.** That is an honest finding, not a fix.

What could be seen is *why it would feel automatic*: the chip sits in the
control row where a thumb lands first, the sheet then covered the composer, and
dismissing it was a second tap before typing. And a modal is a modal: it can
appear without being asked for.

**What changed.** The modal is gone, so the failure mode is gone with it. The
same controls now live in `.composer-tray`, an inline block between the field
and the control row, unfolded by the chip (`aria-controls="composer-tray"`).
Nothing opens it but that tap; nothing covers the task; there is no dialog to
dismiss and no focus to hand back. Standard folds the tray away (the choice is
complete), Deep research keeps it open for the budget. The `.sheet` CSS was
deleted rather than left behind.

## 2. No visible send button while typing

**What he saw.** A field with text in it and no way to send it.

**What the code did.** `updateTrailingAction()`:

```js
el.send.hidden = state.running || typing || !micUsable;
```

The voice input takes the trailing slot while the field is empty, and the send
button takes it once there is something to send — that is what the comment above
the function said. The line did the opposite: `typing` hid the button at exactly
the moment it was needed, and the mic hid too, so the slot was empty while the
operator typed.

**Why it survived a round about this composer.** `server/web_client.test.ts`
asserted the same wrong sentence back to the code:

```js
assert.ok(client.includes('el.send.hidden = state.running || typing || !micUsable'),
  'and the send takes over the moment there is something to send');
```

A test that restates a bug is a bug with a witness. It is rewritten.

**What changed.** The mic holds the slot only while there is nothing to send and
nothing running; typing hands it to Send. The replacement test asserts the new
line *and* asserts the old one is absent.

## 3. The Thinking panel was empty, and a step sat outside it with a green tick

**What he saw.** An empty "Thinking" box, and under it one step — *"Still
thinking — retrying the request."* — with a green check on it.

**What the code did.** The engine retries a rejected request (`antigravity.ts`,
the `thinking_summaries` ladder and the field-strip fallback) and logs exactly
that sentence at `warn`. The client drew every `log` event as `done: true`
unless it matched the rate-limit pattern, so a *retry* was rendered as an
*accomplishment*. And until a thinking summary arrived there was no content at
all, so the panel was an empty box with a chevron.

**What changed.**

* A new timeline status, `note`, which claims nothing, with an info glyph
  instead of a tick (`web/timeline.js`, `.step[data-status="note"]`).
* Log rows are keyed by their message, so an engine that repeats the same
  sentence every fifteen seconds produces one row, not twelve.
* The panel says the true thing while it is empty: *"The request is out.
  Nothing has come back from the model yet."* — and the placeholder is removed
  for good when text arrives. The write updates a text node in place, so
  selection and scroll inside the panel survive a token.
* The steps are appended **inside** the `<details>` panel, under the thinking
  text and over a hairline. The plan stays outside: it carries the Approve
  button, and a decision must not be able to hide behind a collapsed panel.

## 4. The drawer looked broken

**What he saw.** A moon the size of the drawer next to "Theme: dark", the
Scheduled form expanded, and no task rows.

**What the code did.**

* The moon: `applyTheme()` swapped the row's mark with `mark.outerHTML =
  THEME_ICONS[pref]` — and the replacement SVG carried no class. Without
  `.drawer-row-icon`'s 17px, an inline SVG with no intrinsic size grows to fill
  its container. This is mine, from round seven.
* The form: `renderScheduled()` wrote the *create* form into the panel body, so
  opening "Scheduled" printed six empty inputs before the first task.
* No rows: recent tasks sat under two collapsible panels and the Settings row —
  below the fold, where a drawer's only real content was not.

**What changed.**

* Every theme mark carries its class, **and** the row sizes any icon inside it
  (`.drawer-row > svg`), so losing a class can never grow an icon again.
* The panel body is the list, then a "New schedule" button that reveals the
  form; the form renders closed.
* Order is search → New task → budget → **recent tasks** → Remembered →
  Scheduled → Settings → theme/sign out.

## 5. Settings had not been overhauled

**What he saw.** Dense rows, and a "Replace" button cut in half.

**What the code did.** `.secret-actions button { flex: 1 }` made three actions
share a phone's width, so the longest label was clipped inside a card that is
`overflow: hidden`; inputs sat beside labels rather than under them.

**What changed.** Key actions wrap instead of compressing and are never narrower
than their own label (`min-width: fit-content`), rows and cards may shrink
(`min-width: 0`), coarse pointers get 44px targets and 16px inputs (no iOS zoom
on focus), the page opens with a line saying changes apply immediately, and the
key action says what it does — "Replace key" / "Add key", not a bare "Replace".

## 6. Starter cards on a page whose task was running

**What he saw.** The welcome cards and suggestion chips on a task page.

**What the code did.** `submitPrompt()` hid the hero, so the composer path is
not the cause. Two paths could leave the hero up while a run was live:
`newTask()` — which cleared the thread, dropped the stream **and showed the
starter cards while the task was still running** — and the boot recovery, which
asked `/api/runs/active` once inside a silent `catch`, so one failed request
(the free tier's cold start is exactly that) made the app decide nothing was
running, forever.

**What changed.**

* `newTask()` refuses to abandon a live run: it keeps the card, and says why
  ("Your task is still running — showing it live. Stop it to start another.").
  The server would have refused the second run anyway (409).
* One recovery path, `ensureLiveRun()`, used by boot, by opening a conversation,
  by the phone waking (`visibilitychange`) and by the New task button. It
  retries once before giving up, hides the hero, and when even the retry fails
  it says so with a "Check again" button rather than pretending there is nothing
  to see.

## 7. Three minutes with no live stream

**What he saw.** "You said the live stream is working — why is it not present in
the UI?" — three minutes of a running task with only the retry line.

**What the code did.** Two things, and neither was the stream itself.

* *Finding it.* After a reload, `state.runId` is null. Opening the conversation
  that owned the run only re-attached if `state.runId` was already set, and the
  boot recovery was the single silent request described above. The stream was
  open the whole time; nothing on screen pointed at it.
* *Saying something.* A thinking model streams nothing — legitimately — for
  minutes. Everything in the engine was reactive: it could only report things
  that had already happened, and nothing had happened. Silence was the entire
  output.

**What changed.**

* The engine watches its own stream: after 30 seconds without a frame it emits
  *"Nothing from the model yet — 45s in. The request is open and thinking."*
  every 15 seconds until words arrive (`heartbeatMs` / `heartbeatSilenceMs` are
  options so the test can run them small; the timer is unref'd and cleared with
  the socket). Deltas reset the clock, so a working stream stays quiet.
* The client keeps it as **one row that is rewritten** — "still working, 45s" is
  a state, and forty-five rows is not information.
* Opening a conversation now reads the run state out of its own messages
  (`runStatus` on the operator's message), so a reload can find a live run with
  no dependence on `state.runId`; if the server says it is no longer running,
  the card replays to catch the thread up.

---

## What is verified, and how

| Item | Test |
| --- | --- |
| Mode tray, no modal, chip names it | `web_client.test.ts` "there is no modal" |
| Send button while typing | `web_client.test.ts` trailing-control case (and the old line asserted absent) |
| `note` status, one row per repeated message | `timeline.test.ts`, `web_client.test.ts` |
| Thinking panel never empty | `web_client.test.ts` "never an empty box" |
| Steps inside the panel, plan outside | `web_client.test.ts` + `.thinking > .steps` in CSS |
| Theme icon cannot grow | `ui_audit.test.ts` "an icon cannot grow to fill its row" |
| Drawer order and the hidden schedule form | `web_client.test.ts` drawer cases |
| Settings clipping | `web_client.test.ts` + `ui_audit.test.ts` |
| Live-run recovery everywhere | `web_client.test.ts`, rungs |
| Engine heartbeat | `antigravity.test.ts` "the silence watchdog" (2 cases, real fake server) |

## Still open, honestly

* **The mode sheet's auto-open was never explained.** The modal is gone, so the
  symptom cannot recur, but if he sees a sheet appear again it is a different
  bug and I want the screenshot.
* **No browser in this sandbox.** Everything above is structural: markup, CSS
  cascade and DOM logic. The phone is the only real proof, and the next
  screenshots are the next test.
* **Deploy lag.** `78d5afc` was confirmed live by `/healthz`; the three commits
  after it need the same check before any of this is called fixed on his phone.
* Still queued from `plan/23`: per-passage source pills, Temporary chat, the
  run-settings rail, the Build-mode dock.
