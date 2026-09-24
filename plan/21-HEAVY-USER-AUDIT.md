# 21 — Heavy-user audit: walking the whole app the way a person uses it

You asked for this twice, so here it is in words: what was tested, what broke,
what was fixed, and what is still weak. The tests themselves are in
`server/heavy_user.test.ts` (11 cases) and `server/web_client.test.ts`; this is
the reading of them.

Branch `arena/01a0c7ad-awais-codex-agent`, tip `9608727`.

## The method

Every other test in the suite isolates one thing. The heavy-user pass boots the
**real** app — `createApp`, the same sessions, budget gate, executor and routes
that run on your phone — on its own port, and then uses it in the order a person
does, over HTTP, with a scripted model behind it:

> sign in with the saved link → give it a big messy task with a file attached →
> watch it work and stop to ask permission → approve the plan → let it finish →
> read the answer → take the file it produced → rate the answer → share the
> replay → search for the task afterwards → book a reminder → start a second
> task while the first is running → stop it.

That sequence is the point. It is the only place where features meet each other.

## Your question: does a live stream stay in one card?

Yes — and it is now pinned in the tests rather than in my memory.

- A run's card is stamped with its run id and looked up by it
  (`cardFor(runId) ? existingCard(runId) : createRunCard(runId)`), and every
  event is bound to that card, so one run cannot paint into two cards.
- Every way back into a run goes through the same `attach()` guard: a reconnect,
  the boot recovery, "Review plan", reopening the conversation that owns a live
  run, and the new palette's "resume the running task" row. A replay from a
  cursor resumes from the SSE `id:` line and never repeats an event.
- On the server, a stream subscribes *before* it replays, buffers while
  replaying, drops transient decoration frames, and closes with `event: end` if
  the run is already finished — so a reconnect to a dead run ends instead of
  hanging.

## Feature by feature

| Feature | How it was walked | Verdict |
| --- | --- | --- |
| Saved-link login (`?k=`) | claim on the redirect, cookie asserted separately | works; a non-browser client that follows the redirect lands signed out (correct, now documented) |
| Deny by default | every `/api` path without a session | 401/redirect as expected |
| A real task | big prompt + attachment → plan → approve → run | works end to end |
| Plan approval | `awaiting_plan` + `run.plan_ready`, approve resumes | works; a stream read on an un-approved run never ends (correct — it is waiting for you) |
| Live stream | frame order, durability, no duplicates on replay | works; transient frames carry no `id:` by design |
| Cancel | a genuinely slow run, then `/cancel` | streams `run.cancelled`; an orphaned run is finished server-side so the stream still ends |
| One task at a time | second run while the first is live | 409, as intended |
| Files produced | list, download, pin | works |
| Answer rating | thumbs, reason, note; message- and run-scoped | works both ways, lands on the same row |
| Search | a word said *inside* a task, not its title | finds it |
| Share / replay | public page with no session and no script; revoke | works; revoked links die immediately |
| Reminders | create, list, delete | works (body is `{text, runAt}`) |
| Memory | add, list, use | works |
| Budget | buckets and shared daily limit | works |
| Settings | keys, WhatsApp toggle | works |
| Verification gate | a task that announces steps and never closes them | **fails the run** — "N of N step(s) not finished" — instead of shipping a cheerful answer |
| A failing run | engine error mid-stream | stream ends with a failure the card can render |

Not part of this walk (covered by their own tests): scheduled tasks, the daily
briefing, GitHub/Google/LinkedIn integration routes.

## What the walk found

1. **The `?k=` link is claimed on the redirect.** Anything that is not a
   cookie-storing browser lands signed out. The app is right; the test now
   proves it by asserting the 302 and the cookie separately.
2. **The durable position rides the SSE `id:` line, not the payload.** That is
   the EventSource cursor, and it is what a reconnect resumes from. A parser
   that invents a `seq` field out of the JSON reports phantom duplicates —
   this cost real debugging time.
3. **Cancelling a fast run proves nothing.** The cancel path needed a genuinely
   slow run in an isolated app to be tested at all.
4. **The verification gate is real.** Announced-but-unclosed steps fail the run.
5. **A shipped copy bug, found while touching the row:** the LinkedIn publish
   button read "in Publish to LinkedIn" — a rename artifact, now fixed.

None of these were guessed at from reading code; each one is a thing the walk
did and the app did not expect.

## What this does *not* prove

Honest limits, so you know what is still unverified:

- **No browser was driven.** The client assertions are structural (the shipped
  markup, stylesheet and client, read and pinned) plus HTTP-level behaviour. No
  layout was measured, no animation timed, no tap simulated. A real phone is
  still the only place the phone rules can be *seen*.
- The scripted engine is not a real model: latency, token streaming and failure
  shapes are simulated.
- Deployment was verified only through `/healthz` (commit, uptime) — not by
  using the live URL as an operator.

## Still open (carried, not forgotten)

- The greeting → sandbox decision.
- Rotating `ACCESS_KEY`.
- A task-level `…` header menu; an animated cold-start splash (both deliberately
  deferred).
- Free tier sleeps after ~15 minutes idle: the first request after that waits
  for a cold start.

## Where round five stands

| Stage | What shipped | Commit |
| --- | --- | --- |
| F | Outputs panel docks above 1100px — real split, no scrim | `a9f3a57` |
| G | Answer feedback: table, routes, thumbs, reason chips, Settings view | `1ad91a4` |
| H | ⌘K / Ctrl+K palette over tasks *and* actions | `6dbf84f`, `9608727` |

At the tip: **822 tests pass, 0 fail; lint clean.** The deploy follows the branch
about a minute after a push.
