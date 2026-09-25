# Round eleven — the audit: what the other agent platforms have that WAIS does not

The ask: *"audit what other agentic platforms have that this one doesn't."*

This file is the answer. It is written to be read on a phone, so it says the
short version first.

Two rules were kept while writing it:

* every claim about **WAIS** carries the file it was read from, because a gap
  list that is wrong about the current product is a rumour, not an audit;
* every claim about a **platform** carries a source at the bottom, because
  "everyone else has X" is how features get built that nobody wanted.

---

## 0. The short version

WAIS is already ahead of the big products on three things they cannot copy
cheaply, and behind them on four things that are cheap to fix.

**Ahead, and should stay:** control from WhatsApp, a sandbox that lasts across
tasks, and a public replay link. (Section 4, with the receipts.)

**Behind, in the order I would fix them:**

| # | Gap | What the others do | Size |
|---|-----|--------------------|------|
| 1 | **A screenshot cannot be sent** | Every product accepts images; the agent underneath WAIS supports them too | S–M |
| 2 | **The second task is refused** | Parallel agent threads and a task list, not "another task is already running" | M |
| 3 | **A running task cannot be steered** | "You can intervene and redirect at any point" | M |
| 4 | **Tasks only start when a clock says so** | Scheduled tasks that fire on a new email / PR / message | M |
| 5 | **A task has no address** | Deep links, and a phone share sheet that opens into the composer | S |
| 6 | **What it costs is a route, not a glance** | Usage panels; cost per task, spend this month | S–M |
| 7 | **Outputs have no history** | Version list per artifact, restore a previous one | M |
| 8 | **Nothing groups a body of work** | Projects: chats, files and standing rules in one place | M–L |
| 9 | **No loop that grades past runs** | Datasets, scorers, prompt experiments | M–L |
| 10 | **Connectors are code, not settings** | Add a connector from the UI (MCP and friends) | L |

Sections 1 to 3 are the detail, section 5 is what is *deliberately* not on the
list, section 6 is the recommended order.

---

## 1. What WAIS has today, verified

Read from the repo, not from memory. Paths are the evidence.

**The operator layer — what the person actually uses**

| Surface | Where |
|---|---|
| A task: ask, plan, approve, edit the plan, cancel, retry, resume | `server/routes/runs.ts` (`/runs`, `/plan`, `/approve`, `/cancel`, `/retry`, `/resume`) |
| Live stream of the answer, the reasoning and the raw frames | `server/events.ts`, `web/app.js` (trace, raw toggle) |
| The timer and the spinner beside it | `web/timeline.js` `formatTimer`, `web/app.js` `startRunClock` |
| Memory the operator can read, edit, delete, clear | `server/memory.ts`, `/api/memory*` |
| Conversations, from both surfaces, with branches | `server/routes/runs.ts`, `server/branches.ts` |
| Scheduled tasks and reminders, including monthly | `server/scheduler.ts`, `/api/scheduled-tasks`, `/api/reminders` |
| Outputs: files, artifact preview, pin, download, public share link | `server/artifacts.ts`, `server/routes/artifacts.ts` |
| A public replay of any finished task, revocable | `server/share.ts`, `/share/:token` |
| Feedback per answer and per run, plus a summary | `server/feedback.ts`, `/api/*/feedback` |
| Budget and usage | `server/budget.ts`, `/api/budget`, the usage line under an answer |
| Settings: providers, keys, checks, preferences | `server/settings.ts`, `/api/settings*`, `web/app.js` settings page |
| Command palette over actions and past tasks | `web/palette.js` |
| Voice: dictation in, reading out | `web/voice.js` |
| A PWA with icons, a shell cache and an offline navigation fallback | `web/manifest.json`, `web/sw.js` |
| Attachments (text, in the browser, never uploaded) | `server/attachments.ts` |
| The design engine: directions, recipes, an asset kit, a mechanical gate | `server/design.ts`, `server/design/*` |

**Integrations, all of them fences the agent writes into the prompt**

| Integration | Scope | Where |
|---|---|---|
| Gmail + Calendar | read-only by design | `server/google.ts` |
| GitHub | tokens, repos, PR routes | `server/github.ts`, `server/routes/github.ts` |
| LinkedIn | drafts, publish | `server/linkedin.ts` |
| WhatsApp | the operator's remote control: approvals, done-pings, digests, breakage alerts, relay | `server/whatsapp/*` |

**What the engine gives us under the hood** (`server/engine/antigravity.ts`):
one managed agent per task, in a remote sandbox, with a continuation handle —
`previousInteractionId` and `environmentId` are stored and reused, so a
follow-up continues in the *same workspace* rather than retyping context.

---

## 2. The gaps, in detail

Sizes: **S** is one sitting, **M** is a round, **L** is a project. Every "engine
blocked?" answer is about Google's managed agent, since that is the brain.

### Tier 1 — buildable here, and worth it

#### 1. Images as attachments — S–M, not engine-blocked

**Today:** `server/attachments.ts` takes text only, up to three files, 200 KB
each and 400 KB total, read in the browser and folded into the wire prompt.
There is no path for a screenshot at all.

**The others:** every platform takes an image. For the work WAIS is now doing
(sites, pages, redesigns), the most common thing the operator has in hand is a
picture: this layout is broken, read this chart, copy this competitor.

**The good news, and why this is first:** the agent underneath **already
supports images**. Google's Antigravity agent documents multimodal input —
text and image, image as inline base64, `{"type":"image","data":...,"mime_type":"image/png"}`
— and the same doc says audio, video and *documents* are not supported yet.
So this is one part type end to end: composer → request → `input[]`, and no
waiting on anyone.

**Same document, second find:** the request also accepts
`environment.sources` — files mounted into the sandbox at a target path
(`/workspace/data.csv`). That is the honest answer to the 200 KB text ceiling:
paste small files, **mount** big ones and let the agent read them with its own
tools.

**Touches:** `server/attachments.ts` (a kind, a mime, a byte cap), the run
request, `server/executor.ts` (`input[]` when images are present), the composer
in `web/app.js`, and tests that assert the wire shape.

#### 2. A queue for the second task — M, not engine-blocked

**Today:** the second ask is refused outright — `server/runs.ts` returns
"Another task is already running (id); one at a time protects the daily quota".
The guard is right (one key, one daily allowance) but the *answer* is a dead end
for someone on a phone who has just thought of the next thing.

**The others:** ChatGPT and Codex run agent threads in parallel with a task
sidebar; Manus runs several tasks; Claude has background agents and `/loop`.

**Why the fix is small here:** the engine still runs one task at a time, so this
is *order*, not concurrency: accept the second ask with a `queued` status, start
it when the active one finishes, and let the phone say so. WAIS already sends a
done-ping when a task ends (`server/whatsapp/doneping.ts`) — the queue rides the
messaging it already has instead of inventing a notification system.

#### 3. Steering a running task, without killing it — M, not engine-blocked

**Today:** a running task can be cancelled, retried or resumed. There is no way
to say "no, the other folder" while it works. The most expensive failure in
practice is a task that goes the wrong way at minute two of eight.

**The others:** Manus says outright that you can "intervene and redirect at any
point"; Codex steers a live thread; Claude has side conversations.

**Why the fix is small here:** cancel is already safe (the answer so far is
kept, the run is marked), and a follow-up already resumes the same sandbox
through `previousInteractionId`/`environmentId`. So "steer" is: stop the
stream, append the note to the prompt, continue in the same workspace, and say
on the card that it was continued with a note at 3:12.

#### 4. Tasks that fire on an event, not only on a clock — M, not engine-blocked

**Today:** schedules and reminders exist and work (`server/scheduler.ts`), and
Google (read-only mail and calendar), GitHub and WhatsApp are all wired.

**The others:** ChatGPT scheduled tasks can now start on an event — a new Gmail
message, a Slack message, GitHub pull-request activity (release notes, Aug 25
2026); Claude has `/loop`.

**Why it fits WAIS:** every piece is already here — the poller
(`server/whatsapp/poller.ts`), the fences (`server/google.ts`,
`server/github.ts`), the schedule runner, the alerting. "Watch for this and
start a task when it happens" is wiring, not a new platform.

#### 5. A task with an address, and a share sheet — S + S, not engine-blocked

**Today:** the app is one page. Only the Settings page pushes history state
(`web/app.js`), so a task cannot be linked, bookmarked, or shared *to yourself*.
A finished task can be shared publicly (`/share/:token`) but the operator's own
copy has no URL.

**The others:** every web product has addresses; ChatGPT tasks are linkable and
reachable from the phone app; Claude Code has `claude-cli://` deep links.

**The phone half:** a PWA `share_target` in `web/manifest.json` makes WAIS
appear in the Android/iOS share sheet, so "Share → WAIS" opens the composer with
the link or the text already in it. That is the single most phone-native feature
in this list and it is a manifest entry plus a route.

#### 6. What it has cost, at a glance — S–M, not engine-blocked

**Today:** `/api/budget` exists and the usage line under an answer shows time
and tokens. There is no view that answers "what has this week cost me".

**The others:** usage and credit panels everywhere. The most common complaint
about the agent platforms is invisible cost (a 2026 review of Manus leads with
exactly that).

**Why it matters here:** freemium-only infra with one API key means the operator
pays; one screen with today, this month, per-task and per-day spends closes it.

#### 7. Outputs with a history — M, not engine-blocked

**Today:** artifacts are per run, with pin, download, preview and share
(`server/artifacts.ts`). Nothing shows the page this task built last round
against the one it built today.

**The others:** Replit checkpoints and file history, v0 and Lovable version
lists, ChatGPT's artifact viewer — the pattern is "every version, restore one".

**Why it matters here:** the design engine now builds a page per task. Seeing
v3 beside v7 and going back is the whole iteration loop.

#### 8. Projects — M–L, not engine-blocked

**Today:** a flat conversation list, global memory, and a sandbox per
conversation. Nothing groups "the client site", its files, and the rules that
apply to it.

**The others:** ChatGPT Projects, Claude Projects (instructions, files, sharing),
Manus knowledge and playbooks, Codex multi-repo projects and `AGENTS.md`-style
rules.

**Why it matters here:** "deep searching and big complex tasks" is
project-shaped. A project = conversations + files + standing instructions +
one sandbox, and the last of those already exists.

#### 9. A loop that grades past work — M–L, not engine-blocked

**Today:** feedback per answer, regression tests, run records, and one
mechanical judge (`server/design/gate.ts` `checkBuild`).

**The others:** datasets, scorers and experiments (the LangSmith pattern),
OpenAI's AgentKit evals and guardrails.

**Why it matters here:** the pending proof for the design engine — five briefs
built twice against a twelve-item rubric — is this, done by hand. A small eval
runner over past runs turns a one-off proof into a standing check.

#### 10. Connectors the operator can add — L, partly engine-blocked

**Today:** four integrations, each wired in code. Adding a fifth is a code
change and a deploy.

**The others:** Claude connectors (including custom MCP servers), ChatGPT's
plugin directory, Manus integrations with Zapier, Slack, Telegram, Line.

**Why it is last in tier 1:** at one operator, this is churn before it is
capability. It is the difference between a product with integrations and a
platform, and it should be a deliberate decision, not the next round.

### Tier 2 — needs the engine or the sandbox to expose something

| Gap | The others | Why WAIS cannot close it today |
|---|---|---|
| **Checkpoints and rewind** | Claude: Escape twice, `/rewind`; Replit: a checkpoint per step, restore the whole project | The API documents *resuming* an environment; it documents no snapshot or rollback verb. Until it does, the honest version is counters and a resume, not undo |
| **A live view of the desktop** | Manus's Computer window, Devin's IDE, Codex computer use | The managed agent runs remotely and returns text, steps and artifacts; no screen stream |
| **Parallel sub-agents / wide research** | Manus Wide Research fans out sub-agents in parallel | One interaction is one agent. WAIS's deep research chains passes under a time budget, which is the cheap version |
| **Model or reasoning choice** | Every platform has a picker (and Codex a reasoning level) | `ENGINE` is an env var (`server/config.ts`) and the agent id is fixed config; a picker needs the API to take a per-request choice |
| **Your own browser and logins** | Manus Browser Operator, Codex's Chrome extension | The sandbox is remote and clean; it has no session to borrow |
| **Documents, audio, video in** | PDFs and audio uploads everywhere | The Antigravity doc says only text and image are supported today. Mounting a text-ish file with `environment.sources` covers part of the gap now |

### Tier 3 — deliberately not on the list

Teams and collaboration (Manus Collab, Replit team spaces, ChatGPT shared
tasks), roles, SSO, org analytics, audit exports, a public API and a
marketplace. WAIS is one operator on one key, by design, and the phone is the
collaboration surface. Adding seats would mean accounts, permissions, billing
and a support surface — none of which is what this product is for.

---

## 3. Where WAIS is already ahead

Worth writing down, because an audit that only lists what is missing is how a
product talks itself into rebuilding itself.

1. **Control from a chat app.** Approvals arrive on the phone as YES/NO, tasks
   report when they are done, a morning digest summarises, breakage alerts fire,
   and mail and calendar are fenced read-only (`server/whatsapp/*`,
   `server/google.ts`). None of the coding agents can be approved from WhatsApp.
2. **A sandbox that lasts across tasks.** Continuation handles are stored and
   reused, so the second ask builds on the first one's actual workspace. Most
   chat products carry context; this carries the *workspace*.
3. **A public replay by link.** `server/share.ts` builds the page from an
   allowlist so a new field on a run can never leak into it. Manus's replay is
   behind product login; this is a URL anyone can open, and revocable.
4. **Memory you can read, edit and see being used.** `/api/memory*` plus
   `memory.recall` events on the card. Claude's and ChatGPT's memories are a
   black box you can mostly only delete.
5. **The raw frames.** The stream itself is inspectable in the panel, not just
   the pretty reading of it. Almost nobody exposes this.
6. **Attachments that never leave the device.** Read in the browser, folded into
   the request (`server/attachments.ts`). A file that is never uploaded cannot
   leak from a server.
7. **A quota guard that refuses instead of quietly spending.** The refusal is
   the wrong *answer* (gap 2) but the right *instinct*: on a freemium key, a
   product that silently drains a day's allowance is the bug.

---

## 4. The recommended order

1. **Images in, and mount big files** (gap 1). Cheapest real capability gain,
   documented by the API, and it makes the design work actually usable.
2. **The queue** (gap 2). Removes a dead end on the surface the operator uses
   most, and it reuses the done-ping.
3. **Steer a running task** (gap 3). Reuses cancel and resume; saves the
   expensive failure.
4. **Event-triggered tasks** (gap 4). Rides the poller, the fences and the
   scheduler that already exist.
5. **Deep links and the phone share sheet** (gap 5). Small, and the most
   phone-native win available.

Then: cost at a glance, artifact history, projects, the eval loop. Connectors
and Tier 2 wait on a decision or on Google.

---

## 4b. What remains, reconciled (second pass, same day)

A second read, this time of the platforms the first pass did not cover —
**Cursor 3**, **Devin 3**, **Google AI Studio's own Build mode** (the reference
product), and the open/agent-platform layer — checked against what has shipped
since. Same rules: every WAIS claim carries a file, every platform claim carries
a source in section 6.

**Shipped since the first pass:** the run timer and its spinner (`fcf9a2c`), the
same clock in the top bar and the tab (`6720649`), and pictures in the composer
(`9b1a89c`).

| # | What remains | Who has it | Blocked by the engine? | Size |
|---|---|---|---|---|
| 1 | **The queue** — the second ask waits its turn instead of being refused | Cursor 3's Agents Window, Codex/ChatGPT task list, Manus multi-task | No. The engine is still one at a time; this is ordering plus the done-ping | M |
| 2 | **Steering a live task** — "no, the other folder" without killing it | Manus ("intervene and redirect at any point"), Cursor background agents ("take over at any time") | No. Cancel and resume already exist | M |
| 3 | **Annotate the preview** — draw on the built page and say "this bit" | AI Studio Build's edit tool (draw on the app, tweak components) | No, but it needs a real preview surface first | M |
| 4 | **Checkpoints and rewind** — go back to the version before it broke | AI Studio ("jump back to previous checkpoints", compare code versions), Claude `/rewind`, Replit per-step checkpoints | Yes, for a true snapshot: the API documents resume, not rollback | M–L |
| 5 | **Design-to-code from a picture** — now partly possible | Cursor Design Mode (Figma, screenshots, sketches) | No longer blocked: images ship, so a screenshot can drive a build | S |
| 6 | **One-click deploy / a live URL for a built page** | AI Studio → Cloud Run; Replit custom domains; Manus `manus.space` | No. This is the biggest missing *ending* for a site-builder | M–L |
| 7 | **Event-triggered tasks** — run when mail/PR/message lands | ChatGPT scheduled tasks with webhooks (Gmail, Slack, GitHub) | No. Poller, fences and scheduler all exist | M |
| 8 | **Deep links + the phone share sheet** | ChatGPT task links, `claude-cli://` deep links | No | S |
| 9 | **Cost at a glance** — today, this month, per task | every platform's usage panel; Manus reviews lead with cost surprise | No. `/api/budget` exists | S–M |
| 10 | **Artifact history** — version list per output, restore one | AI Studio version compare, Replit file history, v0/Lovable versions | No | M |
| 11 | **Projects** — conversations + files + standing rules in one place | ChatGPT Projects, Claude Projects (instructions/files), Manus knowledge, Codex multi-repo + rules files | No. Continuation gives the shared sandbox already | M–L |
| 12 | **An eval loop over past runs** | OpenAI AgentKit evals and guardrails; the LangSmith pattern | No. Feedback, run records and `checkBuild` already exist | M–L |
| 13 | **Connectors the operator can add (MCP)** | Cursor, Claude connectors, ChatGPT plugins, AI Studio's MCP support | Partly. The agent accepts tools; the operator-facing registry is ours | L |
| 14 | **Parallel sub-agents** | Cursor (up to 8 subagents), Manus Wide Research, Antigravity itself (multi-agent orchestration, async task management) | Yes: one interaction is one agent. WAIS chains passes instead | L |
| 15 | **A live view of the sandbox** | Manus's Computer window, Devin's IDE | Yes: the managed agent returns text, steps and artifacts, no screen | L |
| 16 | **Model / reasoning picker** | every platform; Devin and Cursor pick models per task | Yes: agent id and model are configuration here | M (when the API allows) |

**Two findings from this pass worth acting on:**

* **Images are now doubly justified.** AI Studio's Build agent generates its own
  imagery on the fly and takes drawings on the preview; Cursor's Design Mode
  reads Figma files, screenshots and sketches. The picture path shipped
  yesterday is the same primitive those two build on. Item 5 is now a small
  follow-up, not a project.
* **The ending is the real gap.** Of the sixteen, only item 6 changes what the
  operator *gets* at the end of a build: a page with an address they can open
  and send to someone. Everything else improves the middle. That is the item I
  would argue hardest for after the queue.

**Next three, in order:** the queue (1, shipped — section 4c) → steering (2, shipped
— section 4d) → deploy a built page to a
live URL (6).

**Still deliberately out:** teams, seats, SSO, org analytics, audit exports, a
public API, a marketplace (section 3, tier 3), and — new to this pass — computer
use, which Devin and Cursor justify only with a local desktop WAIS does not have.

---

## 4c. Round twelve — the queue, shipped

The first item on the remaining list, built. The second ask is no longer refused.

**What changed, in the operator's words:** you send a second task while the first
is running. It used to answer "another task is already running" and that was
that — the thought was gone. Now the task is accepted, recorded and parked, and
it starts by itself the moment the first one finishes. On the phone the reply
says where it sits in the line; on the web the card says "Next in line" and what
it is waiting behind, with no spinner and no clock, because nothing is working
yet.

**What was deliberately kept:** one task at a time. One key, one daily
allowance, one agent — the guard is unchanged, and it is still the database's
partial unique index that enforces it rather than any application code.

**Verified live** (scripted engine, a local instance): three asks in a row, the
first running, the other two parked at positions 1 and 2. The line drained by
itself, in order, with no operator action. The promoted task's own stream opens
with `run.queued {started: true, position: 1, waitedMs: 36772}` — the wait is on
the record, and the run's clock restarted at the moment the work did: asked at
03:06:11, started at 03:06:47.

**Where the queue lives:** `server/queue.ts` (the pump), `server/migrations/024`
(`'waiting'` as a status outside the single-active predicate),
`claimWaitingRun` in `server/runs.ts` (one statement: out of the line, clock
restarted, slot claimed).

**Also fixed, because it was measuring wrong:** `npm test` reported three
different totals for one unchanged tree — 1040, 1051, 1037 — every one of them
"0 fail". The parent process held `--test-force-exit`, so a file's results could
land after it had already exited. The flag now goes to the child processes that
need it and the parent waits for the reporter to drain; the suite reports the
same number every run, and refuses to report at all if it ends without a summary.

---

## 4d. Round thirteen — steering a live task, shipped

The second item on the remaining list. Until now a task in flight had exactly two
fates: let it finish, or kill it and start over. Deviations had no expression —
the operator watched a task go the wrong way and had the choice of waiting for a
wrong answer or losing the work already done.

**What a steer is, precisely:** the same run, continuing. The pass in flight is
stopped, a new pass starts inside the same run, with the same sandbox, the same
answer so far, the same trace and the same charge against the day's allowance.
The note rides on the wire only — the stored prompt stays exactly what the
operator wrote — and it is labelled as newer than the original request, with an
explicit instruction to keep what is already done rather than begin again.

**Why the sandbox survives.** A steer only works if the second pass inherits the
first one's handles, and those are announced seconds into a task, not at the end
of it. The engine now hands `{interactionId, environmentId}` to the executor the
moment it learns them (`EngineContext.continuation`), the executor keeps them in
memory for the next pass and on the row for a crash, and the pass after a steer
is handed the *live* pair rather than the null the run started with. Without
that seam a "steer" would quietly become a second task in someone else's
workspace.

**What the operator sees.** A chip in the composer appears while a task runs:
off, the text is a new ask and takes its place in the line (round twelve); on,
the same text corrects the task in flight. That is the one state where the
composer is genuinely ambiguous, so the operator says which — the composer never
guesses, because guessing wrong is how work gets thrown away. On the card, the
correction is drawn where it happened, above whatever it changed, marked "You
corrected this task" with the second one counted.

**Verified live** (scripted engine, a local instance, task slowed 10x):

* one ask, steered 4 seconds in — `run.steered {note, count: 1}` lands between
  the thinking snapshots, the run stays `running` on the same id, and it
  completes 20 seconds later with one final answer;
* two steers on one run — counts 1 then 2, in order, on one card;
* a second ask sent while that run was live — parked as `waiting` at position 1,
  promoted by itself after the steered task finished, and completed; queue and
  steering coexist;
* a steer against a finished run answers 409 with a sentence ("That task is not
  running any more. Send a follow-up message instead."), not a silent no-op;
* stop beats steer: a cancel after a steer clears the pending note, and the pass
  that was live stays stopped (`server/runs.test.ts`, "cancelling during a steer
  is still a cancel").

**Where it lives:** `Executor.steer()` / `takeSteerNotes()` (a steer is
abort-with-a-note; a stop clears the notes on its way out, so a stop always
wins), the pass loop in `execute()`, `steerPreamble()` on the wire,
`POST /runs/:id/steer`, and `refreshSteerChip()` / `markSteered()` on the client.

---

## 5. Shipped while this audit was being written

Two things on this list are no longer gaps:

* **The run timer and the spinner beside it** (`fcf9a2c`, extended `6720649`) —
  the clock is a stopwatch seeded from the run's own start time, so a task that
  reconnects three minutes in shows three minutes rather than restarting at
  zero; the phase sits on the panel head where the body cannot scroll it away;
  and the same number now runs in the top bar and in the tab title, because the
  panel scrolls and the operator leaves. This is the AI-Studio pattern: the
  spinner says the task is alive, the clock says how long it has been. Checked
  on the wire — `run.started` carries `startedAt`.
* **Pictures as attachments** (gap 1) — the composer takes screenshots now,
  read in the browser, carried in the request, shown as thumbnails, capped and
  refused in sentences. The pixels are never written to a row.

Still open from the list: event triggers, deep links and the share
sheet, cost at a glance, artifact history, projects, the eval loop, and
connectors. (The queue is closed — see section 4c.)

---

## 6. Sources

Platform claims above, and where they were read (all fetched 2026-09-24):

* **Claude Code 2026 features** — subagents, skills, hooks, checkpoints
  (`Escape` twice / `/rewind`), background tasks, `/loop` scheduled tasks, Agent
  SDK, plugins:
  <https://www.marktechpost.com/2026/06/14/claude-code-guide-2026-25-features-with-examples-demo/>
  and <https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html>
* **ChatGPT / Codex** — Codex merged into the desktop app with inline diff
  editing and PR review in the side panel; scheduled tasks that run on a
  schedule, on a trigger, or while monitoring, including webhooks for new Gmail
  mail, Slack messages and GitHub pull-request activity; memories; multi-repo
  projects: <https://developers.openai.com/codex/whats-new>,
  <https://help.openai.com/en/articles/6825453-chatgpt-release-notes>,
  <https://learn.chatgpt.com/docs/changelog>
* **Manus** — cloud browser and Browser Operator, My Computer, Wide Research
  (parallel sub-agents), scheduled tasks, Mail Manus, Manus Collab, API and
  integrations, replayable sessions, "Manus's Computer" side panel:
  <https://work-management.org/website/manus-review/>,
  <https://sidsaladi.substack.com/p/manus-ai-101-the-complete-guide-to>,
  <https://workos.com/blog/introducing-manus-the-general-ai-agent>,
  <https://future-stack-reviews.com/manus-ai-review-2026/>
* **Replit / v0 / Lovable** — checkpoints and rollbacks per step, file history,
  custom domains, secrets, deployment and databases:
  <https://releasebot.io/updates/replit>,
  <https://www.rapidevelopers.com/replit-tutorial/how-to-leverage-replit-s-auto-save-and-version-history-for-continuous-development>,
  <https://www.shipai.dev/blog/replit-deployment-guide-custom-domains-secrets-databases-monitoring>
* **Cursor 3 / Devin 3** — Agents Window with parallel worktrees and cloud
  agents, Design Mode (Figma, screenshots, sketches → components), Bugbot PR
  review, background agents you can take over; Devin's interactive planning and
  dynamic re-planning, Slack/Teams/Jira/Linear:
  <https://baeseokjae.github.io/posts/cursor-3-guide-2026/>,
  <https://www.morphllm.com/comparisons/devin-vs-cursor>,
  <https://aitoolanalysis.com/cursor-ai-review/>
* **AI Studio Build mode** — the reference product: checkpoints and code-version
  compare, drawing on the preview to iterate, one-click deploy to Cloud Run,
  export to Antigravity, generated imagery, Workspace data, MCP, structured
  outputs: <https://developers.googleblog.com/google-ai-studio-native-code-generation-agentic-tools-upgrade/>,
  <https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/>,
  <https://www.datacamp.com/tutorial/google-ai-studio-tutorial>
* **The agent under WAIS** — multimodal input (text and image, inline base64;
  audio, video and documents not supported yet) and `environment.sources`
  inline file mounts: <https://ai.google.dev/gemini-api/docs/antigravity-agent>
