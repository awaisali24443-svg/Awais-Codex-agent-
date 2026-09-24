# Round four — the sweeps before this one, swept

Commit **`9b2d980`** on `arena/01a0c7ad-awais-codex-agent` (parent `0d1cb82`).
No features. Each change below closes something that was claimed done and was not.

Suite at this commit: **721 pass / 0 fail** (175 suites, ~122 s), `npm run lint` **0**.

---

## 1. The "never says mission" test was looking at nine files out of sixty-six

`brand.test.ts` checked a hand-written list: four wire prompts, five client
files. The server has sixty-six non-test sources. Everything outside the list
kept saying **mission** where a person or the model could read it:

| Where | What it said |
| --- | --- |
| `server/settings.ts` (×2) | "Takes effect on the next **mission**", "every **mission** fails with auth_failed" — Settings page copy |
| `server/routes/artifacts.ts` (×5) | "…is recorded for this **mission** but is not in the sandbox snapshot any more", "Only a finished **mission**'s files can get a public link" — download/share/preview errors |
| `server/whatsapp/approvals.ts` (×2) | "✅ Plan approved — the **mission** is running now", "🛑 Plan rejected — the **mission** will not run" — WhatsApp replies |
| `server/mission_steps.ts` | "You are RESUMING an interrupted **mission**" — a wire prompt, i.e. the model |
| `server/ui-design-guide.md` | "Follow this when a **mission** asks you to design…" — the guide injected into every UI task |
| `scripts/verify-integrations.ts` (×5) | `--key-only  … no **mission** (spends nothing)` and friends — operator CLI help |
| `server/main.ts`, `server/config.ts`, `server/app.ts` | boot banners: "can run **missions** on your quota" |
| `server/memory.ts`, `server/engine/scripted.ts` (×3), `server/runs.ts` (×3) | the memory log, the demo engine's output, the run-conflict error and the "New **mission**" title fallback |

All twelve reworded to *task*. **The test now walks the tree** — every non-test
source under `server/` and `web/`, the shipped docs, the operator CLI — skipping
only bare identifiers, module paths and SQL (a query that names the
`mission_steps` table is not copy). Two new assertions keep the walk honest: the
scan must contain the surfaces that matter (it asserts `server/runs.ts`,
`server/ui-design-guide.md`, …), and it must be more than 55 files.

Proved failing-first by putting `Takes effect on the next mission` back and
adding `'Start a mission from the composer.'` to `server/runs.ts`: the test named
both, file and string, and passed again once reverted.

**Deliberately not changed:** code comments (the file's docstring has always
exempted them — "a comment is not a surface"), and the four root dev docs
(`README.md` 12, `STATUS.md` 11, `ARCHITECTURE.md` 6, `DEPLOY.md` 4). Those are
prose about internals, not strings anyone ships; say the word and they get the
same treatment.

## 2. A running task could be lost by looking at another chat

Opening a chat replaces the whole thread, and the live run card is a DOM node
inside it. So on a phone: start a task, open the drawer, tap another chat, tap
back — and you find your own question, **no answer arriving, no spinner,
"Working…" in the header, and a locked composer**. The stream was still open,
still writing into a card that was no longer on the page. Nothing was broken and
nothing could be seen.

**Fix.** `openConversation` now asks two questions:

- Does this chat own the live run? The question that started it is persisted the
  moment the run exists (the answer is not, until the run closes), so
  `message.runId === state.runId` is the answer — and if so, `attach(runId, 0)`
  replays the card and its stream back into the thread.
- If not, the thread gets one line: *A task in "XYZ" is still running.* (or *is
  waiting for your approval*) with a **Show it** button that opens the chat that
  owns it.

Ownership is learned from the run, never guessed: `run.started` carries
`conversationId` and every path that goes live — first send, retry, resume, plan
approval, foreground recovery, the 409 "already running" path — replays it.

Waiting for approval counts as live (`LIVE_RUN_STATUSES = ['running',
'awaiting_plan']`): a plan waiting for a tap is not running, but its card is the
only place to approve it, so it comes back too. `finishCard` marks the run
finished so a completed run is never replayed into a second card.

## 3. `run.paused` had a handler and no listener

`sources.checked` (round two) was a `case` nobody subscribed to, so the work
happened and nothing showed. The mirror image was sitting right there: `case
'run.paused': finishCard(card, 'paused')` — with no listener on the durable
list. Pausing is a declared run status (`setRunStatus` accepts `'paused'` and
writes ``run.${status}``), and the resume endpoint treats a paused run as
resumable, so if anything ever paused a run the task would have sat there
looking hung — the exact bug of round two, from the other side.

Registered the event, and added the mirror test: **every `case` in
`handleEvent` must be subscribed to**. Mutating the file (dropping `run.paused`,
narrowing the live-status list, re-adding the `state.running` guard) fails three
tests; restoring it passes all of them.

---

## Route and event cross-checks (nothing to fix)

- Every route the server registers vs every `api()`/`fetch()` in `web/`: **0 dead
  routes** in either direction.
- Every event the server writes vs every listener/case in the client: **0**
  unlistened, **0** unhandled — and now the reverse direction is enforced too.

## Files touched

```
 server/brand.test.ts           | 115 +++++++++++++++++-----
 web/app.js                     |  64 ++++++++++
 server/web_client.test.ts      |  66 +++++++++++
 server/{routes/artifacts,routes/runs,settings,whatsapp/approvals,runs,
         main,config,app,memory,engine/scripted,mission_steps}.ts
                                |  40 +++---
 server/ui-design-guide.md      |   2 +-
 scripts/verify-integrations.ts |   8 +-
 16 files changed, 240 insertions(+), 59 deletions(-)
```

## Tests added this round (6)

| Test | Guards |
| --- | --- |
| nothing a person or the model can read says mission | finding 1 |
| the files that carry the wording are actually in the scan | finding 1 (the walk cannot silently scan nothing) |
| no case is left without a listener | finding 3 |
| reopening the chat its card belongs to brings the card back | finding 2 |
| waiting for a plan to be approved counts as live | finding 2 |
| another chat says where the running task is, and offers the way back | finding 2 |
| the card learns which chat owns it from the run itself | finding 2 |

## Still open (unchanged)

- Rotate `ACCESS_KEY` — it is in the transcripts; the preview uses a throwaway key.
- A greeting still spins a sandbox (product decision).
- Reconsider the keep-awake ping now that maintenance ticks hourly.
