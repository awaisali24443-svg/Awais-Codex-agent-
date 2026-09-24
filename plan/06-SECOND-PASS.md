# 06 · Second pass — the code I had only cleared by test-evidence before

**Nothing was changed.** No commits, no pushes, no edits. Untracked file in `plan/`.

**State check first:** the repo is **byte-identical to my last review** — `arena/01a0c7ad` @ `6005037`, `main` @
`186e8a8`, PR #2 still open, no commits since 03:21:07Z. So every finding in `plan/05-BUG-REPORT.md` still stands,
unchanged. What follows is the second pass I hadn't done: the modules I had cleared by "the tests cover it"
rather than by reading them.

**Live, re-checked just now:** same process, `startedAt 03:21:49Z`, **uptime 1854 s (31 minutes) and continuous**
— your pinger is holding it awake with no restart. (Method note: a repeated fetch of the same URL is served from
a cache — an unchanged `uptimeSeconds` means the reader was cached, not that the clock stopped. The 1854 s reading
is a cache-busted one.)

---

## N1 · P1 — a phone task that runs longer than 45 minutes is answered only after the next restart

This is the most serious thing I have found in either pass, because it breaks the product's central promise in a
scenario your own UI offers.

**The chain:** `relay.ts:42` gives up watching after `DEFAULT_MAX_WAIT_MS = 45 min` and resolves `'detached'`.
`poller.ts:562` then does this, deliberately:

```ts
if (result.outcome === 'detached') {
  // Still running; the next boot's reconcile picks it up if it dies.
  return;                       // ← nothing sends the answer, nothing marks the message
}
```

Nothing else delivers it:

- the "done ping" is **web-only** — `doneping.ts:120` returns early unless `run.notifyWhatsapp`, which is set
  exclusively by the web composer's checkbox (`routes/runs.ts:203`); the poller's accept call
  (`poller.ts:516`) never sets it;
- the only recovery path is `reconcile()`, and **that runs at boot only** — and with your pinger in place, boots
  can be weeks apart.

**Why it is reachable, not theoretical:** `routes/runs.ts:75` accepts a research budget up to
`RESEARCH_BUDGET_MAX_MIN = 480` (eight hours), and the composer itself offers a "1 hour" preset. So from the
phone: ack → one "still working" line at 90 s → **silence**. The answer sits in Postgres, visible on the web UI,
never sent to the chat that asked for it. It also parks the single active slot for the whole window, so every
message in the meantime gets "I am still on this one".

**Fixes, best first** (I would take (a) plus (b) together):

- **(a) Make delivery the server's job, not the watcher's.** Let a phone-originated run get the same
  terminal-delivery treatment the web's "ping me" runs get — the answer is already persisted before the status
  flips, so this needs no new machinery, only a flag that is set by the origin rather than by a checkbox.
- **(b) Reconcile on a slow timer, not only at boot.** `reconcile()` is one indexed query over
  `wa_updates WHERE processed_at IS NULL` (`poller.ts:237`). Running it every ~10 minutes in the same way the
  reminders loop runs makes delivery self-healing after *any* interruption — a deploy, a crash, a detached relay —
  instead of waiting for the next restart.
- **(c) On detach, keep a cheap poller-side watcher** (no bus subscription: poll the run's status every 30 s and
  send the closing message). Bounded, but it is new code where (a) reuses what exists.
- **(d) Minimal stopgap:** raise `maxWaitMs` above the maximum research budget (8 h + slack). Costs one bus
  subscriber per very long run — cheap for a single operator — and it removes the silence for every case except a
  crash, which (b) then covers.

There is no test for any of this: the relay tests cover fast runs and the poller tests cover reconcile-at-boot,
so the 45-minute boundary is untested in both directions.

---

## N2 · P2 — a deploy that ships a migration can fail to boot, and maintenance on the boot path can too

`migrate()` reads `schema_migrations`, applies what is missing, then records it:

```ts
await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [...]);
```

No `ON CONFLICT`. Render's rollout starts the new instance **before** stopping the old one, so two boots can
overlap for a few seconds. If a migration is pending at that moment — which is exactly when a migration exists —
the second process runs the same SQL, then hits a primary-key violation, the transaction aborts, `migrate()`
throws, and `main.ts:72` has no guard: **the boot dies and the deploy fails.**

The migration SQL itself is safe: I checked all five files and every `CREATE TABLE`, `CREATE INDEX` and
`ALTER TABLE` is `IF NOT EXISTS`-guarded (no exceptions found). So the whole fix is one clause:
`ON CONFLICT (version) DO NOTHING`.

**The related risk, same root cause.** The boot sequence also runs, unguarded: `pruneRunEvents`,
`pruneArtifacts`, `markOrphanedRuns` (`main.ts:72-87`). Any failure there fails the deploy as well. That matters
because — as `plan/05` P1-4 explains — retention only ever runs at boot, so the first prune after weeks of
accumulation is the biggest one it will ever do, on a Neon instance with `statement_timeout: 30 s`. A slow
`DELETE` becoming a failed deploy is a bad trade for housekeeping. Move maintenance to a timer (update on a daily
tick, deleting in batches) and keep the boot calls best-effort.

---

## Verified sound in this pass (read line-by-line, not inferred)

- **`db.ts`** — pool of 3 when the URL is a PgBouncer host (5 otherwise), `statement_timeout` only in the pooled
  case, TLS for Neon with its certificate caveat handled explicitly, a `pool.on('error')` handler (Neon recycling
  connections during scale-to-zero is normal, not a crash), and a cold-start retry. `appendEvent` takes a
  **transaction-scoped advisory lock** before allocating the next seq — that is what makes the event log gap-free
  under concurrent writers, and it is exactly the lock shape PgBouncer transaction pooling supports.
- **`executor.ts`** — `FieldBuffer` keeps at most one write in flight and only ever moves text forward; snapshots
  are cumulative, deltas are transient; artifacts are recorded *before* the durable event that references them;
  memory and the planning contract ride **only on the wire**, so stored prompts and conversation history never
  contain text the operator did not write; shutdown aborts and waits against a deadline.
- **`memory.ts`** — the claim I most wanted to check is true in the code: extraction reads **the operator's prompt
  only**, with explicit-declaration patterns ("remember that", "my name is", "I prefer"), **never model output**.
  So a page the agent read during a task cannot poison long-term memory. It runs after the run settles, is
  best-effort, and costs zero model calls. Recall is lexical by design and says so.
- **`relay.ts`** — at most three sends per task (ack, optional progress at 90 s, answer) against a platform limit
  of 12 sends/minute; the final text is read from Postgres rather than from memory, and the status is re-checked
  after subscribing, so a run that finishes in the gap cannot be missed.
- **`verify.ts`** — verdicts carry a 12-hex fingerprint, never key material; missing credentials are *skips*, not
  failures.
- **`migrate.ts`** — one transaction per migration, and every statement idempotent (the insert being the one
  exception, see N2).
- **`server/routes/github.ts`** — token per request or stored; the API host is a constant, nothing
  caller-controlled.
- **`briefing.ts`** — pure SQL; the morning briefing costs no quota.
- **`app.ts` logger** — logs `req.path` only, **never the query string**, so the `?k=` access key cannot land in
  Render's logs. The comment claims it; the code does it.
- **`web/app.js`** — any 401 triggers the sign-in screen, which means **rotating your `ACCESS_KEY` is safe**: an
  old tab will ask for the new key instead of spinning. Reconnects ride on `Last-Event-ID` and only speak up when
  the run is known to be over.

---

## What to hand the coder, in order

1. **CI, one line** — `whatsapp.test.ts:519` (`plan/05` §1).
2. **N1(b) then N1(a)** — reconcile on a timer, then make terminal delivery the server's job for phone-originated
   runs. This is the promise the product is sold on.
3. **`plan/05` P1-1 and P1-2** — the two one-liners (wrong "tasks left", blank timeline on resume).
4. **`plan/05` P1-3** — the Settings Test button spending quota the budget cannot see.
5. **N2 + `plan/05` P1-4 together** — `ON CONFLICT` on the migration insert, and move all maintenance off the boot
   path onto a daily batched tick (`wa_updates` included; it is the one table nothing prunes).
6. **`plan/05` P1-5** — durable artifacts, when it is next convenient rather than urgently.

Everything from `plan/05` that is *not* listed here still stands and is unchanged on the branch: the quota
leak, the boot-only retention, the dormant reminders, the dead code and v1 leftovers, and the `auth.ts` comment
that still claims there is no login screen.
