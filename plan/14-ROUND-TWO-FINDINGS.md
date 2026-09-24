# 14 — What I found when I kept looking

Round two on the phone bugs. The first six were fixed in `9cdc253` and made
reachable in `b22f0be`; this is what a slower read of the same surfaces turned
up. Pushed as **`32eadb7`** and confirmed live (`/healthz` reports that commit).

**710 tests pass, 0 fail. `npm run lint` green (server + web).**

---

## The pattern

Three of the four were the same shape: **the server did work the interface never
showed.** Not crashes — silences. That is worse than a crash, because the
operator concludes the feature does not exist (or that the agent is stuck), and
nothing anywhere says otherwise.

### 1. The agent was told to think in "missions" — and said so back

The interface was renamed to *task*; the wire prompts were not. So the planning
contract ("this mission is complex"), the deep-research passes ("Work this
mission exhaustively", "This is the SAME mission"), the Google and design
preambles and the continuation prompt all still taught the agent the old word —
which the agent dutifully echoed into the answer the operator reads. Your
screenshot says it exactly: *"Please provide the details or instructions for your
**mission**."*

Fixed everywhere the model or the operator can read it:

| Surface | Before → after |
|---|---|
| Planning contract + plan-only pass | "this mission is complex" → "this task is complex" |
| Deep research (first pass + continuations) | "Work this mission" / "SAME mission" → "task" |
| Google + design preambles | "during this mission" → "during this task" |
| Engine failure copy | "The mission was closed…", "rate-limited the mission", "refused the mission" → task |
| Public replay page | `<h1>Mission replay</h1>` → **Task replay** |

Identifiers (`mission_steps.ts`, `getMissionSteps`, the `mission_steps` table)
are deliberately untouched: nobody reads them, and renaming them is churn.

A test now scans **every string literal** in the four prompt files — comments
stripped, `${…}` interpolations ignored — and the client's own strings, and fails
on the word.

### 2. "Sandbox ready" printed a 32-character hex handle

Your screenshot shows `5d6e8e626738529572b7fd878275db97` under that step. It
means nothing to you and it reads like a rendering bug. The event now carries
`continued`, and the step says **"continuing the earlier workspace"** or **"a
fresh workspace"**. The id is still in the run record.

### 3. Source checks were invisible

Every research answer's links are fetched by the server (HEAD, short timeout) and
reported as a `sources.checked` event: *"3 links dead"* instead of shipping
unverified citations. The event was written on every run, the client even had a
`case 'sources.checked':` handler — but the event was **never in the stream's
listener list**, so the whole thing was dead code and the operator never saw it.

Fixed, and pinned: a test walks the server sources for every `writer.write('…')`,
then fails if the client neither listens for it nor handles it. That class of bug
cannot come back silently.

### 4. You could not keep a file from the phone

The pin endpoint from problem #5 had no way to reach it. Now the outputs panel
rows and the file chips under an answer both carry a **Keep** toggle:

- `Keep` → `Keeping…` → **`✓ Kept`** (green-tinted chip, "· kept" in the label)
- Tapping again stops keeping it; the file then ages out normally
- The chip row and the panel repaint from the same record, so they cannot disagree
- A file that cannot be pinned (never built, or a sandbox that has expired) says
  **why** instead of failing silently — the server's `409` message is surfaced

### Bonus: one status list, not two

`'completed', 'failed', 'cancelled'` appeared in two places and they had drifted —
the stream-end check learned about `'paused'`, the foreground-return check did
not. So a run that paused while the phone was in your pocket came back as
**"Working…" with a stream that could never speak again** — the same
"it's still running" symptom from your message, from a different cause. There is
one `TERMINAL_STATUSES` list now, used by both.

---

## Tests added

| File | What it pins |
|---|---|
| `brand.test.ts` | no "mission" in any literal sent to the model or shown in the client |
| `share.test.ts` | the public replay page says task, and the heading is `Task replay` |
| `web_client.test.ts` | every emitted event is listened to **and** handled; one terminal-status list; the Keep button exists and its failure explains itself |
| `pipeline.test.ts` | `run.environment` carries `continued`; a fresh conversation gets `false`, a follow-up gets `true`; the client never renders the raw id |
| `plan_preview.test.ts` | updated for the reworded contract |

## Trying it without waiting for Render

A **tappable preview** of this exact build is running in the workspace: the real
server, the real client, the scripted engine (tasks finish in seconds, spend no
budget, and never touch Google). Access key: **`wais-preview`**.

Two honest caveats about it: the scripted engine fabricates the *names* of files
(`index.html`, `app-debug.apk`) without building them, so **Download** and
**Keep** explain that there is nothing to read — the real engine does produce
them; and its database is a throwaway, so it starts empty apart from the task I
seeded.

## Still open (unchanged from `13`)

- **Rotate `ACCESS_KEY`** — it has been in transcripts.
- **A greeting still spins up a sandbox.** Now that the UI is honest about it,
  the remaining fix is a product decision: when does a task actually need a
  workspace? Worth doing, not worth guessing at.
- **Render hours** — the 11-minute ping consumes nearly the whole pooled free
  allowance; letting it sleep at night is now cheap thanks to the hourly
  maintenance tick.
