# UI Craft Guide

A direction has been chosen for this task — canvas, type, motion, and the one
moment the page is remembered by. This file decides whether the result is any
good, and none of it is optional in any direction.

## The order of work

1. `tokens.css` first. Every value below becomes a custom property, and
   nothing written afterwards hard-codes a colour, size, radius or duration.
2. The shell — header, hero, footer — at 375px wide, before anything widens.
3. Sections one at a time, top to bottom, each finished before the next.
4. The signature moment, once the page reads well without it.
5. Then the passes: 320px, reduced motion, keyboard order, and every string
   read aloud.

## Layout

- One screen, one job. Every view has a single primary action; everything
  else is secondary.
- Hierarchy before decoration: the most important thing is biggest, first,
  and highest-contrast. If everything is emphasized, nothing is.
- Asymmetry is available now: unequal columns, a tile the size of two, an
  element that deliberately breaks the grid. Rows of equal-weight boxes are
  what a template does.
- Cap prose columns around 60–75 characters; full-bleed is for media.
- Progressive disclosure: advanced options hide behind a tap.

## Spacing

- Use a scale, not arbitrary pixels: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.
- Related items sit close (4–8); unrelated groups separate widely (24+), and
  major sections are allowed to be very far apart (160–240px).
- Consistent rhythm beats clever variation — then break the rhythm once, on
  purpose, where the page should make a point.

## Typography

- Two faces maximum: one display, one text. Name both in `tokens.css`.
- Display type is display type: `clamp()` sizes well above body size, tracking
  tightening as size grows (−0.02 to −0.04em), line-height 0.9–1.05 for
  headlines and 1.6–1.75 for prose.
- A webfont is allowed if it is one link with a system fallback stack. Never
  block first paint on it, never ship more than two weights.
- Numbers that get compared use tabular figures.
- Never let a heading be body text with a bold face on. More than colour or
  layout, that is what makes a generated page look generated.

## Color

- Values live in `tokens.css` and nowhere else. A hex outside that file is a
  defect: it is a value that will not match the next one written.
- One accent, used sparingly. A second accent is a second brand.
- Contrast: 4.5:1 for body text, 3:1 for large text and interface edges.
- State colours (success, warning, error) are tokens too, and are never
  borrowed for decoration.

## Motion

- Read the direction for duration and curve, and use that one curve
  everywhere. Motion is feedback and tempo, not entertainment.
- Animate transform and opacity only — never width, height, top, left or
  margin, which force a layout on every frame.
- Every animation sits inside `@media (prefers-reduced-motion: no-preference)`.
  The reduced version is the finished page with movement removed, not a
  broken one.
- One signature moment beats six effects.

## Mobile first

- Design for the phone, then widen. No horizontal scroll at 320, 375, 768 or
  1280px.
- Touch targets at least 44px; the primary action reachable by thumb.
- One column until the screen earns two. Tables become lists or cards.

## Restraint

- No emoji overload: one icon where it aids scanning, never walls of emoji,
  never emoji as the only carrier of meaning.
- No lorem ipsum, no placeholder copy, no "coming soon", no dead `#` links.
- If the UI is for the arena web app itself, use its design tokens —
  `var(--paper)`, `var(--surface)`, `var(--ink)`, `var(--ink-soft)`,
  `var(--muted)`, `var(--accent)`, `var(--line)`, `var(--space-1…8)`,
  `var(--radius)` — and honor its light/dark themes. Never invent a second
  palette beside it.

## Making it not look generated

Five tells. Each is a defect to fix, not a taste to argue:

- A centred hero, three equal cards, one gradient behind them.
- Headings barely larger than body text.
- The same radius on everything, or no radius decision at all.
- Copy that could describe any company ("we provide solutions").
- Nothing on the page moves, and nothing about it is worth remembering.

## Quality bar

Before calling it done: every colour and size comes from a token; there is at
least one signature moment; it holds at 320px; it survives with motion
removed; the tab order follows the page; every string is real and final; and
the contrast is checked rather than assumed.
