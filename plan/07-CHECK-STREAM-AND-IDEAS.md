# 07 · Your checks answered: the live stream, "is it all solved", and a feature brainstorm

**Read-only. Nothing changed, committed or pushed.** Untracked file in `plan/`.

**What I read:** `arena/01a0c7ad` @ **`c5aa61c`** — 19 commits past my last review (04:27 → 15:56 today). Scratch
clone in `/tmp`, lint and the full suite run there, the deployed commit built and run locally, plus live probes of
`awais-codex-agent-arena.onrender.com` (healthz, readyz, status, runs, a stream, a public share page).

---

## 1 · The live stream — verdict: it works, and I proved it two ways

You said this is the one feature that must work. Here is the evidence, not an opinion.

**A · Live site, replay path (your real run `run_k4DxxyTdUdy7`, finished 15:58:43Z).**
`GET /api/runs/run_k4DxxyTdUdy7/stream?after=0` returned, in order:

```
: stream open
id: 1  event: run.started      {"kind":"chat","engine":"antigravity",…}
id: 2  event: log              {"level":"warn","message":"The API rejected request field 'thinking_summaries'…"}
id: 3  event: text.snapshot    {"text":"### **Pros of Home Solar Panels**…"}
id: 4  event: text.snapshot    {…,"final":true}
id: 5  event: run.environment  {"environmentId":"4fcabb…","interactionId":"v1_ChdO…"}
id: 6  event: run.completed    {"status":"completed",…}
event: end
```

So on the deployed service: the SSE route is reachable, the `?k=` key authenticates a stream, replay is ordered
with correct `id:` values, the terminal event is present, and the stream **closes itself** (`event: end`) instead of
hanging. `X-Accel-Buffering: no` is honoured through Render's proxy — no buffering stall.

**B · Live progress (not just replay).** I built `c5aa61c` — the exact deployed commit — and ran it locally with
the scripted engine, starting a run and watching its stream from the first millisecond:

```
 0.01s  run.started        [id: 1]
 0.01s  thinking.snapshot  [id: 3]
 0.13s  thinking.delta     [transient]
 0.29s  thinking.delta     [transient]
 0.48s  tool.call          [id: 5]
 0.75s  text.delta         [transient]
 0.75s  text.snapshot      [id: 8]
 1.02s  text.delta         [transient]
 1.49s  text.snapshot      [id: 12]   … run.completed [id: 14] → event: end
```

Frames arrive **as they are produced**, mixing transient deltas (no `id` — decoration, dropped under backpressure)
with durable snapshots (numbered, replayable). That is the design working exactly as documented.

**The one real defect in this feature, and it now matters more because of the APK.** Reconnect with a cursor from
*before* a run finished and you get nothing back:

```
$ curl -N "…/stream?after=99"            # or  curl -H 'Last-Event-ID: 99'
: stream open
event: end
```

Cause: `finishRun` compacts a run's intermediate snapshots and then **renumbers `seq`**, so a `Last-Event-ID` from
before the finish points past the end of the log, and `resumeFrom()` (`server/routes/runs.ts:121`) passes it
through untouched. The UI does not hang — `web/app.js:1685` catches `end`, re-asks the server for the run's status
and closes the card correctly — but the **replay content** (steps, thinking, answer text) is missing until a page
reload.

**Why the APK makes this urgent:** Android suspends a backgrounded WebView. Send the app to the background
mid-task, come back a minute later, and the EventSource reconnects with its stale `Last-Event-ID` — that is
*precisely* this path, and it is the common path on a phone, not an edge case.

**The fix (four lines, helper already exists — `latestEventSeq` in `server/runs.ts`):**

```ts
    let from = resumeFrom(req);
    // finishRun compacts snapshots and renumbers `seq`, so a cursor from before
    // the finish can point past the end of the log — replaying from the start is
    // always correct, just heavier.
    if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;
```

**Android/WebView checklist for the stream** (thin shell against the live URL — never a bundled copy of `web/`):

1. `CookieManager.getInstance().setAcceptCookie(true)` — the session cookie is `HttpOnly; SameSite=Lax; Secure`;
   without it the stream 401s while the shell looks fine.
2. Do **not** intercept `/api/runs/*/stream` in `shouldInterceptRequest` — an intercept that buffers the body
   breaks SSE silently. Let Render serve it.
3. Keep the Activity foreground-tolerant: a WebView that is paused mid-stream will reconnect (fine, once the fix
   above lands).
4. Artifact downloads: `DownloadManager` does **not** carry the WebView's cookies. Read
   `CookieManager.getCookie(finalUrl)` and add it as a `Cookie` header, or open the URL inside the WebView and
   let the existing `Content-Disposition` handle it.
5. The PWA shell is ready for it — `sw.js` VERSION is `codex-v3`, manifest `display: standalone` with
   `theme_color: #f5f3ef`. Point the shell at the live URL so the service worker never serves a stale app.

---

## 2 · "Is everything solved?" — the features landed; the fixes did not

I re-checked every finding from `plan/05` and `plan/06` against `c5aa61c`:

| Finding | Status on `c5aa61c` |
|---|---|
| **CI green** | **Still red.** Two causes — see §3. |
| P1-1 "Tasks left today" counts only the whatsapp bucket (`accept.ts`) | **Not fixed** — bit-for-bit the same function |
| P1-2 stale-cursor replay | **Not fixed** (reproduced live above) |
| P1-3 Settings "Test" button spends an un-budgeted interaction | **Not fixed** — no budget call in `routes/settings.ts` |
| P1-4 retention only at boot; `wa_updates` never pruned | **Not fixed** — only `main.ts` boot calls |
| P1-5 artifacts not durable | **Not fixed** — `artifacts.ts` untouched |
| N1 phone task > 45 min is never delivered | **Not fixed** — `poller.ts:627` still returns silently on `detached`; `reconcile()` still only runs at boot (`lifecycle.ts:167`) |
| N2 migration insert race on deploy overlap | **Not fixed** — still `INSERT INTO schema_migrations` with no `ON CONFLICT` |

That is worth saying plainly: the 19 commits are **new capability**, and they are good work — but none of the
eight defects above were touched. The suite agrees with me independently: **533 tests, 532 pass, 1 fail**, and the
failure is the *same* stale assertion from `plan/05` §1.

---

## 3 · What blocks CI right now (two copy-paste fixes)

**a) Lint fails at the type-check step** — `npm run lint` is the first CI stage, so nothing after it runs:

```
server/linkedin.test.ts(184,48): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
server/linkedin.test.ts(194,50): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
```

`createRun()` returns `conversationId: string | null` and the test passes it straight to `listPendingDrafts(db, id)`.
One character each:

```ts
const drafts = await listPendingDrafts(db, run.conversationId!);
…
assert.deepEqual(await listPendingDrafts(db, run.conversationId!), []);
```

**b) The whatsapp assertion** — same one as before, still unfixed (`whatsapp.test.ts:519`):

```ts
assert.match(reply, /Daily run budget exhausted/);   // was: /Daily whatsapp run budget exhausted/
```

With both, the suite is 533/533 and CI goes green. I verified this by running the suite locally — the only failing
assertion in the entire repo is that string.

---

## 4 · The new code: what I checked, what is genuinely good

I went through the riskiest of the 19 commits rather than trusting the messages.

**Sound, and thoughtfully done:**

- **LinkedIn is draft-only and cannot auto-post.** `linkedin.ts:30` — "the fenced block … **Never auto-published**";
  publishing is an explicit operator tap (`POST /linkedin/drafts/:id/publish`). The agent writes; you publish.
- **Google connectors are read-only by scope** (`gmail.readonly`, `calendar.readonly`), tokens are **sealed with
  `MASTER_KEY`** (same AEAD as other secrets), refresh happens on demand, and every agent read is recorded as a
  `google.read` event — so "what did you look at?" has an answer. OAuth `state` is one-time, 16 random bytes, 10-minute
  TTL, deleted on use. Write scopes are deliberately absent pending an approval UX.
- **The scheduler fires through `acceptRun`** — one task at a time, **one budget claim per fire**, and a deferred
  fire is pulled back to 5 minutes instead of skipping the interval.
- **Verification costs nothing.** `mission_verify.ts` is explicitly deterministic — database rows and the final
  text, "**never another engine call**" — so "prove it's done" cannot blow the token budget. A failed check closes
  the run as `verification_failed` rather than marking it done.
- **Share replays are locked down.** 192-bit token from `randomBytes(24)`; `ShareData` is an explicit allowlist,
  not the `Run` object, so `interactionId`/`environmentId` cannot leak; the public page escapes every field
  (prompt, answer, steps, checks). Verified live: the page I fetched exposed the prompt, plan, steps, checks and
  answer — and **no engine handles**.
- **Self-ping is honest about its own limits** — the docstring states plainly that a timer cannot wake a sleeping
  process, and it needs `APP_URL`/`RENDER_EXTERNAL_URL` or it stays off with a warning.

**Three new items worth knowing:**

- **N3 · Every run pays one wasted round-trip.** The live stream I fetched shows `log: "The API rejected request
  field 'thinking_summaries' — dropped it and retrying"` — the 400 fallback working as designed, but it sets
  `agentConfig.thinking_summaries = 'auto'` on **every** request and only learns the field is rejected per attempt.
  There is no process-level memory of the rejection. Fix: remember it for the process lifetime (try once, then stop
  sending it); the feature is opt-in anyway, and you get one less POST of latency on every single run.
- **N4 · Two keepers, one allowance.** The repo self-pings every 14 minutes **and** you have an external pinger.
  They are redundant in the awake state, and the self-ping consumes the same 750 instance-hours (≈744 h/month = the
  whole workspace allowance). Keep the **external** pinger (it is the only one that can revive a *sleeping*
  service) and consider `SELF_PING_ENABLED=false` — unless you want the repo's ping as a backstop, in which case
  accept that no other free web service can ever live in that workspace.
- **N5 · Minor:** `shareUrl()` falls back to `config.appUrl || RENDER_EXTERNAL_URL`; with neither set the copied
  link is relative (`/share/<token>`) and dead for a recipient. Render sets `RENDER_EXTERNAL_URL`, so this is only a
  hazard on another host — worth a one-line guard anyway.

---

## 5 · Feature brainstorm — what to build next, costed for your free tier

Ordered by value per unit of quota. "Cost" means **model runs**, because that is the scarce resource.

### Free — zero runs, and they change how the product feels

1. **Morning brief to WhatsApp.** You already have `briefing.ts` and it is **pure SQL**. One scheduled message at
   8am — what ran overnight, what failed, what needs your decision (pending plan approvals, pending LinkedIn
   drafts), budget left — costs **zero runs** and is the single strongest "it is alive and working for me" signal
   you can ship. Put it in the notification path, not the run path.
2. **Watchdogs → a message on your phone.** Poller died / got a 409 / token rejected / budget spent / quota reset /
   run failed. Every fact already exists (`/api/status`, `health()`, budget rows, terminal events). The phone is
   where you want to learn the agent broke, not the web UI.
3. **Approvals from the phone.** Both new features are waiting for a human: plan previews and LinkedIn drafts.
   Add "reply `yes` to run it / `no` / `edit: …`" in WhatsApp. You keep the human in the loop without opening the
   app — this is the phone-native version of Manus's approval step.
4. **Notify-only reminders.** Today a reminder firing spends a run. Most reminders are "tell me at 4pm" — those
   should just send a message (zero runs), and only "do X at 4pm" should claim one. Split the two.
5. **Voice notes in.** The most natural phone input there is. Transcription is free (Groq's free Whisper tier, or
   Gemini Flash-Lite), and the transcript lands as an editable prompt — exactly like the web mic you just added.
6. **Share link attached to the answer.** You have shareable replays and a sender; when a long mission finishes,
   append "full replay: <link>". Free, and it makes the phone answer complete.
7. **`/usage` and `/what next`** on WhatsApp — spend today, what is queued, what is waiting for approval.

### Cheap — same run, better output

8. **"Build my app and send me the APK."** You are building an APK right now; make it a first-class flow: the
   agent builds, the artifact is delivered to WhatsApp as a document, and the phone installs it. This is the
   demo that sells the whole product.
9. **A report artifact for deep research** — the research run already produces the text; render one PDF/HTML file
   and send *that*. "I got a document" beats "I got a wall of text".
10. **Artifact pinning (R2).** Doubles as the P1-5 fix: "keep this file" moves the bytes off the ephemeral disk, so
    the download link stops rotting. R2's free tier has zero egress.
11. **Weekly self-review** on the scheduler: read the week's failures, run errors and budget use (`briefing.ts`
    data), and post a short "what to fix" note. One run a week for a compounding quality signal.
12. **Presets/templates** — "every Monday 9am: repo digest", "every evening: summarise today's runs". You have the
    scheduler; presets are just saved prompts, and they make the agent feel configured *for you*.

### The differentiators — still free-tier feasible

13. **Chained missions ("keep going").** When a run finishes with a clear next step, reply `go` and it continues in
    the **same sandbox** — you already persist `interactionId`/`environmentId` per run. This is the difference
    between a tool and a collaborator.
14. **Cross-channel continuity.** Ask from the phone "what did you do on the web today?" and get the real answer —
    one rolling conversation per channel becomes one conversation per *you*.
15. **Photo/screenshot in.** "Make this match" plus a screenshot: the engine is Gemini-based, so images are native;
    same run, no extra quota. For a builder, this is a daily-use feature.
16. **Voice replies for long answers** while driving — browser TTS exists on the web side; on the phone, a short
    voice note beats a 3,000-character message.

### APK-specific (from an Android perspective)

17. **Thin shell at the live URL**, never a bundled copy — otherwise the service worker serves a stale app and
    "why is my fix not showing?" becomes your nightly debugging session.
18. **Share-sheet integration:** "Share → Codex" from any app pre-fills the prompt with the shared text/link/photo.
    Pure Android, no server change, and it is the feature that makes the app feel native.
19. **A quick tile / widget:** one tap to start a preset task.
20. **Notifications without FCM:** you do not need push infrastructure — the agent already has a channel that can
    reach you (WhatsApp). Let the app be the *console*, and the phone's messaging app be the notifier.
21. **Offline queue in the shell:** if the phone has no data, hold the prompt and send it when connectivity
    returns. The WhatsApp side already never loses a message; the APK should match that promise.

### Do not build (unchanged from the strategy)

Multi-tenant, a vector DB, a model zoo, web-parity with Manus, or anything whose correctness depends on a paid
tier.

---

## 6 · If I were sequencing your next 48 hours

1. **Two CI fixes** (§3) — CI green, PR #2 mergeable, 5 minutes.
2. **The stream clamp** (§1) — four lines, and it is the difference between "streaming works" and "streaming
   sometimes looks broken on my phone".
3. **N3** (stop re-sending a field the API already refused) — removes a wasted round-trip from *every* run.
4. **N1 then P1-4/P1-3** — the phone's delivery promise, then retention/maintenance and the Test-button quota leak.
5. **Free-feature batch** — morning brief, watchdogs, approvals-from-phone, notify-only reminders. Zero quota,
   maximum felt difference.
6. **N4** — decide which pinger is the real one, and keep the workspace's free services to exactly one.
