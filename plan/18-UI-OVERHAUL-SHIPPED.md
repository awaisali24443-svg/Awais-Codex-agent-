# 18 — The interface overhaul: what shipped

Three commits on `arena/01a0c7ad-awais-codex-agent`, on top of `9b2d980`:

| Commit | What it is |
| --- | --- |
| `20e1a1f` | **The conversation surface** — bubbles, prose, message actions, run folding, motion tokens |
| `94817a4` | **The composer** — one card, mode sheet, the mic↔send↔stop slot, real file attachments (client + server) |
| `1a77ab0` | **The shell** — drawer as front door (search, grouped recents with a preview line), starter cards, screen transitions |
| `80f7e75` | Fix for a type slip the drawer test let through the lint gate |

Suite at the tip: **754 pass / 0 fail** (181 suites, ~145 s), `npm run lint` **0**.

---

## What was actually taken from where

**From Manus** — the task screen, the result cards, and the composer. Your
screenshots show a row that is *title + one line of what happened + date*, a
`:` menu beside the task name, and a composer that is one line with a `+`, a mode
control, a mic and a send. WAIS now has all three: the drawer row carries the
last thing said in the task and its date, grouped Today / Yesterday / Earlier;
the composer is one card with `+` on the left, one mode control, and one trailing
control; and the `…`-style secondary actions (share, outputs) live on the run
rather than as permanent furniture.

**From Claude** — the reading surface. An answer is not a bubble: it is prose at
a 66-character measure with a small mark over it saying who is speaking, and a
row of quiet icon controls under it (copy, listen, retry, outputs) that only
appears when the message is hovered or a control in it is focused — and is always
there on a touch screen. Long work folds into one line, "6 steps · 42.1s", that
opens on a tap. That is the single biggest change to how the app reads: before
it, every run left its whole timeline open above the answer, so the thing you
asked for was the last thing on the screen and the scroll to reach it grew with
every run.

**From Gemini** — the drawer as the front door: search at the top, one obvious
way to start something under it, the recents in the middle, and account-level
actions at the foot where a thumb rests (Settings, Theme, Sign out).

**From the composer consensus (Windsurf Cascade / Cursor / Codex-style agents)** —
one input card, one `+`, one trailing action that changes job, mode selection
below the field rather than three always-visible pills beside it, a 16px field so
iOS never zooms the page, and sheets that return focus to whatever opened them.

**Opening animation** — the welcome mark draws itself in on first paint, screen
changes go through the View Transitions API where it exists, and every animation
in the app is switched off (not slowed) for a reader whose device asked for less
motion.

---

## The backend changes that came with it

- **`POST /api/runs` accepts `attachments: [{name, text}]`.** Text-like files
  are read in the browser and travel inside the request — nothing is uploaded,
  so a file that never leaves the phone cannot leak from a server. Validated by
  the new `server/attachments.ts`: at most 3 files, 200 KB each, 400 KB
  together, and a file that decodes to replacement characters is refused as "not
  a text file". Refusals are sentences naming the file and the limit
  (`400 invalid_attachments`).
- **The stored prompt and the wire prompt are now two different things.**
  `createRun` gained `enginePrompt`: the row, the conversation title and the
  operator's message keep their own words (plus one line, "📎 Attached: notes.md"),
  while the engine is handed the words *and* the file contents, fenced with each
  file's name. `acceptRun` hands the caller back the database row, so the file
  text cannot travel out in an API response. The planning pass sees the files
  too, since it plans from the run.
- **`GET /api/conversations?q=`** searches titles *and message text*, so the
  drawer can find a task by what was said inside it; `listConversations` now
  returns a `preview` (the last message, flattened to one line) beside the title.

## Tests added

| Area | Cases |
| --- | --- |
| Attachments (unit) | 11 — caps, three legal files adding up, binary-as-text, malformed entries, the thread line, the fenced wire block |
| Attachments (routes) | 2 — a file reaches the engine and never the thread; a refusal explains itself and starts nothing |
| Conversation list | 1 — the preview line, and search reaching words inside a message |
| Conversation surface | 7 — bubble-prose split, measured answers, hover-reveal actions, clipboard fallback, run folding, the live clock, arrival motion |
| Composer | 6 — one card, one mode control, the sheet as a dialog, the trailing slot, attachments, the 16px field |
| Drawer | 5 — search above the list, rows that remember, server-side search, the starter cards, transitions |
| Welcome | 1 — every starter says what it does |

## Deliberately left for the next pass

- **The outputs panel and artifact cards.** The panel works and keeps the run's
  files; it has not yet been rebuilt as Manus-style rich cards (icon, thumbnail
  for an image, size, kept state, actions in the card). That is stage D.
- **Task `…` menu.** Share / outputs are on the run card; a task-level menu in
  the header is not built.
- **The splash on a cold start.** `enter()` says "Waking the server…" after four
  seconds and the service worker serves the cached shell after six; I tried an
  animated splash element and removed it rather than ship markup that nothing
  drives.

## How to see it on the phone

Render deploys `arena/01a0c7ad` automatically. Pull the page down once after the
deploy lands — the client files revalidate on every load, so one refresh is
enough. Then:

1. The composer is one card: `+`, the field, one mode chip, one trailing control.
   Type anything and the mic becomes a send; send a task and it becomes Stop.
2. Tap `+` and attach a `.txt` or `.md` — it shows as a chip, travels with the
   task, and the answer can use it.
3. Tap the mode chip: Standard or Deep research with a time budget, plus the
   WhatsApp ping, in one sheet.
4. Send a task. Watch the clock in the working header. When it finishes, the
   whole timeline folds into one line you can tap.
5. Open the drawer: search on top, New task under it, rows with what was last
   said in each task, Settings and Theme at the bottom.
