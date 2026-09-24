# 23 — What the audit found, and what I would add next

You asked three things: what to add to the product, whether the interface can be
improved further, and whether the buttons are balanced. This file answers all
three. The fixes are shipped (`e0ae646`); the additions are a proposal, ordered,
with the reason each one earns its place.

---

## 1. What the audit found (shipped)

I went through the shipped stylesheet and markup rather than looking at
screenshots, because the things that go wrong quietly are structural. Five
findings, all fixed:

| Found | Why it mattered | Fixed |
| --- | --- | --- |
| The toast sat at z-index 60, **under** the outputs panel (65/66) and the palette (70/71) | "Copied", "Could not save that", "Thanks — noted" were invisible on exactly the screens where you are most likely to do something worth confirming | Toast to the top of a ladder that is now written down in one place |
| Five inputs removed the browser's focus ring; one rule put one back | The app ships a ⌘K palette and arrow-key lists, so keyboard users are a real population — and they were navigating blind | One pair of rules owns it: `:focus-visible` draws, `:focus:not(:focus-visible)` removes for pointers |
| Tap targets were 30–36px | Below the 44px Apple and Google both publish — a coin-flip with a thumb on a phone | 44px on coarse pointers, for the top bar, send, answer actions, drawer rows and chips |
| The top bar carried **five** controls, four of them unlabelled icons | A phone-width header became a toolbar, and the title had nothing left to say | Theme moved to the drawer (where it says "Theme: dark" in words); four named controls remain |
| The stylesheet had grown by appending — `.composer-wrap`, `.send`, `.convo` and a dozen others declared two or three times | Superseded blocks are how a stylesheet becomes unreadable and how a fix gets silently overridden later | A script removes only blocks that repeat earlier declarations *exactly*; an effective-declaration dump proves the file behaves identically — 0 differences across 488 selectors |

Two smaller ones, also fixed: the drawer had **no Escape handler at all** and
Settings ignored Escape (it now goes back, like the phone's back gesture); and
four competitor product names were sitting in shipped CSS comments, which the
brand scan never covered because it only walks `.js`, `.html` and `.json`.

**The addition:** `?` opens a **keyboard cheat sheet** — grouped by where you
are, with every row proven against the app by a test, and never firing while you
are typing (that guard is the difference between a shortcut and a bug). The
palette carries a row for it too, because a phone has no `?` key.

`server/ui_audit.test.ts` pins all of it, so none of it can come back by
accident. **858 tests, 0 failing, lint clean.**

---

## 2. Are the buttons balanced now?

Yes, and here is the count, so "balanced" is a fact rather than a feeling:

| Surface | Controls | Verdict |
| --- | --- | --- |
| Top bar | 4 — menu · search · new · **stop** (only while running) | Balanced: two left-grouped on the title, one primary action, one emergency |
| Composer | 3 — attach · mode · one trailing slot (mic ↔ send ↔ stop) | Balanced: the trailing slot changes job rather than multiplying |
| Answer | copy · hear · retry · thumbs · share/file actions | Revealed on hover/focus, so a thread of ten answers is quiet |
| Palette | 1 input + ↑↓/↵/esc, and each row prints its own keys | Balanced by construction |
| Drawer | search · new task · recents · theme · settings · sign out | Balanced: one primary, everything else a row |

The rule I would hold from here: **a header gets four controls, and a new icon
has to displace one.**

---

## 3. What I would add next — in the order I would build it

Each row says what it is, why it earns its place, and roughly what it costs.
Everything in the first block is small enough to ship as its own commit with
tests, in the shape the last six rounds have used.

### Worth doing next (high value, low risk)

1. **Temporary task — "don't save this one."** A toggle in the mode sheet. The
   motivation is real: some questions are private, and today every run is
   written to the conversation, the memory extractor and the file record. It is
   a retention feature, not a switch: it needs the ephemeral run marked in the
   database, skipped by memory extraction, and hidden from the drawer. *This is
   the single most-asked-for feature in the AI Studio surface I could not copy
   in an afternoon.*

2. **A daily/weekly digest of what ran.** The morning digest already exists for
   reminders; a short evening summary — tasks run, files produced, anything
   waiting for approval — turns the app from something you drive into something
   that reports. Cheap: it is a scheduled message built from rows we already
   have.

3. **Templates ("do this again").** Any finished task gets "Use as a template":
   the prompt is kept with its mode and attachments, and appears as a starter
   card. The starter cards exist on the empty screen; this makes them *yours*
   instead of ours. Small: one table, one card, one endpoint.

4. **Per-task cost in the drawer.** The answer already reports time and tokens;
   the drawer row could carry the same numbers, so the operator can see which
   kinds of task are expensive *before* the budget warning. Small, and it makes
   the budget concrete instead of a bar with no memory.

5. **`/` to focus the composer, and `⌘↵` to send from anywhere.** Two keys, both
   already half-implemented in spirit; they go in the cheat sheet the day they
   work. Tiny.

### Worth doing, but they are their own round

6. **Offline answers.** The PWA caches the shell, so the app opens with no
   network — but a task submitted offline is refused. A visible "queued until
   you are back" state would make the free-tier sleeping instance and the
   underground train the same problem, solved once. Needs a local queue and a
   drain-on-reconnect, and it must not break the one-run-at-a-time rule.

7. **A second engine you can choose per task.** The engine seam exists
   (`EngineContext`) and the scripted engine is a reference implementation. A
   model picker per run — "fast" vs "deep" — is a real product decision with a
   real cost story, and it wants its own plan.

8. **Sharing a *conversation*, not just a run.** Replays are per-run today. A
   public conversation view is more useful and more dangerous (it exposes the
   thread); it needs a redaction story first, which is why it is not in the
   list above.

### Deliberately not recommended

- **Folders / tags for tasks.** Search already reaches inside tasks, and the
  drawer sorts by recency. Folders are a filing system for people with more
  tasks than the free tier allows in a day.
- **A settings panel for model parameters.** The engine is a managed agent;
  knobs that do not reach it would be theatre.
- **An animated splash on cold start.** It would delay first paint on an
  instance that sleeps after fifteen minutes — a cost disguised as polish.

---

## 4. The state of the interface, honestly

- **What is proven:** structure (tests walk the shipped markup, stylesheet and
  client), behaviour over HTTP, and the effective CSS (a dump of what the
  browser would apply, which is how the cleanup was shown to be a no-op).
- **What is not proven:** anything visual. No browser runs here, so no layout
  was measured and no animation timed. The 44px targets, the focus rings and
  the ladder are *correct by construction* and pinned by tests, not *seen*.
  That is the one gap a real phone closes and this sandbox cannot.
