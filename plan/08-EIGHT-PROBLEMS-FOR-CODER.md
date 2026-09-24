# 08 · The eight problems, with details — for the coder

**Status: verified against `arena/01a0c7ad` @ `706bb6a` (this morning).** Nothing here is fixed yet as of that
commit. Each item: what the user sees → why → the exact fix → how to prove it's fixed.

Hand them in this order. #8 first if you want CI green while you work on the rest.

---

## 8 · CI is red (do this first — it blocks everything else)

**What the user sees:** every push shows a red X. Nothing deploys from it, and no other fix can be proven.

**Two causes, both one-liners.**

**(a) Lint fails** — `npm run lint` is the first CI step, so nothing after it ever runs:

```
server/linkedin.test.ts(184,48): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server/linkedin.test.ts(194,50): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
```

`createRun()` returns `conversationId: string | null`; the test passes it straight to `listPendingDrafts(db, id)`.

```ts
// line ~183
assert.ok(run.conversationId, 'createRun gives the test a conversation');
const drafts = await listPendingDrafts(db, run.conversationId);
// line ~194
assert.deepEqual(await listPendingDrafts(db, run.conversationId), []);
```

(`assert.ok` narrows the type in TS, so no `!` and no cast.)

**(b) A stale assertion** — `server/whatsapp.test.ts:519`

```ts
assert.match(reply, /Daily run budget exhausted/);   // was: /Daily whatsapp run budget exhausted/
```

The code is right and the test is wrong: the budget is now one shared daily pool, so the message is no longer
whatsapp-specific.

**Done when:** `npm run lint` exits 0 **and** `npm test` reports 0 fail. Then push and confirm the X is green.

---

## 1 · "Tasks left today" tells the user the wrong number

**What the user sees:** the phone says *"Tasks left today: 79/100"* while the very next message is refused.

**Why:** the spending gate counts the **whole day** across web + whatsapp + api (`budget.ts`, one atomic statement
over the day total), but this function counts only the `whatsapp` bucket. Spend 20 runs on the web and the phone
believes nothing was spent. Only caller: `server/whatsapp/poller.ts:493` (the `/status` reply).

```ts
// server/accept.ts:230 — replace the whole function
/** Today's remaining runs across every channel — the counter the gate enforces. */
export async function remainingRuns(deps: AcceptDeps): Promise<number> {
  const used = await peekDayTotal(deps.db);
  return Math.max(0, deps.config.dailyRunBudget - used);
}
```

- Import `peekDayTotal` instead of `peekBudget` in `accept.ts`.
- `peekBudget` then has no callers — delete it from `budget.ts` (or keep it and document it as display-only).
- Update the caller: `remainingRuns({ db: this.deps.db, executor: this.deps.executor, config: this.deps.config })`
  (drop the `'whatsapp'` argument). `RunKind` is still used elsewhere in `accept.ts` — keep that import.

**Test:** with `dailyRunBudget = 2`, spend 1 run via the web path, then send `/status` on WhatsApp and assert it
reports **1** left, not 2.

---

## 2 · Coming back to a finished task shows an empty timeline

**What the user sees:** background the app (or lock the phone) mid-task; when the task finishes while you're away,
you come back to a blank timeline until you reload the page.

**Why:** `finishRun` compacts a run's intermediate snapshots and then **renumbers `seq`**. A browser reconnecting
with its old `Last-Event-ID` sends a number the compacted log no longer reaches, and `resumeFrom()`
(`server/routes/runs.ts:121`) passes it through, so the replay is empty. The stream still ends politely — the *content*
is what's missing. This is the common case on Android, because a backgrounded WebView is suspended and reconnects
when you return.

```ts
// server/routes/runs.ts — in the stream handler, replacing `const from = resumeFrom(req);`
let from = resumeFrom(req);
// finishRun compacts snapshots and renumbers `seq`, so a cursor from before the
// finish can point past the end of the log. Replaying from the start is always
// correct, just heavier.
if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;
```

`latestEventSeq` already exists in `server/runs.ts` — add it to that file's import list.

**Test:** run a task to completion, then request the stream with `after` far past the last seq (or a stale
`Last-Event-ID` header) and assert the body contains `run.started` and a `text.snapshot` — i.e. replay is not empty.

---

## 3 · The Settings "Test" button spends quota the budget cannot see

**What the user sees:** nothing wrong, until the day's runs run out earlier than `/api/budget` promised.

**Why:** `POST /api/settings/verify/gemini-key` runs **a real engine interaction** (`server/verify.ts:303`,
`checkAgent` → `engine.run`) and never claims a budget slot; the endpoint is not throttled either. Click Test three
times: three interactions spent, `/api/budget` still says 0. It also bypasses the one-task-at-a-time rule, so it
can run alongside a live task.

```ts
// server/routes/settings.ts — inside the verify handler, after the key check passes and before checkAgent
const keyCheck = await checkGeminiKey({ apiKey: key });
if (keyCheck.verdict !== 'ok') { res.json({ ok: false, key: keyCheck, agent: null }); return; }

// The agent leg is a real interaction: claim it from the same daily gate every
// other run uses, so /api/budget stays truthful.
try {
  await consumeRunBudget(db, 'api', config.dailyRunBudget);
} catch (err) {
  res.status(429).json({
    ok: false, error: 'budget_exceeded',
    message: (err as Error).message, key: keyCheck, agent: null,
  });
  return;
}
const agentCheck = await checkAgent({ apiKey: key, agent, timeoutMs: 90_000 });
```

`SettingsRouteDeps` currently has no `db`; add `db: Db` and `limit: number` (or pass `config`) at the call site in
`app.ts`. Optional second guard: a small per-minute counter (3/min) like the login throttle.

**Test:** budget 1 → spend it with a run → `POST /api/settings/verify/gemini-key` returns 429 and `/api/budget`
shows no extra spend; with budget left, a successful verify increments the `api` bucket by 1.

**Also:** the button's UI copy should say it spends one interaction.

---

## 4 · Retention is not actually running, and one table is never pruned

**What the user sees:** nothing, for weeks — then the free 0.5 GB database fills up and things start failing.

**Why:** `pruneRunEvents` and `pruneArtifacts` are called **only in the boot sequence** (`server/main.ts:76`, `:81`).
That was fine when Render slept and restarted constantly; now a pinger keeps the process alive for weeks, so the
only prune is the one at deploy time — and the first one after a long uptime is the biggest, on a DB with a 30 s
statement timeout. Worse: **`wa_updates` is never pruned by anything** (`grep` finds only a test's
`DELETE FROM wa_updates`), so every inbound WhatsApp message is stored forever.

```sql
-- server/whatsapp/store.ts (new function) — pruneWaUpdates(db, keepDays = 30)
-- Only rows that were handled: an unprocessed row is pending work, never delete it here.
DELETE FROM wa_updates
 WHERE processed_at IS NOT NULL
   AND received_at < now() - ($1 || ' days')::interval
RETURNING 1
```

```ts
// server/main.ts — one hourly tick, next to the reminders/scheduler loops
const runMaintenance = async (): Promise<void> => {
  try {
    const events = await pruneRunEvents(db, config.eventRetentionDays);
    const artifacts = await pruneArtifacts(db, config.artifactRetentionDays);
    const messages = await pruneWaUpdates(db, 30);
    if (events || artifacts || messages) {
      console.log(`[maintenance] pruned events=${events} artifacts=${artifacts} wa_updates=${messages}`);
    }
  } catch (err) {
    console.error('[maintenance] tick failed (will retry next hour):', (err as Error).message);
  }
};
const maintenanceTimer = setInterval(() => void runMaintenance(), 60 * 60_000);
maintenanceTimer.unref?.();
```

Delete in **batches** (e.g. `LIMIT 5000` in a loop until 0 rows) so a 30 s timeout can never kill the tick.

**Test:** insert rows older than the windows, call the tick function, assert the counts and that a fresh,
unprocessed `wa_updates` row survives.

---

## 5 · Files the agent made can disappear

**What the user sees:** the answer lists `report.pdf`; a week later the download says the file is gone.

**Why:** two disposable layers. The bytes are fetched from the engine **sandbox** on demand (`environmentId`,
which expires), and the copy made on first download lives under `artifactsRoot()` =
`<cwd>/data/artifacts` — an **ephemeral** Render disk. And `pruneArtifacts` **deletes the database rows too** after
7 days, so even the record that the file existed goes away.

**Fix, two stages (stage 1 is the whole point):**

1. **Keep on request.** A "Keep" button on an artifact: fetch the bytes, store them in object storage (Cloudflare
   R2 — free tier, zero egress), set `storage_key`, and mark the row `pinned`. Download checks the pinned copy
   first, then the sandbox. `pruneArtifacts` must skip `pinned` rows (add the flag in a new migration).
2. **Auto-keep** the artifacts of any run the user shared (`shareToken` set) — a shared replay whose files 404 is
   a broken promise.

**Test:** materialize an artifact, pin it, then null the run's `environmentId` and assert the download still
returns the bytes; and assert `pruneArtifacts` leaves pinned rows alone.

---

## 6 · A phone task that runs longer than 45 minutes is never delivered

**What the user sees:** send a long task from WhatsApp → ack → one "still working" line at 90 s → **silence**. The
answer exists (visible on the web), but the chat never gets it. It also holds the single active slot, so every
message meanwhile is answered with "I am still on this one".

**Why:** three pieces line up badly:
- `server/whatsapp/relay.ts:43` gives up watching after `DEFAULT_MAX_WAIT_MS = 45 min` and returns `detached`;
- `server/whatsapp/poller.ts:627` deliberately does nothing on `detached` — *"the next boot's reconcile picks it up"*;
- `reconcile()` runs **only at boot** (`server/whatsapp/lifecycle.ts:167`), and with the pinger in place, boots can
  be weeks apart.

It is reachable from the UI: the research budget accepts up to **480 minutes**, and the composer offers a
**1 hour** preset. Nothing anywhere tests the 45-minute boundary.

**Fix (a) is enough to close it — do (b) too.**

```ts
// server/whatsapp/lifecycle.ts — start(), right after `poller.start()`
// A detached relay (a task slower than 45 minutes) relies on reconcile to deliver
// the answer. That used to happen only at boot; with the service kept awake for
// weeks, "the next boot" may never come. A slow tick makes delivery self-healing.
const reconcileTimer = setInterval(() => {
  void this.poller?.reconcile().catch((err: Error) =>
    this.log(`[wa] periodic reconcile failed: ${err.message}`, 'error'));
}, 5 * 60_000);
reconcileTimer.unref?.();
```

Store the handle and `clearInterval` it in `stop()` and `shutdown()` (the class already has both paths).

```ts
// (b) server/whatsapp/poller.ts:627 — leave an honest trace instead of returning silently
if (result.outcome === 'detached') {
  this.log(`[wa] stopped watching ${run.id}; periodic reconcile will deliver its answer`);
  return;
}
```

**Test:** construct a run that never emits a terminal event inside the wait window, force the relay to detach,
let the run finish, then call `reconcile()` and assert the closing WhatsApp message is sent and the `wamid` is
marked processed. Second test: the 45-minute boundary itself (inject a small `maxWaitMs`).

---

## 7 · A deploy that ships a migration can fail to boot

**What the user sees:** a red deploy, and (worse) a service that didn't come back.

**Why:** `migrate()` does a plain `INSERT INTO schema_migrations` (`server/migrate.ts:82`) with no `ON CONFLICT`.
Render starts the new instance **before** stopping the old one, so two boots can overlap for a few seconds —
and the moment a migration is pending is exactly the moment both of them run it. The second INSERT hits the
primary key, the transaction aborts, `migrate()` throws, and `server/main.ts:73` doesn't catch: **the boot dies**.
(The migration SQL itself is safe — every statement in all 13 files is `IF NOT EXISTS`-guarded; it is only the
bookkeeping insert that can collide.)

```ts
await tx.query(
  'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
  [migration.version, migration.name],
);
```

Related, same root cause: the boot maintenance calls (`main.ts:76`, `:81`) are unguarded too, so a slow prune can
fail a deploy. Wrap them (see #4's try/catch — keep the boot call as a best-effort warm-up, let the hourly tick be
the real mechanism).

**Test:** run `migrate()` twice in a row (and once concurrently against the same DB) and assert no throw, with the
second reporting `skipped`.

---

## Order, and what "done" means

1. **#8** — CI green (two one-liners).
2. **#2** — the stream clamp: four lines, and it is the difference between "streaming works" and "streaming looks
   broken on my phone".
3. **#6** — the phone's delivery promise.
4. **#1** and **#3** — the two places that lie about quota.
5. **#7** — the deploy-safety clause.
6. **#4** and **#5** — make it trustworthy over weeks (maintenance tick, durable files).

**Done = for each item: the fix, a regression test that fails before it, `npm run lint` clean, `npm test` 0 fail,
one commit per item.** Nothing else starts until #8 is green.
