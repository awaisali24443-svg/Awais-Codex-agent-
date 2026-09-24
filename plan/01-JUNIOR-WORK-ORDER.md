# Work order — Awais Codex v2 bug fixes

**Audience:** the implementing developer. Read §0 (rules) before touching anything.
**Target branch:** `arena/01a0c7ad-awais-codex-agent` (the branch behind **PR #2**) — *not* `arena/01a0c3fe-awais-codex-agent`,
which is an older ancestor of it.
**Verified against:** `53ad6d6`. All line references are from that commit.
**Goal of this work order:** CI green, then the five real defects fixed, then hygiene. Each task is independent
unless stated; do them in order.

---

## §0 Rules of engagement

1. **One task = one commit.** Message format: `fix(scope): what changed` — e.g. `fix(engine): a 5xx is no longer
   waited out as a TPM limit`. Reference the task number in the body.
2. **Every fix ships with the test that would have caught it.** If a task says "add a test", the task is not done
   without it. Tests are named for the symptom, so a future reader knows what they protect.
3. **Never rewrite a test to make it pass** unless the task explicitly says the old test encoded a bug. Where that
   is true it is called out (see Appendix A). If that happens, the new test must assert the *correct* behaviour and
   the commit message must say the old assertion was wrong and why.
4. **Run before every commit:**
   ```bash
   npm run lint && npm test
   ```
   Both must be clean. `npm test` must print **0 fail and 0 cancelled** — a cancelled test is a failure, not a
   pass. CI runs the same, plus `npm run build` and a boot check of the bundle.
5. **Do not touch** in this work order: `server/whatsapp/*` behaviour, the SSE replay design in
   `server/routes/runs.ts`, the schema of `001_init.sql`, or the auth *cookie* format. None of it is broken.
6. **When a task changes a function signature, update every caller and its tests in the same commit.**
   The compiler will find most of them (`npm run lint`); `pipeline.test.ts` and `artifacts.test.ts` are the usual
   stragglers.
7. **Ask before inventing.** If the fix below does not compile or the surrounding code has moved, stop and ask —
   do not improvise a different design.

### Setup

```bash
git fetch origin
git checkout arena/01a0c7ad-awais-codex-agent
git pull
npm ci                    # lockfile is authoritative; if this fails, stop and report it
npm run lint              # must be clean
npm test                  # record the numbers — this is your baseline
```

**Baseline to expect before you start:** `# tests 336 / # pass 305 / # fail 1 / # cancelled 30`.
After T1 and T2 it must be `# fail 0 / # cancelled 0`.

---

## T1 · `P0` · Stop the stale migration count from cancelling 30 tests

**File:** `server/db.test.ts` (the `before` hook, currently line 31)
**Symptom:** CI has been red for 8 consecutive runs. The failing step is `Test`.

**Why:** the hook hardcodes the migration list. `005_deep_research.sql` was added, so a fresh database applies
five migrations and the assertion throws. Node's test runner then cancels **every test in the file**: `migrations`,
`run_events`, `quota guards`, `whatsapp idempotency`, `memory constraints`, `config validation`. That is the entire
schema-and-guardrail tier — gap-free sequences, cascade deletes, retention, the one-active-run rule, wamid
idempotency and every production config check — silently not running.

**Change:** derive the expectation from the migrations on disk, so this can never happen again.

```ts
// near the top of server/db.test.ts
import { migrate, loadMigrations } from './migrate.js';
```

```ts
before(async () => {
  db = await createDb('');
  const result = await migrate(db);

  // Derived, never typed by hand: this hook previously hardcoded [1, 2, 3, 4]
  // and cancelled this entire file the day 005 was added.
  const onDisk = loadMigrations().map((m) => m.version);
  assert.deepEqual(result.applied, onDisk, 'a fresh database applies every migration on disk');
});
```

**Done when:**
- `npm test` reports `# fail 0 # cancelled 0`
- the six suites named above all appear as `ok` in the output
- CI on the PR is green

**Watch out:** `loadMigrations()` resolves the migrations directory relative to the working directory. Tests run
from the repo root, so this works; if it throws, run from the repo root and report it.

---

## T2 · `P0` · A 5xx must not be waited out as a rate limit

**File:** `server/engine/antigravity.ts` — the "patient loop" inside `attempt()` (~line 318)
**Symptom (measured):** with the fetch mocked to return 500, `verify.test.ts:158` took **180,124 ms** and
reported `timeout` instead of `upstream_error`.

**Why:** `classify()` marks every 5xx retryable (`status >= 500`), and the loop sends *anything* retryable into
`waitForRateLimit()`, which sleeps 65 s, then 130 s, then 130 s, up to `DEFAULT_RATE_LIMIT_MAX_WAIT_MS`
(**30 minutes**). Runs are one-at-a-time, so a Google outage parks the only mission slot for half an hour, tells
the operator the wrong cause ("rate-limited … the TPM window clears"), and makes the credential check report
`timeout` instead of the real error.

**Change:** only a genuine rate limit gets the long wait; everything else gets one short retry.

```ts
    let waits = 0;
    let waitedMs = 0;
    for (;;) {
      if (!response.ok) {
        const error = classify(response.status, await failureDetail());
        if (error.retryable) {
          // Only a TPM/quota rate limit is worth minutes of patience. A 5xx is an
          // outage: retry it once, briefly, then fail honestly. Waiting 65s+ for a
          // server error holds the only mission slot and reports the wrong cause.
          if (error.errorType !== 'rate_limited') {
            if (waits >= 1) throw error;
            waits += 1;
            emit.log(`${error.errorType} (${response.status}) — retrying once`, 'warn');
            await this.sleep(this.retryDelayMs, controller.signal);
            await repost();
            continue;
          }

          waitedMs = await this.waitForRateLimit(emit, controller, touch, waits, waitedMs);
          waits += 1;
          await repost();
          continue;
        }
        throw error;
      }
      // …the existing consume()/resume block below is untouched…
```

Do **not** change the mid-stream block (`asResumableRateLimit`) or `classify()` — the 429 behaviour and the
`quota_exceeded` classification are deliberate.

**Tests to add** (`server/engine/antigravity.test.ts`):
1. a 500 twice → the request is posted exactly twice and the error is `upstream_error`
2. a 500 with `retryDelayMs: 0` → returns in well under a second (assert elapsed < 1000 ms)
3. a 429 → still enters `waitForRateLimit` (construct the engine with `rateLimitBaseDelayMs: 1` so the test is fast)

**Tests to update:** `server/verify.test.ts:158` keeps its `upstream_error` expectation — it should now pass.
Optionally add `assert.ok(Date.now() - start < 5_000, 'a 5xx must not enter the TPM waiting path')`.

**Done when:** `npm test` is fully green (this is the second and last failure) and the new timing test passes.

---

## T3 · `P1` · Make the documented deploy actually deploy

**Files:** `server/config.ts` (~line 175), `DEPLOY.md`, `.env.example`
**Symptom (measured):** following `DEPLOY.md` step 2 exactly — key left empty, to be stored in the app later —
produces `ENGINE=antigravity needs GEMINI_API_KEY …` and the service refuses to boot.

**Why:** the check ignores `MASTER_KEY`. But a key stored in Settings is encrypted *with* `MASTER_KEY`, and the app
already treats that as a legitimate home for the credential everywhere else — `/readyz` consults
`secrets.get('gemini_api_key')`, the engine resolves the key per request, and `DEPLOY.md` explicitly offers this
path. The boot check is the only part that disagrees.

**Change:**

```ts
  const geminiApiKey = (env.GEMINI_API_KEY ?? '').trim();
  if (isProduction && engineRaw === 'antigravity' && !geminiApiKey) {
    // A key stored in the Settings panel is encrypted with MASTER_KEY, so with a
    // MASTER_KEY present there is a real home for it. Refusing to boot here
    // contradicted both that panel and DEPLOY.md, which offers exactly this path.
    if (!masterKey) {
      problems.push(
        'ENGINE=antigravity needs GEMINI_API_KEY, or MASTER_KEY so the key can be stored in Settings. ' +
          'Set the key, set MASTER_KEY, or set ENGINE=scripted to run without one.',
      );
    } else {
      console.warn(
        '[config] no GEMINI_API_KEY in the environment — missions will fail until one is saved in Settings',
      );
    }
  }
```

**Tests:** in `server/db.test.ts` (config validation suite):
- production + antigravity + no key + **no** `MASTER_KEY` → still refuses (keep the existing case, adjusted)
- production + antigravity + no key + **valid `MASTER_KEY`** → boots, and logs the warning
- production + antigravity + key → boots (existing)

**Done when:** the three cases pass and `DEPLOY.md` needs no further edit (it is already correct once the code agrees).

---

## T4 · `P1` · One shared budget counter must gate; channel rows only report

**Files:** `server/budget.ts`, `server/accept.ts`, `server/routes/runs.ts` (`/api/budget`), `server/runs.test.ts`
**Symptom:** the daily guard permits **3× the real quota.**

**Why:** `accept.ts` calls `consumeRunBudget(db, bucket, limit)` with the channel bucket (`web` / `whatsapp` /
`api`). The `budgets` table is keyed `(day, bucket)`, so each channel gets its own counter with its own full
limit, and nothing sums them. The provider quota (~100 runs/day) is shared. A user could burn 300 runs and only
Google's 429 would stop them — which, before T2, then held the slot for 30 minutes.

**Change 1 — `server/budget.ts`, add one function:**

```ts
/**
 * Record a run against a channel for the UI.
 *
 * Reporting only: it must never be able to refuse, or the channel rows become
 * three separate daily allowances again — which is how a shared ~100/day quota
 * turned into 300.
 */
export async function noteChannelUse(db: Db, bucket: BudgetBucket): Promise<void> {
  await db.query(
    `INSERT INTO budgets (day, bucket, count) VALUES (CURRENT_DATE, $1, 1)
     ON CONFLICT (day, bucket) DO UPDATE SET count = budgets.count + 1`,
    [bucket],
  );
}
```

**Change 2 — `server/accept.ts`, the claim:**

```ts
  try {
    // The provider's quota is shared by every channel, so the *gate* is the
    // single 'engine' counter. The channel row is written afterwards for
    // reporting and cannot sanction an extra allowance of its own.
    const used = await consumeRunBudget(db, 'engine', config.dailyRunBudget);
    await noteChannelUse(db, bucket);
    const remaining = Math.max(0, config.dailyRunBudget - used);
```

Add `noteChannelUse` to the existing import from `../budget.js`.

**Change 3 — `server/routes/runs.ts` (`/api/budget`, ~line 409):** report the shared counter alongside the channels:

```ts
    const snapshot = await budgetSnapshot(db, ['engine', 'web', 'whatsapp', 'api'], config.dailyRunBudget);
```

Keep the response shape (`buckets`, `limit`) so the UI keeps working; the UI may show the `engine` row as the
real remaining count.

**Change 4 — delete `refundRunBudget()`** from `budget.ts` unless you use it here. It has no callers; leave the
file honest rather than carrying a function whose comment describes a flow nothing implements.

**Tests:** rewrite `server/runs.test.ts:663` ("whatsapp missions are counted separately from the web") — that
assertion **encodes the bug**. Replace it with:
1. fill the shared `engine` bucket to the limit, then start a WhatsApp run → **429 `daily_budget_exceeded`**
   (today it would succeed — that is the regression this test exists to catch)
2. a completed WhatsApp run still increments the `whatsapp` channel row (reporting works)
3. a refused run increments neither counter

**User-facing wording:** the refusal message comes from `BudgetExceededError`, which will now say
`Daily engine run budget exhausted (n/limit)`. If that wording reaches WhatsApp, override it in `accept.ts`'s
budget branch with plain language, e.g. `Daily task budget exhausted (${err.used}/${err.limit}) — tasks reset at
midnight UTC.`

**Done when:** the three tests pass and `/api/budget` shows an `engine` row.

---

## T5 · `P1` · Compact the event log after a run finishes

**Files:** `server/db.ts` (add the function), `server/main.ts` (call it at boot), `server/db.test.ts` (test)
**Symptom (measured):** a 6-second scripted run producing a 20 KB answer wrote **114,750 bytes** of
`run_events` — **5.7×** the answer. A 10-minute mission with a 60 KB answer extrapolates to **~23 MB** at the
750 ms snapshot cadence. Neon free is **0.5 GB**, and events are only pruned when they are *entirely* older than
14 days, so twenty such runs fill the database and the retention window is longer than the time it takes.

**Why it works this way:** `text.snapshot` / `thinking.snapshot` carry the **full text so far** (not deltas), which
is what makes replay idempotent. That is correct and stays. The redundancy is only *between* snapshots of the same
field in a run that has already finished.

**Change — add to `server/db.ts`:**

```ts
/**
 * Drop superseded field snapshots from finished runs.
 *
 * A snapshot holds the whole text so far, so once a run is over only the newest
 * one per field can ever be read: replay ends with it, and the WhatsApp relay
 * reads it as the answer. Every earlier copy is strictly redundant — and at a
 * 750 ms cadence they are what turns a 60 KB answer into 23 MB of event log.
 *
 * Live runs are never touched: their snapshots are what a reconnecting client
 * replays from.
 */
export async function compactRunEvents(db: Db, olderThanMinutes = 60): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM run_events e
         USING runs r
        WHERE e.run_id = r.id
          AND r.status IN ('completed', 'failed', 'cancelled')
          AND r.finished_at < now() - ($1 || ' minutes')::interval
          AND e.type IN ('text.snapshot', 'thinking.snapshot')
          AND e.seq < (
                SELECT max(x.seq) FROM run_events x
                 WHERE x.run_id = e.run_id AND x.type = e.type
              )
        RETURNING 1
     )
     SELECT count(*)::text AS count FROM deleted`,
    [String(Math.max(1, olderThanMinutes))],
  );
  return Number(rows[0]?.count ?? 0);
}
```

**Change — `server/main.ts`, next to `pruneRunEvents` at boot:**

```ts
  const compacted = await compactRunEvents(db);
  if (compacted > 0) console.log(`[boot] compacted ${compacted} superseded snapshot event(s)`);
```

**Tests** (`server/db.test.ts`):
1. a finished run with 5 `text.snapshot` rows → compaction leaves exactly 1, and its `payload->>'text'` equals the
   last text
2. a **running** run's snapshots are untouched
3. running compaction twice is a no-op the second time (idempotent)

**Optional follow-up (only if you want it):** also call it after a run closes in the executor. Not required.

**Done when:** tests pass and the boot log line appears after a run in a local dev session. Do not change the
snapshot cadence or the `final: true` snapshot — other code depends on both.

---

## T6 · `P1` · Artifacts must read the key from the secrets store

**Files:** `server/routes/artifacts.ts`, `server/app.ts` (~line 215), `server/pipeline.test.ts` (~line 323),
`server/artifacts.test.ts` if it constructs the route
**Symptom:** artifact downloads and previews use the **environment** key only, so once you paste a key into
Settings (or rotate it there), missions run on the new key while artifact fetching uses the old one — and reports
`404 artifact_unavailable`, blaming an expired sandbox, so you would look in the wrong place.

**Why:** artifacts are the only consumer that reads `config.geminiApiKey` directly. Everything else resolves the
credential through the live store: the engine (`apiKey: () => secrets.get('gemini_api_key')`), GitHub, WhatsApp,
done-ping, `/readyz`. The store falls back to the environment, so passing the store is strictly better and never
worse.

**Change 1 — `server/routes/artifacts.ts`:**

```ts
import type { SecretsStore } from '../settings.js';

export interface ArtifactRouteDeps {
  db: Db;
  config: AppConfig;
  /**
   * Live credentials. Read per request, never captured: a key saved in Settings
   * must work here too, or the download uses a different key from the engine.
   */
  secrets: SecretsStore;
  /** Injected in tests, which point the sandbox download at a local fake. */
  fetchImpl?: typeof fetch;
}
```

Then in **both** handlers (`/artifacts/:id/download` and the preview handler), read it at request time:

```ts
    const materialized = await materializeArtifact(
      {
        db,
        apiKey: deps.secrets.get('gemini_api_key'),
        environmentId: run?.environmentId ?? '',
        fetchImpl,
      },
      artifact,
    );
```

**Change 2 — `server/app.ts` (~line 215):** pass the store:

```ts
  app.use('/api', createArtifactRoutes({ db, config, secrets: deps.secrets }));
```

**Change 3 — `server/pipeline.test.ts` (~line 323):** construct the route with a real store:

```ts
      createArtifactRoutes({
        db,
        config,
        secrets: createStores(db, config).secrets,   // import createStores from './settings.js'
        fetchImpl: …,
      }),
```

**Tests to add:** store a key in the secrets table (or build a `SecretsStore` with a stored row), then request a
download with a fake `fetchImpl` that asserts the `x-goog-api-key` header equals the **stored** value while the
environment value differs.

**Done when:** tests pass and `npm run lint` is clean (the signature change will surface every caller).

---

## T7 · `P2` · The session probe must tell the truth

**File:** `server/app.ts` — move `app.get('/api/auth/session', …)` (currently ~line 175) to **below**
`app.use('/api', requireSession(config))` (~line 187)
**Symptom (measured):** `GET /api/auth/session` with **no cookie** returns
`200 {"authenticated":true,…}`. The client boots with `await api('/api/auth/session'); await enter();`, so every
cold load renders the app, fires three authenticated requests, takes a 401, and only then shows the sign-in
screen. Not a security hole — every real endpoint is guarded, and there is a test proving it — but the endpoint is
a lie and the flash is visible on every load.

**Change:** relocate the handler under the guard and correct its comment. No client change is needed: the client
already treats 401 as "show the sign-in screen".

```ts
  app.use('/api', requireSession(config));

  // Reaching this line means the cookie verified (or the deployment is in open
  // mode, which the client is told about). The client branches on the status:
  // 200 → the app, 401 → the sign-in screen. It used to be mounted above the
  // guard and always answered 200, which made every cold load flash the app
  // before the login screen.
  app.get('/api/auth/session', (req: Request, res: Response) => {
    res.json({ authenticated: true, authMode: config.authMode, requestId: (req as Request & { id?: string }).id });
  });
```

**Tests to add** (`server/auth.test.ts`): `GET /api/auth/session` with no cookie → **401**; with the session
cookie → **200** and `authenticated: true`.

**Done when:** the two tests pass. Verified during planning: no existing test asserts the current behaviour.

---

## T8 · `P2` · Cancelling an orphaned run must write a terminal event

**File:** `server/routes/runs.ts` — the `cancel` handler (~line 206)
**Symptom (measured):**
`POST /api/runs/run_zombie/cancel → 200 {"ok":true,"signalled":false}`, status becomes `cancelled`, but
`run_events` holds only `run.started`. With no terminal event:
- the **SSE stream never ends** — the browser sits on a dead stream (the handler only finishes on a terminal event);
- the **WhatsApp relay never sends the outcome** (it sends the closing message on `run.cancelled`), and the
  `wa_updates` row stays unprocessed forever, retried at every boot.

**Why:** the fallback calls `setRunStatus()`, which flips the row without appending an event. Every other path
uses `finishRun()`, which appends the terminal event and flips the status **in one transaction** — that ordering is
what makes "status is terminal" mean "the log is complete".

**Change:**

```ts
    const signalled = executor.cancel(run.id);
    if (!signalled) {
      // Close it the way every other path closes a run: the terminal event is
      // appended first, in the same transaction as the status change. Without the
      // event the SSE stream never ends and the WhatsApp relay never sends the
      // outcome — the user is simply never told.
      const seq = await finishRun(db, run.id, {
        status: 'cancelled',
        errorType: 'orphaned',
        errorMessage: 'Cancelled while no executor was attached',
      });
      bus.publish(run.id, {
        seq,
        type: 'run.cancelled',
        payload: { status: 'cancelled', errorType: 'orphaned' },
      });
    }
    res.json({ ok: true, signalled });
```

Add `finishRun` to the existing `from '../runs.js'` import list (`getRun`, `setRunStatus`, … are already there).

**Tests to add** (`server/runs.test.ts`):
1. insert a `running` run with no executor, cancel it, then assert `run_events` contains `run.cancelled`
2. open the SSE stream on it and assert it receives `run.cancelled` followed by `event: end` (no hang)
3. the existing "cancel while nothing is running" behaviour is unchanged (`signalled: true` path)

**Done when:** the three tests pass and the stream test finishes promptly rather than timing out.

---

## T9 · `P2` · Validate `NODE_ENV`

**File:** `server/config.ts` (~line 105)
**Symptom:** `NODE_ENV=Production` (capital P) or `NODE_ENV=prod` silently makes `isProduction === false`, which
disables **every** production guard: no `DATABASE_URL` requirement (so it falls back to PGlite on Render's
ephemeral disk — **silent data loss on every restart**), no `SESSION_SECRET` length check, no `MASTER_KEY`
requirement, no `ACCESS_KEY` strength check.

**Change:**

```ts
  const KNOWN_ENVS = ['development', 'test', 'production'] as const;
  const rawEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  if (!KNOWN_ENVS.includes(rawEnv as (typeof KNOWN_ENVS)[number])) {
    problems.push(`NODE_ENV must be one of ${KNOWN_ENVS.join('|')} (got "${env.NODE_ENV}")`);
  }
  const nodeEnv = (
    KNOWN_ENVS.includes(rawEnv as (typeof KNOWN_ENVS)[number]) ? rawEnv : 'development'
  ) as AppConfig['nodeEnv'];
  const isProduction = nodeEnv === 'production';
```

**Tests:** `NODE_ENV=Production` and `NODE_ENV=prod` are rejected with a message naming the allowed values.

**Done when:** the two cases fail loudly instead of quietly changing mode.

---

## T10 · `P2` · `/readyz` must notice an unusable deployment

**File:** `server/app.ts` (`/readyz`)
**Symptom:** it checks the database, the poller and whether a key exists — but not auth. A deployment where key
mode has **no** `ACCESS_KEY` (every request 401, the sign-in form included) still answers `200 {"ok":true}` to the
external pinger. The pinger currently means "the process is up", not "the app works".

**Change:** add an auth check and let it fail readiness when it must.

```ts
    // Can a browser actually get in? In key mode with no key, nothing works —
    // not the sign-in form, not the API — and a green pinger would hide that.
    const sessionOk = verifySession(createSession(config.sessionSecret), config.sessionSecret);
    checks.auth =
      config.authMode === 'open'
        ? 'open (no key required)'
        : !sessionOk
          ? 'session signing broken'
          : config.accessKey
            ? 'key mode (key set)'
            : 'key mode with NO KEY — unreachable';
    if (config.authMode === 'key' && (!config.accessKey || !sessionOk)) ready = false;
```

Import `verifySession` and `createSession` from `./auth.js` (both are exported).

**Tests to add:** key mode + no `ACCESS_KEY` → `/readyz` returns **503** with `checks.auth` naming the problem;
open mode → 200.

---

## T11 · `P3` · Throttle sign-in attempts

**File:** `server/app.ts` (`POST /api/auth/login`)
**Symptom:** public, unlimited, and every failure writes a `console.warn`. The key is long so guessing is
impractical; the cost is log noise that hides real warnings.

**Change:** a small in-memory limiter (correct for a single process; no dependency).

```ts
  const loginAttempts = new Map<string, { n: number; until: number }>();

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const seen = loginAttempts.get(ip);
    if (seen && seen.n >= 5 && now < seen.until) {
      res.status(429).json({ error: 'too_many_attempts', message: 'Wait a minute and try again.' });
      return;
    }

    const provided = (req.body as { key?: unknown; password?: unknown } | undefined);
    const value = provided?.key ?? provided?.password;

    if (!checkAccessKey(value, config.accessKey)) {
      loginAttempts.set(ip, { n: (seen?.n ?? 0) + 1, until: now + 60_000 });
      console.warn('[auth] a sign-in attempt used the wrong key');
      res.status(401).json({ error: 'invalid_key', message: 'That key is not right.' });
      return;
    }

    loginAttempts.delete(ip);
    res.setHeader('Set-Cookie', sessionCookie(createSession(config.sessionSecret), config.isProduction));
    res.json({ ok: true });
  });
```

**Tests:** six wrong attempts → the sixth is 429; a correct key after a throttle window still signs in.

---

## T12 · `P3` · Hygiene batch (one commit)

1. **`render.yaml`:** add the two keys the code reads but the blueprint never sets —
   ```yaml
         # Reminders are opt-in in code; set true to let the 60s firing loop run.
         - key: REMINDERS_ENABLED
           value: "false"
         # Optional: enables the GitHub export. Leave unset to keep it disabled.
         - key: GITHUB_TOKEN
           sync: false
   ```
   Decide deliberately: with `REMINDERS_ENABLED=false` the reminder scheduler will never fire on Render.
2. **`server/runs.ts`:** the conversation-title fallback is still `'New mission'` → `'New task'`. (Last
   user-visible "mission" string; the user has asked for "task" everywhere.)
3. **`server/app.ts` error handler:** call `next(err)` when `res.headersSent` instead of returning silently, so a
   streaming response's error is delegated rather than swallowed.
4. **`server/db.test.ts` fixture:** `'antigravity-preview-05-2026'` → `config.antigravityAgent` (or the current id).
5. **`web/sw.js`:** note in the header that `VERSION` must be bumped when `web/` changes, or wire the bump into the
   build. Do not remove the cache in this task.
6. **Correction — do NOT "fix" `dotenv`.** An earlier audit said it was unused; that was true of `main`, not of
   your branch. `config.ts` already imports and calls it. No action.

---

## T13 · Optional, decide with the owner · Retire the v1 tree

`index.html` (125 KB), `js/`, `routes/`, `src/`, `memory-engine.ts`, `antigravity-client.ts`, `apk-generator.ts`,
`call-budget-server.ts`, `config.ts`, `types.ts` are unreachable — nothing boots or serves them, but they are
type-checked, referenced by an old `render.yaml`, and they are why two generations of config coexist.

**Do not do this until T1–T12 are merged and green.** Then: `git tag v1-legacy`, delete the files, and fix
`ARCHITECTURE.md`/`STATUS.md` to point at the tag. Confirm with the owner before deleting.

---

## Appendix A — tests that currently encode a bug

| File | Assertion | Action |
|---|---|---|
| `server/runs.test.ts:663` | "whatsapp missions are counted separately from the web" | **Rewrite** for T4: the shared counter gates; the channel row only reports. The commit message must say the old assertion encoded the 3× budget bug. |
| `server/db.test.ts:31` | `applied, [1, 2, 3, 4]` | **Replace** with the derived list (T1). |
| `server/db.test.ts` config suite | "production refuses to boot the real engine without a key" | **Adjust** for T3 (refuses only when `MASTER_KEY` is also absent). |
| `server/verify.test.ts:158` | mocked 500 → `upstream_error` | **Keep as-is** — it is correct; T2 makes it pass. |

## Appendix B — verification commands

```bash
npm run lint                 # tsc, server + web
npm test                     # 0 fail, 0 cancelled
npm run build                # bundle builds
AUTH_MODE=open ENGINE=scripted PORT=3000 node dist/server.cjs &
curl -fsS http://127.0.0.1:3000/healthz && curl -fsS http://127.0.0.1:3000/readyz
```
CI does all of the above on every push (`.github/workflows/ci.yml`) — **the PR must be green before it is
reviewed.**

## Appendix C — definition of done (paste into the PR description)

- [ ] T1–T12 applied; CI green (`verify` job: lint, tests, build, bundle boot)
- [ ] `npm test`: 0 fail, **0 cancelled**
- [ ] Every fix has a regression test named for the symptom
- [ ] `runs.test.ts` budget assertion rewritten and the reason recorded in the commit message
- [ ] No signature change left a stale caller (lint is clean)
- [ ] Screenshots/log lines attached for T7 (login no longer flashes) and T8 (cancelled stream ends)

## Appendix D — traps already paid for in this repo

- **Shallow clone:** `git fetch --unshallow` before any `git log`-based reasoning; history lies otherwise.
- **`import.meta.url` is empty in the CJS bundle.** Never locate files with it; use `server/paths.ts`
  (`moduleDirs()` / `findDir()`). Boot the bundle after touching anything on the boot path — `tsx` hides this.
- **`npm test` must keep `--test-force-exit`** (an aborted socket keeps the process alive otherwise).
- **The test glob is explicit** in `package.json`; after adding a test file, check the `# tests` count went up.
- **PGlite and `node-postgres` differ** on array parameters — filter in code, not with `= ANY($1)`.
