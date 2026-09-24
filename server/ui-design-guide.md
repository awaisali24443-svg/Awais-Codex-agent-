# UI Design Guide

Follow this when a task asks you to design or build a user interface —
a web page, app screen, landing page, dashboard, or mockup. Aim for a
warm, minimal, quiet interface — one that disappears so the content can
speak.

## Layout

- One screen, one job. Every view has a single primary action; everything
  else is secondary.
- Hierarchy before decoration: the most important thing is biggest, first,
  and highest-contrast. If everything is emphasized, nothing is.
- Generous whitespace. Empty space is not empty — it separates, groups,
  and calms. When in doubt, add space, not borders.
- Content width: cap text columns around 65–75 characters; full-bleed is
  for media, not paragraphs.
- Progressive disclosure: advanced options hide behind a tap. The default
  view shows only what most people need.

## Spacing

- Use a scale, not arbitrary pixels: 4, 8, 12, 16, 24, 32, 48, 64.
- Related items sit close (4–8); unrelated groups separate widely (24+).
- Consistent rhythm beats clever variation: same gaps between same kinds
  of things, everywhere.

## Typography

- System font stack. Never download a webfont for a metered connection —
  no user should pay data for your typeface.
- Scale: body 16, small 14, caption 12–13, headings 20 / 24 / 32. Few
  sizes, clear steps.
- Line height: 1.5–1.6 for body text, 1.2–1.3 for headings.
- Weight is for meaning: regular body, medium/semibold for emphasis and
  headings. Never fake bold with extra size.

## Color

- A restrained palette: one background, one surface, one text color, one
  muted secondary text, one accent. Warm neutrals over cold grays.
- Accent is for action: primary buttons, active states, key highlights.
  If the accent appears everywhere, it means nothing.
- Status colors are semantic only: green = success, red = destructive or
  error, amber = warning. Never decorate with them.
- Dark mode is a first-class citizen: warm dark surfaces, never pure
  black; keep contrast ratios readable (body text 4.5:1 minimum).
- Text on accent backgrounds must pass contrast — white on a light
  accent fails; darken the accent or use dark text.

## Components

- Buttons: one primary per view, filled with the accent; secondary
  actions are quiet (outline or text). Destructive actions are red and
  never the primary.
- Forms: labels above inputs, always; helpful placeholder text is not a
  substitute for a label. Show errors inline, next to the field.
- Cards: subtle surface change or a hairline border — never heavy
  shadows and borders together. One card, one idea.
- Empty states: explain what goes here and offer the one action that
  fills it. Never a blank box.
- Loading: skeletons or quiet spinners, never blank screens. Errors:
  plain language, what happened, what to do next.

## Motion

- Motion is feedback, not entertainment: 150–250ms transitions on state
  changes. Nothing bounces, nothing spins forever.
- Respect reduced-motion: when the user asks for less, give them none.

## Mobile first

- Design for the phone, then widen. Touch targets at least 44px; the
  primary action reachable by thumb.
- One column until the screen earns two. Tables become lists or cards.

## Restraint

- No emoji overload: one icon where it aids scanning, never walls of
  emoji, never emoji as the only carrier of meaning.
- No lorem ipsum in delivered work: every string is real, final copy.
- If the UI is for the arena web app itself, use its design tokens —
  `var(--paper)`, `var(--surface)`, `var(--ink)`, `var(--ink-soft)`,
  `var(--muted)`, `var(--accent)`, `var(--line)`, `var(--space-1…8)`,
  `var(--radius)` — and honor its light/dark themes. Never invent a
  second palette beside it.

## Quality bar

Before you call a UI done: open it on a phone-sized viewport, toggle
dark mode, tab through it with a keyboard, and read every string aloud.
If anything feels heavy, remove it — simplicity is the feature.
