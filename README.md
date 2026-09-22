# Awais Codex Agent 🚀

> **Autonomous AI engineering agent, with a WhatsApp front door.**
> One self-hosted workspace: send a task from the web or from your phone, watch it run live, and come back to the answer later — it remembers you either way.

Powered strictly by the **Google Antigravity managed agent** (`antigravity-preview-09-2026`) running inside a remote Linux sandbox that can actually build things.

---

## What it does

| | |
|---|---|
| **Live missions** | One prompt becomes a run: thinking, tool calls, steps and the final answer stream to the browser over SSE |
| **Nothing is lost** | Every event is written to Postgres before it is sent, so a dropped phone connection, a closed tab or a redeploy costs you nothing — reopen and it replays what you missed |
| **Remembers you** | Facts, preferences and standing instructions persist across sessions and conversations, and are recalled into every new mission (`server/memory.ts`) |
| **WhatsApp** | The September 2026 *third-party agents* feature: add the agent in WhatsApp, paste the API key it generates, and text it tasks. Acknowledgement, progress for slow work, the answer, plus `/status`, `/cancel`, `/new` |
| **Real artifacts** | When the agent builds a file (APK, ZIP, tarball), it is recorded on the mission and downloadable — fetched from the sandbox on first request and cached after |
| **Knows its limits** | A daily run budget enforced in the database, one mission at a time, typed errors (`quota_exceeded`, `auth_failed`, `agent_unavailable`), and an idle watchdog so a stalled agent frees the slot |
| **Configurable from the app** | The Settings panel in the drawer changes the daily budget and the agent id live, and holds credentials — a key pasted there is encrypted with `MASTER_KEY` (AES-256-GCM), never sent back to the browser, and used from the next request instead of the next deploy |
| **Installable** | A PWA with a service worker: network-first while online, last-known page offline |

---

## Architecture

```
┌──────────────────────────── browser (no framework) ────────────────────────────┐
│ web/index.html · web/app.js · web/styles.css · web/sw.js (service worker)      │
│   sign in with the access key → run cards → artifact chips → memory panel      │
└───────────────────────────────────┬────────────────────────────────────────────┘
              fetch /api/*  +  EventSource (SSE, Last-Event-ID replay)
┌───────────────────────────────────▼────────────────────────────────────────────┐
│ server/main.ts — boot: validate config → Postgres → migrate → prune → recover  │
├────────────────────────────────────────────────────────────────────────────────┤
│ routes/  runs (create, stream, cancel) · memory · artifacts                    │
│ accept.ts       the ONE path a task may start: one-at-a-time + budget claim    │
│ executor.ts     engine output → durable, replayable event log                  │
│ engine/         the engine seam: antigravity (real) | scripted (spends nothing) │
│ memory.ts       profile + memories, recall, extraction                         │
│ artifacts.ts    record + lazily fetch produced files from the sandbox          │
│ budget.ts       atomic daily cap (one SQL statement)                           │
│ whatsapp/       poller → accept → relay → sender; format.ts converts Markdown  │
├────────────────────────────────────────────────────────────────────────────────┤
│ Postgres (Neon) — 13 tables; in-process PGlite for dev and tests               │
└───────────────────────────────────┬────────────────────────────────────────────┘
                    Google Interactions API  ▸  /v1beta/interactions (streaming)
                    WhatsApp Agent Platform ▸  api.whatsapp.com/agent/v1 (long poll)
                    Google Files API        ▸  /v1beta/files/environment-…:download
```

**The rules the code keeps** (all of them are enforced somewhere, none are aspirational):

* a run is a row, not a request — it survives the process that started it
* durable events are persisted *before* they are published; the SSE bus is a latency optimisation, never the source of truth
* a terminal event is written *before* the run's status flips, so "status is finished" proves "the log is complete"
* one mission at a time and the daily cap are database constraints, not checks in a handler
* a WhatsApp message is idempotent by `wamid`: a replayed offset can never start the same task twice
* memory and artifacts degrade to "not available" rather than failing a mission

---

## Getting started

```bash
git clone https://github.com/awaisali24443-svg/Awais-Codex-agent-.git
cd Awais-Codex-agent-
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` needs no configuration at all: with no `.env`, it uses in-process **PGlite** for storage and starts **open** (it warns you). That PGlite lives in memory, so tasks, memories, settings and stored keys are gone when the process stops — point `DATABASE_URL` at Postgres (or set `MASTER_KEY` and run with a database) if you want a local run to persist. To point it at the real agent, copy `.env.example` to `.env` and set `GEMINI_API_KEY`. To try the whole pipeline without spending a single one of your ~100 daily runs, set `ENGINE=scripted`.

```bash
npm test             # 237 tests, no network and no credentials required
npm run lint         # type-checks the server AND the browser app (see below)
npm run build        # bundles the server to dist/server.cjs (the UI ships as-is)
npm start            # production
npm run db:migrate   # apply migrations and exit
npm run icons        # re-render web/pwa-*.png + apple-touch-icon.png from icon.svg
```

`npm run lint` runs two checks: `tsc --noEmit` over `server/`, and `tsc --noEmit -p tsconfig.web.json`, which type-checks `web/app.js` and `web/sw.js` as JavaScript. The second one exists because the browser app has no bundler and no build step of its own — without it, a renderer that calls a function nobody defined is a `ReferenceError` at runtime, and inside `enter()` that looks like a sign-in screen rather than a bug. (It looked exactly like that for a while: `loadMemory()` was called by nobody from nowhere.) `server/web-app.test.ts` covers what a type checker cannot know — that every `$('id')` exists in the markup, and that every asset the page asks for is really served.

### Configuration

Everything lives in `.env` (see `.env.example` for the annotated list).

| Variable | Why it exists |
|---|---|
| `DATABASE_URL` | Postgres. **Required in production** — free hosting disks are ephemeral, so JSON files lose data on every restart |
| `SESSION_SECRET` | Signs the session cookie. ≥32 chars in production |
| `ACCESS_KEY` | The key in your `?k=…` link / sign-in screen. ≥12 chars in production |
| `MASTER_KEY` | 64 hex chars (`openssl rand -hex 32`). Enables storing credentials from the app; without it, Settings refuses writes rather than saving them in the clear |
| `GEMINI_API_KEY` | Google AI Studio key for the agent. Optional — a key stored in Settings is used instead |
| `ANTIGRAVITY_AGENT` | The managed agent id — **date-stamped**, so it is configuration, not a constant |
| `DAILY_RUN_BUDGET` | Hard daily cap, default 100 |
| `WHATSAPP_TOKEN` + `POLLER_ENABLED` | The phone channel. Exactly one process may poll an agent |
| `ENGINE` | `antigravity` (default) or `scripted` |

Locally, `AUTH_MODE` defaults to `key` but falls back to `open` with a loud warning when no access key exists, so a fresh clone is usable instead of serving a sign-in screen nobody can pass. Production always requires the key.

---

## Deploying to Render

`render.yaml` is a complete blueprint: link a Neon database, paste the connection string as `DATABASE_URL`, generate `SESSION_SECRET` and `ACCESS_KEY`, set `MASTER_KEY` (`openssl rand -hex 32`) and `GEMINI_API_KEY`, and deploy. Migrations run at boot, because Render's free tier has no shell.

Then: open `https://<service>.onrender.com/?k=<ACCESS_KEY>` **once**. The key is exchanged for a signed session cookie and stripped out of the address bar.

---

## The API

Everything except `/healthz`, `/readyz` and `POST /api/auth/login` requires a session (cookie, `?k=`, `x-access-key`, or a bearer token).

```
POST   /api/runs                     start a mission           → 201 {run, budget}
GET    /api/runs/:id/stream          live SSE (replays from Last-Event-ID / ?after=)
GET    /api/runs/:id                 run + events + artifacts
GET    /api/runs/active              what is running right now
POST   /api/runs/:id/cancel          stop it, keeping partial output
GET    /api/runs/:id/artifacts       what it built
GET    /api/artifacts/:id/download   the bytes (lazily collected from the sandbox)
GET    /api/budget                   per-channel usage for today
GET    /api/conversations            history · /:id/messages
GET    /api/memory                   profile + memories
POST   /api/memory                   add one · /search to see what would be recalled
PUT    /api/memory/:id · DELETE :id  correct or forget
PUT    /api/memory/profile           name, role, stack, standing directives
POST   /api/memory/clear             forget everything
GET    /api/settings                 live settings + credential states (never values)
PUT    /api/settings/:key            change one (applies immediately, no redeploy)
DELETE /api/settings/:key            drop the override, back to the environment
PUT    /api/settings/secrets/:name   store a credential, encrypted
DELETE /api/settings/secrets/:name   forget it (the env var, if set, applies again)
GET    /healthz · /readyz            liveness and readiness (database, poller, key)
```

Example — teach it something, then use it:

```bash
curl -X POST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"prompt":"remember that: deploys go through Render"}'

curl -X POST localhost:3000/api/runs -H 'content-type: application/json' \
  -d '{"prompt":"how should I deploy this?"}'   # the memory rides along with the prompt
```

---

## WhatsApp (third-party agents, the September 2026 feature)

This uses the **WhatsApp Agent Platform** — the API behind the *third-party agents* that
WhatsApp began rolling out on 4 September 2026 (Android beta 2.26.35.3, [WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-chats-with-third-party-agents/)).

That feature is not the old Business/webhook API, and the difference matters:

| | Business Cloud API (old) | Third-party agents (this) |
|---|---|---|
| Who talks to whom | A business to customers, via Meta's review and a registered number | **Your** agent in **your** chat, on your personal WhatsApp |
| Who can be messaged | Any number that opted in | **Only the account that created the agent** — there is no way to message an arbitrary number |
| Setup | Business verification, phone number, webhook URL, app secret | Name + avatar in WhatsApp, then **one API key** |
| Transport | Meta POSTs webhooks to you | **You long-poll** `api.whatsapp.com/agent/v1` |

### Connecting it

1. On the phone: **Settings → Agents → Create an agent**, give it a name and an avatar.
   (You can have up to five; removing one disconnects it but keeps the chat history.)
2. Open the agent's chat → **Chat info → API key**. Copy it.
3. Open this app → **drawer → Settings → WhatsApp Agent Platform token → Replace**, paste, Save.

That is the whole setup. The poller starts the moment the key is stored — no restart, no
`POLLER_ENABLED=true`, no redeploy — and the same panel then reads *WhatsApp connected*, or
tells you why it did not (a 401 from the platform in plain words). Removing the key stops the
poll immediately, so a revoked credential is not left looping.

`WHATSAPP_TOKEN` in the environment still works and is equivalent; a key stored in Settings
takes precedence, and deleting it hands control back to the variable. `POLLER_ENABLED=false`
is the hard off — that is how a second host (your laptop, or a staging deploy) stays quiet,
because the platform allows exactly **one** poller per agent and answers a second with 409.
With no value set the poller runs whenever a token exists.

Then text the agent a task. `/help`, `/status`, `/cancel`, `/new <task>` are understood.
Progress arrives for slow tasks, the answer is chunked to the platform's 4096-character cap,
and Markdown is converted to WhatsApp's own syntax (`*bold*`, not `**bold**`) at the boundary.

### What it does and does not do

* Inbound messages are written to `wa_updates` **before** anything else and marked read only
  after that, so a crash cannot lose a task or double-handle one (the `wamid` primary key is
  the enforcement).
* Answers are read from the durable snapshot, not from memory, so a redeploy mid-task still
  delivers the result.
* Typing indicators are refreshed while a task runs — they expire after 25 seconds — and a
  send is never retried after a 5xx, because it may already have been delivered.
* **Text only, for now.** The platform also does media (upload/download, images, documents,
  audio) and this build does not use it: you cannot send the agent a photo, and it cannot send
  a built artifact back to your phone. That is the next piece of work, not a limitation of
  the platform.
* Agent chats are **not** end-to-end encrypted — WhatsApp says so explicitly in its terms —
  so a task sent from the phone passes through Meta's service unencrypted, exactly as it
  would with any third-party agent. Personal chats between people are unaffected.
* The feature is still rolling out to a limited number of accounts in selected countries. If
  **Settings → Agents** is not in your WhatsApp yet, neither is this channel; the web app is
  unaffected.

---

## Where it stands

Honest accounting, kept up to date with the code. "Built" means the feature exists with tests
and has been exercised at runtime; "proven live" is narrower — only a real API key can settle
that, and the one thing still unproven is listed below.

| Area | Built | Notes |
|---|---|---|
| Mission loop: engine, streaming, durable events, replay, cancel, retry ladder | ✅ 100% | The real Antigravity protocol is implemented against the documented endpoint; every test runs against a fake server, so **the first mission with a real `GEMINI_API_KEY` is still the proof** |
| Storage: Postgres + migrations, PGlite for dev/test, orphan recovery, retention | ✅ 100% | |
| Auth: `?k=` link, session cookie, bearer, open mode, dev fallback | ✅ 100% | |
| Budget: per-channel daily cap, enforced in the database | ✅ 100% | Changeable live from Settings |
| Memory: extraction, recall, profile, API, prompt injection | ✅ 100% | |
| Artifacts: record, lazy fetch, download, cache, prune | ✅ 95% | No upload *into* a run, no delete from the UI |
| Settings & secrets: live config, AES-256-GCM credentials | ✅ 95% | Two settings and two credentials — only the ones something reads |
| WhatsApp: connect, poll, relay, format, commands | 🟡 90% | Text only; media is untouched |
| PWA: installable, offline shell, versioned caches | ✅ 100% | |
| Deploy & CI: Render blueprint, GitHub Actions, health checks | ✅ 100% | |
| Docs: README, `.env.example`, `STATUS.md`, `ARCHITECTURE.md` | ✅ 100% | |
| GitHub export: token, repo list, push | ❌ 0% | v1 had it; never ported |
| Legacy v1 tree (`js/`, `routes/`, root `index.html`, …) | ❌ not removed | Documented as reference-only; git history keeps it |

**Overall: about 90% of what v1 promised, plus the whole §8 plan from `ARCHITECTURE.md` except
GitHub export.** The three things actually left are WhatsApp media, GitHub export, and running
one mission against the live agent. `STATUS.md` has the file-by-file version of this.

## Repository layout

```
server/                the application (see STATUS.md for the file-by-file map)
  engine/              the engine seam: antigravity.ts (real) · scripted.ts (free)
  whatsapp/            poller · relay · sender · api · format · store
  routes/              runs · memory · artifacts
  migrations/          001_init.sql — the whole schema, with its constraints
web/                   the client: no framework, no build step, installable
data/                  runtime scratch (gitignored): extracted sandbox snapshots
.github/workflows/     CI: install → type-check → 193 tests → build → boot the bundle
```

**Legacy v1 — kept for reference, not built and not served:** `index.html`, `js/`, `routes/`, `routes/whatsapp.ts`, `memory-engine.ts`, `antigravity-client.ts`, `apk-generator.ts`, `call-budget-server.ts`, `config.ts`, `types.ts`, `public/`, `metadata.json`. These are the previous generation of the product (file-based storage, Meta Cloud webhooks, a hand-rolled APK packager). Nothing imports them; `ARCHITECTURE.md` reviews them in full and `STATUS.md` records what has since been rebuilt.

---

## Security notes

* Deny by default: every `/api` route needs a session, and `PUBLIC_ROUTES` is a two-entry allowlist.
* Constant-time comparisons for the access key and bearer tokens.
* The agent's API key travels as a header, never in a URL.
* Stored credentials are AES-256-GCM encrypted, with the secret's own name bound in as associated data so a ciphertext cannot be moved between rows. No endpoint returns a stored value — only whether it exists, where it came from, and a short fingerprint so you can tell whether you pasted the same key twice. A value saved while `MASTER_KEY` was one thing, read while it is another, is reported as unreadable rather than silently ignored.
* Extracted sandbox snapshots land in `data/artifacts/` (gitignored) and are only ever served by artifact id; files are located by basename inside the extraction root, so an agent-supplied path cannot climb out of it.
* Artifact downloads and memory writes are both behind the session, so the store is only ever read and written by the operator.

---

## License

MIT · Developed by **Awais Ali** ([awaisali24443-svg](https://github.com/awaisali24443-svg))
