# 04 · Review of the newest branch + the plan, revised for your always-on pinger

**Read-only.** I changed nothing in your repo: no commits, no pushes, no edits to code. This file is an
untracked working-tree addition (`plan/04-...md`); commit it, ignore it, or delete it — your call.

**What I actually read:** the branch with the newest work —
`arena/01a0c7ad-awais-codex-agent` @ **`6005037`**, 13 commits between 03:15 and 03:21 today, i.e. *after* my
last audit (which was pinned to `53ad6d6`). You were right that I was reading a stale commit.
I ran its suite and lint locally (in a scratch clone under `/tmp`, never in your checkout), and read the
hardening fixes.

**Headline:** the coder did the work well — 337 of 338 tests pass, lint is clean, and 12 of the 13 work-order
tasks plus both bonus items are in. **CI is red for exactly one reason: a stale assertion string.** One line
fixes it and PR #2 goes green. Below: that fix, two new bugs I found in the *new* code, and what your ping
changes about the freemium plan.

---

## 1. Verdict on the branch — what is done, and what is not

| # | Task | State | Evidence / note |
|---|---|---|---|
| T1 | `db.test.ts` derives migrations from `loadMigrations()` | **done** | `c5ca7dc`. The 30 cancelled suites are gone: `# cancelled 0` in my run. |
| T2 | A persistent 5xx must not enter the rate-limit wait ladder | **done, reviewed** | `eb8ec50`. Only `errorType === 'rate_limited'` gets the patient loop; other retryable 5xx get `MAX_UPSTREAM_RETRIES = 2` with an *abortable* backoff, then `upstream_error`. Exactly the spec, with tests. |
| T3 | Boot warns (not dies) when `GEMINI_API_KEY` is empty in production | **done, reviewed** | `fe41ad7`. Warn + "runs will be refused until a key is stored in Settings". |
| T4 | One shared daily budget gate | **done, reviewed** | `d833ce5`. `consumeRunBudget` claims in a *single* statement whose `WHERE` compares the day **total** against the cap — the 3× leak is closed. Per-channel rows are bookkeeping only. |
| T5 | Compact intermediate snapshots | **done, reviewed** | `fa4439c`. Sound: those snapshots are cumulative, so keeping first+last per type loses nothing. See F2 for the one edge it introduced. |
| T6 | Artifact downloads resolve the key from the secrets store | **done, reviewed** | `41c9729`. Store-first, env fallback, read per request. |
| T7 | `/api/auth/session` must sit behind `requireSession` | **done, reviewed** | Registered after `app.use('/api', requireSession)`; `/api/auth/login` stays public above it. |
| T8 | Cancel with no executor still emits a terminal event | **done, reviewed** | `47b2d77`. `finishRun` + `bus.publish(run.cancelled)`, as specced. |
| T9 | Validate `NODE_ENV` | **done, reviewed** | Rejects anything outside development/test/production instead of silently dropping production guards. |
| T10 | `/readyz` → 503 when not ready | **done, better than spec** | Checks database, poller, engine key *including the stored one*, and auth mode; `res.status(ready ? 200 : 503)`. |
| T11 | Login throttle | **done** | Per-IP counter with a window and eviction, `429` on excess. |
| T12 | Hygiene | **partly — and I'm reversing my own advice** | `render.yaml` does **not** declare `REMINDERS_ENABLED`/`GITHUB_TOKEN` — correct, see §5. User-visible "mission" wording is gone; the word survives only in code comments. |
| T13 | Retire v1 | **~60 % done** | `js/` and top-level `routes/` deleted; tag `v1-archive` correctly points at the last commit that still contains them. Leftovers in F5. |
| B1 | Settings key-test button over `verify.ts` | **done** | `6acdc12`. This was strategy Phase 1 — the "is my key alive?" question now has an answer in the UI. |
| B2 | Persist `interaction_id` per deep-research pass | **done** | `f491c39`. This is the "a crashed run can resume instead of re-paying" item. |
| B12 | CI boots in key mode and proves the guard | **done, reviewed** | New `ci.yml` step asserts 401 without the key and 200 with it. |

---

## 2. The one thing standing between you and a green PR

`server/whatsapp.test.ts:519` still asserts the **old** per-channel copy:

```ts
assert.match(reply, /Daily whatsapp run budget exhausted/);
```

The code changed for the right reason: with one shared budget (`budget.ts:37`) the message is no longer
whatsapp-specific — and it shouldn't be, since web and API spend from the same pool. The assertion is stale,
not the behaviour.

**Patch (one line):**

```ts
assert.match(reply, /Daily run budget exhausted/);
```

**Proof:** on a scratch clone of `6005037` I applied exactly that and ran the suite — `# tests 338 · # pass 338 ·
# fail 0 · # cancelled 0`, `npm run lint` clean. That is the whole difference between PR #2 red and PR #2 green.

---

## 3. Two new bugs in the new code, plus four tidy-ups

### F1 — "Tasks left today" over-reports (one line, user-visible)

`server/accept.ts:153`:

```ts
export async function remainingRuns(deps: AcceptDeps, kind: RunKind): Promise<number> {
  const bucket = BUCKET_FOR_KIND[kind];
  const used = await peekBudget(deps.db, bucket);   // ← per-channel count
  return Math.max(0, deps.config.dailyRunBudget - used);
}
```

The gate is the day **total** now, so this reports 100 minus *whatsapp's* count. Spend 40 web runs and the
phone still says "Tasks left today: 100/100" while the next run is refused. Its only caller is
`server/whatsapp/poller.ts:471` (the `/status` reply), so the fix is local:

```ts
export async function remainingRuns(deps: AcceptDeps): Promise<number> {
  // The gate is the day's total (see budget.ts), so what we report must be too:
  // a per-channel count over-reports the moment another channel spends.
  const used = await peekDayTotal(deps.db);
  return Math.max(0, deps.config.dailyRunBudget - used);
}
```

Update the caller to `remainingRuns({ db, executor, config })`; `peekBudget` then has no callers — delete it
and its import. Keep the `RunKind` import: `accept.ts` uses it elsewhere.

### F2 — A resume cursor can outlive the event log it points at (four lines)

`finishRun` compacts snapshots and then **renumbers `seq` 1..N** (`server/runs.ts:445`). A browser that was
streaming this run and reconnects a moment later sends `Last-Event-ID: 50` — a sequence number that no longer
exists because the compacted log now ends at, say, 40. `resumeFrom()` passes it through untouched
(`server/routes/runs.ts:114`), so the replay is empty: the task's timeline comes back blank until a page
reload. Narrow window, real symptom.

The helper already exists (`latestEventSeq`, `server/runs.ts:327`). In the stream route, right after
`const from = resumeFrom(req);`:

```ts
    let from = resumeFrom(req);
    // finishRun compacts snapshots and renumbers `seq`, so a cursor from before
    // the finish can point past the end of the log. Left alone, that replays
    // nothing and the task's timeline looks empty; replaying from the start is
    // always correct, just heavier.
    if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;
```

(The alternative — moving compaction out of `finishRun` into the boot sweep with a one-hour safety window,
which is what I originally specced — is also correct, but it keeps the compaction work on the boot path and
costs more change. The clamp is the smaller fix; take it.)

### F3 — `refundRunBudget` is dead code again

`server/budget.ts:144`. Nothing calls it: `accept.ts` claims *after* the run row exists and the conflict check
has passed, so there is no "refused after claiming" path. Delete it (or write the test that makes it live —
but do not leave a comment claiming a caller that does not exist).

### F4 — The `engine` budget bucket is vestigial

`BudgetBucket` includes `'engine'`, which is never written; `/api/budget` reports `web`, `whatsapp`, `api`, each
with `remaining` computed off the day total (correct). Either drop `'engine'` from the type or keep it and
document why nothing writes it. Cheap tidy, no behaviour change.

### F5 — v1 leftovers still in the tree (finish T13)

Dead, verified: nothing under `server/` or `scripts/` imports any of them, the server serves `web/`, and
`scripts/make-icons.mjs` says so itself ("v1's `public/` folder belongs to a server that no longer runs").

```
index.html                 v1 shell (the app is web/index.html)
public/                    v1 PWA assets (web/ has its own: icon.svg, manifest.json, sw.js, icons)
antigravity-client.ts      v1
apk-generator.ts           v1
call-budget-server.ts      v1
memory-engine.ts           v1
config.ts   (repo root)    v1  — server/config.ts is the live one
types.ts    (repo root)    v1
generate-icons.js          v1  — scripts/make-icons.mjs is the live one
metadata.json              v1
data/agent-memory.example.json  v1
```

They are not merely bytes: `tsconfig.json` has no `include`, so `tsc --noEmit` type-checks the root-level v1
files too, and they can fail CI one day for a reason nobody can explain. Tag is already in place
(`v1-archive`), so delete them in one commit and move on.

---

## 4. Your pinger changes the plan — here is the arithmetic

Good news first: an inbound ping every 11 minutes is well inside Render's 15-minute idle timer, so the service
stays warm and **the WhatsApp poller never stops**. That removes the whole reason for the heavy edge-intake
design (my ADR-001): no Cloudflare Worker, no second runtime, no credential replication. Simpler is better —
I'm withdrawing that from the critical path. Keep it only as an escape hatch.

But the ping is not free, and the bill arrives in a currency you can't see:

- Render gives **750 free instance hours per workspace per calendar month, shared across every free service.
  A spun-down service consumes nothing. When the pool is empty, Render suspends *all* free web services in the
  workspace until the 1st** (hours reset monthly, no rollover). Sources: Render's own free-tier docs, plus
  independent 2026 write-ups.
- A 31-day month contains **744 hours**. So one service kept awake around the clock consumes ~99 % of the
  entire workspace allowance. You have roughly a **6-hour margin**, and only because you run exactly one free
  web service.

**The four rules that keep this safe**

1. **One free web service in that workspace, forever.** Static sites don't consume instance hours, so a static
   site is fine; a second free *web service* — a staging copy, a webhook receiver — will exhaust the pool and
   take the agent down with it until the 1st. If you ever need a second service, come back to the Cloudflare
   Worker design (it lets Render sleep, cutting its hours to near zero).
2. **Prefer 5 minutes over 11.** Against a 15-minute timer, 11 gives you 4 minutes of slack for one late tick;
   5 gives 10. Pings cost nothing, so buy the margin.
3. **Make the pinger a monitor with an alert, not just a pulse.** The ping is now a single point of failure for
   the agent's core promise (messages arriving at 3am), not just for the website. A free uptime monitor
   (UptimeRobot / BetterStack class: email or Telegram on failure) does both jobs — keeps it awake *and* tells
   you when it isn't. If your ping lives in GitHub Actions cron instead: the floor is 5 minutes, scheduled runs
   are delayed under load, and **on public repos scheduled workflows auto-disable after 60 days of repository
   inactivity** — a silent failure mode you'd discover only by noticing the agent went quiet. Use a real
   monitor.
4. **Check the workspace's instance hours monthly** (Render dashboard → Billing). If you ever want headroom
   without paying, drip the ping: letting the service sleep one hour a night (e.g. 04:00–05:00 PKT) banks ~30
   hours a month and costs nothing that matters — messages sent during the gap are **not lost**, they're read
   on the next poll because the platform buffers them and the poller keeps its cursor. Worst case the sender
   waits for the read receipt.

**What the ping does not fix:** free instances still get restarted by Render at will, still have 512 MB / a
fractional CPU, and still have an ephemeral disk. Your app already survives all three (boot prune, orphaned-run
recovery, poller reconcile, artifacts in Postgres). That is why pinning `DATABASE_URL` to **Neon** matters —
the alternative, Render's free Postgres, is deleted 30 days after creation.

---

## 5. Revised plan — smallest useful steps, in order

**Step 0 · Make CI green (5 minutes).** §2. This is the only thing gating PR #2; nothing else should start
before it.

**Step 1 · Land the two real bugs + tidy-ups (30–60 minutes).** F1 (wrong "tasks left"), F2 (blank timeline on
resume), F3, F4, F5. Each is one commit, each with the regression test for F1/F2.

**Step 2 · Tell me four things, and I'll re-aim the roadmap precisely.** I could not verify the deployment from
here — this sandbox can only reach github.com, and `https://awais-codex-agent.onrender.com/healthz` returns
Render's edge 404, which means that hostname is not your service:

1. What is the live URL, and which branch does that Render service deploy from (`main`, or an arena branch)?
2. Is that service's `DATABASE_URL` the Neon pooled string?
3. Where does the 11-minute ping live (a third-party monitor, a workflow in another repo, something else)?
4. Do you actually use the reminders/GitHub-export features? If not, **leave them out of `render.yaml`** — my
   earlier T12 advice, reversed: an env var that no feature reads is just a thing to get wrong later.

**Step 3 · Only three features next (strategy Phase 1, the parts not yet built).**
- **Alerts to your phone** when a run fails, the daily budget is spent, or the poller dies — the app already
  knows all three; it just doesn't tell you. This is the single biggest perceived-quality upgrade per line of
  code, and it turns your pinger from "keeps it awake" into "tells me when it's stuck".
- **Artifact permanence** (R2, zero egress) so "send me the file" still works after a redeploy.
- **A daily digest** — what ran, what it cost, what's waiting.

**Step 4 · Measure for two weeks before building anything else.** The numbers that decide the next phase:
acknowledgement latency, runs per day, messages per task, and how many tasks finished unattended. The app
already logs the raw material (`[http]` request log, `[run]` lifecycle, `[wa]` poller). If those numbers look
like the scoreboard in `plan/02`, Phase 2 (deferral queue, batch checklists) is worth building; if they don't,
the queue is solving a problem you don't have.

**Explicitly not now:** the edge Worker (ADR-001 stays on the shelf), a second free web service, per-channel
budget display, and anything that needs a paid tier to be *correct*.

---

## 6. One line to remember

The branch is 99 % there and CI is red over a string; your pinger works but spends ~99 % of the only quota that
can silently kill the whole agent; and the next two moves are a one-line test fix and a "tell me when it
breaks" message to your phone.
