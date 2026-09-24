# Round nine — why a task showed nothing for minutes, and Settings rebuilt

Two requests came in together:

> "Get some ideas from Claude connectors and other platforms and completely
> redesign the settings screen."

> "The response is coming too much late … couple of minutes without showing any
> live stream. Find the root of that problem, not another surface fix."

One of them was a real bug with a real root, and this file records it. The other
is a design change, and this file records the rules it was built on.

Build: `05c4945` is the tip. Root-cause fix `5344818`; Settings `b82342f`; the
focus-ring repair `6ba9cba`; the older-shell guard and the render/end-to-end
verification `93f1dd8`, `05c4945`. Suite at the tip: 219 suites, 895 passing, 0
failing; lint clean. Every claim below has a test that fails if it comes back.

---

## 1. Minutes of nothing, and the root of it

**What he saw.** A complex task submitted, then "a couple of minutes without
showing any live stream" — and, in the screenshot, one line: *"Still thinking —
retrying the request."* Nothing else moved.

**What the code actually did.** Two separate silences had been collapsed into
one symptom, and only one of them was the stream.

The first was the shape of the request. For any prompt `looksComplex()` liked,
`acceptRun()` (`server/accept.ts`) called `executor.planMission()` and **awaited
it before answering `POST /api/runs`**. That call is a full engine interaction:
it streams the model's own milestone list, it has a 60-second abort, and when
the model is slow or rate-limited it runs the retry ladder — 20s, 40s… So the
one request whose whole job is to hand the browser a run id to watch was the
one request that sat on the model for up to a minute, twice on a bad day. The
browser had nothing to attach to, so it had nothing to show. **That is the root
of "no live stream": the stream could not exist until planning was over, and
planning was the slow part.**

The second silence was inside the engine's own socket. Once the run *was*
streaming, a task could still show nothing but the retry line: the retry ladder
emits a line when it retries, and between retries the model simply had not sent
a frame yet. Silence there looked exactly like a hang, because nothing said
otherwise.

**What changed.**

- `planning` is a real status. Migration `022_planning_status.sql` extends the
  `runs_status_check` constraint and **recreates** `runs_single_active_idx`
  (a partial index's predicate cannot be altered) so a run being planned still
  holds the single active slot — otherwise a second task could start executing
  while the first was unapproved. `getActiveRun`, the WhatsApp digest, the
  boot-time staleness sweep and crash recovery all learned the status.
- `acceptRun` answers immediately with the run in `'planning'` and does the
  drafting in the background. The returned promise rides along on the result
  (`planning?: Promise<void>`) so a test can await the outcome; the real callers
  — `routes/runs.ts`, `main.ts`, the scheduler — deliberately ignore it.
- The pass now streams everything through one serialised writer:
  `run.plan_started` the moment it begins, `plan.milestone` as each step is
  named, the engine's own `log` lines (including the silence heartbeat below),
  and `run.plan_ready` last, when there is a plan to approve.
- Stop cancels the pass: the planning call registers itself in the executor's
  active map like any other run. A run left in `'planning'` by a restart is
  failed as `interrupted` (`server/recovery.ts`) rather than holding the slot
  for the hour the staleness sweep would have taken — and it is never started
  executing unapproved.
- The engine now says when the model has gone quiet (`ad56452`): after 20
  seconds with no frame it logs "No words from the model yet — 45s in. The
  request is open.", and repeats every 15 seconds until words arrive. It is one
  rewritten row in the panel, not a row per beat.
- The client has an honest state for all of it: the card is up from the first
  second saying *"Working out the plan — nothing runs until you approve it"*,
  the steps appear inside it as they are written, a clock counts, `'planning'`
  counts as a live run (so a reload finds the card), and the header says
  "Planning…" rather than "Working…".

**Tests that hold it.** `plan_preview.test.ts` proves the response arrives
before a deliberately slow plan does, and that the milestones stream in order
during it; `accept.test.ts` and the HTTP test prove the 201 carries `'planning'`
and that the announced events are durable; `orphans.test.ts` proves a planning
run is failed as `interrupted` and never started; `web_client.test.ts` pins the
drafting card, the clock, and `LIVE_RUN_STATUSES`.

**What is still not proven:** how the model behaves when it is genuinely slow.
The heartbeat makes the wait legible; it cannot make the model faster.

---

## 2. Settings, rebuilt as a directory

**What he saw.** Settings was the one surface the overhaul had never touched:
raw key/value rows with bare inputs, `Replace` buttons beside hashes, and the
descriptions the server has sent since day one sitting unseen. The request was
specific — take the ideas from Claude's connectors screen and the platforms like
it — and that pattern is worth copying because it is the one people already know
how to use: **one searchable list of named things, each showing what it is, what
state it is in, and one obvious action.**

**What changed.**

- A search box filters settings and connections together. It lives *outside* the
  re-rendered body (`#settings-search` in `web/index.html`, `#settings-body`
  below it) because an input that is re-created between keystrokes loses focus
  and, on a phone, the keyboard.
- A setting is a question, its answer, and the reason it exists. The
  description is finally rendered; the current value sits on the row; the
  control opens underneath it (`aria-expanded`, focus moved into the field)
  instead of standing beside the label. The page reads as sentences rather than
  as a form of nine inputs.
- A connection is a card: name, state pill, what it unlocks, its fingerprint and
  when it was last saved, then **one primary action** — `Add key` or `Replace
  key` — with `Test it` and `Remove` as secondaries that wrap rather than
  compress.
- The state pill is honest in four states: `Connected` (saved here, or from the
  environment), `Not set`, `Needs attention` (present but undecryptable because
  `MASTER_KEY` changed), which is a state the old page showed as "not set"
  while the key *was* set.
- Sections carry counts — "How it runs · 3", "Connections · 2 of 8 set" — the
  page still says changes apply immediately, and the build line survives as its
  own row, because it is the first thing worth checking when a fix seems
  missing.
- Mobile rules from the app-class guidance: rows are 44px targets, no surface
  nests a scroll, every row wraps instead of overflowing, and the filter reports
  "Nothing matches that" rather than an empty page.

**Tests that hold it.** A `describe('Settings is a directory, not a form')` block
in `web_client.test.ts` pins the search box and its placement, the four honest
states, the one-primary-action rule, the description being rendered, the editor
opening under the row, and the no-nested-scroll and 44px rules in the
stylesheet.

---

## 3. Two smaller things, found while in there

- **The focus ring on the two most-used fields.** `.composer textarea` and
  `.drawer-search input` both suppressed their outline with `outline: 0` — the
  same declaration as the `outline: none` the focus audit was written to catch,
  spelled the one way it did not look for. The composer is the field the whole
  app is typed into and the drawer search box is the front door, so both were
  the worst two to lose. The audit now catches any suppression outside
  `:focus-visible`, and the suppressions are gone: the global
  `:focus:not(:focus-visible)` rule already keeps the ring away from a mouse.
- **The drawer's active row** carries a hairline of the accent on its leading
  edge, so recents stop reading as a wall of identical rows.

---

## 3b. Two things verification turned up, and one it added

**The release could have broken the phones one version behind.** The Settings
filter box is part of the shell, and its wiring ran unguarded at boot:
`el.settingsSearch.addEventListener(...)`. `$()` returns null for an element
that is not in the document, and the shell a phone is actually running can be
the previous one for a load — the service worker is network-first, but when the
free-tier server is cold a navigation falls back to the cached page after six
seconds and the real one arrives afterwards. On that phone the line threw, and
the throw took every listener bound after it with it: the app looked untouched
because it had stopped booting. The binding is now guarded, and the service
worker's cache name is bumped to `wais-v5` — the documented rule for a shell
change. `shell_cache.test.ts` pins both.

**The connections are shelved.** "The engine", "Your phone", "Code and files",
"Accounts you link" — each with its own count, and a "More connections" shelf
for any key the map has not heard of, so a new secret cannot silently vanish.

**And the page is now tested by running it.** `server/settings_render.test.ts`
executes the real render functions against a real `/api/settings` payload in a
vm with a four-member DOM stub, and asserts the HTML has no holes, the three
honest states appear, the primary action is worded correctly, and the filter
narrows the page. The heavy-user walk gained an end-to-end measurement of the
fix in section 1: a complex task accepted in under 400ms while still
'planning', findable at `/api/runs/active`, streaming `run.plan_started` and its
milestones before `run.plan_ready`.

## 4. Still open, and said plainly

- **The sidebar** is grouped, truncated, hoverable and dated, but it has not had
  the full professional pass: row height, the footer's balance, and what a
  long-running task looks like in the list are all still open questions.
- **The mode-sheet auto-open** remains unreproducible in the code — every
  `hidden = false` in the client was enumerated and only `openModeSheet()` ever
  unhides it. It is closed by removing the modal, not by finding the cause, and
  that is the honest record.
- **The planning pass is still a second engine call.** Complex tasks now stream
  while it runs, but they still pay for the plan before execution: one more
  round-trip than a task that just started.
