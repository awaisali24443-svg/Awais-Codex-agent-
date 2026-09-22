# Awais Codex Agent — Architecture & Code Review

> **This document reviews v1** — the original single-process app (`server.ts`, `routes/`, `js/`, file-based storage). It is kept because its analysis of the engine protocol, the retry ladder, the WhatsApp webhook and the security gaps is still accurate and still useful.
>
> **The app that runs today is v2** (`server/`, `web/`, Postgres, `npm run dev`). `README.md` documents it, `STATUS.md` maps it file by file and tracks which of this review's recommendations have since been implemented. The v1 sources referenced below are still in the tree as legacy: nothing imports them, and nothing serves them.

*Full read-through of every source file (8,080 lines of TS/JS + a 3,831-line HTML shell), verified by actually installing deps, type-checking, booting the server, and hitting its endpoints.*

---

## 1. What this project actually is

**Purpose:** a **single-user, self-hosted "Manus-style" autonomous AI engineering workspace**, plus a **WhatsApp front-end onto the same agent**.

It is not a framework or a library — it's a personal product. You type a task ("build me a calculator app and give me the APK"), the server forwards it to **Google's Antigravity managed agent** (`antigravity-preview-05-2026`) running inside a **remote Google Linux sandbox**, streams the agent's reasoning/tool-calls back to the browser over SSE, shows live "mission" cards, then lets you inspect the generated code, download artifacts/APKs, push the result to a new GitHub repo, or keep working by text message from WhatsApp.

Concretely it bundles five products into one Express process:

| Capability | Where |
|---|---|
| Live agent chat with streaming thinking + tool cards | `js/queue.js`, `js/execution-cards.js`, `routes/tasks.ts` |
| Cross-session persistent memory ("remembers you") | `memory-engine.ts`, `routes/memory.ts` |
| WhatsApp bot (Meta Cloud webhook **and** pairing-key tunnel) | `routes/whatsapp.ts` |
| GitHub export of generated code | `routes/github.ts` |
| PWA install + local APK/ZIP packager | `public/`, `apk-generator.ts`, `js/artifacts.js` |

**The core dependency is real.** I verified against current Google docs: the Interactions API (`POST https://generativelanguage.googleapis.com/v1beta/interactions`) does expose a managed agent with the ID `antigravity-preview-05-2026` (default underlying model: Gemini 3.8 Flash, `environment: "remote"` provisions a Linux sandbox, supports SSE streaming, background execution, `previous_interaction_id` session reuse, and `GET/DELETE .../environments`). So `config.ts` + `antigravity-client.ts` are wired to a genuine API surface, not a hallucinated one.

### Verified by running it

```
npm install                     → 498 packages, no errors
npx tsc --noEmit (npm run lint) → clean, exit 0
npm run dev (tsx server.ts)     → "Awais Codex server running on http://0.0.0.0:3000"
GET /api/health                 → 200 {"status":"ok","defaultEngine":"antigravity-preview-05-2026",...}
GET /api/memory                 → 200 (profile pre-seeded: "Awais Ali")
GET /api/whatsapp               → 200 gateway info, v1.4.0, verifyToken "Awais Codex"
```

---

## 2. High-level architecture

```
┌──────────────────────────── BROWSER (SPA, no framework) ────────────────────────────┐
│ index.html  (3,831 lines: all markup + ~2,800 lines of hand-written CSS + IDs)       │
│ js/main.js  ← bootstrap, settings, theme, files, modals, PWA, WhatsApp polling       │
│   ├── state.js (state + DOM refs + localStorage persistence)                        │
│   ├── queue.js (SSE client, task queue, retry ladder, polling fallback)              │
│   ├── execution-cards.js / thinking-panel.js (render turns, steps, thoughts)         │
│   ├── artifacts.js (artifact dock, code viewer, split view, downloads)               │
│   ├── sidebar.js / memory.js / github.js / call-budget.js / api.js (helpers)         │
└───────────────────────────────────────┬──────────────────────────────────────────────┘
              fetch /api/*  +  SSE (text/event-stream)         localStorage: API key,
                                        │                      theme, projects, PAT
┌───────────────────────────────────────▼──────────────────────────────────────────────┐
│ server.ts  — Express 4 + Vite middleware (dev) / static dist (prod), listens 0.0.0.0 │
│  /api/health · /api/stream-task(SSE) · /api/execute-task · /api/poll-task/:id        │
│  /api/call-budget · /api/download-artifact · /api/memory/* · /api/github/*           │
│  /api/whatsapp/* · /whatsapp · /webhook · /api/webhook · /v1/*  (OpenAI-compatible)  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ antigravity-client.ts    retry + env-fallback + SSE consumer                          │
│ memory-engine.ts         JSON store, mutex, keyword recall, regex auto-extraction     │
│ call-budget-server.ts    daily website/whatsapp counters                              │
│ apk-generator.ts         hand-rolled ZIP writer + CRC32 ("APK")                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ data/  agent-memory.json · call-budget.json · whatsapp-conversations.json             │
│        whatsapp-agent-keys.json · whatsapp-config.json   (all gitignored, plaintext)  │
└───────────────────────────────────────┬──────────────────────────────────────────────┘
                                        │ HTTPS
                          Google Generative Language API
                    POST /v1beta/interactions   (agent: antigravity-preview-05-2026)
                    GET/DELETE /v1beta/environments
                    GET /v1beta/files/environment-<id>:download   (tarball snapshot)
                                        │
                     Meta Graph API  graph.facebook.com/v21.0/<phoneId>/messages
                     GitHub REST API api.github.com (repo create + contents PUT)
```

---

## 3. Line-by-line file walkthrough

### 3.1 Config & build plumbing

**`config.ts` (8 lines)** — loads `.env` via dotenv, exports `PORT` (default 3000), `API_ENDPOINT` (`/v1beta/interactions`), `ENV_ENDPOINT` (`/v1beta/environments`), and the hard-coded engine ID + label. Deliberately a one-engine product: `DEFAULT_ENGINE = 'antigravity-preview-05-2026'`.

**`package.json`** — `"type": "module"`. Scripts: `dev` = `tsx server.ts` (no nodemon; Vite handles client HMR), `build` = `vite build` **+** `esbuild server.ts --bundle --platform=node --format=cjs --packages=external --outfile=dist/server.cjs`, `start` = `node dist/server.cjs`, `lint` = `tsc --noEmit`. Note the split personality: the server is bundled to **CJS** while the source is ESM-with-`.js`-extension imports.

**`tsconfig.json`** — `moduleResolution: bundler`, `allowImportingTsExtensions`, `noEmit`, `paths: {"@/*": ["./*"]}`. Because it is `noEmit` and bundler-resolved, `import ... from './config.js'` in `.ts` files is correct and type-checks (verified).

**`vite.config.ts` (104 lines)** — four plugins: React, Tailwind v4, and `VitePWA` (autoUpdate SW, manifest with 192/512/maskable icons, CacheFirst runtime caching for Google Fonts, `devOptions.enabled: true` so the SW also runs in dev). `server.hmr` is disabled when `DISABLE_HMR=true` — a concession to hosted/iframe previews.

**`render.yaml`** — one free-tier Node web service; `npm install --include=dev --legacy-peer-deps && npm run build`; secrets (`GEMINI_API_KEY`, `GITHUB_TOKEN`) marked `sync: false`.

**`metadata.json` / `.npmrc` / `.gitignore`** — AI-Studio-style capability declaration; `legacy-peer-deps=true` + `include=dev` (needed because the build uses devDeps); `data/*.json` ignored except the example store, `.env*` ignored except `.env.example`.

**Both `package-lock.json` and `bun.lock` are committed** — Bun and npm lockfiles coexist (a portability smell rather than a bug).

### 3.2 `server.ts` (92 lines) — the composition root

- Lines 15–23: if any `HTTP(S)_PROXY` env var exists, install a global undici `EnvHttpProxyAgent` so outbound `fetch` works in proxied environments. Good defensive touch for sandboxes.
- Lines 27–33: `express.json({ limit: '50mb' })` with a `verify` hook that stores `req.rawBody` — required later for **HMAC webhook signature validation**.
- Lines 36–47: route mounting. Notably the WhatsApp router is mounted on **five** prefixes (`/api/whatsapp`, `/whatsapp`, `/webhook`, `/api/webhook`, `/v1`) so it can impersonate Meta's webhook URL *and* an OpenAI-compatible endpoint.
- Lines 56–82: `dist/` static + SPA catch-all in production; otherwise Vite in `middlewareMode` with `appType: 'spa'`, and a fallback that serves the repo root statically if Vite fails to initialise.
- Line 84: binds `0.0.0.0` — correct for container/preview hosting.

### 3.3 `antigravity-client.ts` (230 lines) — the engine adapter

- `getApiKey(req)`: header `x-gemini-api-key` (per-user browser key) **falls back to** `process.env.GEMINI_API_KEY`. This is the "bring your own key or use the server's" pattern.
- `cleanupOldEnvironments(apiKey, maxToKeep)`: lists `v1beta/environments`, sorts by `created`, DELETEs the oldest beyond `maxToKeep`. This exists purely to work around the **remote-sandbox storage quota** on free keys.
- `extractOutputTextFromSteps(steps)`: defensive text scavenger — model output can arrive as `content[]` of strings, `content.text`, or `text`; the agent's final answer is reassembled from `type === 'model_output'` steps when `output_text` is absent.
- `callAntigravityWithRetry()` — the resilience ladder, three attempts max:
  1. POST the payload with `x-goog-api-key`.
  2. On **400/404** (stale/expired sandbox) → rewrite `environment = 'remote'`, **drop `previous_interaction_id`** (because the interaction history lived in the dead env), retry.
  3. On **429** whose message mentions `storage quota`/`environment` → delete old environments down to 1, reset to `remote`, retry.
- `consumeAntigravityStream()` — a complete SSE parser used by the WhatsApp path: buffers by `\r?\n\r?\n`, splits `event:`/`data:` lines, joins multi-line data, skips `:` comments and `[DONE]`, then extracts *interaction id*, *step summaries*, *tool-call names* (mapping `create_file`/`edit_file`/`run_command` to human milestones like "Generating code and assets...") and any **artifact paths** (`*.apk`, `*.zip`, `*.tar`) from tool arguments. Returns `{finalOutputText, completedInteractionId, generatedArtifacts, stepsCount, lastMilestone}`.

### 3.4 `routes/tasks.ts` (687 lines) — web task pipeline

- `normalizeMissionActivity()` (lines 29–116): converts raw agent steps into UI-friendly "phases" — `planning | scaffolding | implementation | build | verification | general` — by pattern-matching tool names and shell commands (`/gradle|mvn|build|cargo|cmake|assemble/` → build; `/test|pytest|jest|check/` → verification; `/npm i|pip install|apt|yarn add/` → scaffolding). This is what draws the mission cards.
- `buildContextualPrompt()` (lines 123–148): **only** injects prior dialogue when there is *no* `previous_interaction_id` — when the server-side interaction is alive, conversation state is native and history injection is skipped to save tokens. History is a labelled `### CONVERSATION MEMORY` block with assistant turns truncated at 1,200 chars, ending in an explicit "maintain continuity" instruction.
- `GET /api/call-budget` — returns today's counters (no auth).
- `GET /api/download-artifact` (lines 157–286) — layered artifact retrieval:
  1. **Local disk**: rejects `..`/NUL, rejects `/etc/`, `/proc/`, `/sys/`, `/root/`, `/var/`, `/home/`, `.env*`, `.git`, `.npmrc`, `whatsapp-config.json`, `whatsapp-agent-keys.json`; then requires the resolved path to sit inside `process.cwd()` or `os.tmpdir()`; then re-blocks files named `.env*`, `.npmrc`, `*secret*`, `*keys.json*`. (A genuinely careful traversal guard.)
  2. **Remote sandbox**: downloads `files/environment-<id>:download`, and if a specific file is requested, extracts the tarball with `tar -xf` into a temp dir and recursively searches for the basename.
  3. Otherwise **404 with an honest message** — it refuses to fabricate a file that was never built.
- `POST|GET /api/stream-task` (lines 289–530) — the heart of the app:
  - Builds the prompt: within-session history → **cross-session memory block** (`injectMemoryIntoPrompt`).
  - Attachments become multimodal `parts[]` typed `image|video|audio|file` from MIME prefix.
  - Sets SSE headers incl. `X-Accel-Buffering: no` (proxy-friendly) and a **15-second idle keep-alive comment** emitted by a 5s interval.
  - Aborts the upstream request on client disconnect (`res.on('close')` → `abortController.abort()`).
  - **Re-emits** upstream events, but first: normalises thought events into `event: thought`, infers a type when the stream is untyped (`interaction.completed` / `interaction.created` / `step.delta` / `step.start`), accumulates `delta.text`, backfills `interaction.output_text` from steps, and attaches `normalized_activity` to each event.
  - On `interaction.completed` it **fires-and-forgets** `extractAndStoreMemories(...)` — this is how the agent learns about you as a side effect of normal use.
  - Maps HTTP status → typed errors (`quota_exceeded`, `auth_failed`, `agent_unavailable`, `unknown_error`).
- `POST /api/execute-task` (532–631) — the non-streaming twin: `background: true` server-side job; same prompt augmentation; returns the raw interaction JSON.
- `GET /api/poll-task/:id` (634–685) — status polling for background jobs, with the same error taxonomy and `extractOutputTextFromSteps` backfill.

### 3.5 `memory-engine.ts` (427 lines) — the "remembers you" system

- Types: `MemoryItem {category: preference|fact|project|instruction|learning, key?, content, source: web|whatsapp|manual|auto_extracted, tags[], accessCount, lastRecalledAt}` and `UserProfileMemory {name, role, preferredLanguage, preferredFrameworks[], environment, customDirectives[], attributes}`.
- **Default store is pre-seeded with the author's identity** — name `Awais Ali`, role "Software Engineer & Project Architect", frameworks React/Node/Tailwind/Express — plus a core directive memory. First boot writes this to `data/agent-memory.json`.
- **Concurrency:** a hand-rolled promise-chain mutex (`withMemoryLock`) serialises all read-modify-write cycles, because the store is a single JSON file. Without it, two simultaneous WhatsApp messages would clobber each other.
- **Durability:** `saveMemoryStore` writes to a `.tmp.<ts>` file, `unlinkSync`s the target (a Windows file-locking safeguard), then `renameSync`s — the documented "atomic write" claim.
- **CRUD:** `addMemoryItem` de-duplicates by `key` or identical content and *merges* tags instead of appending a duplicate; `updateMemoryItem`, `deleteMemoryItem`, `updateUserProfile`, `clearAllMemories` round out the set.
- **Recall is lexical, not semantic:** `scoreRelevance` tokenises the prompt and scores +3 for a content substring hit, +4 for a key hit, +5 for a tag hit, plus category bias (`instruction` +2, `preference` +1.5). Top-N are returned and their `accessCount`/`lastRecalledAt` are bumped asynchronously. No embeddings, no vector DB — deterministic and dependency-free, but blind to synonyms.
- **`formatMemoryContextBlock()`** renders profile + recalled memories into a delimited `### [PERSISTENT MEMORY SYSTEM ...]` prompt block, with an instruction telling the model to use it naturally. `injectMemoryIntoPrompt()` prepends it to every task.
- **`extractAndStoreMemories()`** is regex-based extraction on the *user's* message: `my name is|call me X` → profile name + memory; `remember that: ...` / `note that:` → instruction memory; `I prefer|always use|I like using X` → preference memory. Cheap, offline, and deliberately conservative (explicit declarations only) to avoid false positives. *(The function accepts `apiKey` and `outputText` but does not use a model for extraction — the "autonomous extractor" is pure pattern matching.)*

### 3.6 `call-budget-server.ts` (63 lines) + `js/call-budget.js`

Daily counters (`websiteCount`, `whatsappCount`) keyed by local `YYYY-MM-DD`, persisted to `data/call-budget.json`; the day rolls over implicitly because a record with a stale date is ignored. Incremented on each successful stream/execute/WhatsApp run. The header chip renders `${count}/100 today`.

### 3.7 `routes/memory.ts` (113 lines)

Plain REST over the engine: `GET /` (store + profile), `POST /` (manual add, category validated against the 5 legal values, defaults to `fact`), `PUT /:id`, `DELETE /:id`, `PUT /profile/update`, `POST /clear`, `POST /search` (prompt → scored memories). No auth (see §6).

### 3.8 `routes/github.ts` (325 lines) — code export

- `getFilesRecursively()` skips `.git`, `node_modules`, `dist`, `.tmp`, `data/`, and any `*.tar|zip|apk`, and ignores files ≥5 MB.
- `resolveGitHubToken()` resolution order: explicit arg → `req.body.token|githubToken` → `x-github-token`/`Authorization: Bearer` → `GITHUB_TOKEN | GITHUB_PAT | GH_TOKEN | GITHUB_PERSONAL_ACCESS_TOKEN | GITHUB_API_KEY`.
- `resolveGitHubOwner()` calls `/user`, falling back to the owner of the most recent repo (a workaround for fine-grained PATs, which often can't read `/user`).
- `GET /api/github/status` — reports `connected`, `username`, and **classifies the token** (`github_pat_` → fine-grained, `ghp_` → classic).
- `POST /api/github/repos` — lists 30 recently-updated repos.
- `POST /api/github/export-repo` — creates the repo (falling back to an existing one if creation 422s), then gathers files from **(a)** the remote environment tarball (download + extract + walk) or **(b)** an explicit `files[]`; if nothing was found it still writes a README so the repo isn't empty. Then it pushes **one `PUT /contents/...` per file**, first `GET`ing the existing blob SHA so updates don't 409. `AbortSignal.timeout(15000)` per call. Returns `{repoUrl, pushedFilesCount}`.

### 3.9 `routes/static.ts` (32 lines)

Serves `sw.js` with `Content-Type: application/javascript` + `Service-Worker-Allowed: /` + `no-store`, and `manifest.json` as `application/manifest+json`. Needed because the SPA catch-all would otherwise mis-serve both.

### 3.10 `routes/whatsapp.ts` (1,388 lines) — the biggest file, and the most interesting

**Storage:** four JSON files in `data/` (conversations, agent pairing keys, gateway config) guarded by their own promise-chain mutex (`withConversationLock`).

**Two independent transports:**

1. **`WhatsAppAgent` class** — a WebSocket "agent tunnel": connects to `WHATSAPP_WS_URL` with `?key=<pairingKey>&name=<name>`, sends a `handshake` frame, answers inbound frames (`handleIncomingEvent` → `executeTask` → `reply` frame with text + artifacts). It has exponential backoff `min(300s, 2^n × 10s)` with a 60s floor on DNS failures, manual-disconnect that suppresses reconnects, and per-agent state (`status`, `connectedAt`, `messagesProcessed`, `lastError`). **If `WHATSAPP_WS_URL` is unset it simply marks itself `online` without connecting** — "local agent tunnel mode", i.e. a stub that makes the UI look paired while nothing is actually dialled out.
2. **Meta Cloud API** (`handleIncomingMessage`, mounted on six paths) — a deliberately **shape-agnostic webhook**: it parses Meta's `entry[0].changes[0].value.messages[0]`, Messenger-style `entry[0].messaging[0]`, OpenAI-style `messages[]`, Twilio (`Body`/`From`), 360dialog, Gupshup, Baileys (`data.message.conversation`), plus generic `message|prompt|text|query|input|content|msg|body|question` in body *or* query string. `GET /` handles Meta's `hub.mode=subscribe` handshake against a token allowlist that includes the literal `"Awais Codex"` and `awais_codex_verify_token`. It also auto-learns the sending `phone_number_id` and the API key from `Authorization`/`x-agent-key` headers.
   - Meta webhooks get an **immediate 200** (Instagram/Meta retry semantics) while the real work runs detached — the user gets a "Task Received" WhatsApp message, then **milestone broadcasts every 10 seconds** via a `setInterval` progress timer.
   - Outbound `sendWhatsAppMessage()` chunks long replies at 3,800 chars, splitting preferentially on `\n\n`, then `\n`, then the literal `\n` string, else hard-cutting.
   - Openness is explicit in code: `verifyWhatsAppAdminSecret()` **returns `true` unconditionally** and the router middleware is a no-op `next()`.
   - Extras: agent pairing CRUD (`/pair`, `/agents`, `DELETE /pair/:key`), persisted config get/post, a rolling 50-entry in-memory **webhook log** (`/logs`), and `/test-inbound` + `/test-send` harnesses.
3. **`executeTask()`** — shared by both transports and by `/v1/chat/completions`: greeting fast-path (regex on `hi|salam|aoa|ping...` under 30 chars) answered instantly without spending a model call; pulls the **last 6 successful turns** of that WhatsApp conversation into a `### WHATSAPP CHAT MEMORY` block; adds cross-session memory; streams from Antigravity; sends 10s progress updates with live phase + step count; then records the completed turn and replies with the final text + artifact list.

### 3.11 `apk-generator.ts` (124 lines)

A dependency-free ZIP writer: CRC-32 table (IEEE 802.3, polynomial `0xedb88320`), local file headers + central directory + EOCD, storing `AndroidManifest.xml`, a 32-byte `classes.dex` header, and `META-INF/MANIFEST.MF`. **Be clear about what this is:** the output is a structurally valid *ZIP* containing a **stub** DEX and a manifest whose `SHA-256-Digest` values are literally the string `placeholder`. It is not a compiled, signed, installable APK and has no code in it. It is a packaging demo / fallback, not a toolchain (and it is not wired into the routes — the real APK path is "the agent runs Gradle in the remote sandbox, then `/api/download-artifact` fetches the tarball").

### 3.12 Client — `index.html` + 11 ES modules (vanilla, no framework)

- **`index.html` (3,831 lines)**: an early script that *silences* `[vite]`/websocket console noise (for iframe embeds), full meta/PWA/apple tags, a ~2,800-line hand-written CSS design system using CSS custom properties with a dark/light `data-theme` switch, then all markup: sidebar (search, history, nav tabs, artifact badge, install/split/download/memory/settings), workspace (topbar with engine pill + call-budget chip + queue badge), chat area with welcome hero and quick-prompt cards, artifact dock (code/preview/logs tabs), and modals for settings, install, memory, downloads, image lightbox, plus **custom confirm and toast components** replacing the native `confirm()`/`alert()` dialogs (iframe-safe).
- **`js/state.js` (256)** — `STORAGE_KEYS` (`awais_codex_api_key`, theme, poll rate, projects, engine, active session) and a central `state` object (projects, activeTask, taskQueue, abortController, attachedFiles, dock flags) + a giant `initEl()` that caches ~150 DOM nodes by ID, `escapeHtml`, `formatFileSize`, project normalisation/serialisation.
- **`js/queue.js` (838)** — the client brain: `handlePromptSubmission` (validation, queue-if-busy), `executeTurn` (POST `/api/stream-task`, reads the SSE stream with the same block parser as the server, dispatches to renderers), a **retry ladder** (`quota_exceeded` → pause 60s and requeue; `daily_quota_exhausted` → fail fast; stream failure with a known `interactionId` → switch to `startPolling`; otherwise → `executeTurnViaBackendTask` on `/api/execute-task`), `finishTurn`/`failTurn`, `processNextInQueue`, `cancelTask`, `retryTask`.
- **`js/execution-cards.js` (636)** — turns a task into a card: phase/role detection (`detectStepRole`), step content formatting, `detectApkInfo`, and a real Markdown renderer (`formatMarkdownOutput` + `formatInlineMarkdown`) that converts fenced code blocks into **clickable artifact chips** which open the dock.
- **`js/thinking-panel.js` (150)** — live reasoning stream with an elapsed-time timer and collapsible thought list.
- **`js/artifacts.js` (445)** — `extractArtifactsFromProject` (harvests code blocks, file paths, APK mentions from steps/output), the dock viewer, sandbox log view, split-screen mode, lightbox, download modal, and `downloadWorkspaceArchive` → `/api/download-artifact`.
- **`js/sidebar.js` (215)**, **`js/memory.js` (298)**, **`js/github.js` (114)**, **`js/api.js` (46)**, **`js/call-budget.js` (57)** — history CRUD/search/rename, memory modal + profile editor, GitHub PAT management and export UI, error classification, and budget polling.
- **`src/` is dead code.** `src/App.tsx` returns `<div></div>`, `src/main.tsx` mounts it into `#root` — but `index.html` has no `#root` and loads only `/js/main.js`. React, `react-dom`, `lucide-react`, `motion`, and the Tailwind pipeline are installed and configured (and `src/index.css` is just `@import "tailwindcss"`) yet **nothing on the page uses them** — the entire UI is hand-written HTML/CSS/vanilla JS. The build spends time compiling a React app that never renders. This is the single biggest cleanup opportunity.

---

## 4. Runtime flows

**Web task**
`user types` → `queue.handlePromptSubmission` → `POST /api/stream-task` (+`x-gemini-api-key` if the browser has one) → memory block + history injected → `POST /v1beta/interactions {agent, input, environment:'remote'|envId, stream:true, previous_interaction_id?}` → SSE frames parsed, typed, enriched with `normalized_activity` → browser renders thoughts/steps/cards → `interaction.completed` → `interactionId` stored on the turn (so follow-ups reuse the sandbox and its files) → `extractAndStoreMemories()` writes anything learnable to `data/agent-memory.json`.

**WhatsApp task**
`Meta webhook` (instant 200) → normalize any of ~8 payload shapes → `recordTurnStart` (creates/reorders a `wa_<digits>` conversation) → "Task Received" reply → stream from Antigravity → 10s milestone pushes → `recordTurnComplete` → final answer chunked at 3,800 chars. The same conversation then appears in the web sidebar because both read `data/whatsapp-conversations.json`.

**Failure handling, end to end**
Bad key → `auth_failed`. Dead sandbox → server silently drops `environment` + `previous_interaction_id` and retries once on `remote`. Storage quota → prune old sandboxes, retry. Mid-stream disconnect with an interaction ID → the client polls instead. Stream never starts → non-streaming fallback. Rate limit → 60s pause and requeue. Genuinely missing artifact → truthful 404 rather than a fake file.

---

## 5. What's done well

1. **Real protocol work, not hand-waving** — two independent SSE parsers, raw-body capture for HMAC, chunked WhatsApp sending, `X-Accel-Buffering: no`, keep-alive comments, `AbortController` on disconnect.
2. **Resilience designed for a *preview* API** — expired sandboxes, storage quota, background jobs, polling, and non-streaming fallbacks are all handled, which is exactly what a preview-tier managed agent needs.
3. **Prompt-composition discipline** — history injection is *skipped* when the server-side interaction is alive (token economy), and both history and memory blocks are clearly delimited with explicit behavioural instructions.
4. **Path-traversal hardening** in `/api/download-artifact` — deny-list + allow-list prefix check + basename re-check. Better than most hobby servers.
5. **Concurrency awareness** — two promise-chain mutexes + tmp-write/rename for all JSON stores; no database needed.
6. **Zero-friction UX engineering** — custom confirm/toast (iframe-safe), offline banner, PWA install, split view, attachments with base64 multimodal upload, honest error taxonomy surfaced to the user.
7. **Verified to actually run** — installs clean, type-checks clean, boots, endpoints answer.

---

## 6. Risks & rough edges (honest list)

**Security — this is the main one.** There is *no* authentication anywhere. Any `POST /api/whatsapp/*`, `GET/POST /api/memory*`, `GET /api/github/status`, or `POST /api/github/export-repo` works for anyone who can reach the URL. Because it is designed for a public Render deploy with a server-side `GEMINI_API_KEY`/`GITHUB_TOKEN`, that means a stranger could (a) burn your Google quota via `/api/stream-task`, (b) read and rewrite your persistent memory, (c) register or delete your WhatsApp pairing keys, (d) **push generated files into your GitHub account using your PAT**, and (e) use `/v1/chat/completions` as a free proxy to your paid key. The client dutifully sends `Authorization: Bearer <admin secret>` and `x-whatsapp-admin-secret`, but `verifyWhatsAppAdminSecret()` returns `true` and is never wired into a middleware — the check is decorative.

**Secrets at rest.** `data/whatsapp-config.json` stores the Gemini key and WhatsApp API key in plaintext, and `whatsapp-agent-keys.json` stores pairing keys — all on an ephemeral free-tier disk (so they also vanish on redeploy, silently "unpinning" the WhatsApp agent).

**Webhook signature check is conditional.** HMAC verification only runs when `WHATSAPP_APP_SECRET` is set **and** a signature header is present; a request that simply omits `X-Hub-Signature-256` skips validation entirely.

**Verify-token allowlist contains the literal product name** (`"Awais Codex"`), and the default in docs/`.env.example` is `awais_codex_verify_token` — guessable, and it's echoed back by `GET /api/whatsapp` to any caller.

**APK claims vs. reality.** `README.md` advertises "signed APK packager"; the code produces an unsigned ZIP with placeholder digests and a 32-byte stub DEX. It also isn't reachable from any route. Worth renaming or wiring up.

**Sandbox cleanup is aggressive.** `cleanupOldEnvironments(..., maxToKeep: 1)` on quota errors is global to the API key — with multiple conversations (or the WhatsApp path) in flight it can delete a sandbox another turn still depends on; the retry then silently loses that conversation's files.

**Dead React stack** as described in §3.12 — ~5 runtime dependencies and a build step producing an empty `<div>`.

**Two lockfiles** (`bun.lock` + `package-lock.json`) can drift; `render.yaml` uses npm while the lockfile set implies Bun was primary once.

**No tests.** Zero test files, no CI workflow; `npm run lint` is the only gate. Given how much branching exists in the retry/fallback ladder, that's the highest-value missing piece.

**Minor:** fixed 4s default poll rate and `100` displayed daily cap that is never enforced server-side; `extractAndStoreMemories` ignores the `apiKey`/`outputText` it's handed (so it can't do model-based extraction despite the naming); `express.json({limit:'50mb'})` for every route is generous for a single user but wasteful; `data/` is a single-writer JSON store that would not survive multi-instance deployment.

---

## 7. Change made during this review

`vite.config.ts` — added `allowedHosts: true` to `server`. The Vite middleware was rejecting the sandbox preview host with `403 Blocked request. This host is not allowed`, which broke the live preview; the app now serves correctly through a proxied hostname. (`tsc --noEmit` still passes and the dev server boots on `0.0.0.0:3000`.)

---

## 8. If I were continuing the work

1. **Add real auth** — one bearer-token middleware over `/api/*` (memory, tasks, github, whatsapp admin routes) and make `verifyWhatsAppAdminSecret` actually enforce something.
2. **Make the webhook signature mandatory** when `WHATSAPP_APP_SECRET` exists, and rotate the default verify token off the product name.
3. **Delete the React stack** (or finish it) — remove `src/`, `@vitejs/plugin-react`, `lucide-react`, `motion`, `@tailwindcss/vite`, `autoprefixer` if the vanilla UI is the intended product.
4. **Add tests** for `normalizeMissionActivity`, both SSE parsers, `scoreRelevance`, the traversal guard, and the retry ladder.
5. **Encrypt or externalise secrets** (`data/*.json` → env/secret store) and add a `/api/backup` export.
6. Rename the APK generator honestly or wire it into the artifact pipeline as a fallback.
7. Pick one lockfile; add a GitHub Actions workflow running `npm run lint && npm run build`.
