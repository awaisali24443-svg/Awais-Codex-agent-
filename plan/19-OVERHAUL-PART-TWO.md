# 19 — Overhaul, part two: results, decisions, and the rest of the screens

Six commits on `arena/01a0c7ad-awais-codex-agent` since `9b2d980`. The first four
are written up in `17-UI-OVERHAUL-PLAN.md` and `18-UI-OVERHAUL-SHIPPED.md`; this
file covers the rest, where the remaining screens were brought into the same
language.

| Commit | What it is |
| --- | --- |
| `7a060d9` | **Results are cards, and an answer shows where its facts came from** (stage D) |
| `aaef8f6` | **The plan, settings, and a shared replay** in the same language (stage E) |
| `7fd9f17` | **Reading while it works** — one tap back to the bottom |

Suite at the tip: **777 pass / 0 fail** (183 suites, ~141 s), `npm run lint` **0**.

---

## 1. A produced file is a card

It was a pill with a filename in it — `index.html · 12 KB` — which says something
exists and nothing else. It is now a card carrying four things:

- **what it is**, derived from the name (`artifactKind`): a web page, an Android
  app, a spreadsheet, a PDF, an image, code, an archive, or honestly just "File";
- **how big**, and **whether it is kept** (`artifactMeta`) — "Kept" is a promise
  about retention, so `stored` (the bytes are on the disk today) is deliberately
  not shown as if it were the same thing;
- **what can be done now**: Open (live preview, sandboxed), Download, Keep.

The **thread and the outputs panel draw the same component**, so a file cannot
look like one thing in the conversation and another in the panel, and pinning it
in either place repaints both through the same registry. The panel also learned
to say which task it belongs to, and each of its tabs now counts what is inside
it ("Files · 3").

New pure module **`web/records.js`** — `artifactKind`, `artifactMeta`,
`sourcesFromText`, `markDead`, `sourcesSummary` — with 12 unit tests, so the
parsing is pinned without a browser.

## 2. An answer shows its sources

Research is only trustworthy if you can see where it came from, and an answer
that says "according to the RBI circular" without saying which one is asking to
be believed. The links are already in the answer text; `sourcesFromText` pulls
them out in citation order, deduplicated (a markdown link and a bare URL to the
same place are one source, and the *named* one wins), and `markDead` marks the
ones the server's link check could not reach. A dead source is a fact about the
answer, so it is shown — struck through, in the danger colour, with "did not
respond" under it — not hidden.

Four are shown and the rest are one tap away. **Stored answers get the same
strip**, so a task from last week reads exactly as it did the day it ran, and
nothing has to be fetched for it. Bare URLs in the prose are real links now too;
text that looks like a link but is not one reads as broken.

## 3. The plan — the only irreversible tap in the app

Approving a plan starts work that costs a run. Before this pass, a plan waiting
for approval looked exactly like a plan being worked on. It is now its own card
that says *"Nothing has run yet — approve to start, or edit it first"*, counts
its own steps, puts **Approve** first as a primary action with **Edit** beside
it, and keeps its rows in order above the buttons.

## 4. Settings, grouped by question

Three settings, then keys, then the phone channel, with notes in between: one
undifferentiated list. It is now three titled blocks — **How it runs**, **Keys**,
**The phone channel** — in the same card language as everywhere else, because a
settings page is a list of questions, not a list of keys.

## 5. A shared replay looks like the app it came from

The public page was bare system font on white. It now wears the same warm paper,
the same mark, the same cards, and follows the reader's light/dark preference —
and still ships **no script and no external stylesheet**, which is the promise of
a link a stranger opens on a metered phone. Five new assertions hold it there,
including "no script at all".

## 6. Reading while it works

The stream already stopped following the bottom when the operator scrolled up —
without that, reading a paragraph while a task runs is impossible. What was
missing was the way back: on a phone, the bottom of a long thread is a long drag.

There is now a pill above the composer, where the eye already is:

- while the task works: **"Working… jump to latest"** with a spinner;
- if the run finishes while you are reading further up: **"New answer — jump to
  it"**, with a filled dot instead of the spinner;
- one tap scrolls back smoothly and re-pins the stream; a new task clears it.

---

## Where this leaves the app

Every surface the operator can reach now speaks one language: warm paper and a
warm accent, cards for records, prose for answers, quiet icon rows for actions,
the same motion tokens, sheets that return focus, and animations that switch off
entirely for a device that asked for less motion.

**Still open, and deliberately so:**

- **Desktop two-pane.** Above ~1200px the research says the conventions converge
  on a persistent right panel for outputs. The slide-over works at every width;
  a docked panel is a layout change worth doing on its own.
- **Feedback on an answer** (thumbs up/down). It needs somewhere to be stored to
  mean anything, and nothing reads it yet.
- **A greeting still spins a sandbox.** The product call from earlier rounds.
- **Rotate `ACCESS_KEY`** — it is in the transcripts.
