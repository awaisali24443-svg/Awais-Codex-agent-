# Strategy — making Awais Codex better than the current agents, on free tiers

**Audience:** the owner (architect/planner). This is a decision document, not a tutorial.
**Companion:** `plan/01-JUNIOR-WORK-ORDER.md` (the fixes the coder executes first).

---

## 0. The one rule

**You cannot beat Manus, Devin, Claude Code, ChatGPT-Agent, Cursor or OpenHands on capability — and you
shouldn't try.** They have frontier models, GPU fleets, and teams. On a free tier you have ~100 agent runs a day,
512 MB of RAM and an ephemeral disk.

So don't compete on *what the agent can do*. Compete on the four things a big lab structurally cannot optimise for
a single person:

| Axis | Why they can't | Why you can |
|---|---|---|
| **Reachability** | Their product is a console/app you must open; that is where their funnel is | Yours answers a WhatsApp message from a locked phone in seconds |
| **Continuity** | Sessions are isolated by design (multi-tenant, privacy, cost) | One user, one Postgres — the agent can remember everything, forever |
| **Proactivity** | A proactive agent is a support and cost problem at scale | One user who *wants* to be interrupted is the ideal case |
| **Ownership & price** | Per-seat pricing, vendor-held data, quota tiers | $0 marginal cost, your key, your database, your artifacts |

One sentence to build the product around: **"The agent that comes to you."**
Everything below is in service of that sentence.

---

## 1. Free-tier resource map — what each thing buys you

Verified 2026-09 (limits change; re-check before relying on any single number).

| Resource | Free allowance | What it is for in your design |
|---|---|---|
| **Antigravity agent** (your key) | ~100 runs/day, 60 RPM, 100K TPM | **The scarce resource.** Spend it only on work that needs a sandbox |
| **Gemini Flash / Flash-Lite** (same key) | Free tier on Flash families (your key already shows Flash-Lite 15 RPM) | Triage, titles, summaries, memory extraction, formatting — no run consumed |
| **Cloudflare Workers** | 100K req/day, 10 ms CPU/invocation, **cron triggers included**, Durable Objects 100K req/day, Queues 10K ops/day | **The always-on edge.** Intake, acknowledgement, queueing, wake-ups |
| **Cloudflare R2** | 10 GB-month, 1M Class A + 10M Class B ops, **zero egress** | Artifacts: APKs, zips, previews that outlive the sandbox and the deploy |
| **Cloudflare D1 / KV** | 5 GB / 1 GB | Only if you want edge-side state; your Postgres is still the source of truth |
| **Neon Postgres** | 0.5 GB, 100 CU-hours/mo, scales to zero, PgBouncer | Durable state: runs, events, memory, queue, usage |
| **Render** | 512 MB / 0.1 CPU, **sleeps after 15 min idle**, ephemeral disk, 750 instance-hours/mo | **Execution only** — the runner, not the front door |
| **GitHub Actions** | ~2,000 min/mo private (public repos free) — verify | **The CPU farm**: APK builds, big tar extraction, nightly `pg_dump`, the verify workflow |
| **QStash / Inngest** | 500 msgs/day / ~25K runs/mo | Optional: wake the runner, schedule batches |
| **Groq / Cerebras / OpenRouter** | Groq ~30 RPM, 1K req/day, 200K tokens/day · Cerebras ~1M tokens/day at 5 RPM · OpenRouter 50 req/day | Fallback cheap tier if Gemini's free tier annoys you |
| **Workers AI** | 10K neurons/day | Last-resort local-to-edge inference (embeddings, small classification) |

**Two caveats worth writing down:** the free Gemini tier's content may be used to improve Google's products, so
never route private repo code through it — that traffic belongs on your own key's agent path or on a provider whose
terms you accept. And free tiers that sleep (Render) or expire can never be the *only* place something important
lives; hence Postgres for state and R2 for artifacts.

---

## 2. The architectural move: always-on intake, on-demand execution

Today the poller and the executor live in the same process on Render. When Render sleeps (15 minutes idle), the
phone side goes dark: no acknowledgement, no queueing, and a 1-minute cold start before anything can even be
accepted.

**Split them.** The edge never sleeps and is free; the container is allowed to.

```
        ┌─────────────────────────── CLOUDFLARE (free, always on) ───────────────────────────┐
        │  Worker (cron every minute)                                                        │
        │   1. GET /updates?timeout=10  → WhatsApp Agent Platform                            │
        │   2. record the message in Neon (wamid = idempotency key)                          │
        │   3. mark read + reply INSTANTLY: "Got it — starting now"                          │
        │   4. wake the runner (fetch /healthz, or a QStash message)                         │
        └───────────────────────────────────┬───────────────────────────────────────────────┘
                                            │ queued work
                                            ▼
        ┌──────────────────────── RENDER (free, may be asleep) ────────────────────────────┐
        │  Node app: acceptance rules, budget gate, executor, Antigravity engine, SSE, UI   │
        │  Reacts to the queue; if it was asleep, step 4 wakes it                            │
        └───────────────────────────────────┬───────────────────────────────────────────────┘
                                            │ artifacts
                                            ▼
                                   CLOUDFLARE R2 (10 GB, zero egress)
```

**Why this is the right move, and not just a trick:**

1. **It is already supported by your code.** `POLLER_ENABLED=false` + `pollerMode: 'off'` exists precisely for
   "another process owns the poller", and the WhatsApp platform's rule — *exactly one poller per agent* (409
   otherwise) — is satisfied by the Worker owning it and Render never polling.
2. **The phone experience stops depending on Render.** Acknowledgement, read receipts and queueing are instant at
   any hour; execution starts when the runner is awake.
3. **It gives you the deferral queue for free.** If the runner is down, out of quota, or busy, the message is
   already durably stored with a promise attached.

**Verify before building:** the cron-triggered Worker's wall-clock limit on the free plan. Use `timeout=10` on the
poll and a 1-minute tick; if a tick can overlap the next, guard with a Durable Object or a KV lock. Keep the
Worker dumb — it must never contain business rules; those stay in `accept.ts`.

---

## 3. Quota multipliers — how ~100 runs/day becomes a heavy day's work

The quota is only a bottleneck if you spend runs on things that are not agentic work. Five multipliers, in order
of value:

| # | Multiplier | Effect | Where it plugs in |
|---|---|---|---|
| 1 | **Continuation** (already built) | A 10-message conversation is **1** run, not 10 | `resolveContinuation` + `previous_interaction_id` |
| 2 | **Route the non-agentic 30%** | Titles, summaries, memory extraction, transcription, triage → free Flash-Lite at 15 RPM. These never touch Antigravity | New `server/router.ts`; replaces the places that currently spend a run to produce a sentence |
| 3 | **Batch** | One run carries a checklist: "morning batch: 1) repo status 2) PR review 3) fix the failing test 4) summarise inbox". 5 asks from 1 run | Batch composer in the UI + `/batch` in WhatsApp |
| 4 | **Defer, never refuse** | At the cap, queue to the reset instead of returning 429-and-forget. **Zero wasted asks** | New `task_queue` table + the edge intake above |
| 5 | **Dedupe & cache** | Identical prompt within N hours → return the stored answer, spend nothing | Hash the normalised prompt; `settings`-style lookup |

Realistic outcome: a heavy personal day (10–15 asks, several follow-ups, one batch, a couple of proactive runs)
lands at **under 20 runs** — a fifth of the quota. The binding constraint becomes **100K TPM** and the 60 RPM
ceiling, which batching also helps. The budget guard from the work order (T4) makes this honest instead of
optimistic.

---

## 4. The five wedges, as features

Each row: what to build, why it beats them, effort.

| # | Wedge | The feature | Why it wins | Effort |
|---|---|---|---|---|
| W1 | **Reachability** | Send a task by text, **voice note**, or a forwarded message; ack in <5 s even at 3am (edge intake) | Every competitor needs you to open an app. You need a locked phone and one message | M |
| W2 | **Continuity** | One thread per person; follow-ups resume the sandbox; memory injected every run; "what did we decide about X?" answers from your own history | Their sessions are isolated by design. Yours is one long relationship | S–M (tables exist) |
| W3 | **Proactivity** | Morning brief (briefing module exists), reminders (exists, off by default), watchdogs ("tell me when CI goes red on this repo", "check the build in an hour and fix it"), follow-up nudges on unfinished work | **No current agent initiates.** This is the single biggest differentiation and you already have half the modules | M |
| W4 | **Deliverables** | Every result ends with a thing: live preview link, APK, zip, or a fresh GitHub repo. Artifacts move to R2 so links never rot | They hand you a chat transcript. You hand them an installable file | S (R2) + M (packaging) |
| W5 | **Ownership & $0** | Self-hosted, your key, your Neon, no seat pricing; a daily quota as a *feature* ("deliberate, not a toy") | The only personal agent whose data never leaves your accounts | already true |

**The sentence to put on the door:** *"Message it like a person. It remembers you, works while you sleep, and
hands you a file — for nothing."*

---

## 5. Roadmap — five phases, each a work package for the coder

Phases 1–2 are the "make it trustworthy" pass; 3–5 are the differentiation. Each package lists its acceptance
criteria so it can be verified, not believed.

### Phase 1 — Trustworthy (after `plan/01` lands; ~1 week)
| Package | What | Done when |
|---|---|---|
| 1.1 | **Verify button** in Settings — expose `verify.ts` (`checkAgent`, `checkGithub`, `checkWhatsapp`) as an authenticated endpoint + one UI button | Pasting a bad key shows `auth_failed` in-app, without spending a run |
| 1.2 | **Resume, don't restart** — persist `interaction_id` the moment it arrives; add "Continue this task" on failed/orphaned runs | A killed run can be continued; the sandbox is reused, not re-billed |
| 1.3 | **Artifacts to R2** + a stable public link per artifact | An artifact downloaded a week after the sandbox expired still works |
| 1.4 | **Nothing fails silently** — failed runs, quota exhaustion and poller death each send one WhatsApp message | Kill the poller deliberately; the phone says so within 2 minutes |

### Phase 2 — Always-on (2 weeks)
| Package | What | Done when |
|---|---|---|
| 2.1 | **Edge intake Worker** (cron poll → Neon → instant ack → wake runner); `POLLER_ENABLED=false` on Render | A message sent while Render is asleep is acknowledged in <5 s and executed after wake |
| 2.2 | **`task_queue` table + deferral** — 006 migration; acceptance returns `queued_for_reset` instead of 429 when the quota is spent | Fill the budget, send a task, watch it run automatically after reset |
| 2.3 | **Batch mode** — one run, a checklist of asks; `/batch` in WhatsApp and a batch composer in the UI | 5 asks produce 1 run and 5 result cards |

### Phase 3 — Proactive (2 weeks)
| Package | What | Done when |
|---|---|---|
| 3.1 | **Morning brief** on a schedule (module exists; wire it to a cron + the phone) | Brief arrives at the chosen hour, unattended, spending 1 run |
| 3.2 | **Watchdogs** — "check this repo's CI every 2 hours, tell me only if red; if red, open a draft fix" | A deliberately broken CI turn produces one message and one draft fix |
| 3.3 | **Reminders on** (`REMINDERS_ENABLED=true` + a UI toggle) | A reminder set by voice fires and reports back |

### Phase 4 — Conversational depth (2–3 weeks)
| Package | What | Done when |
|---|---|---|
| 4.1 | **Voice notes → tasks** (Groq Whisper free tier) | A 30-second voice note becomes a correct task |
| 4.2 | **Ask one question, then continue** — if a task is ambiguous, one WhatsApp question; the answer resumes the same sandbox | An under-specified task produces exactly one question, never a stall |
| 4.3 | **Templates/chips** — saved prompts ("tidy my repo", "weekly competitor scan", "review my landing copy") | Two taps from the phone starts a recurring job |

### Phase 5 — Compounding (ongoing)
| Package | What |
|---|---|
| 5.1 | **Memory with citations** — every claim about you links to the memory row and the run that produced it |
| 5.2 | **Monthly self-review** — the agent reports its own failure rate, cost per delivered task, and proposes one improvement (then you approve it) |
| 5.3 | **Chained work** — "check in an hour" / "when the build finishes, deploy" with a bounded chain depth |

---

## 6. The four product rules that make it *feel* better than Manus

1. **Never show a dead stream.** If a run failed or was cancelled, the chat says so and offers the next action.
   (Work order T8 is part of this.)
2. **Answer in the channel you were asked in.** A WhatsApp ask gets a WhatsApp answer — chunked, with the artifact
   link, never "open the dashboard to see".
3. **Never fail silently.** Every failure ends with a message that names the cause and the fix, and the reason is
   recorded (`error_type`) so you can see patterns.
4. **Every result ends with an artifact or a decision.** "Here is the APK" / "here is the repo" / "I need one
   answer to continue" — never a chat transcript as the deliverable.

---

## 7. What NOT to build (protect your focus)

- **Multi-tenant SaaS, teams, sharing.** It multiplies every security and quota problem and destroys the
  "I own it" advantage.
- **A model zoo / your own router dashboard.** One router, three tiers (free-fast, agent, fallback), done.
- **Chat-UI parity with Manus.** You win on the phone, not on the web app.
- **A vector database.** Until memory search actually hurts, `ILIKE` over a small table beats another service.
- **Benchmarks and evals against other agents.** The metric that matters is "did the last 30 tasks have to be
  redone by hand?"
- **Anything that needs a paid tier to be *correct*.** Every phase above runs on the free allowances in §1.

---

## 8. Scoreboard — five numbers to keep on one page

| Metric | Target | Why |
|---|---|---|
| **Time to acknowledgement** | < 5 s, any hour | The only metric the phone user feels (Phase 2) |
| **Runs per delivered task** | < 1.5 | Below 1.0 means you are batching well (Phase 2) |
| **% tasks ending with an artifact or decision** | > 80% | The "hands you a thing" promise |
| **Follow-ups that continue a sandbox** | > 60% | Continuity is the wedge; if this is low, nothing else matters |
| **Unattended success** | > 70% | Proactive runs that finished with nobody watching (Phases 2–3) |

If time-to-ack is slow, the edge intake is not done. If runs-per-task climbs, the router is leaking agent runs into
work that does not need a sandbox.

---

## 9. Risks and the mitigation for each

| Risk | Mitigation |
|---|---|
| Render sleeps / 750 instance-hours | Edge intake (§2) does the front door; the runner only wakes for work |
| Agent id is date-stamped and Google retires it | Phase 1.1's verify button + `agent_unavailable` surfaced to the phone |
| Free Postgres has no backups | Nightly `pg_dump` in GitHub Actions → private release; `MASTER_KEY` deliberately excluded |
| One poller per agent (409) | Exactly one owner: the Worker. Render runs with `POLLER_ENABLED=false` |
| Free-tier terms / privacy on shared free inference | Private code goes only through your own key's agent path |
| Quota reset timing (~noon PKT) vs your day | The deferral queue (2.2) turns the reset into a promise, not a wall |
| Two branches diverged again (v1/v2, 01a0c3fe/01a0c7ad) | One trunk: `main` after PR #2 merges; delete stale branches; tag v1 |

---

## 10. What to do this week

1. Hand `plan/01-JUNIOR-WORK-ORDER.md` to the coder. Nothing else starts until CI is green (T1, T2).
2. Decide T13 (delete v1) and the two `render.yaml` switches (reminders, GitHub token).
3. Approve Phase 1 — it is the "stop lying to me" phase: verify, resume, artifacts that survive, failures that
   speak.
4. Then Phase 2, which is the actual product moat on a free tier: **always-on intake**, **deferral**, **batching**.

Everything in Phase 1–2 is buildable with the resources already in §1, and none of it exists in Manus, Devin or
ChatGPT-Agent in a form that fits one person's phone.
