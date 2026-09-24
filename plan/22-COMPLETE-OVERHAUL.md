# 22 — The complete overhaul: every part, where it came from, what it cost

The brief, in full (sent five times, each one meaning *deeper*):

> do a complete overhaul of the app and of any part of the app need fix, renewal,
> additions or changing do that in the UI. I need a complete best UI. I want that
> get and collect every small part of the UI from each app — Manus's chatting
> bubbles, Claude's chat options, Gemini's inbox, another app's opening animation
> — etc and so on. If anything is needed to be added in the backend, add it. But
> before: do proper research, find out, collect data, then make a plan and execute.

This file is the whole account in one place: what was taken from where, what it
looks like in the code, what it cost in tests, and what was deliberately refused.
Branch `arena/01a0c7ad-awais-codex-agent` (also `arena/01a0c3fe-…` — the two are
one history now), tip after round six: **`a15cf06`, 839 tests pass / 0 fail.**

---

## 1. The borrowing ledger

Every item below is a thing one specific product does well, and the place it
lives in WAIS. Nothing was copied as decoration: each row changed a screen.

| Taken from | The piece | Where it lives now | Status |
| --- | --- | --- | --- |
| **Manus** | Task rows: title + one line of what was last said + a date | Drawer, grouped Today / Yesterday / Earlier | `1a77ab0` |
| **Manus** | The task screen: a rail of steps with status, one live clock | The run card's step timeline | `20e1a1f` |
| **Manus** | The live thinking stream | "Thinking" panel, open while it works, folded after | `20e1a1f` |
| **Manus** | Result cards (file: kind, size, kept, actions in the card) | `artifactCard` — drawn identically in the thread and the panel | `7a060d9` |
| **Claude** | Answers are prose, not bubbles: 66-character measure, small speaker mark | The answer surface | `20e1a1f` |
| **Claude** | Quiet action row that gets out of the way (copy, listen, retry, outputs) | Under every answer, hover/focus-revealed | `20e1a1f` |
| **Claude** | The artifacts panel docks — it narrows the chat instead of covering it | Docked above 1100px, overlay below, width-driven | `a9f3a57` |
| **Gemini** | The inbox | The drawer as the front door, with server-side search across message text | `1a77ab0` |
| **Gemini Deep Research** | A plan you review *before* anything runs | The plan card: approve, or edit | `9b2d980`, `aaef8f6` |
| **Gemini Deep Research** | Edit plan → then Start research | Staged in round six: renaming became a real editor — move, drop, add | `a474da8` |
| **Gemini Deep Research** | The side panel: "researching N sources…" with the list as it is visited | The source rail (below), fed by the run's own events | `989f356` |
| **Gemini** | Citations as source pills with dead-link detection | The Sources strip under an answer, `sources.checked` | `7a060d9` |
| **Google AI Studio** | Per-response metadata: tokens used, time taken | The cost line under a finished answer | `a15cf06` |
| **Google AI Studio** | Live quota awareness | Budget buckets in Settings | earlier round |
| **Linear / Raycast / Superhuman** | ⌘K palette: actions *and* conversations in one box | Stage H palette, with a search button for touch | `6dbf84f`, `9608727` |
| **ChatGPT** | Thumbs in the message row, reasons only after a thumbs-down | Inline ratings + a closed reason list + optional note | `b50a06c`, `1ad91a4` |
| **The composer consensus** (Windsurf / Cursor / Codex-style agents) | One input card, one `+`, one trailing control that changes job | The composer | `94817a4` |
| **"The best opening animation"** | The welcome mark draws itself in; screen changes use View Transitions | First paint and every screen change | `84b4215`, `9d27880` |

---

## 2. Round six: the research, then what shipped

### What the research actually found (and an honest limit)

The ask included watching Google AI Studio advertisements. **I cannot watch
video** — I read instead, and it is worth being exact about what that produced:

- Google's 2026 Super Bowl spot for Gemini ("New Home": a mother and son
  redraw their new house room by room, rated best ad of the game) is *emotional
  storytelling about previewing an outcome*, not a UI showcase. Its product
  lesson is not a widget — it is that people trust a tool that shows them the
  result before it is real. That is exactly what an editable plan and a live
  "where it is looking" panel do, and it is why those two became round six.
- AI Studio's **product surface** (which I could read in detail) is more
  borrowable: a chat playground with per-response metadata, an editable research
  plan, "Temporary chat", Build mode's three panels, and live quota monitoring.
- The Deep Research flow documented by Google and by everyone who has used it is
  consistent: *plan card → Edit plan → Start research*, then a side panel that
  says "Researching N websites…" and lists them as they are visited, then a
  report with citation superscripts and per-passage source pills.

### Stage I — the plan is a list, and it is edited like one (`a474da8`)

Renaming a step is the smallest possible edit; a plan you can only rename is
still the model's plan. The checklist now opens into a real editor: each row
**moves up, moves down, or goes away**, a missing step is typed in at the
bottom, and **Start the task** saves and begins — so what runs is what was
approved. The editor cannot produce something the server would refuse (same
20-step cap, last step not removable).

Writing the test found a **real bug, bigger than the feature**: editing a plan
persisted the event and never published it, so the phone that made the edit saw
the new plan (it re-rendered from its own response) while any other open view
kept the old one until it reconnected. Approval had the same hole. Both go
through one `announce()` now — persist, then publish — and a test holds a stream
open, edits the plan, and asserts the frame arrives with its `id:` line intact.

### Stage J — a task that goes looking says where (`989f356`)

A task reading the web and a task that is stuck look identical from outside. The
run now streams its reading: URLs found in tool arguments, the question behind a
lookup-shaped call (never a fabricated URL for it), and pages named in the
agent's own narration. Deduped, capped at forty, durable — so a reconnect
replays the same rail and a second device sees the same list.

On screen it is a rail, not a transcript: two rows while it moves, newest first,
with one control that says what it will do. When the answer lands it folds to
*"Where it looked · 8 sites"*. That line exists for the case worth caring about:
**the pages a task read and the pages it cited are allowed to disagree, and only
one of those lists is written by the model.**

### Stage K — what it cost, and how long it took (`a15cf06`)

AI Studio's per-response metadata, in the one place it earns its keep: the
operator runs on a free tier where the limits are tokens and requests, so a
number you can watch while it is still explainable beats a warning at the end of
the month. Drawn once, from one helper, both live and on a reopened answer; an
engine that reports no tokens prints no tokens, and a half-known line shows a
dash rather than a zero pretending to be a measurement.

### What round six deliberately did not take

| Not taken | Why |
| --- | --- |
| **Temporary chat** (AI Studio) | Our runs are the record — steps, files, share links, ratings all hang off the run row. A "not saved" mode is a real feature and a real data-deletion story, not a toggle; it needs its own round. |
| **Compare mode** (two models side by side) | WAIS runs one engine that manages its own sandbox; two columns of one engine is not a comparison. |
| **Run settings** (temperature, top-p, max tokens) | The engine is a managed agent. Exposing knobs that do not reach it would be theatre. |
| **Build mode's three panels** | Already have two (thread + docked outputs). A third column on a phone-first app is a desktop-only flourish. |
| **An animated cold-start splash** | Tried in round one and removed rather than ship markup nothing drives. A splash that delays first paint on a free tier that sleeps is a cost, not a feature. The welcome mark's own animation is the honest version. |

---

## 3. What the app is now, screen by screen

- **Login** — one key field, a saved link, "Waking the server…" after four
  seconds so a sleeping instance never reads as broken.
- **The thread** — the operator's own words in a quiet bubble on the right,
  answers as measured prose on the left, a working header with a live clock,
  steps on a rail, the source rail under the steps, the answer, its citations,
  its files, its cost line, and one action row per message.
- **The plan card** — steps, *Approve & start*, *Edit*; the editor moves,
  drops, adds; nothing runs until it is approved, and the waiting state says so.
- **The composer** — one card: `+`, the field, one mode control (Standard /
  Deep research with a time budget), one trailing control that is mic, send, or
  stop depending on what can happen next.
- **The drawer** — search on top (titles *and* what was said inside), New task,
  grouped recents with a preview line, Settings and Theme at the bottom.
- **⌘K** — one box over tasks and actions, grouped, ranked, with its own keys
  printed; a search button on touch; Escape returns focus where it was.
- **The outputs panel** — a column above 1100px, an overlay below, the same
  cards as the thread, tabs with counts.
- **Settings** — keys, channels, budget, and "What you told me": the ratings you
  gave, so the loop is visibly closed.

---

## 4. Non-negotiables, held

- **The phone rules**: no sideways scroll, no token cap or estimate chip, no raw
  "Step k/N" text, Settings as its own page with a back gesture, running tasks
  showing what they wait on, no Edit button on a finished answer.
- **No third-party product words** anywhere a reader can see them —
  `brand.test.ts` walks the shipped tree; the classes, the copy and the docs are
  clean, and the borrowed ideas are described in these plan files, not in the
  product.
- **Motion** is opt-in: everything animated has a `prefers-reduced-motion` path
  that switches it off rather than slowing it down.
- **The login stays.** Access is a key in a link; there is no public surface.
- **One run at a time**, enforced by the database, not by the UI.

---

## 5. How it was verified

| Check | Result at `a15cf06` |
| --- | --- |
| `npm test` | **839 pass / 0 fail** (199 suites, ~125 s) |
| `npm run lint` | 0 (both `tsc --noEmit` passes) |
| Heavy-user walk (`heavy_user.test.ts`) | 13 cases: sign-in through failure paths, over HTTP against the real app |
| Client pins (`web_client.test.ts`) | 80 cases: the phone rules and every round-six surface, read out of the shipped files |
| Deploy | `/healthz` reports the commit; Render follows `arena/01a0c7ad` |

The client tests are structural — they read the shipped markup, stylesheet and
client and pin the decisions — because there is no browser in this sandbox.
(The summary line varies by a test or two between runs: the suite runs with
`--test-force-exit`, so a worker still finishing when the rest are done is cut
off rather than counted. Failures are what to read, and there are none.)
That is the honest limit of every UI verification in this project, and it is
stated in `21-HEAVY-USER-AUDIT.md` too.

---

## 6. Still open, with reasons

| Open | Note |
| --- | --- |
| Task-level `…` header menu | Share/outputs live on the run card; a header menu needs a decision about where a task ends. |
| The greeting → sandbox question | Waiting on the operator's call, not on implementation. |
| Rotate `ACCESS_KEY` | One environment variable, one deploy. |
| Temporary chat | See above: it is a retention feature, not a toggle. |
| A first-run tour | The empty screen currently teaches by being useful (starter cards, the composer's own labels). A tour is a promise to maintain it. |
