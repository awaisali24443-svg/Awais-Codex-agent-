# 09 · The one painful problem, a name, and a real research plan

Read-only advice. Nothing in the repo was changed.

---

# Part 1 · The painful problem Manus, ChatGPT and Devin have not solved

## "Your work dies with the session."

Every one of these products has the same hidden flaw, and users feel it as a specific, repeated frustration:

- You spend two hours building something with the agent. The session ends, the sandbox is recycled — and tomorrow
  you start by **re-explaining the entire project**.
- You ask a follow-up three days later; the agent has no memory of the files it wrote, the decisions it made, or
  why it made them.
- A long task dies at minute 40 (sandbox timeout, rate limit, a restart) and everything it produced is gone — you
  paid for those tokens and have nothing.
- It finishes, hands you a link, and a week later the link is dead. The "deliverable" was a temporary view.

ChatGPT has memory but **no workspace**. Manus has a workspace but **it is temporary**, and each task is a fresh
VM with a fresh brain. Devin holds a session for hours, but the session is the product — when it ends, the project
state ends with it. Google's and OpenAI's agent modes inherit the same architecture: **a conversation with a
computer that is thrown away afterwards**.

## Why they have not fixed it

It is not a model problem; it is an economics and architecture problem.

1. **Idle compute costs money.** Keeping one user's environment alive between sessions is a cost they pay and you
   don't. Scale that to millions of users and it is an enormous, permanent bill for work nobody is watching.
2. **Their architecture is session-first.** Context windows and sandboxes are the primitive; state lives inside
   them. Making state durable means re-architecting the product around a database, not a chat.
3. **Re-doing work is revenue.** If a lost session makes you re-run the task, that is more usage, not less.
   There is no commercial pressure to fix it.
4. **Durable execution is genuinely hard.** Resuming a half-finished job, exactly once, without paying twice or
   double-writing, is a distributed-systems problem (checkpoints, idempotency, leases, reconciliation).

## Why *you* can win it

Your free-tier constraint is actually the winning design, because it forces the right architecture:

- You cannot keep a process warm forever, so you **checkpoint to Postgres instead of keeping a sandbox alive**.
  That is durable execution, arrived at by necessity.
- You already have the primitives: checkpoints and `resumeFromStep`, `recovery.ts` (triage + resume the newest
  orphan), orphan marking at boot, per-mission cost caps, an append-only event log, artifacts in a database.
- Your product is on **WhatsApp**, where continuity matters most: you send a task at midnight, sleep, and expect
  the answer in the morning. A session-based agent cannot promise that. A job-based one can.

## The promise to build the brand on

> **"Start it, close your phone, and it finishes. Come back next week and it still knows everything."**

Four acceptance tests that make that true (and that you can demo):

1. **Kill the server mid-task** → it resumes from the last checkpoint and loses no tokens. *(Partially built;
   `recovery.ts` exists.)*
2. **Sleep overnight with the phone off** → the answer is waiting, delivered, with the files still downloadable.
   *(Needs problems #5 and #6 fixed — see `plan/08`.)*
3. **Rate-limited or quota-reset mid-mission** → the task pauses, waits, and continues when the window opens,
   instead of failing. *(The scheduler and budget gate make this possible.)*
4. **Open a task from three weeks ago** → the conversation, the steps, the files and the replay are all still
   there, and you can say "continue" and it does. *(Needs #2, #4, #5.)*

**Here is the thing worth noticing: your eight bugs are this feature.** Problems #2 (reconnect loses the
timeline), #5 (files vanish), #6 (long tasks never get delivered) and #7 (a deploy kills a migration) are exactly
the places where the promise currently breaks. Fixing them *is* building the differentiator — which is why the
right order is bugs first, features second.

Phrase to own: **"Durable tasks"** — or in plain words for the store listing, *"the agent that finishes what it
starts."*

---

# Part 2 · A name

## What makes a name work

It must be **unique in a search box**, easy to type on a phone, and not collide with a giant. Three things to
avoid, in order:

- **"Codex"** — that is OpenAI's brand now. Right now your product is called "Awais Codex"; every search for it
  lands on OpenAI. A famous app cannot be named after someone else's famous app.
- **"Aws"** — too close to AWS, and unusable in speech.
- **Anything already in your own repos** (Zenox, Synod) unless you are reviving that brand deliberately.

## Candidates, all built from your name

| Name | How it works | Say it | Risk |
|---|---|---|---|
| **Awai** ⭐ | **Aw**ais + **AI** — the letters literally spell it | "uh-WHY" | None serious; short names need a logo, which is fine |
| **Awali** | **Awa**is + **Ali** — the two halves of your name fused | "ah-WAH-lee" | A town in Bahrain, a Swahili word, a bank in Bahrain |
| **Awalio** | Aw + a + lio, SaaS-shaped, sounds like a company | "ah-WAH-lee-oh" | Slightly generic, longer to type |
| **Awaisly** | your name + "-ly", like Grammarly/Calendly | "ah-WAYS-lee" | A mouthful; reads as a person's name |
| **Alif** | the first letter of the Arabic alphabet — "where it begins" | "ah-LEEF" | Not obviously *your* name; other Alif products exist |

**My recommendation: `Awai`.**

- Four letters, one syllable, and the AI is *inside the name* — AW**AI** — so nobody needs it explained.
- The story is one line: *"Awai — Awais Ali's AI."* That is how a personal brand and a product name fuse, which is
  what you are actually asking for.
- It pairs with the differentiator: **Awai — the agent that finishes what it starts.**
- Styling: `Awai` in text, `AWAI` in a logo, `awai.app` / `awai.ai` / `getawai.com` as domains.

Backup: **Awali** if you want both halves of your name, **Awalio** if you want it to sound like a company.

## Before you commit to it (one hour of checking, saves a year of regret)

1. **Domains:** `.com` first, then `.ai` / `.app`. If the `.com` is parked, a variant (`getawai.com`) is fine.
2. **Trademark:** quick search in the USPTO/EUIPO databases and Pakistan's IPO — you want no live mark in the
   software/AI class (Nice class 9 and 42).
3. **App stores:** search the Play Store and App Store — a name that already has three apps makes you invisible.
   Also reserve the Play package id (`com.awai.app`) now; package ids cannot be renamed later.
4. **Social handles:** the same handle everywhere (GitHub, X, YouTube, LinkedIn). Consistency is what makes a brand
   findable.
5. **The phone test:** say it aloud to someone; if they spell it right first try, the name is usable.

Then put the name **everywhere at once** — app title, logo, `manifest.json`, share-page title, WhatsApp messages,
README — and stop calling it anything else. Changing a name twice costs more than choosing a slightly worse one.

---

# Part 3 · Making research mode genuinely stronger than ChatGPT — a real plan

I am not going to tell you it will out-think GPT-5-class models. It will not, on raw knowledge. **You win on
process, persistence and proof** — and in research, those are most of the game. Here is the honest version.

## 3.1 The seven advantages you can actually build

1. **Time, not turns.** A chat answers in one pass under a length limit. Your research run can work for 15–480
   minutes, in chained passes, without losing the thread. Reviewing literature is *long, boring work* — exactly
   what a human pays an agent to do and what a chat cannot.
2. **Live sources, not frozen weights.** A model's knowledge has a cutoff. Your pipeline can query live indexes
   every time (see 3.4), so it can cite a paper from last month. A chat without browsing literally cannot.
3. **A source database, not a paragraph.** You already have `sources.ts` (citation checking). Extend it so every
   claim carries a resolvable identifier and a verbatim quote. A chat's citations are decoration; yours become
   auditable.
4. **Records that outlive the context window.** 200 extracted studies will never fit in a conversation. In your
   app they are *rows in Postgres*, so a table can grow all day and still be exportable tomorrow.
5. **Protocol first, approval gates.** Real research requires the method to be fixed *before* you look at results
   (that is what makes it evidence rather than fishing). Your plan-preview feature is the perfect place: the agent
   proposes the protocol, you approve or edit, then it executes. No chat does this.
6. **Deterministic verification.** Your verifier checks claims against the durable record instead of trusting prose
   — and it costs no extra model calls. "Prove it's done" is a research-grade property.
7. **Reproducibility you can hand to someone.** Figures, the analysis script, the extracted data and the search log
   are all artifacts. A reviewer can re-run it. That is what separates a manuscript from an essay.

**One honest warning.** Google's **free** tier may use your content to improve their products. Never push an
unpublished novel idea, a dataset under embargo, or a co-author's draft through a free key. Use a paid key for
those, or keep the novel core out of the prompt. Also: never let the agent fetch pirated full texts — use metadata
and legal open-access copies (3.4).

## 3.2 What "PhD-level" can honestly mean here

A publishable paper needs a novel question, a rigorous method, and accountability. Three lanes are genuinely
reachable; one is not.

**Lane 1 — Systematic review / meta-analysis.** No new data required. Pool results from existing studies, follow
PRISMA 2020, register the protocol on PROSPERO (free), assess bias per study, produce a forest plot. This is real,
respected, publishable work — in medicine, social science, education, and computer science.

**Lane 2 — Re-analysis / reproducibility study.** Take an open dataset or a published benchmark and test whether
the result holds (different model specification, different splits, published-vs-reported numbers). Fields actively
want these papers, and *nobody has time to do them* — which is precisely the gap an agent fills.

**Lane 3 — Methodological / simulation study.** Compare methods on simulated data via Monte Carlo (e.g. which
estimator holds under X), fully computational, publishable in methods journals.

**Off the table for now — and you must not pretend otherwise:** experiments with human participants, clinical
trials, surveys of real people. Those need ethics approval (IRB), informed consent, and a human who is legally
accountable. An agent cannot be the responsible party, and most journals now require a human author with
accountability.

## 3.3 The plan, phase by phase

Each phase is small, testable, and builds on something you already own. "Runs" = daily model runs, your ~100/day.

**R0 — Literature plumbing (0 runs).**
Clients for the free scholarly APIs (3.4), cached in Postgres, deduped by DOI, with a retraction check.
*Acceptance:* given a search string, return 50 deduped works with DOI, abstract, open-access link, citation count
and retraction status — with **zero** model calls. *Cost:* 0 runs, pure code.

**R1 — Protocol first (1 run).**
Reuse the plan-preview flow: question → PICO/PEO framing → inclusion/exclusion → per-database search strings →
outcomes → analysis plan → *you approve or edit*. Store the approved protocol with a version and a timestamp.
*Acceptance:* nothing is searched or screened before you approve; the protocol is exportable and, for reviews,
ready to paste into PROSPERO.

**R2 — Screening with reasons (1–3 runs).**
Title/abstract triage where every exclusion records a machine-readable reason, then a full-text stage; borderline
cases are flagged for you instead of guessed. Export the PRISMA flow numbers
(identified → screened → included/excluded with reasons).
*Acceptance:* the flow diagram's numbers are generated from the database, not typed by hand.

**R3 — Extraction table (2–5 runs).**
One row per study: design, N, population, intervention, comparator, outcomes, effect sizes with CIs, plus a
risk-of-bias assessment (RoB 2 / ROBINS-I / Newcastle-Ottawa / AMSTAR-2 as appropriate). **Every cell carries the
quote and location it came from.** Uncertain cells are flagged for human review, never invented.
*Acceptance:* CSV + BibTeX export; clicking a number shows its source quote.

**R4 — Analysis (1–2 runs).**
Run the statistics in the sandbox: random-effects meta-analysis, heterogeneity (I², τ²), funnel plot / Egger test,
subgroup and sensitivity analyses, forest plot + PRISMA flow diagram as figures — with the analysis script saved
as an artifact so the whole thing is reproducible.
*Acceptance:* re-running the saved script reproduces the exact numbers and figures.

**R5 — Manuscript (2–4 runs).**
IMRaD structure against a journal template (LaTeX or DOCX), references formatted, tables and figures placed, a
cover letter, and an AI-use disclosure paragraph. **The Methods section is written from the run's actual logs**, so
it describes what really happened.
*Acceptance:* one downloadable bundle — manuscript + figures + tables + checklist + BibTeX.

**R6 — Adversarial review before you submit (1 run).**
A "reviewer 2" pass over your own draft: unsupported claims, abstract that overstates the results, missing
limitations, statistical misreadings, contradictions between sections. Output: a numbered report and a draft
point-by-point response letter.
*Acceptance:* every claim in the abstract maps to a specific result in the tables.

**Total for one full systematic review: roughly 8–14 runs.** Your daily budget is not the constraint. Rigour and
your own judgement are.

## 3.4 Free infrastructure (this is what makes it real, not hand-waved)

| Source | What it gives you | Cost |
|---|---|---|
| **OpenAlex** (`api.openalex.org`) | 250M+ works, authors, venues, citations | Free, no key |
| **Crossref** (`api.crossref.org`) | DOI metadata, references, retraction links | Free |
| **Semantic Scholar** | abstracts, citation graph, TLDR summaries | Free tier |
| **arXiv** | preprints (CS/physics/maths) | Free |
| **PubMed E-utilities** | biomedical literature, MeSH terms | Free (3 req/s) |
| **bioRxiv / medRxiv** | life-science preprints | Free |
| **DOAJ** | vetted open-access journals | Free |
| **Unpaywall** | legal open-access copy for a DOI | Free (email param) |
| **ClinicalTrials.gov** | trial records for evidence tables | Free |
| **Zenodo / OSF / Figshare** | deposit data, pre-register a study | Free |
| **PROSPERO** | register a systematic-review protocol | Free |
| **Our World in Data / World Bank / UCI / Kaggle** | datasets for re-analysis studies | Free |

Rules: metadata and legal open-access text only — no Sci-Hub, no scraping past paywalls, respect `robots.txt` and
API terms. **Cite-or-die:** every reference is verified to resolve (DOI check) before it appears; quotes are
verbatim from fetched text; a reference the agent cannot verify is dropped, not guessed.

## 3.5 Quality gates to enforce in code (not in prose)

- **PRISMA 2020** checklist (27 items) auto-filled from the run's logs — for reviews.
- **PROSPERO** registration before screening starts (reviews); **OSF** preregistration for other designs.
- **Risk-of-bias tools:** RoB 2 (RCTs), ROBINS-I (non-randomised), Newcastle-Ottawa (cohort/case-control),
  AMSTAR-2 (reviews), **GRADE** for certainty of evidence.
- **Reporting standards:** CONSORT (trials), STROBE (observational), TRIPOD (prediction models), MOOSE.
- **AI disclosure:** ICMJE/COPE and most publishers require disclosure that AI was used and forbid AI as an author.
  Generate that paragraph — and never let the app's name appear as an author.
- **Plagiarism and self-plagiarism** check on export (this is the one gate worth paying for; a single iThenticate
  pass is cheap next to a rejection).

## 3.6 Why this beats a chat, in one paragraph you can put on a landing page

> A chat gives you an answer in one pass and forgets it. **Awai runs a research process**: protocol first, live
> literature searches, a screening log with reasons, an extraction table where every number points back to its
> source, statistics you can re-run, and a manuscript with an audit trail a reviewer can follow. It works for
> hours, survives restarts, and can still be resumed next week — which is exactly why you can submit what it
> produces and a chat's essay cannot be submitted at all.

## 3.7 Start here (the smallest useful thing)

Build **R0 + R1** first: the free-API literature layer, and a protocol you approve before anything runs. That is a
few days of work, costs zero runs, and it is already more research discipline than any chat product has. Then R2
and R3, which are where a real review is actually won. Do not start with the PDF export — start with the source
ledger.
