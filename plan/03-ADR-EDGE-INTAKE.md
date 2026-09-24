# ADR-001 · Always-on WhatsApp intake at the edge

**Status:** proposed — needs the owner's decision before Phase 2.1 starts.
**Context:** `plan/02-FREEMIUM-STRATEGY.md` §2. **Decides:** where the WhatsApp poller runs, and how the edge gets a
credential that lives encrypted in Postgres.
**Depends on:** work-order T6 (artifacts read the secrets store) landing first — same seam, same fix pattern.

---

## 1. The problem

Render's free instance sleeps after ~15 minutes without inbound traffic. The poller runs inside that process, so:

- a message sent at 3am is not read, not acknowledged, not even queued — from the phone it is indistinguishable
  from the agent being dead;
- the first message after a sleep pays a ~1 minute cold start before anything at all happens;
- the platform's own rule — **exactly one poller per agent** (a second poll gets `409 PollReplacedError`) — means
  you cannot simply run a second poller elsewhere; you must move the one you have.

Cloudflare Workers' free plan removes the cause: 100,000 requests/day, cron triggers included, Durable Objects and
Queues included, no sleeping. A 1-minute cron is 1,440 ticks/day; with 2–3 subrequests per tick that is well under
1% of the daily request allowance.

**The catch:** the Worker needs the WhatsApp token, and that token lives in the `secrets` table, encrypted with
`MASTER_KEY`, decrypted only inside the Render process. Solving *that* is what this ADR is for.

---

## 2. Options for the credential

| | Option | Rotation | Works while Render sleeps | Risk |
|---|---|---|---|---|
| A | **Worker secret** — paste the token into the Worker's env as well | Two places; a rotation missed in one silently stops intake | Yes | Drift. Two sources of truth, and the failure is silent |
| B | **Worker asks Render for the token** per tick | One place | **No** — a sleeping Render cannot answer | Couples the front door to the thing that sleeps; defeats the design |
| C | **Render pushes the token to the edge** whenever it changes; the Worker reads its copy from KV | One place (Settings) | Yes | A push can fail → needs a reconcile on boot |
| D | **Give the Worker `MASTER_KEY`** so it decrypts from Postgres itself | One place | Yes | Spreads the key that protects *every* stored secret into a second runtime. Reject |

**Decision: C**, with **A** allowed only as a bootstrap while C is being built.

Why C: the Settings panel stays the single place a credential is entered or rotated; the edge is a *replica*, not a
second source. The failure mode is bounded and repairable (a missed push is corrected by the next boot's full
sync), unlike A's silent drift or B's dependency on a sleeping process.

---

## 3. Design

### 3.1 The push (Render → edge)

New internal endpoint on the app, guarded by a shared secret (`EDGE_SYNC_SECRET`, a Render env var and a Worker
secret — not `MASTER_KEY`):

```
POST https://<worker-host>/internal/token
x-edge-secret: <EDGE_SYNC_SECRET>
{ "whatsapp_token": "…", "whatsapp_to": "…", "version": 7 }
```

Called in two places, both already hookable:

1. **On save/rotate/remove** — the existing `onSecretChanged` callback in the settings routes (it exists today to
   start/stop the poller; the push is a second subscriber, and a failure there must not fail the save).
2. **At boot**, and every 6 hours — a full sync, so an edge that missed a push (deploy, network blip, cold KV)
   repairs itself without anyone noticing.

The Worker stores the values in KV and **never** logs them. `version` is a monotonic counter from the app: the
Worker accepts a write only if it is newer, so two racing pushes cannot install an older token.

### 3.2 The poll

```
*/1 * * * *  →  Worker.scheduled()
  1. token = KV.whatsapp_token;  if empty → log once, exit        (no token, no spin)
  2. acquire the tick lock (DO or KV with a 55s TTL)               (no overlapping ticks)
  3. GET {API}/updates?offset=<KV cursor>&limit=50&timeout=10      (409 → back off 60s, alert)
  4. 204 → release lock, exit
  5. for each message:                                            (idempotent by wamid)
       INSERT INTO wa_updates (wamid, kind, payload) VALUES (…) ON CONFLICT DO NOTHING
       if inserted:  POST /statuses {status:'read', typing_indicator}   ← the ack
                     send the human reply ("On it — …")
  6. write next_offset to wa_state                                 (same table Render uses today)
  7. wake the runner:  GET https://<app>.onrender.com/healthz      (fire and forget)
```

The Worker talks to **Neon over its HTTPS driver**, so no TCP and no connection pool to babysit. `wa_state` and
`wa_updates` stay the single source of truth — unchanged schema, unchanged idempotency guarantees: a wamid is
still the idempotency key, and the cursor is still only advanced after the batch is stored.

**Deliberately dumb:** the Worker holds no business rules. Acceptance, the budget gate, the queue and the engine
all stay in `accept.ts` on Render. If the edge ever needs a rule, the rule is wrong.

### 3.3 What Render does

Unchanged, minus the poller: `POLLER_ENABLED=false` on Render (the code already supports `pollerMode: 'off'` with
the message *"another process owns the poller"*). Render polls nothing and only executes work it is woken for.

### 3.4 Wake-up

`GET /healthz` is enough to break the sleep — but a wake is not the same as *work*. Two refinements, in order:

1. Phase 2.1: wake unconditionally on any queued message; Render's executor picks the work up from `wa_updates`
   during its boot reconcile (that path already exists and is tested).
2. Phase 2.2: the `task_queue` table becomes the contract — the Worker inserts a queue row, Render drains it. Then
   waking is about "there is a row", not "there might be a message".

---

## 4. Failure modes

| Failure | Detected by | Behaviour |
|---|---|---|
| Worker tick overlaps the previous one | tick lock (DO/KV TTL) | Second tick exits immediately; no double poll, no 409 |
| Two Workers deployed | platform 409 | Back off 60s, alert once (never a retry storm) |
| Token revoked or wrong | `400 / code 100` from the platform | Stop ticking, surface on `/api/status` and the phone |
| `EDGE_SYNC_SECRET` wrong | push returns 401 | Logged on Render; boot sync retries every 6h |
| Render is asleep | nothing — this is the design | The ack already went out; execution waits for the wake |
| Neon cold start | driver error | Retry once with backoff inside the tick; the message stays in the platform buffer |
| Message arrives twice | `wamid` primary key | `ON CONFLICT DO NOTHING`; no second task (already proven by tests) |
| Worker hits 100k req/day | Cloudflare hard stop | Practically unreachable: 1,440 ticks + acks ≈ 5k/day. Alarm at 50% |

---

## 5. Cutover (do it in this order)

1. Build the Worker behind a flag; it **does not poll** yet (`EDGE_POLLING=false`).
2. Verify the push path: rotate the token in Settings, confirm KV updated and `version` incremented.
3. Stop Render's poller (`POLLER_ENABLED=false`), **then** flip `EDGE_POLLING=true`. Never both.
4. Send a message with Render awake → it must arrive exactly once (check `wa_updates` has one row).
5. Let Render sleep for 20 minutes, send a message → acknowledged within 5 seconds, executed after the wake.
6. Rollback is one env var each way.

---

## 6. Acceptance tests

- A message during a Render sleep is marked read and acknowledged in **< 5s**, and executed after the wake, with
  exactly one `wa_updates` row.
- Rotating the token in Settings takes effect at the edge without a redeploy; the old token stops being used.
- Killing the Worker mid-tick loses nothing: the cursor has not moved, and the next tick re-reads the same offset
  (the wamid conflict makes the replay harmless).
- A second poller (deliberately run locally) produces the documented 409 path — backoff, one alert, no storm.
- `/api/status` and `/readyz` report the poller's true owner and health from the edge.

---

## 7. What this buys, in one line

The phone experience stops depending on a host that sleeps: **intake and acknowledgement become free and
always-on, and execution becomes the only thing that needs waking.** It is also the prerequisite for the deferral
queue (Phase 2.2) and therefore for "never refuse a task" — the difference between an agent that is a wall and one
that makes a promise.
