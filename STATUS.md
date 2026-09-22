# Awais Codex — what this branch is, and what is left to do

*Read-through of every file on `arena/01a0c7ad-awais-codex-agent` (92 files, the branch as it stood), plus a full runtime pass: install, type-check, tests, production build, boot (both `tsx` and the bundled CJS server), endpoints, and a complete scripted mission over SSE.*

> **Sections 0–7 describe the branch as it was when audited** — that is what "what is remaining" was measured against, and they are left intact so the measurement can be checked. **Section 8 lists what has since been implemented** on the same branch, with fresh numbers: 193 tests, CI green, the branch pushed and open as [PR #1](https://github.com/awaisali24443-svg/Awais-Codex-agent-/pull/1).

---

## 0. The short version

This branch holds **two products side by side**, and a third that is dead:

| | Where | State |
|---|---|---|
| **v1** — the app `ARCHITECTURE.md` reviews (vanilla SPA + JSON files on disk) | `index.html`, `js/`, `routes/`, `memory-engine.ts`, `antigravity-client.ts`, `apk-generator.ts`, `call-budget-server.ts`, `config.ts`, `types.ts`, `public/`, `src/` | Kept, untouched, **not reachable** — nothing boots it any more |
| **v2** — a rewrite (Postgres, durable run log, real auth, WhatsApp poller) | `server/`, `web/` | The live app: `npm run dev` and `npm start` both boot this |
| **The React shell** | `src/App.tsx` (`return <div></div>`) | Dead in v1, dead in v2, still installed, still built around |

The plan in §8 of `ARCHITECTURE.md` was acted on — **items 1 (auth) and 4 (tests) are genuinely done, to a high standard** — but **2 (webhook token), 3 (React stack), 5 (secrets/backup), 6 (APK) and 7 (lockfile/CI) are not**, and v2 has so far rebuilt only part of v1's feature set: the **chat, streaming, history and budget** are done far better than before, while **persistent memory, artifacts/downloads, GitHub export, the installable PWA and the APK packager have no v2 implementation at all** — several of them only as empty tables in `001_init.sql`.

There were also **three concrete blockers** that stopped this branch from running as documented (§5) — all three are now closed; see §8 for what changed after this audit, and §9 for the raw evidence trail this document was written from.

---

## 1. What the base actually is

`git` facts, verified after `git fetch --unshallow` — the clone handed to the agent was **shallow**, which made one linear history look like two unrelated roots; the first version of this document said "no merge base" and was wrong:

```
$ git merge-base --is-ancestor main HEAD  →  yes
$ git rev-list --parents -1 0f87213       →  0f87213 56de355      (first v2 commit, built on main)
$ git rev-list --parents -1 724ee0c       →  724ee0c 003e5f9
$ git log --oneline main..HEAD | wc -l    →  10
$ gh api .../compare/main...HEAD          →  {"status":"ahead","ahead_by":10,"behind_by":0}
$ git ls-tree -r main --name-only | wc -l →  51
$ git ls-tree -r HEAD --name-only | wc -l →  101
```

One history, not two: `main` is v1's tip and the v2 commits are built straight on top of it.

```
16 commits of v1 under main … tip 56de355
  0f87213  feat(v2): Postgres data layer, migrations, config validation, tests   ← v2 starts
  2c2816b  feat(v2): Express app factory, single-operator auth, boot sequence
  8c56965  feat(v2): server-owned run pipeline and the live SSE stream
  b19c624  feat(v2): the real Antigravity engine, continuation, and the v2 entry point
  f691889  feat(v2): no login screen — access is a key in the link
  2638649  feat(web): Manus-style mobile UI with the live thinking stream
  003e5f9  fix(boot): locate the web root and migrations without import.meta
  724ee0c  feat(whatsapp): send tasks from your phone
  89d470f  Rewrite v2: memory, artifacts, WhatsApp formatting, CI and one honest lockfile
  a25a7f0  CI: bump actions to v5
  9d4e475  apk-generator: real SHA-256 digests, and say it is unsigned
```

And when this audit was first written, `HEAD` was 92 files: 51 of v1, plus v2 — the v1 tree was simply never removed, which is why the two products sit side by side in one working tree.

Only **four files** of v1 were edited rather than left alone:

| File | Change |
|---|---|
| `.env.example` | Rewritten from v1's vars (`WHATSAPP_AGENT_KEY`, `WHATSAPP_APP_SECRET`, `GITHUB_PAT`, `WHATSAPP_ADMIN_SECRET`…) to v2's schema: `DATABASE_URL`, `SESSION_SECRET`, `MASTER_KEY`, `WHATSAPP_TOKEN` (Agent Platform), `POLLER_ENABLED`, `ACCESS_KEY`, `AUTH_MODE`, `DAILY_RUN_BUDGET`, `ANTIGRAVITY_AGENT`, `ENGINE` |
| `package.json` | `dev`/`build` re-pointed `server.ts` → `server/main.ts`; `test` and `db:migrate` added; `pg`, `@electric-sql/pglite`, `@types/pg` added |
| `package-lock.json` | The matching lock entries |
| `vite.config.ts` | §7's fix: `allowedHosts: true as const` |

Everything else in the tree is additive. The v1 modules are still imported by nothing new — `server.ts`, `routes/*.ts`, `memory-engine.ts`, `antigravity-client.ts`, `apk-generator.ts`, `call-budget-server.ts` and all of `js/` are now **unreachable code kept in the repository**.

---

## 2. v2, file by file (the app that actually runs)

**`server/` — 25 files**

| File | What it is |
|---|---|
| `main.ts` (194) | Composition root: validate config → connect Postgres → migrate → prune → recover orphans → listen on `0.0.0.0`. Graceful shutdown aborts runs and closes the pool |
| `config.ts` (175) | Typed env validation with actionable errors; fails fast (`ConfigError` lists every problem at once). Deliberately refuses to silently fall back from `antigravity` to `scripted` |
| `app.ts` (229) | Express factory: security headers, request-id access log, `?k=` → session claim, `/healthz`, `/readyz`, auth routes, `requireSession` over `/api`, static `web/` + SPA fallback, JSON-404 for unknown `/api`, no stack traces leaked |
| `auth.ts` (205) | Single-operator HMAC session cookie (year TTL), cookie parse, constant-time key compare. **Deny-by-default on `/api`**, three ways in (cookie, `x-access-key`, bearer). Carries the fix for v1's fatal `req.path`-inside-mounted-router bug, with a comment naming it |
| `db.ts` (220) | One Postgres dialect, two drivers (`pg` for Neon, in-process PGlite for dev/tests). Neon pooling/TLS/cold-start handled; `pg_advisory_xact_lock` for gap-free event sequencing; `pruneRunEvents`, `markOrphanedRuns` |
| `migrations/001_init.sql` (197) | 13 tables. Two partial/unique indexes carry invariants: `runs_single_active_idx` (one mission at a time) and `wa_updates.wamid` (idempotency) |
| `migrate.ts` (96) + `migrate-cli.ts` (41) | `NNN_name.sql` runner, one transaction per migration, idempotent; also runs at boot because Render's free tier has no shell |
| `paths.ts` (66) | Deliberate no-`import.meta` location probing — the comment documents the exact production bug it exists to prevent |
| `events.ts` (75) | In-process pub/sub; durable events persisted *before* publish, so the bus is a latency optimisation, never the source of truth. Empty channels are removed (no leak) |
| `executor.ts` (366) | The heart: durable `DurableWriter` (serialised, ordered, never fatal), `FieldBuffer` throttled full-text snapshots (750 ms), transient `*.delta` for feel, terminal event written **before** the status flips |
| `runs.ts` (443) | Run repository: lifecycle, `resolveContinuation` (resume the sandbox of the last *completed* run in the conversation), `RunConflictError`, `finishRun` closing run+message+usage in one transaction |
| `accept.ts` (148) | The single acceptance path both channels use: in-progress check → insert → atomic budget claim → refund by closing the run if the budget refuses |
| `budget.ts` (119) | `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit RETURNING count` — check-and-spend in one statement; `peek`, `snapshot`, `refund` |
| `routes/runs.ts` (313) | `/api/runs` (+ `/active`, `/:id`, `/:id/cancel`), `/api/runs/:id/stream` (subscribe → replay → flush → go live, heartbeats, backpressure-aware delta dropping, self-terminating), `/api/budget`, `/api/conversations`, `/api/conversations/:id/messages` |
| `engine/types.ts` (99) | The engine seam: `EngineContext`, `EngineResult`, `EngineError` with `retryable` deliberately narrow |
| `engine/antigravity.ts` (617) | The real engine: `POST /v1beta/interactions` with `agent`, `environment`, `previous_interaction_id`, `stream`, `store`, optional `max_total_tokens`; idle watchdog; fresh-sandbox fallback on 400/404; drop-optional-fields retry on unknown-field 400s; retry only when nothing was emitted; **recovery of the stored interaction by id after a cut stream**; tolerant SSE parsing, output-text/usage/artifact extraction |
| `engine/scripted.ts` (143) | A real streaming engine that spends nothing — reference implementation + demo/CI path |
| `whatsapp/api.ts` (469) | WhatsApp **Agent Platform** client (`https://api.whatsapp.com/agent/v1`): long-poll `/updates`, `POST /messages`, `POST /statuses`, error classification (409 = poll replaced), never retries a send |
| `whatsapp/store.ts` (139) | `wa_state` cursor (advanced only after handling) + `wa_updates` wamid idempotency; "run exists but reply never sent" is *resumed* |
| `whatsapp/poller.ts` (580) | The loop: poll → record → accept → acknowledge → detach. `/help /new /status /cancel`. Backoff table per error kind; boot-time `reconcile()` |
| `whatsapp/relay.ts` (200) | Run → phone: reads the answer from the durable snapshot, one progress line after 90 s, stops watching after 45 min (`detached`, run continues), re-checks terminal after subscribing, never throws |
| `whatsapp/sender.ts` (95) | One sequential send chain (order preserved, ≤1 send at a time), chunked at 4 096 chars |
| `*.test.ts` × 5 + 2 (2 450 lines) | 112 tests in 23 suites |

**`web/` — 4 files**: `index.html` (login + app + drawer + toast, 116 lines), `app.js` (802 lines: session boot, conversations, run cards, thinking/steps/answer, SSE with `Last-Event-ID`, 409 → attach to the live run, 429 → budget notice, escape-first Markdown subset, auto-grow composer, drawer, sign-out), `styles.css` (420 lines, a warm "Manus mobile" design system, no webfonts), `manifest.json`, `icon.svg`.

**What v2 does strictly better than v1:** runs are rows, not memory (a dropped browser costs nothing); every durable event is persisted before it is published, so reconnect replays exactly what was missed; "one mission at a time" is a unique index, not a hope; the budget claim is atomic; WhatsApp messages are idempotent by wamid and answered even if the process dies mid-task; auth is real, deny-by-default, and tested.

---

## 3. Verified by running it

```
npm install --include=dev --legacy-peer-deps  →  added 514 packages, 0 vulnerabilities
npm test                                      →  tests 112, suites 23, pass 112, fail 0  (~20 s)
npm run lint        (tsc --noEmit)            →  clean, exit 0
npm run build                                 →  exit 0
                                                   vite: 15 modules → dist/index.html 102.62 kB,
                                                         dist/assets/index-*.js 101.06 kB,
                                                         PWA precache 18 entries (356.72 KiB)
                                                   esbuild: dist/server.cjs 105.7 kB (+map)
npm run dev                                   →  [boot] Awais Codex v2
                                                   database: PGlite (dev/test); [migrate] applied 001_init
                                                   agent: antigravity-preview-09-2026
                                                   listening on http://0.0.0.0:3000
GET  /healthz                                 →  200 {"ok":true,"service":"awais-codex","version":2,...}
GET  /readyz                                  →  200 {"checks":{"database":"ok","poller":"disabled",...}}
GET  /api/status            (no session)      →  401 unauthorized
GET  /                        (no session)    →  200 text/html  ← the v2 login screen
POST /api/auth/login        (wrong key)       →  401 invalid_key
node dist/server.cjs        (bundled prod)    →  boots, finds web/ and migrations, 200 on /healthz and /
```

Full scripted mission through the real routes (`ENGINE=scripted AUTH_MODE=open PORT=3100`):

```
POST /api/runs {"prompt":"build me a calculator"}
  → 201 {"run":{…,"status":"queued"},"budget":{"bucket":"web","remaining":99,"limit":100}}

GET  /api/runs/:id/stream
  → : stream open
    id: 1  event: run.started
    id: 2  event: log                {"message":"Scripted engine start (14 steps)"}
    id: 3  event: thinking.snapshot  {"text":"Prompt is 21 characters. "}
           event: thinking.delta     {"chunk":"Reading the request …"}   ← no id: decoration only
    id: 5  event: tool.call          {"name":"read_project","args":{"path":"."}}
    id: 6  event: tool.result        {"name":"read_project","result":{"files":42,…}}
           event: text.delta         {"chunk":"This is the scripted engine.\n\n"}

GET  /api/runs/active  → {"run":{…,"status":"running"},"streaming":true}
GET  /api/budget       → {"buckets":[{"bucket":"web","used":1,"remaining":99},
                                     {"bucket":"whatsapp",…},{"bucket":"api",…}]}
GET  /api/status       → {"activeRuns":1,"engine":"scripted","agent":"antigravity-preview-09-2026",…}
```

Both external APIs were checked against current documentation, and both are real:

* The Interactions API with `agent: "antigravity-preview-09-2026"` (`environment: "remote"`, `agent_config.max_total_tokens`) is the current managed-agent surface — the older `antigravity-preview-05-2026` that v1 hard-coded has since been superseded, which is exactly why v2 made the id configurable.
* The WhatsApp **Agent Platform** (`api.whatsapp.com/agent/v1`, token from *Settings → Agents → Create an agent → Chat info → API key*) exists, with long-poll `get_updates`, `mark_read`, and a typing indicator that "dies after 25s" — matching `poller.ts` and `api.ts`. v2 has replaced v1's Meta Cloud webhook with this.

---

## 4. The plan (§8 of `ARCHITECTURE.md`), item by item

| # | Item | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **Real auth** over `/api/*`; make `verifyWhatsAppAdminSecret` enforce something | ✅ **Done** | `server/auth.ts` + `app.ts`: deny-by-default middleware, HMAC-signed year-long cookie, `?k=` claim-and-redirect, `x-access-key`, bearer. `PUBLIC_ROUTES` is the only hole. 15 tests (`auth.test.ts`), including "every /api route is 401 without a session" and "a wrong bearer token is rejected". In-code comment names v1's `req.path`-vs-`originalUrl` trap as *"exactly how v1's auth ended up decorative"*. The WhatsApp path is now token-authenticated by the platform, so `verifyWhatsAppAdminSecret` no longer exists |
| 2 | Mandatory webhook signature; rotate the default verify token | ⚠️ **Superseded, not resolved** | v2 has **no inbound webhook at all** — the Meta path is gone, so there is no HMAC to enforce. But the guessable `awais_codex_verify_token` still ships in `render.yaml`, and the v1 code that accepted it is still in `routes/whatsapp.ts` |
| 3 | **Delete the React stack** (or finish it) | ❌ **Not done — and now worse** | `react`, `react-dom`, `lucide-react`, `motion`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `autoprefixer` are still dependencies; `vite.config.ts` still registers the React and Tailwind plugins and VitePWA; `src/` still contains the empty `<div>`. And `npm run build` now compiles **v1's shell** into `dist/` (`dist/index.html` title: *"Awais Codex — Autonomous AI Assistant"*, loading `/assets/index-*.js` + `registerSW.js`) — **which nothing serves**, because `app.ts` serves `web/`. The v2 UI therefore ships unbundled, unminified, and with no service worker, while the build works on an app no user will ever see |
| 4 | **Add tests** for the tricky parts | ✅ **Done** | 112 tests / 23 suites / ~20 s, no network or credentials: the SSE parser and retry ladder (`engine/antigravity.test.ts`), the traversal-free run lifecycle, one-at-a-time under simultaneous requests, reconnect delivering only what was missed, per-channel budgets, the auth matrix, and a fake WhatsApp platform (`whatsapp.test.ts`) covering replay, 409, 429, unbreakable-text chunking |
| 5 | Encrypt/externalise secrets; add `/api/backup` | ◐ **Half done** | Encrypted-secret *plumbing* exists — `MASTER_KEY` is validated (64 hex) in `config.ts`, and `001_init.sql` creates `secrets` and `settings`. **But there is no crypto module, no settings API and no backup endpoint**, so `MASTER_KEY` is read and never used. `.env.example` promises "the web UI can also supply a key, which is stored encrypted" — that UI does not exist |
| 6 | Rename the APK generator honestly, or wire it in | ❌ **Not done** | v2 has **no artifact path whatsoever** (the `artifacts` table is created and unused; `engine/antigravity.ts` still *detects* `.apk/.zip/.tar` paths and logs "Artifact produced:" — nothing stores, serves or downloads them). `apk-generator.ts` is still committed with `SHA-256-Digest: placeholder`, and `README.md` still advertises a "Local APK Compiler & Packager" and a "signed APK packager" |
| 7 | One lockfile; add CI | ❌ **Not done** | `bun.lock` **and** `package-lock.json` are both committed; there is no `.github/` directory, so `npm test` and `npm run lint` — both of which pass — are never run automatically |

---

## 5. v1 capability inventory: what v2 had not rebuilt

> *As of the audit. Memory, artifacts and the installable PWA have since been rebuilt — see §8.*

`ARCHITECTURE.md` §1 lists five products bundled into the process. Measured against v2:

| v1 capability | v2 status | Where the hole is |
|---|---|---|
| Live agent chat, streaming thinking + tool cards | ✅ Rebuilt, better | `executor.ts` + `routes/runs.ts` + `web/app.js` |
| **Cross-session persistent memory** | ❌ **Missing** | `memories` + `memory_profile` tables exist in `001_init.sql`; no repository, no routes, nothing is injected into a prompt. Turn 1 of a new conversation and turn 50 are strangers to each other — only *within* a conversation is the sandbox resumed (`resolveContinuation`) |
| **Artifact dock, code viewer, downloads** | ❌ **Missing** | `artifacts` table only; no `/api/download-artifact`, no viewer, no APK/ZIP retrieval |
| **GitHub export** | ❌ **Missing** | `GITHUB_TOKEN` survives in `.env.example`; zero references in `server/` |
| **PWA install** | ◐ **Manifest only** | `web/manifest.json` is served, but there is **no service worker in the v2 client** (`grep -r serviceWorker web/` → nothing). VitePWA still generates `dist/sw.js` for the app nobody loads |
| **APK/ZIP packager** | ❌ **Removed** | Fine, given it produced placeholder digests — but the README still claims it |
| Meta Cloud webhook, OpenAI-compatible `/v1/*`, pairing-key tunnel | ⚠️ **Replaced** | Now the WhatsApp Agent Platform poller. `kind: 'api'` and the `'api'` budget bucket remain and are reachable via `POST /api/runs {kind:"api"}`, but the OpenAI-compatible endpoint it existed for is gone |
| Phone-visible progress | ✅ Rebuilt | `relay.ts`: acknowledgement, "still working (2m 10s) — running `gradle`" after 90 s, closing message, plus a plain-language note for quota/auth/agent failures |

---

## 6. Blockers before this can run as documented

> *All three are closed as of §8. Kept because the reasoning explains why `render.yaml`, dev auth and the build script look the way they do now.*

**1. `render.yaml` cannot boot v2.** It still sets only `NODE_ENV`, `GEMINI_API_KEY`, `WHATSAPP_VERIFY_TOKEN`, `GITHUB_TOKEN`. `config.ts` refuses to start in production without `DATABASE_URL`, `SESSION_SECRET` (≥32) and `MASTER_KEY` (`ACCESS_KEY` ≥12 too), so the deploy dies at boot:

```
Invalid environment configuration:
  - DATABASE_URL is required in production — Render's free disk is ephemeral …
  - SESSION_SECRET must be at least 32 characters in production
  - MASTER_KEY is required in production (encrypts stored API tokens)
  - ACCESS_KEY must be at least 12 characters in production — it is the only thing between
    the public internet and your daily run quota.
```

**2. Local development is locked out.** With `.env` absent, `AUTH_MODE` defaults to `key` and `ACCESS_KEY` is empty — and `checkAccessKey` returns `false` when the expected key is empty, so *nothing* opens the app:

```
GET /?k=anything                                    → 401
POST /api/auth/login {"key":"anything"}             → 401
GET /api/status  -H 'x-access-key: anything'        → 401
GET /api/status  -H 'authorization: Bearer <default session secret>' → 200   ← scripts only
```

`npm run dev` therefore serves the login screen and the login screen cannot be passed. (The same applies to any hosted preview of this branch.) Config validates the key only in production, so the failure is silent in dev.

**3. The build builds the wrong app.** `vite build` compiles v1 (`dist/index.html` = "Awais Codex — Autonomous AI Assistant", 102.62 kB + a 101 kB JS bundle + a PWA service worker), while the server serves the raw, unbundled `web/`. Either point Vite at `web/` (and register the SW) or drop Vite from the pipeline — right now the only consistently useful half of `npm run build` is the esbuild server bundle.

**4. WhatsApp replies are Markdown.** The model answers in `**bold**` and the relay forwards it verbatim; WhatsApp's own syntax is `*bold*`, and the platform's SDK documentation calls sending raw Markdown *"the single most common way agent replies look broken"*. v2 has no conversion step.

**5. The documentation describes v1.** `README.md` (project structure, `tsx server.ts`, "strict engine isolation", the APK packager) and `ARCHITECTURE.md` (the whole review) both describe the previous app. Nothing in the repository describes v2's topology — Neon, the run/event model, the poller, `AUTH_MODE`, `POLLER_ENABLED`.

**6. `main` and this branch share no history.** Any merge needs `--allow-unrelated-histories`; a PR would report the entire tree as new.

---

## 7. What I would do next, in order

> *Steps 1–4 were carried out (plus CI, dependency pruning and the README rewrite); the remaining items are named at the end of §8.*

1. **Unblock deployment and local use** (~30 min): add `DATABASE_URL`, `SESSION_SECRET`, `MASTER_KEY`, `ACCESS_KEY`, `POLLER_ENABLED` to `render.yaml`; treat an empty `ACCESS_KEY` in non-production as `AUTH_MODE=open` with a warning (or generate and print one at boot) so `npm run dev` is usable.
2. **Fix the build**: make `vite build` target `web/` (with the service worker registered) or remove Vite and serve `web/` as-is — do not leave a build that compiles an app nobody loads.
3. **Rebuild persistent memory on Postgres** (`memories`, `memory_profile`): repository + `/api/memory` + injection into the prompt when a run is created, for both channels. This is the single biggest feature gap and the one the product is named for.
4. **Wire artifacts end to end**: the engine already detects artifact paths — persist them into `artifacts`, add `GET /api/runs/:id/artifacts` and a download route, and show them in `web/app.js` (the v1 dock, rebuilt).
5. **Rebuild GitHub export** on top of (4), reusing v1's token-resolution and `PUT /contents` logic, which was already careful.
6. **Secrets, for real**: an AES-256-GCM module keyed by `MASTER_KEY`, a settings API writing `secrets`, and a Settings panel so the Gemini key no longer has to be an environment variable — which also makes the "web UI can supply a key" promise true.
7. **WhatsApp polish**: Markdown → WhatsApp formatting at the relay boundary; media upload/download (the client covers text/status only).
8. **Cleanup**: delete the React stack and the v1 tree (`src/`, `index.html`, `js/`, `routes/`, root `server.ts`, `memory-engine.ts`, `antigravity-client.ts`, `apk-generator.ts`, `call-budget-server.ts`, `types.ts`, `public/`, `metadata.json`, `generate-icons.js`) — check each against v2 before deleting; keep one lockfile; add `.github/workflows/ci.yml` running `npm run lint && npm test && npm run build`; rewrite `README.md` and `ARCHITECTURE.md` for v2.

---

## 7b. The second continuation pass — settings, secrets, and a live UI bug

Three things landed on top of §8, all verified in this document's style.

**1. Settings and secrets are real now.** `server/crypto.ts`, `server/settings.ts` and `server/routes/settings.ts`, mounted at `/api/settings` and behind the session like everything else under `/api`:

* Credentials are AES-256-GCM sealed with `MASTER_KEY`, with the secret's own name bound in as associated data — so the ciphertext of one credential cannot be pasted into another row and opened there (a test does exactly that and expects a failure).
* No endpoint returns a value: not on write, not in the list. What you get is whether it exists, where it came from (encrypted store vs environment), a timestamp and a 12-hex fingerprint so "did my paste take?" is answerable without ever shipping the key back to a browser. The test asserts against the raw response text, so a future field that leaks it fails too.
* A stored value **takes effect on the next request, not the next deploy**: the engine and the WhatsApp client read their credentials through a getter, so `PUT /api/settings/secrets/gemini_api_key` makes `/readyz` report `key present (stored)` on the running process.
* Two settings are honoured and both have a consumer: `dailyRunBudget` (read per mission by `accept.ts`, and by `/api/budget`, so what the UI shows and what the server enforces cannot disagree) and `antigravityAgent` (date-stamped, so it must be changeable without a redeploy). The store writes into the live `AppConfig` rather than keeping a second copy, which is why those two call sites needed no changes at all.
* Changing `MASTER_KEY` does not take the server down: unreadable rows are reported at boot, the environment values keep working, and the panel shows the credential as *cannot decrypt*. A dev boot with no `MASTER_KEY` refuses writes with `503 encryption_unavailable` and a hint, rather than encrypting with a placeholder key that is sitting in the repository.
* `config.masterKey` is now empty when unset instead of `'0'.repeat(64)`. A known fake key would have made writes *succeed* while storing a value anyone could read — the worst of both.

**2. A live bug in the browser app.** `web/app.js` called `loadMemory()` at two places and defined it nowhere. Since `enter()` awaited it, every line after it — resuming a task that was already running, reopening the last conversation — never executed, and because the boot handler catches the `ReferenceError` as "not signed in", **the app showed the sign-in screen instead of the app**. The memory panel's HTML and CSS had been built; nothing ever filled them in.

Fixed, and then guarded: `npm run lint:web` type-checks `web/app.js` and `web/sw.js` (`tsconfig.web.json`, `checkJs`), which reports `TS2304: Cannot find name 'loadMemory'` on the very next commit. Getting there meant fixing 42 real complaints in the browser app (untyped `$()`, a timer hung off a function object, three call sites passing fewer fields than `addStep` claimed to require). `server/web-app.test.ts` covers the rest: every `$('id')` exists in `index.html`, ids are unique, every referenced asset is served, every collapsible panel is bound to a renderer, and the UI's table of credential states matches the server's list exactly.

**3. The PWA cache version moved on** (`codex-v1` → `codex-v2`) so the installed app actually picks up the new markup instead of serving yesterday's shell forever.

### Verified

```
npm run lint       → server (tsc) clean + browser app (tsc, checkJs) clean
npm test           → 237 tests / 46 suites, 0 failures
npm run build      → dist/server.cjs 160.3 kB

# live, against the running preview with a MASTER_KEY set
PUT /api/settings/secrets/gemini_api_key {"value":"AIza…"}
  → 200 {secret:{source:"stored", fingerprint:"ea957e23b0b5"}} — the value is not in the response
GET /api/settings  → source "stored", fingerprint, updatedAt
PUT /api/settings/dailyRunBudget {"value":25}
  → GET /api/budget limit 100 → 25 with no restart
  → the next mission: {"bucket":"web","remaining":24,"limit":25}
```

Known limitation, unchanged: with no `DATABASE_URL`, dev storage is in-memory PGlite, so settings, secrets, memories and runs do not survive a restart — including the stored credentials. Persistence is covered by the store-level test (a second store decrypts what the first wrote) and by anything running against real Postgres.

---

## 7c. The third pass — connecting WhatsApp for real, and where the app stands

### The platform this talks to, confirmed

The phone channel is the **WhatsApp Agent Platform** (`api.whatsapp.com/agent/v1`), which is the
API behind the *third-party agents* feature WhatsApp started rolling out on 4 September 2026
(Android beta 2.26.35.3; terms updated 25 August 2026). It is not the old Business/webhook API:

* The user creates the agent **inside WhatsApp** (Settings → Agents → Create an agent, name and
  avatar, up to five), and WhatsApp **generates the API key** that the hosting service uses.
* An agent can only message the account that created it — there is no way to message an
  arbitrary number, which is why our replies go back to the inbound message's `from`.
* Transport is a **long poll we make** (`get_updates` with an offset), not a webhook Meta posts
  to us. Sends, read receipts and typing are the other side of it.
* One-to-one chats only; agent chats are **not** end-to-end encrypted, and the rollout is still
  limited by country and account.

Our client already matched that shape (endpoint, `Bearer` token, long poll with offsets, no
retry on send, typing that expires after 25s, per-endpoint rate discipline). What it did *not*
match was the setup story: the poller was built once at boot and only if `WHATSAPP_TOKEN`
happened to be in the environment, and `POLLER_ENABLED` defaulted to false. So "paste the API
key WhatsApp gave you" — the entire setup the feature asks for — did nothing until the next
deploy. **Fixed in this pass:**

* `server/whatsapp/lifecycle.ts` owns the connection: `poll ⇔ POLLER_ENABLED is not false AND a
  token exists`. It is the only place that starts or stops the loop, it serialises overlapping
  credential changes, and it stops the old loop *before* a new one could exist (a second poller
  on one agent is a 409 from the platform, i.e. a connection nobody can take over).
* `POLLER_ENABLED` is now opt-out: unset means "poll whenever a token exists"; `false` remains
  the hard stop for the second host; `true` means a token must be reachable at boot, and is
  still the silent-spin error when nothing could ever supply one.
* `PUT /api/settings/secrets/whatsapp_token` returns the resulting connection state, so the
  panel can say *connected* — or name the platform's error (a wrong key connects, fails the
  first poll, and is reported as `state: 'error'` with `lastError`, rather than a 500 that hides
  both). Removing the key stops the poll immediately.
* The Settings panel shows the connection, and `/readyz` reports `poller: running`.

**14 new tests** drive this through the real HTTP surface against a fake platform: the key
starts the poll and real requests arrive with `Bearer <token>`; removal leaves nothing polling;
a wrong key is stored and reported as an error; `POLLER_ENABLED=false` stores the key but keeps
this host quiet; an environment token takes over again when the stored one is deleted.

### How complete is it

| Area | Built | What is missing |
|---|---|---|
| Mission loop — real engine, SSE, durable replay, cancel, retry ladder, idle watchdog | **100%** | Nothing in the code. **No mission has run against a live `GEMINI_API_KEY`** — every test uses a fake server |
| Storage — Postgres/PGlite, migrations, orphan recovery, retention | **100%** | |
| Auth — `?k=` link, session, bearer, open mode, dev fallback | **100%** | |
| Budget — per-channel, database-enforced, live-configurable | **100%** | |
| Memory — extraction, recall, profile, API, prompt injection | **100%** | |
| Artifacts — record, lazy fetch, download, cache, prune | **95%** | Uploading a file *into* a run; deleting from the UI |
| Settings & secrets — live config, AES-256-GCM store | **95%** | Only the settings and credentials something actually reads |
| WhatsApp — connect, poll, relay, format, commands | **90%** | **Media both ways**: no photo in, no APK back to the phone |
| PWA, CI, Render, health, docs | **100%** | |
| GitHub export | **0%** | v1 had token handling and a repo list; v2 never ported it |
| Legacy v1 tree | not removed | Kept as reference; git history preserves it either way |

**Overall ≈ 90%** of what v1 promised, plus the entire §8 plan except GitHub export. Ranked by
what a user would feel: (1) WhatsApp media, (2) live agent verification with a real key,
(3) GitHub export, (4) deleting the v1 tree.

---

## 8. What has since been done (continuation pass)

Everything in §6's blocker list and the first four items of §7 are addressed. The suite went from **112 to 193 tests**, all passing; `npm run lint` is clean and `npm run build` produces a server bundle that boots.

| Was | Now |
|---|---|
| **Block 1 — `render.yaml` could not boot v2** | The blueprint carries the whole environment: `DATABASE_URL`, `SESSION_SECRET` (generated), `ACCESS_KEY` (generated), `MASTER_KEY`, `GEMINI_API_KEY`, `ENGINE`, `ANTIGRAVITY_AGENT`, budget/retention values and the optional WhatsApp pair, plus `healthCheckPath: /healthz` and `npm ci --include=dev` |
| **Block 2 — local dev was locked out** | With no `ACCESS_KEY`, a development run now starts **open with a loud warning** instead of serving a sign-in screen nobody can pass. Asking for `AUTH_MODE=key` explicitly without a key is a boot error; production still requires a ≥12-character key |
| **Block 3 — the build built the wrong app** | Vite, VitePWA, React, Tailwind, `lucide-react`, `motion`, `src/`, `vite.config.ts` and v1's `server.ts` are gone; `npm run build` now bundles only `dist/server.cjs` (140 kB) and the client ships as `web/` with a hand-written service worker |
| **No persistent memory** | `server/memory.ts` + `server/routes/memory.ts`: profile and memories on the Postgres tables that were already waiting, lexical recall with category bias, explicit-declaration extraction from the operator's own words, recall injected into every prompt by the executor and recorded as a durable `memory.recall` event. **27 tests**, plus 6 proving the wiring end to end |
| **No artifacts** | `server/artifacts.ts` + `server/routes/artifacts.ts`: the engine's artifact paths become rows and durable `artifact` events, and `GET /api/artifacts/:id/download` collects the file from the sandbox snapshot on first request (streamed to disk, extracted with system `tar`, cached, hashed) or explains honestly why it cannot. **16 tests + 5 route/wiring tests** |
| **WhatsApp replies were raw Markdown** | `server/whatsapp/format.ts` converts to WhatsApp's syntax at the relay boundary: bold, italic, strikethrough, code fences, links, tables, headings. **21 tests** |
| **Dead React stack / two lockfiles / no CI** | One lockfile (`package-lock.json`, regenerated — 114 packages instead of 514), `.npmrc` removed (no more `--legacy-peer-deps`), `.github/workflows/ci.yml` runs install → type-check → 193 tests → build → **boot the bundle and hit `/healthz`** |
| **The PWA was a manifest with no worker** | Real `web/sw.js`: network-first while online, shell + last answer offline, `/api/*` never cached, versioned caches, served with `no-store` + `Service-Worker-Allowed: /` |
| **Docs described v1** | `README.md` rewritten for v2 (architecture, API, WhatsApp setup, deployment, security notes, legacy map); `.env.example` and the boot log updated |
| **Dead config fields** | `ARTIFACT_RETENTION_DAYS` now prunes artifacts and their cached bytes at boot; `APP_URL` prints a real clickable `?k=` link at boot |

Also settled: **the branch is on GitHub** ([PR #1](https://github.com/awaisali24443-svg/Awais-Codex-agent-/pull/1), 10 commits ahead of `main`, CI green), the PWA icons are generated from `web/icon.svg` by `scripts/make-icons.mjs` instead of hand-copied, and **`apk-generator.ts` no longer lies**. It used to write `SHA-256-Digest: placeholder` into `META-INF/MANIFEST.MF` of an APK it called "signed"; it now computes each entry's real base64 SHA-256, and the doc comment states plainly that there is no signature block so Android will refuse to install it. Verified by unzipping the output: both digests match the entries, `unzip -t` is clean, no `placeholder` text remains. Nothing calls it — it is kept as v1 reference, not as a build path.

Still open, deliberately: WhatsApp media (the platform can send and receive it; this build is text-only), GitHub export (v1 had it, v2 never rebuilt it), and deleting the legacy v1 tree rather than documenting it.

### Verified after the continuation pass

```
npm ci --include=dev          → 114 packages, 0 vulnerabilities (no --legacy-peer-deps)
npm run lint                  → tsc --noEmit, clean
npm test                      → 193 tests / 40 suites, pass 193, fail 0  (~31 s)
npm run build                 → dist/server.cjs 140.8 kB (+map) — the only artefact now
node dist/server.cjs          → boots; /healthz 200, /readyz 200
GET /sw.js                    → Content-Type: application/javascript + Service-Worker-Allowed: /
GET /manifest.json            → application/manifest+json

# a real mission, live
POST /api/runs {"prompt":"my name is Awais and remember that: deploys go through Render"}
  → learned: profile.name "Awais", [INSTRUCTION] "deploys go through Render"
POST /api/runs {"prompt":"how should I deploy this"}
  → event memory.recall {"recalled":1,"profileFields":["name"]}
  → run.prompt stayed "how should I deploy this" — memory is added on the wire only
GET /api/runs/:id/artifacts   → [] (nothing built yet) · download 404s with an explanation
```

*(This table replaces the "if I were continuing" section below as a record of intent; the verification log that follows is from the original audit and is left as it was.)*

---

## 9. Verification log

```bash
# install / static checks
npm install --include=dev --legacy-peer-deps      # 514 packages, 0 vulnerabilities
npm test                                          # 112 pass / 0 fail / 23 suites / ~20 s
npm run lint                                      # tsc --noEmit, clean
npm run build                                     # exit 0 (see §3 for sizes)

# runtime, dev entry point
npm run dev                                       # boots on 0.0.0.0:3000, PGlite, migration 001 applied
curl -i localhost:3000/healthz                    # 200 {ok:true, version:2}
curl -s localhost:3000/readyz                     # 200 {checks:{database:ok, poller:disabled}}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/status        # 401
curl -s -X POST localhost:3000/api/auth/login -d '{"key":"anything"}'     # 401 invalid_key
curl -s localhost:3000/                           # 200 — the v2 login screen

# full mission on the scripted engine (no quota spent)
ENGINE=scripted AUTH_MODE=open PORT=3100 npx tsx server/main.ts
curl -sX POST localhost:3100/api/runs -d '{"prompt":"build me a calculator"}'      # 201, remaining 99
curl -sN    localhost:3100/api/runs/<id>/stream                                    # numbered replay + deltas
curl -s     localhost:3100/api/runs/active                                         # streaming:true
curl -s     localhost:3100/api/budget                                              # per-channel counters

# production artefact
PORT=3200 AUTH_MODE=open node dist/server.cjs     # boots; finds web/ and server/migrations; 200s

# configuration behaviour
NODE_ENV=production GEMINI_API_KEY=x npx tsx -e '…loadConfig()'   # ConfigError, 4 problems listed

# repository shape
git rev-list --parents -1 <sha>                   # both commits are root commits
git merge-base main HEAD                          # no merge base
git diff --name-status main..HEAD | sort | uniq -c # 41 A, 4 M
```
