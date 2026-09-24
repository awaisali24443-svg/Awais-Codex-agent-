# 10 · The seven remaining problems — complete details, ready to hand over

**Verified against `arena/01a0c7ad` @ `89a3390`** ("Idea #5 groundwork: public artifact download links"), which is the
tip as of this writing. Every file, line and snippet below was read from that commit.

**Where this branch stands right now**

| Already done | Still broken (the seven below) |
|---|---|
| CI fix #8 — the two test lines are corrected | **1** the phone reports the wrong "tasks left" |
| Morning digest, breakage alerts, message-only reminders (your ideas, landed) | **2** a reconnecting client gets an empty replay |
| Public artifact download links (idea groundwork) | **3** the Settings "Test" button spends hidden quota |
| | **4** retention never runs; `wa_updates` grows forever |
| | **5** artifact files and their records are disposable |
| | **6** a phone task over 45 minutes is never delivered |
| | **7** a deploy that ships a migration can fail to boot |

**Rules for the whole batch:** one commit per problem · each ships a regression test that fails before the fix ·
`npm run lint` and `npm test` must both be clean (0 fail) before the next one starts · don't touch the WhatsApp wire
protocol, the SSE frame format, or the cookie/session model while doing these.

**Order: 2 → 6 → 1 → 3 → 7 → 4 → 5.** Reason: 2 and 6 are the ones a user actually notices; 1 and 3 are honesty
about quota; 7 prevents a bad deploy; 4 and 5 are hygiene that matters over weeks.

---

## Problem 1 · "Tasks left today" tells you the wrong number

**What you see:** the phone replies *"Tasks left today: 79/100"* — and then refuses your next message with
"budget exhausted". Or the reverse: it says 0 left while 60 runs remain.

**Why:** `server/accept.ts:249` counts **one channel's** usage, but the spending gate counts the **whole day**.
Spend 21 runs on the web and the whatsapp bucket is still 0, so the phone thinks nothing has been spent.

```ts
// server/accept.ts:249 — current
export async function remainingRuns(deps: AcceptDeps, kind: RunKind): Promise<number> {
  const bucket = BUCKET_FOR_KIND[kind];
  const used = await peekBudget(deps.db, bucket);      // ← per-channel
  return Math.max(0, deps.config.dailyRunBudget - used);
}
```

The gate itself is right — `server/budget.ts:57` `consumeRunBudget()` claims against
`SELECT COALESCE(SUM(count), 0) FROM budgets WHERE day = CURRENT_DATE`, i.e. the day total. Only the *reporting*
disagrees with it. Sole caller: `server/whatsapp/poller.ts:520` (the `/status` reply).

**Fix**

```ts
// server/accept.ts — replace the function (and drop the now-unused `kind` parameter)
/** Today's remaining runs across every channel — the counter the gate actually enforces. */
export async function remainingRuns(deps: AcceptDeps): Promise<number> {
  const used = await peekDayTotal(deps.db);
  return Math.max(0, deps.config.dailyRunBudget - used);
}
```

1. `server/accept.ts:25` — import `peekDayTotal` instead of `peekBudget`; delete `peekBudget` from the import list.
2. `server/budget.ts:90` — `peekBudget` now has no callers. Either delete it, or keep it and add
   `/** Display only: one channel's usage. `remainingRuns` uses the day total, never this. */`.
3. `server/whatsapp/poller.ts:520` — change the call to `remainingRuns({ db: this.deps.db, executor: this.deps.executor, config: this.deps.config })`.
4. Keep the `RunKind` import in `accept.ts` — it is used elsewhere.

**Test** (in `server/whatsapp.test.ts`, next to the existing budget test): set `dailyRunBudget: 2`, run one web-path
run to completion, then send `/status` on WhatsApp and assert the reply contains `1/2` (not `2/2`). Second case:
spend both runs, send a normal message, assert the refusal message and that `/status` agrees.

**Done when:** the number on the phone and the number in `/api/budget`'s `remaining` are always the same, and a
test proves it.

---

## Problem 2 · Coming back to a finished task shows an empty timeline

**What you see:** you background the app (or lock the phone) while a task runs. The task finishes while you are
away. You come back and the timeline is **blank** — no steps, no reasoning, no answer — until you reload the page.
The task itself is fine; only the view is empty. **On Android this is the normal path**, because a backgrounded
WebView is suspended and reconnects when you return.

**Why:** two correct pieces that combine badly.
- `finishRun` compacts a run's intermediate snapshots and then **renumbers `seq` from 1** (`server/runs.ts`, the
  renumber step after the compaction delete), so a run that once had 50 events can end with 40.
- The browser reconnects with `Last-Event-ID: 50` (or `?after=50`). `server/routes/runs.ts:123` `resumeFrom()`
  passes that number straight through, the replay query finds nothing at or above it, and the stream immediately
  ends — the client's `end` handler (`web/app.js`) correctly closes the card but has no content to draw.

**Fix** — a four-line clamp in the stream route (`server/routes/runs.ts`), using a helper that already exists
(`latestEventSeq`, `server/runs.ts:465`):

```ts
// near the top of the stream handler, replacing: const from = resumeFrom(req);
let from = resumeFrom(req);
// finishRun compacts snapshots and renumbers `seq`, so a cursor from before the
// finish can point past the end of the log. Repairing it to 0 replays everything —
// always correct, just heavier — instead of replaying nothing.
if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;
```

Add `latestEventSeq` to the `../runs.js` import block (`server/routes/runs.ts:50-61`).

**Test** (in `server/runs.test.ts` or a new `server/stream.test.ts`): complete a run, read its events, take the
largest `seq`, then request the stream with `after = maxSeq + 10`:

```ts
const res = await get(`/api/runs/${run.id}/stream?after=${maxSeq + 10}`);
assert.match(res.text, /event: run\.started/);   // replay is not empty
assert.match(res.text, /event: run\.completed/);
```

And a second case: a fresh (unfinished) run with `after` beyond the log still streams live and ends with the
terminal event.

**Done when:** a stale cursor always yields a complete replay, and the test proves it with a number that does not
exist.

---

## Problem 3 · The Settings "Test" button spends quota the budget cannot see

**What you see:** nothing, until the day runs out earlier than the app promised. `/api/budget` is *wrong* after
you use the Test button.

**Why:** `POST /api/settings/verify/gemini-key` (`server/routes/settings.ts`, the handler at the
`'/settings/verify/gemini-key'` route) runs a **real engine interaction** — `checkAgent()` calls `engine.run()`
(`server/verify.ts`). It never claims a budget slot, and the endpoint is not throttled. Three clicks = three
interactions while `/api/budget` still reads 0. It also ignores the one-task-at-a-time rule, so it can run beside
a live task.

**Fix** — claim from the same gate every other run uses, before the agent leg:

```ts
// server/routes/settings.ts — inside the handler, after the key check, before checkAgent
const keyCheck = await checkGeminiKey({ apiKey: key });
if (keyCheck.verdict !== 'ok') {
  res.json({ ok: false, key: keyCheck, agent: null });
  return;
}

// The agent leg is a real interaction. Claim it from the shared daily gate so
// /api/budget stays truthful and the button cannot quietly overspend the day.
try {
  await consumeRunBudget(db, 'api', dailyRunBudget);
} catch (err) {
  res.status(429).json({
    ok: false,
    error: 'budget_exceeded',
    message: (err as Error).message,
    key: keyCheck,
    agent: null,
  });
  return;
}

const agentCheck = await checkAgent({ apiKey: key, agent, timeoutMs: 90_000 });
res.json({ ok: agentCheck.verdict === 'ok', key: keyCheck, agent: agentCheck });
```

Wiring (three small edits):
1. `server/routes/settings.ts` — add to `SettingsRouteDeps`: `db: Db;` and `dailyRunBudget: number;` (import the
   `Db` type and `consumeRunBudget` from `../budget.js`).
2. `server/app.ts:305-311` — pass `db` and `dailyRunBudget: config.dailyRunBudget` into `createSettingsRoutes({...})`.
3. `server/settings.test.ts` — the existing settings suite constructs these deps; add the two new fields to every
   construction (a `db` from the test's PGlite instance, `dailyRunBudget: 100`).

Optional second guard: the same per-minute counter style as the login throttle (3 per minute), so a stuck button
cannot burn ten interactions.

**Test:** budget 1 → spend it via a normal run → `POST /api/settings/verify/gemini-key` returns **429** and
`/api/budget`'s `api` bucket stays unchanged. With budget available, a successful verify increments the `api`
bucket by exactly 1.

**Also:** change the button's copy in `web/app.js` to say it spends one interaction (it currently says nothing).

**Done when:** the button can no longer spend quota invisibly, and a test asserts both the 429 and the counter.

---

## Problem 4 · Retention never runs, and one table grows forever

**What you see:** nothing for weeks — then the free 0.5 GB Neon database fills up, writes slow down, and the day
ends with failures that look like anything but "the disk is full".

**Why:** `pruneRunEvents(db, 14)` and `pruneArtifacts(db, 7)` are called **only in the boot path**
(`server/main.ts:76` and `:81`). That design assumed Render sleeps and restarts often; with your pinger keeping
the process up for weeks, the only prune is at deploy time — and the first one after long uptime is the largest,
against a pool with a 30-second `statement_timeout` (`server/db.ts`), i.e. exactly when a single-statement delete
is most likely to time out.

And **`wa_updates` is never pruned by anything** — every inbound WhatsApp message keeps its full payload
(`jsonb`) forever. Only a test deletes from it.

**Fix — three parts.**

**(a) A batched, timeout-proof prune.** Replace `server/db.ts:195` `pruneRunEvents` with a loop that deletes a
bounded slice per statement (the primary key is `(run_id, seq)`, and `run_events_at_idx` covers the `at` filter):

```ts
export async function pruneRunEvents(db: Db, keepDays = 14, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{ count: string }>(
      `WITH doomed AS (
         SELECT run_id, seq FROM run_events
          WHERE at < now() - ($1 || ' days')::interval
          LIMIT $2
       ), deleted AS (
         DELETE FROM run_events e
          USING doomed d
          WHERE e.run_id = d.run_id AND e.seq = d.seq
          RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(keepDays), String(batch)],
    );
    const n = Number(rows[0]?.count ?? 0);
    total += n;
    if (n < batch) return total;   // last (partial) slice — done
  }
}
```

**(b) `wa_updates` gets a window too.** Add to `server/whatsapp/store.ts`:

```ts
/** How long a handled inbound message is kept. Unprocessed rows are never touched. */
export const WA_UPDATE_RETENTION_DAYS = 30;

/**
 * Retention for the message log. Only rows that were actually handled are
 * eligible: an unprocessed row is pending work (boot recovery reads it), so
 * deleting one would silently drop a message the operator sent.
 */
export async function pruneWaUpdates(db: Db, keepDays = WA_UPDATE_RETENTION_DAYS, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{ count: string }>(
      `WITH doomed AS (
         SELECT wamid FROM wa_updates
          WHERE processed_at IS NOT NULL
            AND received_at < now() - ($1 || ' days')::interval
          LIMIT $2
       ), deleted AS (
         DELETE FROM wa_updates w USING doomed d WHERE w.wamid = d.wamid RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(keepDays), String(batch)],
    );
    const n = Number(rows[0]?.count ?? 0);
    total += n;
    if (n < batch) return total;
  }
}
```

**(c) An hourly tick that runs all three.** In `server/main.ts`, next to the digest/alerts ticks (same shape,
same `unref()`), after the DB and config exist:

```ts
// ---- maintenance ---------------------------------------------------------
// Retention used to be a boot-only task, which was fine while the free tier
// slept often. The keep-awake ping means boots can be weeks apart, so pruning
// moves to a timer; the boot calls stay as a warm-up. Batched deletes keep a
// single statement inside the pool's 30s timeout.
const runMaintenance = async (): Promise<void> => {
  try {
    const events = await pruneRunEvents(db, config.eventRetentionDays);
    const artifacts = await pruneArtifacts(db, config.artifactRetentionDays);
    const messages = await pruneWaUpdates(db, 30);
    if (events || artifacts || messages) {
      console.log(`[maintenance] pruned events=${events} artifacts=${artifacts} wa_updates=${messages}`);
    }
  } catch (err) {
    // Never fatal: the next tick tries again.
    console.error('[maintenance] tick failed:', (err as Error).message);
  }
};
const maintenanceTimer = setInterval(() => void runMaintenance(), 60 * 60_000);
maintenanceTimer.unref?.();
void runMaintenance();
console.log('[boot] maintenance: on (hourly retention sweep)');
```

**(d) Keep the boot calls but make them non-fatal** — wrap `main.ts:76` and `:81` in one try/catch so a slow
first sweep can never take the deploy down (see Problem 7).

**Test** (`server/db.test.ts` or a new `server/maintenance.test.ts`): insert 3 `wa_updates` rows — one processed
and old, one processed and fresh, one **unprocessed and old** — run `pruneWaUpdates`, assert only the first was
deleted. Same shape for `run_events` (old vs fresh) and a batch-boundary case (insert `batch + 1` old rows and
assert all are gone in two passes).

**Done when:** the sweep can be called at any time, on any size of table, without a timeout, and a test proves an
unprocessed message is never deleted.

---

## Problem 5 · Files the agent made (and shared) disappear

**What you see:** the answer lists `report.pdf` (or the APK, or a website). A week later the download says the
file is gone — or the *public link you texted to yourself* returns 404 — even though the task record still lists
it.

**Why:** three disposable layers, and the new share feature made the third one visible:
1. **The bytes come from the engine sandbox** — `materializeArtifact()` downloads from the run's
   `environmentId`, and remote environments expire.
2. **The local copy is on an ephemeral disk** — `artifactsRoot()` = `<cwd>/data/artifacts` (`server/artifacts.ts:158`),
   wiped by every deploy.
3. **The database row itself is deleted after 7 days** — `pruneArtifacts()` does
   `DELETE FROM artifacts WHERE created_at < now() - interval` and returns rows, so `artifacts` (and now
   `artifacts.share_token`, added in `019_artifact_share.sql`) go away together. A shared link dies with the row.

**Fix — two stages. Stage 1 is the product promise; stage 2 is polish.**

**Stage 1 — pinning (real durability).**

1. **Migration `020_artifact_pin.sql`** (follow the existing style — every statement `IF NOT EXISTS`-guarded):

```sql
-- Pinned artifacts are kept: the bytes live in object storage, and the row is
-- exempt from the retention sweep because the operator asked for it by name.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
```

2. **`server/artifacts.ts`** — add a small storage abstraction with one real implementation and one no-op:

```ts
export interface ArtifactStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}
/** Used when no object storage is configured: pinning reports "unavailable" rather than pretending. */
export const noStore: ArtifactStore = { async put() {}, async get() { return null; }, async delete() {} };
```

   Implementation notes: Cloudflare **R2** over its S3-compatible endpoint is the free choice (10 GB-month, zero
   egress) — `@aws-sdk/client-s3` pointed at `https://<account>.r2.cloudflarestorage.com`, with
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in the environment (Render env vars, not
   the UI — a storage credential is infrastructure, not a per-user secret). If those four are absent, the store is
   `noStore` and the pin button returns "Storage is not configured" — never a fake success.

3. **`POST /api/artifacts/:id/pin`** (`server/routes/artifacts.ts`): materialize the bytes, `put()` them under
   `key = artifact.id`, set `storage_key = key, pinned = true, pinned_at = now()`, return the updated artifact.
   `GET /api/artifacts/:id/download` checks order: **pinned store → local cache → sandbox.** And in
   `pruneArtifacts`, add `AND pinned = false` to the DELETE, so a pinned row (and its bytes) survives.

4. **UI:** a "Keep" button on the artifact chip (`web/app.js`), which flips to a "Kept ✓" state; the download route
   keeps working unchanged.

**Stage 2 — auto-keep what was promised.** In `setArtifactShareToken` (or wherever a share token is minted),
pin the artifact automatically: a shared replay is a public promise, and a promise that 404s is worse than no
link. Wrap it: if storage is not configured, mint the token but say so in the response
(`durable: false`).

**Test** (`server/artifacts.test.ts` and `server/artifact_share.test.ts`): materialize → pin with an in-memory
fake store → null the run's `environmentId` → assert the download still returns the exact bytes; assert
`pruneArtifacts` leaves the pinned row; assert a shared-token download works after pruning when pinned.

**Done when:** a pinned (or shared) file survives a redeploy, and the tests prove it without a sandbox.

---

## Problem 6 · A phone task that runs longer than 45 minutes is never delivered

**What you see:** you send a long task from WhatsApp. You get the acknowledgement, then one *"Still working"* line
at 90 seconds — and then **nothing, ever**. The answer exists (open the web app and it's there), but the chat you
asked in never receives it. Meanwhile every other message is answered with *"I am still on this one."*

**Why:** three correct decisions that line up into a hole.
- `server/whatsapp/relay.ts:43` — `DEFAULT_MAX_WAIT_MS = 45 min`. After that, the relay stops watching and returns
  `'detached'` (documented: *"a run that outlives this is not lost … the web UI still shows it"*).
- `server/whatsapp/poller.ts:654` — on `'detached'` it deliberately does nothing:
  *"the next boot's reconcile picks it up if it dies."*
- `reconcile()` — the only thing that delivers a detached run's answer — runs **only from the boot path**
  (`server/whatsapp/lifecycle.ts:168`). With the keep-awake ping, boots can be weeks apart.

It is easy for you to hit: the composer offers a **1 hour** research preset, and the API accepts up to 480 minutes.
Nothing tests the 45-minute boundary.

**Fix — (a) is the real fix; (b) makes the log honest.**

**(a) Reconcile on a timer, inside the service that owns the poller** (`server/whatsapp/lifecycle.ts`):

```ts
// field, beside `private poller: WhatsAppPoller | null = null;`
private reconcileTimer: NodeJS.Timeout | null = null;

// in start(), right after `poller.start();`
// A relay detaches from any task slower than 45 minutes and relies on reconcile
// to deliver the answer. That used to happen only at boot; with the service kept
// awake for weeks, "the next boot" may never come. Five minutes is one indexed
// query over wa_updates WHERE processed_at IS NULL.
this.reconcileTimer = setInterval(() => {
  void this.poller?.reconcile().catch((err: Error) =>
    this.log(`[wa] periodic reconcile failed: ${err.message}`, 'error'),
  );
}, 5 * 60_000);
this.reconcileTimer.unref?.();

// in stop(), before `this.poller = null;` — the sweep must not outlive its poller
if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }

// in shutdown(), same clear as stop()
```

   `reconcile()` already does exactly the right thing for this case: for a `wa_updates` row whose run has a
   terminal status it calls `this.watch(run, wamid, from)` → the relay sends the closing message → `markProcessed`.
   So a detached run's answer arrives within five minutes of finishing, with no new delivery code.

**(b) Say what actually happens** (`server/whatsapp/poller.ts:654`):

```ts
if (result.outcome === 'detached') {
  this.log(`[wa] stopped watching ${run.id} (slower than the relay window); the periodic reconcile will deliver its answer`);
  return;
}
```

**Optional (c) — make the wait window fit the product.** `DEFAULT_MAX_WAIT_MS` of 45 minutes is shorter than the
1-hour preset: raise it to `8 * 60 * 60_000` so a long research run is normally delivered live, and let (a) cover
the crash case. If you do this, note it in the constant's comment.

**Test** (`server/whatsapp.test.ts`): start a run that does not finish inside the window (inject
`maxWaitMs: 20`), assert the relay returns `'detached'`; then finish the run, trigger the reconcile tick (call the
service's timer callback or `poller.reconcile()` directly), and assert the closing WhatsApp message was sent and
the `wamid` is now `processed_at IS NOT NULL`. Second test: a task slower than the window but faster than the
tick is delivered exactly once (no duplicate send).

**Done when:** a task of any legal length ends with its answer in the chat — not "whenever the server restarts".

---

## Problem 7 · A deploy that ships a migration can fail to boot

**What you see:** a deploy that goes red, and a service that does not come back — the worst failure mode, because
it happens exactly when a schema change is shipping.

**Why:** `server/migrate.ts:82` records each migration with a plain `INSERT INTO schema_migrations`. Render starts
the new instance **before** stopping the old one, so two boots can overlap for a few seconds; if a migration is
pending (the one moment it matters), both run it, the second `INSERT` violates the primary key, the transaction
aborts, `migrate()` throws, and nothing catches it — `server/main.ts:73` is a bare `await migrate(db)`.

The migration SQL itself is safe: all 14 files' statements are `IF NOT EXISTS`/`DROP CONSTRAINT IF EXISTS`
guarded. It is only the bookkeeping insert that can collide.

**Fix**

```ts
// server/migrate.ts:82
await tx.query(
  'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
  [migration.version, migration.name],
);
```

**Also make the boot path fail-soft around non-essential work** (`server/main.ts:76-83`) — a slow prune must never
be a failed deploy:

```ts
try {
  const pruned = await pruneRunEvents(db, config.eventRetentionDays);
  if (pruned > 0) console.log(`[boot] pruned ${pruned} run event(s) older than ${config.eventRetentionDays}d`);
  const prunedArtifacts = await pruneArtifacts(db, config.artifactRetentionDays);
  if (prunedArtifacts > 0) console.log(`[boot] pruned ${prunedArtifacts} artifact(s) older than ${config.artifactRetentionDays}d`);
} catch (err) {
  // Housekeeping, not correctness: the hourly maintenance tick covers it.
  console.warn('[boot] retention sweep failed (the hourly tick will retry):', (err as Error).message);
}
```

**Test** (`server/db.test.ts` or `server/migrate.test.ts`): call `migrate(db)` twice against the same PGlite
instance; the second run must not throw and must report every migration as skipped. Stronger version: run two
`migrate()` calls concurrently on the same database and assert neither throws.

**Done when:** a double boot on a pending migration is a no-op, and there is a test that would have caught the old
behaviour.

---

## How to verify the batch on the live service (no test framework needed)

After each fix deploys, these are the user-visible checks:

1. **Problem 1:** spend one run on the web, then send **`/status`** on WhatsApp — the two numbers must match
   `/api/budget`.
2. **Problem 2:** start a task, put the phone in airplane mode (or lock it) for a minute, reopen the app — the
   timeline must still be there.
3. **Problem 3:** note `/api/budget`, press **Test** in Settings, check `/api/budget` again — the `api` count must
   go up by one (or the button must refuse).
4. **Problem 4:** after an hour of uptime, the Render log must show at least one `[maintenance]` line when there
   was something to prune.
5. **Problem 5:** create a file, press **Keep**, redeploy, download it again — it must still download.
6. **Problem 6:** send a task from WhatsApp that takes longer than 45 minutes (or set a small wait window in a
   test build) — the answer must arrive in the chat without a restart.
7. **Problem 7:** the next deploy that includes a migration must go green while the old instance is still up.

## What to tell the coder, in one line

> "Ideas are landed; now the seven. Order 2 → 6 → 1 → 3 → 7 → 4 → 5. One commit each, a regression test that fails
> before the fix, `npm run lint` and `npm test` clean (0 fail) before the next. Details in `plan/10`."
