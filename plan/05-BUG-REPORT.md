# 05 · Read-only review — what is broken, what is healthy, what needs a decision

**Nothing was changed.** No commits, no pushes, no edits to code or config. This file is an untracked addition to
`plan/`; keep it, commit it, or delete it.

**What I read:** `arena/01a0c7ad-awais-codex-agent` @ **`6005037`** — a scratch clone under `/tmp`, its full
suite and lint executed there, plus a targeted read of ~25 files (auth, crypto, budget, runs, executor, engine,
artifacts, reminders, memory, briefing, planning, github, WhatsApp intake, the web app, the workflows).

**What I probed live:** `https://awais-codex-agent-arena.onrender.com` — `/healthz`, `/readyz`, `/api/status`,
`/api/budget`, `/`, and a wrong-key request. (This sandbox can only reach github.com directly, so the live checks
went through a fetch tool; I could not open the WhatsApp chat, the Neon console or the Render billing page.)

---

## 0 · The live service, verified

| Check | Result |
|---|---|
| `/readyz` | `database: ok`, **`poller: running`**, `engine: key present (environment)`, `auth: key`, `migrationsApplied: 0`, `orphanedRunsRecovered: 0` |
| `/api/status` | agent `antigravity-preview-09-2026`, WhatsApp `agentId 1356900514169054`, **`offset: 75`**, `lastError: null`, `handled: 0`, `duplicates: 0`, `activeRuns: 0`, `openStreams: 0`, `dailyRunBudget: 100`, `eventRetentionDays: 14`, `nodeEnv: production`, `whatsappConfigured: true` |
| `/api/budget` | `web 0/100`, `whatsapp 0/100`, `api 0/100` — nothing spent today |
| Auth from outside | wrong key → `401 invalid_key`; your key → JSON; `/` with no key → the sign-in screen and **no data** |
| Which build is live | `/readyz` includes `checks.auth`, which only exists in the coder's T10 work → **the deployed service is running the latest branch**, and it came up at `03:21:49Z`, 42 seconds after the last push at `03:21:07Z` → **auto-deploy is on and follows that branch** |
| Uptime | `startedAt 03:21:49Z`, 18+ minutes continuous at the time of the probe → **your 11-minute pinger is working** |

So: the deployment is healthy, current, and correctly locked. Everything below is about the code.

---

## 1 · P0 — the one thing blocking the merge

**CI is red on `6005037`**, and only because of a stale assertion.

`server/whatsapp.test.ts:519` expects `/Daily whatsapp run budget exhausted/`; the code now says
`Daily run budget exhausted (100/100)` — correct, because the budget is shared across channels now. The test is
wrong, not the behaviour.

```ts
assert.match(reply, /Daily run budget exhausted/);
```

I applied exactly that to the scratch clone: **338 tests, 338 pass, 0 cancelled**, `npm run lint` clean. That is
the whole difference between PR #2 red and PR #2 green — nothing else on the branch is failing.

---

## 2 · P1 — real defects, in the order I would fix them

### P1-1 · "Tasks left today" tells you the wrong number
`server/accept.ts:153`

```ts
const bucket = BUCKET_FOR_KIND[kind];
const used = await peekBudget(deps.db, bucket);   // per-channel count
return Math.max(0, deps.config.dailyRunBudget - used);
```

The spending gate counts the **day total** (`budget.ts`), but this counts only the *whatsapp* bucket, and its one
caller is the phone's `/status` reply (`whatsapp/poller.ts:471`). Spend 40 runs on the web and your phone still
says "Tasks left today: 79/100" while the next message is refused. One-line fix: use `peekDayTotal` (then
`peekBudget` has no callers — delete it), and drop the now-unused `kind` parameter from the call site.

### P1-2 · A reconnect can show an empty timeline
`finishRun` compacts a run's intermediate snapshots and then **renumbers `seq`** (`server/runs.ts:445`). A browser
that was streaming the run and reconnects right after it finishes sends `Last-Event-ID` from before the renumber —
a number the compacted log no longer reaches. `resumeFrom()` (`server/routes/runs.ts:114`) passes it straight
through, so the replay is empty and the task's timeline looks blank until a reload. Four-line fix, using a helper
that already exists (`latestEventSeq`, `server/runs.ts:327`):

```ts
let from = resumeFrom(req);
// finishRun compacts snapshots and renumbers `seq`, so a cursor from before the
// finish can point past the end of the log. Replaying from the start is always
// correct, just heavier.
if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;
```

The compaction itself is sound: those snapshots are cumulative, so the last one of each type holds the whole text.

### P1-3 · The Settings "Test" button spends quota that the budget cannot see
`POST /api/settings/verify/gemini-key` → `checkAgent()` → **a real engine interaction** (`server/verify.ts:303`).
Unlike every other run in the system, it never calls `consumeRunBudget`, and the endpoint has no throttle:

- click Test three times → three real interactions spent while `/api/budget` still says `0/100`;
- it also ignores the one-task-at-a-time rule, so it can run alongside a live task;
- nothing in `verify.test.ts` asserts budget behaviour, which is why it slipped through — the tests all pass.

Two honest fixes, pick one: (a) claim a budget slot for the agent leg (`consumeRunBudget(db,'api',…)` after the key
check passes, before `engine.run`), or (b) declare it an intentional exception: throttle it (e.g. 3/minute) and
show it in the UI as "this spends one interaction". (a) is the one that keeps `/api/budget` true.

### P1-4 · Retention is not actually running, and one table is never pruned
`pruneRunEvents`, `pruneArtifacts` and `markOrphanedRuns` are called **only in the boot sequence**
(`server/main.ts:73`, `:78`, `:87`). That was fine when Render slept and restarted constantly. Now that a pinger
keeps the process alive, a redeploy is the only thing that enforces your 14-day event retention and 7-day artifact
retention — and **`wa_updates` has no retention at all**: the table is documented (`001_init.sql:167`) and indexed,
but nothing ever deletes a row from it (`grep` finds only the test's `DELETE FROM wa_updates`).

On a 0.5 GB Neon this is slow-motion, not an emergency — but it is exactly the kind of thing that is invisible
until the day it isn't. Fix: a maintenance tick on a timer (the reminders ticker at `main.ts:197` is the pattern) —
prune events, artifacts **and** `wa_updates` (say, 30 days for messages) once a day, and keep the boot call too.
`runs` and `messages` are deliberately never pruned; that is a reasonable choice, just be aware the conversation
history is the thing that grows forever.

### P1-5 · Artifacts are not durable — the file you asked for yesterday may be gone
Downloads are materialised from the **engine sandbox** (`materializeArtifact` needs `run.environmentId`), and the
copy made on first download lives on Render's **ephemeral disk**. So a sandbox that expired, or a redeploy, means
the bytes are gone even though the record says the file existed. The route is refreshingly honest about it (a 404
with the reason), but the promise "send me the file" does not survive a day. The strategy doc's Phase-1 item —
R2 or equivalent, free, zero egress — is the fix; until then, treat artifacts as consumable within the session.

---

## 3 · P2 — hygiene, and two decisions only you can make

**D1 · Reminders are inert in production, and the UI doesn't say so.** The scheduler only exists with
`REMINDERS_ENABLED=true` (`main.ts:191`), and `render.yaml` does not set it — which is what I advised, and still
advise if you don't want them. But: there is **no reminders surface in the web app at all** (`grep reminder web/`
finds nothing) and **no endpoint reports whether firing is enabled**, so a client can create a reminder that can
never fire and nobody is told. Either (a) turn it on (each firing spends one run from the shared budget, and it
defers politely when the budget is spent or a task is live), and add the UI; or (b) leave it off and write one line
in the README saying reminders are API-only and dormant. Right now the code is good and the story is unclear.

**D2 · `REMINDERS_ENABLED` / `GITHUB_TOKEN` in `render.yaml`.** Still my advice to leave both out — an env var no
feature reads is just a thing to get wrong later. You don't need GitHub export; if you want it, add the token then.

**H1 · Dead code** — `refundRunBudget` (`budget.ts:144`, no callers: the budget is claimed *after* the conflict
check, so there is no refund path), the `'engine'` budget bucket (declared, never written; `/api/budget` correctly
reports `web`/`whatsapp`/`api`).

**H2 · v1 leftovers still in the tree** — `public/`, root `index.html`, and root-level `antigravity-client.ts`,
`apk-generator.ts`, `call-budget-server.ts`, `memory-engine.ts`, `config.ts`, `types.ts`, `generate-icons.js`,
`metadata.json`, `data/agent-memory.example.json`. Nothing imports them, the server serves `web/`, and
`tsconfig.json` has no `include` — so `tsc --noEmit` type-checks dead v1 files and can fail CI one day for a reason
nobody will understand. The `v1-archive` tag already preserves all of it.

**H3 · Documentation drift** — `server/auth.ts` still opens with "There is no login screen and no password prompt",
but the operator login (`POST /api/auth/login`, throttled) and the Manus-style sign-in screen are exactly what you
asked for and are live. Fix the comment so the next reader doesn't "correct" the code back.

**H4 · A redirect that trusts the request** — `claimAccessKey` builds its 302 target from `req.originalUrl`, so
`//evil.com/?k=<valid key>` would bounce off-site. It requires a valid key, so it is not exploitable by a
stranger — clamp it to a same-origin path when you next touch that file.

**H5 · "100 runs/day" is not a token ceiling** — deep research is one run but several engine passes, and the
Settings test is a run-less interaction (P1-3). Only `researchBudgetMinutes`, `MAX_RESEARCH_PASSES` and the
engine's token cap bound what you actually spend. Worth one sentence in the README so the number isn't
over-trusted.

**H6 · Login throttle is per-process and in-memory** — a restart clears it. Fine for one operator; noting it only
so nobody mistakes it for a durable control. (`trust proxy` is correctly set, so it keys on the real client IP —
that part is right.)

---

## 4 · Verified sound — so you know what was checked, not skipped

- **Crypto**: AES-256-GCM, random IV per seal, auth tag verified, **secret name bound as AAD** so a ciphertext
  swapped between rows fails to open. Fingerprints are truncated SHA-256; values never leave the server.
- **Auth**: timing-safe compares; `HttpOnly` + `SameSite=Lax` + `Secure` in production; `/api/auth/session` and
  everything else behind `requireSession`; only `/healthz`, `/readyz` and the login POST are public; `trust proxy`
  set; the login throttle exists and 401s are honest. Verified from outside, not just in tests.
- **XSS discipline**: `markdown()` escapes **before** applying its subset, links are `https?:`-only,
  conversation titles and artifact labels go through `textContent`, memory/settings rows are escaped. The preview
  iframe is `sandbox="allow-scripts"` (opaque origin — no same-origin access) with `frame-ancestors 'self'`, and
  downloads sanitize the filename before `Content-Disposition`.
- **Budget**: the claim is a **single atomic statement** whose `WHERE` compares the day total against the cap —
  the 3× overspend is closed, and a refused task never reaches the engine.
- **Run lifecycle**: `finishRun` writes the terminal event in the same transaction; the log stays gap-free;
  cancel-with-no-executor still emits `run.cancelled`; orphan recovery runs at boot; the one-active-run index holds.
- **Deep research**: pass chaining via `previousInteractionId`/`environmentId`, handles persisted per pass
  (`f491c39`) so a crash resumes instead of re-paying, deadline + pass cap, honest final synthesis.
- **WhatsApp intake**: message recorded before it is marked read, `wamid` is the idempotency key, the cursor only
  advances after the batch is stored, 409/429/backoff handling, chunking ≤ 4096, typing refreshed inside its 25 s
  life. The live poller is connected and has logged no error.
- **CI**: lint, the full suite, bundle boot, and the key-mode auth probe (`401` without the key, `200` with it).
- **v1 retirement**: the `v1-archive` tag points at the last commit that still contained `js/` and `routes/`.

---

## 5 · Three things I'd do today, in this order

1. **The one-line test fix** → CI green, PR #2 mergeable.
2. **P1-1 and P1-2** (both one-liners with a regression test each) → the phone stops lying about the budget, and a
   reconnect stops blanking a task.
3. **P1-3** → the Test button stops spending invisible quota, and `/api/budget` becomes true again.

Then **P1-4/P1-5** as the "make it trustworthy over weeks" pair: a daily maintenance tick, and durable artifacts.

**Housekeeping, your side:** the access key you pasted is now in a chat transcript and in my tool logs — I'd
rotate it. It is a Render-generated env var (`ACCESS_KEY`), so changing it there issues a new link and invalidates
the old one; nothing else needs touching.
