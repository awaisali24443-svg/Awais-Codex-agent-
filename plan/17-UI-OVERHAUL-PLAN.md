# 17 — UI overhaul: research, plan, and what gets built

**Goal (yours):** take the best-grained part of every app you named — Manus's task
view and rich result cards, Claude's message actions and calm reading surface,
Gemini's inbox/sidebar, the best opening animation anywhere — and rebuild WAIS's
interface out of them, adding whatever the backend needs to support it.

This document is the plan. The build log is `18-UI-OVERHAUL-SHIPPED.md`.

---

## 1. What I actually looked at

| Source | What I took from it |
| --- | --- |
| Your Manus screenshots (`image-search/manus-*`) — task view, agent skills, desktop composer | The task screen is **back chevron + title + `…` menu**, results are **rich cards with the provider's icon, a title and a body** (Gmail … "Meeting Invitation / Hi James, …"), and the composer is **one line: "Give Manus a task to work on…" with a `+`, a mode control, mic and send**. The sidebar is **"+ New task" on top, then rows of [bold title / one-line progress summary / date]**, plus quick-action chips under the greeting on the empty state. |
| Claude interface research (Artifacts, message actions, reading surface) | The assistant's answer is **not in a bubble** — it is prose at a fixed reading measure with a **quiet icon action row underneath** (copy, retry, feedback). Long work collapses into a **summary line** ("Ran 3 steps") that expands on tap. Artifacts open in a **side panel that stays open across the conversation** and updates in place. |
| Gemini app (drawer, inbox, recents) | The conversation list is **the app's front door**: search on top, grouped recents with a preview line, account and settings pinned to the **bottom** of the drawer, not the top. |
| Composer consensus, 2026 (Windsurf Cascade / Cursor / Codex-style agents, Android composer issues, chat-UI pattern guides) | **One input card, one `+` on the left, one trailing action that is a mic when empty and a send when typing, mode/model selected *below* the field in one compact control**, field grows ~3–6 lines then scrolls, never floats over messages, rises with the keyboard, focus returns to the trigger when a sheet closes. |
| Conversational UI guidance (empty states, streaming, threading) | **Never ship a blank box**: starters on the empty state are the highest-traffic screen. **Silence reads as broken** — streaming and honest stages. **Mix chat with buttons**: when the next step is a finite choice, render a control, not a sentence. |
| Mobile layout rules | User right / assistant left, user bubble filled, assistant plain; max-width 85% on a phone; 8–12px inside a turn, 16–24px between turns; composer pinned, thumb-reachable, safe-area aware. |

**What I am deliberately not copying:** other products' names, their exact
colours or type, and any pattern that costs money or a network request (no web
fonts, no icon CDNs, no analytics).

---

## 2. The borrow table — where each pattern lands in WAIS

| Pattern | Borrowed from | Lands as |
| --- | --- | --- |
| Soul of the task screen: chevron + title + `…`, results as cards | Manus | Reworked top bar, `…` task menu, artifact and sources cards |
| Assistant answer as prose, not a bubble | Claude | `.answer` at a 68ch measure, quiet actions under it |
| Icon action row under each message (copy / edit / retry / share / outputs) | Claude | Replaces the current pill buttons; icons on desktop, always-shown on touch |
| Work collapses to "6 steps · 42s" when done | Claude | New collapsible run summary |
| Conversation list: search, `+ New task`, grouped recents with a preview line, footer actions | Gemini + Manus | Rebuilt drawer |
| One-line composer with `+`, mode control, mic↔send | Manus | Rebuilt composer card |
| Mode picker below the field, not three pills in the row | Windsurf / Cursor consensus | A "mode" chip that opens a bottom sheet (Standard / Deep research + duration / Ping) |
| Rich result card: icon, title, body | Manus | Artifact cards, source cards, "what I did" cards |
| Starters on the empty state | Manus / every chat guide | New welcome screen with 4 starter cards |
| Opening animation, screen transitions | best-in-class pattern (View Transitions + springs) | Animated boot mark, screen fade/slide, staggered message entry, reduced-motion honoured |
| Stop while working, in the thumb's reach | Claude / ChatGPT | Trailing action becomes **Stop** while a task runs |

---

## 3. What the backend has to grow

| Need | Change |
| --- | --- |
| Recents rows show a **preview line** | `/api/conversations` returns `preview` (last message snippet) and `lastRole` |
| Search across old tasks | client filters the loaded list; server gains `?q=` so it works past 50 conversations |
| The `+` button must do something real | `POST /api/runs` accepts `attachments: [{name, text}]` (text-like files only, capped), folded into the engine prompt as a files block; the stored user message names them |
| Artifact cards need a type | existing artifact record already carries name/size/`previewable`/`stored` — no change |
| Sources card needs domains | `sources.checked` already carries the dead list; the answer's links are parsed client-side — no change |

---

## 4. Build order (one commit each, tests with each)

**A. The conversation itself** — bubbles, answer measure, message action row,
run summary collapse, step rail polish, elapsed-time header.
*Acceptance:* user bubble filled and right-aligned, assistant prose full-width at
measure, actions reachable by keyboard, work collapses to a summary when the run
ends, no horizontal overflow at 320px.

**B. The composer** — one card, `+` attach sheet (real file attach), mode sheet,
mic↔send, stop while running, attachment chips, keyboard-safe.
*Acceptance:* idle composer = `+`, field, trailing action; mode is one control
below the field; typing swaps mic for send; a text file attached reaches the
engine prompt; Escape closes any sheet and returns focus.

**C. The shell** — drawer rebuilt (search, New task, grouped recents with preview,
footer), welcome screen with starter cards, task `…` menu (share, outputs,
rename-free), screen transitions and boot animation, reduced-motion path.
*Acceptance:* drawer usable one-handed, every row shows title + preview + date,
search filters, transitions do not fire under `prefers-reduced-motion`.

**D. Results** — artifact cards, sources card, verified/proof card, outputs panel
in the same language; outputs panel keeps the run's artifacts in view while the
thread scrolls (Claude's "panel stays open, updates in place" idea, as far as a
phone allows).

**Then:** full suite, lint, `plan/18` build log, push, verify the deploy by
`/healthz` commit, and tell you exactly what to look at on the phone.

---

## 5. Non-negotiables

- No third-party product names in anything shipped (the tree-wide test enforces it).
- No new network requests: system fonts, inline SVG icons, no icon CDN.
- Works at 320px wide, with the keyboard open, one-handed.
- `prefers-reduced-motion: reduce` turns every animation off, not down.
- Every interactive control: real `<button>`, an `aria-label`, visible focus, 44px tap target.
- Nothing that already works may regress: the tests from rounds 1–4 stay green.
