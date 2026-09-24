# Round three — four ways the app looked broken when it wasn't

Commit **`0d1cb82`** on `arena/01a0c7ad-awais-codex-agent` (parent `32eadb7`).
No features were added. Every change below exists because a real path through the
app produced no visible explanation.

Suite at this commit: **716 pass / 0 fail** (172 suites, ~147 s), `npm run lint` **0**.

---

## 1. A plan that arrived while the phone was asleep was unreachable

**What happens.** You send a task, then lock the phone or switch apps. The server
drafts the plan and emits `run.plan_ready` while the screen is off. On a phone,
a backgrounded tab's `EventSource` is torn down, so the event is never delivered
and the run sits in `awaiting_plan`. When you come back the card shows the run
with no Approve button — the only visible action left is **Stop**, which cancels
the task you were trying to start. The task could not be approved without
starting a new one.

**Before:** `visibilitychange` returned early unless `state.running`, and the
reconnect path only re-attached the *stream*, never re-read the *run*.

**After:** returning to the tab fetches the run unconditionally. If the status is
`awaiting_plan` and either the stream is dead or the card is gone, we stop
running-lookalike state and re-attach from the run itself, which replays
`run.plan_ready` and repaints Approve / Edit. Three tests:
`web_client.test.ts` "an already-backgrounded plan is still approvable".

## 2. Re-attaching stacked a duplicate card for the same run

**What happens.** `attach()` unconditionally called `createRunCard()`. Every
second attach for one run — foreground return, or tapping **Review plan** — drew
a *second* card. Two live thinking panels, two answer panes, ambiguity about
which Stop button owns the run.

**After:** `createRunCard` stamps `card.dataset.runId`. New `cardFor(runId)`
rebuilds the render handle over the *existing* DOM node (resetting
`thinkingText`, `answerText`, `stepIndex` so the replay is clean), and
`existingCard()` lets `attach()` prefer it. Tests: "a re-attach reuses the card
it already has" and "a reused card starts from a clean slate".

## 3. A cold start was a minute of nothing

**What happens.** Render's free tier sleeps after 15 minutes idle and takes about
a minute to wake. During that minute the page is blank or a browser error — no
sign anything is happening.

**After:** two independent pieces.
- `web/app.js`: `enter()` shows *"Waking the server…"* after `BOOT_NOTICE_MS`
  (4 s), and clears only its own notice — never someone else's.
- `web/sw.js`: a navigation races the network against
  `NAVIGATION_TIMEOUT_MS` (6 s) via `settleWithin()` and falls back to the
  cached shell. The request is deliberately **not** aborted, so the cache still
  updates and the next visit is from cache.

Tests: "a cold start says the server is waking" + "a navigation never waits on
the network forever" (asserts the two constants, the shell fallback, and that no
`abort()` was introduced).

## 4. The composer was silent for as long as the plan took to draft

**What happens.** `POST /api/runs` does not answer until the run row exists — and
for a complex task the plan is drafted *inside that request*. Your message
appeared, the composer cleared, and then nothing for up to a minute. Same
silence as a crash.

**Before:** `submitPrompt` cleared the prompt, appended your message, and awaited
the API with no placeholder.

**After:** `pendingRunNotice()` renders *"Starting the task…"* immediately;
after 6 s it becomes *"Still starting — a complex task drafts its plan first,
which can take a minute."* A `finally { pending.done(); }` removes it on every
exit — including the 409 (something else is running), 429 (budget) and generic
failure paths, so the notice can never linger as a second thing on the thread.
Test: "starting a task says so while the request is in flight".

---

## Route reachability (checked, nothing to fix)

Walked every route string registered on the server against every `api()` /
`fetch()` call in `web/`: **0 dead routes in either direction**. The route
matcher needed `:param` normalisation before diffing — `GET /api/runs/:id` in the
server and `` `/api/runs/${id}` `` in the client do not compare literally.

## Files touched

```
 server/web_client.test.ts |  69 +++++++++++++++++-
 web/app.js                | 120 ++++++++++++++++++++++++++++++++--
 web/sw.js                 |  44 ++++++++++++++---
 3 files changed, 221 insertions(+), 12 deletions(-)
```

## Tests added this round (6)

| Test | Guards |
| --- | --- |
| an already-backgrounded plan is still approvable | finding 1 |
| …and foregrounds a plan whose stream died | finding 1 |
| a re-attach reuses the card it already has | finding 2 |
| a reused card starts from a clean slate | finding 2 |
| a cold start says the server is waking | finding 3 |
| a navigation never waits on the network forever | finding 3 |
| starting a task says so while the request is in flight | finding 4 |

## Preview

Preview still serves the older tree (port 4200, key `wais-preview`): the watchdog
fixture is in-memory, so a restart loses it, and the preview process predates
`0d1cb82`. Findings 1–4 are all client-side and are visible on the live site
after the deploy below; finding 4 is the easiest to see from the phone.

## Still open (unchanged from round two)

- Rotate `ACCESS_KEY` — it is in the transcripts. The preview uses a throwaway key.
- A greeting still spins up a sandbox (product decision, not a bug).
- Reconsider the keep-awake ping now that maintenance ticks hourly.
