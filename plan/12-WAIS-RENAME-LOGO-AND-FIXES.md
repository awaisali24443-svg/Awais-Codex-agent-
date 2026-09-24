# 12 — What was fixed, what was renamed, and what changed on screen

Two commits' worth of work, pushed to `arena/01a0c7ad-awais-codex-agent`:
`eeb24a0` (the seven problems) and `84b4215` + `b80a9e5` + `9d27880` (WAIS,
the mark, the motion). Superseded on the same branch by `9cdc253` (the six
phone bugs) and `b22f0be` (deploy freshness + build stamp) — see `13`.

- Lint: `npm run lint` green — server (`tsc --noEmit`) **and** the web client
  (`tsc -p tsconfig.web.json`), which was red on a clean checkout too.
- Tests: **665 pass, 0 fail** at the time (`npm test`), up from 629 pass + 1 fail.
- Verified live: booted the real server, ran a task end-to-end, checked the
  brand in the served HTML/manifest and every new endpoint by hand.

---

## 1. The seven problems

Each has a regression test that failed before the fix. That is not a claim —
the patches were reverted one at a time and the suite was watched going red
(problems 1, 2, 3, 7: 6 of 12 tests failed; 4, 5 and 6 were verified against
the shape of the old code, see the commit message).

| # | Problem | Fix | Test |
|---|---------|-----|------|
| 1 | `remainingRuns` reported one channel's count while the gate refuses on the day total, so the phone was promised runs the server would reject | `remainingRuns` uses `peekDayTotal` (`server/accept.ts`); `peekBudget` is documented display-only | `regressions.test.ts` |
| 2 | After `finishRun` compacts and renumbers `seq`, a reconnecting client's stale `Last-Event-ID` replayed *nothing* | the cursor is clamped to the run's latest seq (`server/routes/runs.ts`) | `regressions.test.ts` |
| 3 | The Settings key-test ran a real interaction through the real engine that no budget counted | it claims an `api` run first (429 when the day is spent) and refunds it if the key or agent leg fails | `regressions.test.ts` |
| 4 | Retention ran only at boot, and `wa_updates` was never pruned at all — a slow leak on a 0.5 GB database | batched prunes, an hourly `[maintenance]` tick, a try/caught boot sweep, and 30-day retention for *handled* WhatsApp messages only | `regressions.test.ts` |
| 5 | Artifacts died three ways: ephemeral disk, expiring sandbox, row deleted at 7 days | pinning (`POST /api/artifacts/:id/pin`) stores the bytes in Postgres (8 MB cap), downloads and public links read the pin first, retention skips pinned rows, sharing pins what it hands out | `artifact_pin.test.ts` |
| 6 | A task slower than the relay's 45-minute window was never delivered — reconcile ran only at boot, and with the keep-awake ping a boot can be weeks away | a 5-minute rescue sweep, cleared on `stop()`/`shutdown()`, plus an honest log when the relay stops watching | `whatsapp/lifecycle.test.ts` |
| 7 | Two boots racing on a pending migration collided on the `schema_migrations` insert and killed the deploy | `ON CONFLICT (version) DO NOTHING` | `regressions.test.ts` |

Also fixed on the way in: `server/accept.ts` passed `conversationTitle` to
`createRun`, which the input type never declared — `tsc` failed on a clean
checkout, so nothing could be verified until it was repaired.

**New tables/columns:** `artifacts.pinned`, `artifacts.pinned_at`,
`artifact_blobs` (migration `020_artifact_pin.sql`).

**New endpoints:** `POST /api/artifacts/:id/pin`, `POST /api/artifacts/:id/unpin`,
`durable` on the share response, `pinned` on each artifact in the run list.

---

## 2. The name

The product is **WAIS** everywhere a person reads it: page title, wordmark,
sign-in headline, header, welcome screen, install prompt, manifest, the
assistant's own name in the client, the replay page, the boot banner, the
WhatsApp messages ("WAIS needs you", "WAIS check-in"), the commit messages this
server writes to GitHub, the identity the agent is given in its core memory,
`metadata.json`, the README, and the APK label.

Deliberately **not** renamed, and `brand.test.ts` now fails if anyone tries:

- **`AAD_PREFIX = 'awais-codex:secret:'`** in `server/crypto.ts` — every stored
  secret was encrypted under it. Change it and they cannot be decrypted.
- **`service: 'awais-codex'`** in `/healthz` and `/api/status` — monitors key
  off it.
- **The host and the repo** — every link already shared points at them.
- **`com.awaiscodex.app`** — Android treats a new package id as a *different*
  app, so an update would leave two copies on the phone. Only the visible label
  changed.

---

## 3. The mark

`web/icon.svg`, with `npm run icons` rendering the PNG set from that one file.

A monogram **W** in warm ivory with a **terracotta spark** rising out of its
middle vertex — the agent finishing what it was handed. Deep indigo-charcoal
rather than the blue-violet every assistant wears, and the spark is the
interface's own accent colour (`#c2613e`), so the icon and the app are visibly
one product. Built from strokes and one four-point star, which is why it still
reads at 16px.

The maskable variant is built properly now: squared corners, no badge outline,
monogram at 80% — Android's circle crop shows the icon's own gradient instead
of a seam.

Sheet: `plan/11-wais-mark.png`.

---

## 4. The motion

The welcome screen animates once, in about a second: the badge rises, the **W
draws itself**, the spark **lands** and then breathes; the name, greeting and
chips follow in a short stagger. The sign-in screen does the same, quieter
(badge + wordmark, then headline, then form).

Two things were done deliberately:

- **It is fail-visible.** The animation runs *into* the resting state, not out
  of a hidden one — the finished mark is what is on screen if the animations
  never run at all.
- **It is opt-out.** Everything sits inside the existing
  `@media (prefers-reduced-motion: reduce)` rule, so a phone that asks for less
  motion gets the finished frame immediately.

---

## 5. What is still open

- **Rotate `ACCESS_KEY`** — it has appeared in earlier transcripts.
- **Render hours.** The keep-awake ping (11 minutes) means one always-on
  service consumes nearly the whole 750 h/month pooled free allowance. The
  hourly maintenance tick makes letting it sleep at night much cheaper than it
  used to be — worth reconsidering the ping interval.
- **The `pin` cap** is 8 MB per file on purpose (the free database is 0.5 GB for
  everything). If APKs and media need to be kept, that wants object storage,
  not this table.
