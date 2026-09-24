# Round ten — two proposals, no code

Two requests, both answered here as plans:

1. **Stream the raw response, the reasoning and the decisions live** — "as we said
   to the agent that send the raw response and thinking and decisions also so we
   will stream them as a live thinking as you do."
2. **Make WAIS capable of building 2070-grade websites** — the current output is
   "too much formal and old type", and the ask is a solution, with the research
   done first.

Nothing in this file is built yet. No product code was touched. This is the plan
to approve, change, or reject.

---

# Part A — the live trace

## A1. What the app does today, verified in the code

I read the stream path rather than remembering it. The plumbing is further along
than I expected, and being precise about that changes what is worth building.

| What | Where | State |
| --- | --- | --- |
| Answer text, live | `server/executor.ts` publishes `bus.publishTransient(run.id, 'text.delta', { chunk })`; `web/app.js` handles `case 'text.delta'` and re-draws | **already streaming** |
| Thinking, live | same file: `bus.publishTransient(run.id, 'thinking.delta', { chunk })` → `case 'thinking.delta'` appends to `card.thinkingTail` | **already streaming** |
| Reconnect | `thinking.snapshot` / `text.snapshot` are durable and reconcile the tail | **already correct** |
| Tool calls, results, files, logs | `tool.call`, `tool.result`, `artifact`, `log` → rows via `addStep()` | **already there** |
| The engine's own line when the model is quiet | heartbeat every 15s after 20s of silence | **already there** |

So "the raw response does not stream" is not true any more — and it is worth
saying that plainly rather than rebuilding something that works. What is missing
is **what the stream contains and how it reads**:

1. **Reasoning is not what is on screen.** The backend only sometimes exposes a
   reasoning channel. `server/engine/antigravity.ts` asks for it
   (`thinking_summaries: 'auto'`, retried as `THINKING_SUMMARIES_AUTO`), and the
   code comments record what happens when the backend refuses: the engine falls
   back to `data.step.summary` — the agent's *narration of what it is doing* —
   and forwards it to the thinking channel as "the closest thing this stream
   gives us to a reasoning trace". On a run where that field is refused, the
   panel shows a summary feed and calls it Thinking. That is the gap.
2. **Decisions are never voiced.** A tool call arrives as a row with arguments.
   Nothing says *why* it chose to search instead of write, what it rejected, or
   which plan step it just committed to. The model makes those choices and the
   wire carries no sentence about them, because nobody asked it for one.
3. **The panel has no cadence.** `thinkingTail` and `answerTail` are strings that
   get re-drawn. There is no caret, no line-per-thought, no auto-scroll pin, no
   distinction between "thinking", "decided", "called a tool", "found
   something". A live stream that repaints a paragraph reads as a text box, not
   as a mind at work.
4. **There is no raw view.** Nothing lets you see the unfiltered frames — which
   is what you asked for first, and is also the only honest way to answer "is the
   model thinking or is the app stuck".

## A2. The honest limits (this decides the design)

The model is a hosted agent engine. We cannot make it emit reasoning it does not
send, and we must not **fake** reasoning — a plausible invented thought stream
would be a lie the whole product rests on. So there are exactly two sources:

- **Real reasoning**, when the backend exposes it (`thought_summary` deltas, a
  `thought` step with content parts, or the sibling `reasoning`/`thinking` keys
  the engine already probes). Streamed verbatim, sanitized, labelled *Reasoning*.
- **The model's own narration**, always available (`step.summary`), labelled
  *What it's doing*. Never dressed up as reasoning.

And for decisions there is a third, real option: **ask for them**. A short wire
instruction on complex tasks — "state one line of why before each tool call" —
produces genuine decisions from the model itself. They are the model's words,
not ours, and they cost a few tokens per step. This is the only way to show
decisions the model would otherwise never speak.

## A3. What to build

**A3.1 A trace feed, not a paragraph.** Five row kinds with their own icon and
colour token — `Thought`, `Decision`, `Tool`, `Result`, `Milestone`. Each lands
as its own line, with a short `+3s` delta on the right so the rhythm of the run
is visible. The live line carries a caret while the run is live.

**A3.2 Real reasoning where it exists, honest narration where it does not.** The
panel head says which one you are looking at — *Reasoning* or *What it's doing* —
and switches on its own when a run starts sending real thought. No silent
substitution.

**A3.3 The decision protocol.** For complex tasks, the wire prompt gains one
line: before each tool call, emit `WHY: <one sentence>`. The parser lifts those
into `Decision` rows and strips them from the answer text, so they never leak
into the deliverable. Cost: a sentence per tool call. Benefit: the panel explains
itself, which is most of what "live thinking" means to a person watching.

**A3.4 A Raw switch.** In the thinking panel head, `Raw` shows the unfiltered
frames the client received (type, name, payload, time), newest last, virtualised
so a 2,000-frame run does not melt a phone. Off by default, remembered per
device. This is the debugging surface and the answer to "is it working".

**A3.5 The shape of the wait.** While nothing has arrived: the heartbeat line,
the elapsed clock, and the current phase ("drafting the plan", "on step 3 of 7"),
so a slow minute has a shape instead of a spinner. Already half-built; this makes
it one line with three parts.

**A3.6 Reconnect is already right, keep it that way.** Snapshots reconcile, tails
reset, deltas resume. The tests that pin "no duplicate fragments across a
reconnect" must be extended to the new row kinds.

**A3.7 Raw and reasoning are different switches, one place.** Panel head:
`Reasoning | What it's doing` (auto) and `Raw` (on demand). No third toggle.

## A4. Tests

- a delta arrives → one row per fragment, no duplication after a snapshot
- reconnect mid-thought → the feed continues, the caret returns only if the run is live
- `WHY:` lines become Decision rows **and never appear in the answer body**
- narration is labelled as narration; a run with real reasoning is labelled Reasoning
- Raw view renders a long run without unbounded DOM growth
- non-complex tasks pay zero extra tokens for the decision protocol

## A5. Effort, risk

About a day of work, no backend dependency, works today on narration alone and
gets better the moment the reasoning channel answers. The only real risk is
token cost from the decision protocol — capped per step, gated to complex tasks.

---

# Part B — making WAIS build 2070-grade sites

## B1. Why the output looks old (the diagnosis, in the code)

1. **The house style is literally an instruction to be restrained.**
   `server/ui-design-guide.md` is 92 lines titled "warm, minimal, quiet" and its
   final section is "Restraint". `server/design.ts` injects it on UI tasks. The
   engine is doing exactly what it was told. This is the single biggest cause and
   it is mine.
2. **There is no art-direction step.** The build starts at "what files?" and
   never answers "what is this thing's visual world?". Every page therefore
   converges on the same safe default: centered hero, three cards, one gradient.
3. **There is no imagery or asset system.** Typography and boxes alone are what
   2015 looks like. The best sites in every category are carried by art direction
   — photography, 3D, motion, texture — and we supply none.
4. **Nothing checks the output.** Any HTML ships. No contrast check, no
   placeholder check, no motion check, no "is there a single memorable moment".
5. **There is no second pass.** One shot per prompt, no way to say "bolder", "calmer",
   "different world" — which is most of how the good builders get good output.

## B2. The research: ten categories, and what the best in each actually do

Top-of-category sites read, in each case, because of two or three repeatable
moves — not because of one clever effect.

| Category | The ones worth studying | The moves that carry them |
| --- | --- | --- |
| Immersive 3D & studio sites | Lusion, Active Theory, Bruno Simon's driving portfolio, Unseen Studio, Obys, Studio Freight, Resn, MONOGRID, Locomotive | A full-bleed real-time scene *is* the page; cursor and scroll drive the camera; emissive accents on deep black; chromatic aberration and bloom; page transitions treated as theatre; hard 60fps discipline |
| Editorial luxury commerce | Aimé Leon Dore, Jacquemus, The Row, Hermès, SSENSE, Moncler, Net-a-Porter | Silence and enormous whitespace (The Row); world-building where campaign imagery flows into shoppable pages (Jacquemus); taste as positioning (SSENSE); two or three colours with one signature accent (Hermès orange) |
| Fintech, banking, SaaS | Stripe, Mercury, Ramp, Brex, Wise, Revolut, Monzo, Plaid | Neutral grotesk type systems and motion restraint *as* the trust signal; a barely-there gradient with a static fallback (Stripe); calm editorial dashboards (Mercury); work-queues instead of chart walls, fewer forms not more chrome (Ramp); tabular figures for money; security as a destination page |
| Developer tools & docs | Resend, Vercel, Supabase, Clerk, Sentry, Postman, Linear, Raycast, Cursor | Docs in the primary nav; a live code snippet with language tabs above the fold; interactive demo instead of description; the product screenshot as the hero; machine-readable markdown as a new norm |
| AI products | Anthropic, Midjourney, Runway, Perplexity, Hugging Face, Cohere | Show output, never describe it; the product's own surface as the hero (a search box, a gallery); restraint as differentiation in a noisy category |
| Data stories & scrollytelling | NYT Snow Fall, The Pudding, Reuters Graphics, Bloomberg Visual Stories, Guardian Firestorm, The Deep Sea | Scroll position *is* the timeline; charts revealed in layers as you scroll; user-paced audio; the interaction mirrors the subject (depth as mechanism) |
| Architecture, interiors, travel, hospitality | White Desert, The Tuscan Journey, ERA Residence, Sobha Privy, visualisation studios (The Boundary, DBOX, Brick Visual) | Cinematic full-screen imagery; 360 tours, walkthroughs, real-time configurators; whitespace and photography doing the work; restraint as premium |
| Automotive & product configurators | Scout Motors, Decathlon, hardware-plus-software brands | The configurator is the hero interaction; scroll-driven product reveals; a physical object rendered with weight and light |
| Entertainment, music, personal brands | Lando Norris (site of the year), Trevor Noah, Paul Kalkbrenner, Mat Voyce, Gil Huybrecht, Jesper Landberg | Personality first; kinetic typography matched to the subject; hero reacting to the cursor; sound used deliberately |
| Craft benchmarks (quiet camp) | Anthropic, The Row, Vercel, Linear | Hairlines instead of boxes; one typeface doing all the work; space as confidence; motion that earns itself |

### The "2070" ingredients, extracted

Everything the top of the loud categories shares, in order of visual impact:

1. Deep-black or deep-toned canvas with **emissive accents** (cyan / amber / magenta) and glow
2. **Chromatic aberration, bloom, film grain** (2–5% noise) — the single cheapest "engineered" signal
3. **Liquid-glass surfaces**: `backdrop-filter`, 1px translucent borders, an inner highlight
4. **Spatial layering**: parallax depth, floating panels, scroll-driven camera moves
5. **Kinetic display typography** at `clamp()` scale, revealed per word or per character, variable weight responding to scroll
6. **Scroll-driven animation as structure** — now baseline CSS, no library required
7. A **real-time scene or shader gradient** in the hero, or full-bleed video
8. **Asymmetric bento / broken editorial grids** instead of three equal cards
9. **A custom cursor and magnetic buttons** — on fine pointers only
10. **One signature moment** per page: the thing someone remembers and screenshots
11. **Performance as craft**: transform/opacity only, 60fps target, `prefers-reduced-motion` honoured

And what makes a page look cheap, which the system must actively prevent: generic
AI imagery, centered hero + three cards + gradient blob, `border-radius: 8px`
everywhere, one font at three sizes, placeholder copy, blue links, default
shadows, motion with no job.

**Note the second camp.** Anthropic, The Row and Linear win by restraint. So the
answer is not "make everything loud" — it is **a system with several committed
directions**, where loud and quiet are both deliberate.

## B3. The solution: five parts

### 1. An art-direction system, chosen in the plan — eight directions

Replace the single house style with a registry of directions, each a complete
token set (palette rules, type pairing, grid, radius, motion curves, texture,
hero architecture, signature moment, and its own don'ts):

| Direction | For | Its signature |
| --- | --- | --- |
| **Nocturne** | tech, AI, tools, launches | deep black, emissive accents, glow, grain, glass |
| **Atelier** | fashion, jewellery, craft, food | near-silence, editorial serif, huge space, image-led |
| **Kinetic** | music, sport, events, culture | type as the hero, scroll-morphing, saturated blocks |
| **Cinematic** | travel, property, film, cars | full-bleed media, scroll-driven camera, slow fades |
| **Neo-brutal** | studios, fashion drops, editorial | raw grid, hard borders, one loud colour, zero radius |
| **Organica** | wellness, food, climate, education | soft gradients, asymmetric flow, rounded forms, warmth |
| **Blueprint** | docs, dev tools, data, systems | mono microtype, hairlines, tabular data, one accent |
| **Retail-polished** | shops, restaurants, local business | confident hero, real photography-led rhythm, trust above the fold |

The direction is **chosen during planning**, before any file is written, and it
appears in the plan you approve — "Direction: Nocturne — deep canvas, emissive
accents" — with one line of why. You can swap it before approving, or ask for one
by vibe ("make it feel like a 2070 luxury car site"), which maps to a direction
plus a small override list.

### 2. Token-first build

The first milestone writes `tokens.css` — palette, type scale, spacing scale,
radius, shadow, motion curves, grain amount — and **every later file may only use
those tokens**. This is the actual reason constrained builders look coherent:
not talent, restriction. It also gives the checker something objective to test
against.

### 3. Reference recipes and skeletons (the "training" answer)

We cannot fine-tune the hosted engine, so capability comes from what it is handed:

- **`server/design/recipes/<direction>.md`** — one page per direction: the exact
  palette/type/space recipe, the section-by-section skeleton, the motion spec,
  "always / never" lists, and two worked fragments of markup. Only the chosen
  direction's recipe is injected, so cost stays flat (~1.2k tokens).
- **`server/design/skeletons/*.html`** — a starting scaffold per page kind: hero,
  sticky-scroll story, gallery, bento features, pricing, configurator, editorial
  article, checkout. The engine adapts a real structure instead of inventing one
  from nothing. This is where most of the quality jump comes from.
- **Constraints from this repo:** `brand.test.ts` walks every non-test file under
  `server/`, so shipped recipes may not name third-party products or companies.
  Directions are described by their mechanics ("emissive accents on deep black"),
  and the attribution (which sites taught each recipe) lives here in `plan/`,
  where it is not shipped to the model.

### 4. Assets without a paid API (freemium constraint holds)

No stock service, no image API, no 3D asset host. So the system generates its
own: CSS mesh gradients and aurora fields, SVG noise and grain overlays, duotone
and gradient-map image treatment, procedurally generated SVG illustrations,
patterns and abstract UI furniture, and type-as-image set in the display face.
Anything you supply can be dropped in. Photoreal product photography is out
unless you provide it — and the recipes are written so a page still looks finished
without a single photo.

### 5. A hard quality gate, then a refinement loop

**The gate** — a deterministic checker that runs on what was built, and whose
failures become the run's own repair list (the step fails with reasons and the
agent fixes them):

- tokens declared and used; no hard-coded colours outside `tokens.css`
- contrast pairs pass; tap targets ≥44px; no horizontal scroll at 320/375/768/1280
- display type scale present (`clamp()` display sizes), not body-sized headings
- motion present and `prefers-reduced-motion` honoured; only transform/opacity animated
- no placeholder copy, no lorem, no `TODO`, no dead links
- at least one signature moment; at least one image system (generated counts)
- page weight budget and no render-blocking assets
- **a "not generic" check**: the page must not be centered-hero + three-equal-cards + one gradient

**The loop** — on the finished card, next to the file: *Bolder*, *Calmer*,
*More motion*, *Different direction* (shows three alternate directions as cheap
variants), *Refine the copy*. Each is a small follow-up run against the same
files. This is how the good builders close the last 20%, and it is what turns one
attempt into a result you actually want.

## B4. How we prove it

Five briefs — a café landing page, a designer portfolio, a SaaS dashboard, an
event page, a product configurator — each built **twice**: once with the current
guide, once with the new system. Both sets kept in `plan/` as evidence, scored on
a twelve-item rubric (direction committed, palette discipline, type scale, hero
architecture, imagery system, motion job, signature moment, pacing, copy quality,
mobile at 375px, accessible contrast, weight budget) plus the checker's own score.
Plus suite tests: the registry resolves, the recipe injection is gated to UI
tasks, the checker fails a deliberately bad page, and non-UI tasks still pay zero
extra tokens.

## B5. Honest limits

- **Photoreal imagery and real 3D assets** need a source we do not have on the
  free tier. Generated gradients, SVG art and typography can carry a page; they
  cannot fake a product photograph.
- **The checker is static by default.** It measures the DOM and CSS, not how a
  page looks. A true visual check means rendering in a headless browser inside
  the sandbox; that is worth doing and it is a real dependency decision (see the
  questions at the end).
- **Taste has a ceiling.** Recipes and a hard gate raise the floor enormously.
  The ceiling still needs your eye — which is exactly why the refinement loop in
  B3.5 matters more than any single prompt improvement.

## B6. Order of work

1. **Directions + token-first + two recipes** (Nocturne, Atelier) — the visible jump
2. **Skeletons + the asset kit** — the structural jump
3. **The gate + self-repair loop** — the consistency jump
4. **Refinement actions + three more directions** — the control you get

Each phase ships separately, green, with its tests, so you can stop after any of
them and still have gained the whole phase.

---

# C. The three decisions you made, and what they change

**Settled, and I am making the calls you left to me:**

| Question | Decision |
| --- | --- |
| Decisions in the live trace | `WHY:` lines on **complex tasks only** — quick questions pay nothing |
| The quality gate | **Static checker in our server first** (no new dependency); the visual pass belongs in the engine's sandbox, attempted in phase 3 |
| The direction of a build | **Always asked.** Three proposed directions as chips + "Let WAIS choose" + a numbered reply on WhatsApp |
| Which ships first | **The live trace (Part A)** — it is independent, fast, and it answers "is it working?" immediately |

## C1. Decisions in the trace — complex tasks only ✅

`WHY: <one sentence>` before each tool call, injected only when the task is
already paying for a plan. Quick questions are untouched and pay nothing. The
parser lifts those lines into `Decision` rows and strips them from the answer
body, so the deliverable never contains the agent's reasoning.

## C2. The quality gate — my call, so here it is with the reasoning

You said you have no idea, which is fair — it was a question about our plumbing,
not about your product. Here is the honest engineering answer:

**The gate is static, in our server, with no new dependency.** It reads the built
HTML and CSS and measures what is actually measurable: tokens declared and used,
contrast pairs, tap targets, the four mobile widths, display type scale, motion
rules and `prefers-reduced-motion`, placeholder copy, dead links, page weight,
and the not-generic check. That catches nearly everything that makes a page look
2015, and it runs on the free tier without a 300MB browser next to a 512MB
container.

**The visual pass comes later, and from the right side of the wire.** A headless
browser in our server is the wrong place to put it. The right place is the
engine's own sandbox, where the files are being written: it can render the page
at 375/768/1280, screenshot it, and hand the images back as artifacts the run
card shows you. I will test whether that sandbox can do it when we reach phase 3,
and if it can, the images go on the card next to the files — you look at the page
without leaving WAIS. If it cannot, the static gate stands on its own and I will
say so plainly rather than half-building a screenshot feature.

## C3. Direction is always your choice ✅ — and this one changes the flow

"Always ask me first" collides with your standing *approve all plans* setting, so
the direction is not part of the plan's approval — it is a **gate of its own**:

- A UI task reaches the direction step and **stops before writing a single file**.
  Nothing is built, nothing is spent on the build.
- The card shows **three proposed directions**, each with one line of why it fits
  the brief, as tappable chips — plus a fourth chip that says **"Let WAIS choose"**.
  That escape hatch exists, but it is only taken when *you* tap it. Silence never
  picks for you.
- Auto-approval still approves the plan and the budget; it cannot answer this,
  because auto-approval approving a direction would be exactly the thing you asked
  me to stop doing.
- Asking for a vibe in your own words works at the same gate ("darker, more like a
  car configurator"), and it re-proposes.
- **From WhatsApp** the three come as a numbered message and you reply `1`, `2`,
  `3`, or `choose` — a phone has no chips, and a gate that cannot be answered
  from the phone would strand every task you start from there.

---

# D. What I will build first, on your word

Nothing above is started yet. When you say go, **phase 1** is one push:

1. `server/design/directions.ts` — the registry: eight directions, each a full
   token set plus its own always/never list, with a test that every direction
   declares every required token group.
2. `server/ui-design-guide.md` rewritten from one house style into the
   direction-aware guide, with two complete recipes shipped
   (`server/design/recipes/nocturne.md`, `atelier.md`). Recipes name no
   third-party product anywhere, because `brand.test.ts` walks that tree and
   would fail the release.
3. The direction gate: the plan step, the three-chip card, the WhatsApp numbered
   reply, and the "let WAIS choose" chip.
4. Token-first build order in the wire prompt: tokens first, then the page, then
   the pass that proves it used them.
5. Tests: registry completeness, gate cannot be auto-approved, WhatsApp reply
   path, recipe injection gated to UI tasks (non-UI tasks still pay zero tokens),
   and a regression test that the old single-guide behaviour is gone.

Then phase 2 (skeletons + asset kit), phase 3 (the gate + self-repair), phase 4
(refinement actions + three more directions), each green before the next.

The trace work in Part A is independent of all of it and can ship first if you
would rather see that land sooner.

---

# E. How it will work, in plain language

Two flows, start to finish. Nothing here is built yet — this is what happens once
it is.

## E1. You ask for a website

1. You send a brief: *"build me a landing page for my café"*.
2. The task is recognised as a UI build. The plan is drafted the way it is today —
   and then it **stops**, before a single file is written.
3. The card shows the plan plus **three directions**, each with one line of why it
   fits *your* brief. For a café, roughly:

   - **Atelier** — "warm and quiet, image-led; food and craft look expensive here"
   - **Organica** — "soft, rounded, friendly; a neighbourhood café rather than a chain"
   - **Retail-polished** — "confident hero, real photography, trust above the fold"

   and a fourth chip: **Let WAIS choose.**

4. You tap one. Or you type it your way — *"darker, like a 2070 car site"* — and
   the three are proposed again against those words. **Nothing is built until you
   answer**, and silence is not an answer: the task waits at the gate.
5. The build runs: **tokens first** (one file declaring every colour, size, radius,
   curve and grain amount), then the page using only those tokens, then the
   self-check pass. A token that is declared and never used, or a colour typed
   outside `tokens.css`, fails the step and the agent fixes it before finishing.
6. The card shows the file and the check results, with the refinement chips beside
   it: **Bolder · Calmer · More motion · Different direction · Refine the copy**.
   Each is a small follow-up run against the same files, not a new task.

**From WhatsApp** the same three arrive as a numbered message — reply `1`, `2`,
`3`, or `choose`. A phone has no chips, and a gate that could not be answered from
the phone would strand every task started there.

## E2. You watch a task work

Inside the Thinking panel, while it runs:

- **Reasoning** — the model's actual thinking, streamed, when the backend exposes
  it. The panel head says *Reasoning* when that is what you are reading.
- **What it's doing** — when it does not, you get the model's own narration, and
  the head says so. Narration is never dressed up as reasoning.
- **Decision** rows — one line, in the model's words, before each tool call:
  *"Searching first because the prices change weekly."* Complex tasks only, and
  those lines are stripped from the answer you keep.
- **Tool · Result · Milestone** rows — each on its own line, each with `+3s` on the
  right so the rhythm is visible, with a caret on the line being written.
- **The wait line** — heartbeat, elapsed time, and the current phase
  (*"drafting the plan"*, *"step 3 of 7"*), so a slow minute has a shape.
- **Raw** — a switch in the panel head that shows every unfiltered frame the
  browser received. For the times you want to see for yourself that the engine is
  alive, not just that the app says it is.

## E3. Where the logic lives

- **New:** `server/design/directions.ts` (the eight directions), `server/design/recipes/*.md`
  (the recipes injected on the wire), `server/design/gate.ts` (the checker).
- **Rewritten:** `server/ui-design-guide.md` — from one house style into the
  direction-aware guide.
- **Touched for the two flows:** `server/engine/antigravity.ts` (label reasoning
  vs narration, lift `WHY:` lines), `server/executor.ts` (publish the trace rows,
  keep the decisions with the run), `web/app.js` + `web/styles.css` (the feed, the
  direction chips, the Raw switch), and the WhatsApp approval path for the numbered
  reply.
- **Untouched:** routes, storage, auth, budgets, the run stream protocol — the new
  rows reuse the event types that already exist and are already tested for
  reconnect.

## F. What shipped in this round

Five commits, each with the tests that prove it, all green together (981 tests,
239 suites, 0 failures):

| Commit | What it did |
| --- | --- |
| `358f5a9` | The trace: `WHY:` reasons become durable `decision` rows, the thinking stream is cut into rows, the panel head names the channel honestly (Reasoning vs what it is doing). |
| `0d146cd` | Silence said out loud (the quiet chip on the head, a wait line with phase and elapsed) and the Raw switch — every frame the browser received, bounded, with the dropped count stated. |
| `e111df2` | Eight art directions replacing the single house style, chosen before any file is written and announced with the reason; the craft guide rewritten; the static quality gate. |
| `5a35c53` | The gate's rules travel to the only thing that can run them (the builder), as a checklist keyed by rule id; `DecisionScanner.finish()` stops holding the last reason forever. |
| `c709faf` | The direction as a durable event carrying its alternates; refinement chips on a finished build (Bolder / Calmer / More motion / Refine the copy / each alternate direction). |

Deviations from §B3/§E3, and why:

- **Recipes live in the registry, not in `server/design/recipes/*.md`.** The
  recipe is now *generated* from each direction's own fields, so a direction
  cannot ship with a documented palette and an undocumented motion rule. One
  source, three readers: the wire prompt, the plan line, the chips.
- **The gate has no server-side file reader.** Built files live in the engine's
  own sandbox and the server only sees them when someone downloads one, so the
  checks were written twice on purpose: as a checker (`checkBuild`, for any path
  that does have bytes — the preview and the artifacts) and as a checklist
  (`gateChecklist`, forced complete by `Record<RuleId, …>`) that reaches the
  model. The visual/screenshot pass is still phase 3.
- **The direction gate still asks nothing.** This round *decides* and announces;
  §C3's promise — three chips and "Let WAIS choose" before the first file, and a
  gate that auto-approval cannot answer — is the next piece, and it now has the
  payload it needs (`design.direction` already carries the three alternates).
