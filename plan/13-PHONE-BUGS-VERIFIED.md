# 13 — The phone screenshots: what was wrong, what was already fixed, and what I added

**Short version:** every bug in those six screenshots had already been fixed and
deployed on `arena/01a0c7ad-awais-codex-agent` about 40 minutes after you took
them (commit `9cdc253`, by the coder session). Your phone was still running the
previous build, because the app was served with an hour of `max-age` — and
nothing on screen could tell either of us which build you were looking at.

So I did three things: verified the fixes (rode the suite to **697 pass, 0
fail**, lint green), added the two changes that stop this happening again, and
tidied three comments the fixes left behind. Pushed as **`b22f0be`**.

---

## 1. Each complaint, and where it stands

| Your words | State | Where |
|---|---|---|
| "the message bubble are completely broken" | **Fixed.** Not the bubbles — the page. The composer's estimate+cap chip sat after the send button in one non-wrapping flex line, so the row was wider than the phone and the whole page could pan sideways, sliding every bubble off the left edge. Both that row and the finished-task row now wrap; the page clips horizontal overflow. | `9cdc253` + my scoped fallback |
| "same token cap for each type of task, remove the cap token completely" | **Fixed, end to end.** The chip, the pre-flight estimate, the client's budget field, the server's mid-stream guard, the pause/resume-with-a-higher-cap path and the `isTokenBudgetSpent` proxy are all deleted — not left inert. | `9cdc253`, comments cleaned in `b22f0be` |
| "I give it a task it still running" | **Fixed as far as it can be.** A run waiting out Google's rate limit (up to 30 min) looked exactly like a hang. That wait is now its own step on the timeline with a spinner, and it turns into a checkmark only when the model speaks again. Also: `paused` was missing from the statuses the client accepts as "the run is over", so a paused run spun forever. | `9cdc253` |
| "the setting page did not open a different page like others app" | **Fixed.** Settings is a third screen with a back arrow, a scrollable body and one history entry, so Android's own back gesture leaves it. (It was a collapsible section inside the drawer.) A duplicate click listener that made one tap save twice went with it. | `9cdc253` |
| "you added edit button to the output message" | **Fixed.** "Edit prompt" is gone from the finished-task row and so is its handler; editing still lives on your own message, where the pencil always was. | `9cdc253` |
| "when I said hello it just outed the raw text first then the greetings" | **Fixed.** The planning protocol asks the agent for "Step 1/N: …" lines; it was leaving them in the prose, so the answer opened with its own table of contents. Those lines are already the timeline, so the prose is filtered before it is drawn — including an echoed protocol block, while a sentence that merely starts with "step" survives. The stored record keeps everything. | `9cdc253` |

## 2. What I added (`b22f0be`)

**The shell revalidates.** `app.js`, `styles.css`, `index.html` and the other
client files were served with `max-age=3600`. The service worker is
network-first, but its fetch goes *through* that HTTP cache — so a deploy
reached your phone up to an hour late. They are `no-cache` now (express still
sends an ETag, so a warm load costs a 304). Icons keep the hour; an icon is
worth caching, a client bundle is not.

**The running build is on screen.** `/healthz` and `/api/status` now report the
commit the server was built from (Render exports `RENDER_GIT_COMMIT`; anywhere
else it says `unknown` honestly), and Settings ends with `WAIS · build b22f0be`.
Next time something looks broken, that line says whether you are even looking at
the fix.

**The service worker's cache name is bumped** to `wais-v4`, so an installed
phone drops the old shell on activate.

**The old-engine fallback is `overflow-x: hidden` on `html` only**, scoped to
engines without `clip`. On `html` it propagates to the viewport and leaves
`position: sticky` working; the same line on `body` would make body a scroll
container and freeze the composer, which is why the code does not do that.

**Three stale comments** that still described the deleted per-task token cap
(`recovery.ts`, `routes/runs.ts`, `executor.ts`).

Tests: `server/shell_cache.test.ts` (14 cases) boots the real app and asserts
the headers a phone receives, the commit on both endpoints, and the Settings
build line. Reverting the cache change turns 5 of them red — checked.

## 3. To see it on your phone

Render redeploys this branch automatically. **Confirmed live:** the deployed
service now answers `/healthz` with `{"service":"awais-codex","version":2,
"commit":"b22f0be"}` and a start time of 04:28:37 UTC — the build from this push. Pull the page down to refresh (or close and reopen the tab):
the cap chip is gone from the composer, Settings opens as its own page from the
drawer, "Edit prompt" is gone from finished tasks, and a "hello" answers with
just the greeting. The build line at the bottom of Settings should read
`WAIS · build b22f0be`.

## 4. Still worth your decision

- **`ping` on a 100-run day.** Not touched here.
- **The `hello` run created a sandbox.** A greeting spun up a remote environment
  ("Sandbox ready 5d6e8e…" in your first screenshot) — real work for no work.
  Fixing it properly means deciding when a task actually needs a workspace, and
  that is a product call, not a bug fix, so I left it alone.
- **Rotate `ACCESS_KEY`** — it has been in transcripts.
