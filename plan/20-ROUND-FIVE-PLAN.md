# 20 — Round five: what the research says is still missing

Same brief again: best UI, borrow the best small piece from each app, backend
changes allowed, research → plan → execute. The first four stages are shipped
(`17`, `18`, `19`). This round takes what the research names as *still* missing,
and what the previous report listed as deliberately deferred.

## What the research says

### 1. The panel should dock, not float (desktop)

The most-cited layout complaint in real 2026 issues is the same one three
separate projects filed independently: **an artifact panel that overlays the
conversation instead of narrowing it**. Claude's panel does a real split — the
chat column narrows and the panel occupies its own space, no scrim, no blur,
nothing hidden underneath. A dev on one of those projects put it plainly: "this
looks noticeably better than the overlay in live testing, even though the
overlay itself reads fine on its own."

The convention across Claude/ChatGPT/Perplexity is a **centre column capped at
about 720–768px with a right panel**; the rail collapses under about 1200px.
Below that, an overlay (or a bottom sheet on a phone) is correct — the same
projects keep the overlay path "for genuinely narrow windows".

**Decision:** the outputs panel becomes a true split above **1100px** — it
occupies its own column and the thread narrows beside it, backdrop gone.
Below 1100px nothing changes: it stays the slide-over it already is.

### 2. Feedback on an answer, done as a pipeline not a pair of buttons

The consensus across every source is the *tiered* pattern, and a warning about
each layer:

- **thumbs, inline with the message, one click, always available** — "the
  ChatGPT thumbs placement … is deliberate UX. Each design choice you make here
  meaningfully shifts how much data you collect";
- **ask why only on thumbs-down**, with 4–6 **predefined categories** ("Wrong
  information", "Too long", "Didn't follow instructions") — "pre-defined
  categories are faster than open text";
- **optional free text** after the category, for the small fraction that wants
  it;
- **inline beats modal** — a form that opens a modal "kills response rate";
- **"do not ignore the feedback you collect. If you ask for it and nothing
  visibly improves, users stop giving it."**

And structurally: a **separate table**, not columns bolted onto the message —
"messageId, conversationId, rating, reason codes, optional comment, timestamp".
Not because a bigger schema is better, but because that is what makes the data
readable later.

**Decision:** thumbs in the answer's action row; thumbs-down opens a row of
category chips plus an optional note, inline, no modal; one row per message in
its own table; the operator can see what they said in Settings, so the loop is
visibly closed.

### 3. One box for everything, on the keyboard (⌘K)

The command palette is the piece Linear, Raycast and Superhuman all converged
on, and the research is specific about what separates a good one from a
decoration:

- **one box for actions *and* conversations** — "Putting everything in one
  place simplifies the mental model of your app";
- **grouped**, with the group hidden when its items filter out, "so you never
  get an orphan heading";
- **recents at the top**, because "a Recent group … does more for perceived
  speed than any animation";
- **the palette must teach itself**: show the keyboard hint next to each action,
  "so power users graduate off the mouse";
- **mobile has no ⌘**: "give touch users a visible tap target" — the palette
  gets a button in the top bar, and the shortcut is hidden where it does not
  exist;
- accessibility is a **combobox**: the input keeps focus, `aria-activedescendant`
  points at the highlighted row, Escape closes and returns focus.

**Decision:** `⌘K` / `Ctrl+K` opens one palette over tasks **and** actions, with
`↑ ↓ Enter Esc` and shortcuts printed next to each action; a search button in
the top bar on touch.

## Stages, one commit each

| Stage | What ships | Tests |
| --- | --- | --- |
| **F** | Docked outputs panel above 1100px — real split, no scrim | `panel.js` placement helper + client |
| **G** | Answer feedback: table, route, thumbs, reason chips, Settings view | `feedback.test.ts` + route + client |
| **H** | Command palette: pure registry/scoring + combobox UI | `palette.test.ts` + client |

## Non-negotiables carried forward

The phone rules hold (no sideways scroll, no raw "Step k/N", its own Settings
page with back nav), the tier-0 login screen stays, no third-party product
words anywhere in user-visible text or class names (`brand.test.ts` walks the
tree), all motion stays behind `prefers-reduced-motion`, and every change is
tested before it is committed.
