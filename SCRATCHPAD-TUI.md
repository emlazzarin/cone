# Scratchpad: TUI redesign

Working notes for the ConeTUI visual redesign (Eddy, 2026-07-01: inspired by
factory-ai/factory's droid CLI — "great looking TUI", but stay hotkey-forward
and keep PWA parity). Mockups live in `scripts/tui-mockups.ts`:

    bun run scripts/tui-mockups.ts            # full color (PWA CRT palette)
    NO_COLOR=1 bun run scripts/tui-mockups.ts # plain box-drawing

## What droid's look is actually made of

Rounded-corner panels with breathing room, a strong brand/identity header, a
composed input *box* (not a bare prompt line), disciplined color (one accent +
dim gray metadata), and vertical whitespace between logical blocks. None of it
requires a framework — it's layout discipline plus box-drawing.

## Constraints (fixed)

- **Hotkeys and modes are untouched.** The redesign is `render.ts` only; the
  state machine, `input.ts`, and all TUI tests that drive `handleInput` stay.
  Tests that assert on rendered strings get updated expectations, nothing more.
- **PWA parity of vocabulary**: same sections, same keys, same amber CRT
  palette (`#f0be42` accent, green for live/read, red for errors).
- Must degrade at narrow widths (the existing `terminal too small` guard, plus
  panels collapsing like the PWA's mobile mode).

## Directions

- **A — Panels**: today's two-pane layout, refined. Rounded borders, identity
  header bar, right-aligned time/badge columns, composed input box, footer as
  dim chips. Lowest risk; every existing interaction maps 1:1.
- **B — Focus**: droid-style single column. Transcript gets full width with a
  time/sender gutter; the chat list becomes a `Tab` overlay (exactly the PWA's
  mobile collapse). Most dramatic; changes information architecture — the list
  is no longer ambient, unread awareness moves to the header count.
- **C — Rail**: dense messenger. Avatar-initial rail + list column + thread;
  closest to the PWA desktop. Most chrome per row; the rail buys little at
  4 chats but scales visually with many.

## Renderer decision

All three are achievable with the **hand-rolled renderer plus a small layout
kit** (`box(title, right, rows)`, `spread(left, right, width)`, `columns(...)`
— the mockup script is effectively a prototype of that kit). A framework
(OpenTUI/Ink-style) would buy resize/diff rendering for free but imports an
event-loop opinion and obsoletes the tested input model. Recommendation:
stay hand-rolled unless direction B is chosen *and* smooth overlay animation
is wanted (it isn't — this is a CRT terminal, not a compositor).

## Recommendation

**A's structure with B's composer and header treatment**: keep the ambient
two-pane (parity with PWA desktop, preserves `j/k` list navigation as a
visible, first-class thing), adopt the rounded input box, the identity
header, and the whitespace/color discipline from B. Revisit B's overlay as
the narrow-width collapse behavior rather than the default.

## Decision (Eddy, 2026-07-02)

**A+B hybrid approved**, with two emphases:
- **Aggressive dynamic resizing** — wide = two-pane, narrow = B's single
  column (mode decides which pane shows), tight heights collapse list rows
  from two lines to one. Resize must always produce a sane screen.
- **Strong state highlighting** — the current tab/section and mode must be
  unmistakable at a glance (droid is subtle here; Cone should not be).
  Implemented as: amber-inverse chip on the active header tab, an explicit
  mode chip in the footer (CHATS / REQUESTS / TALK / COMPOSE / CONTACTS /
  EDIT / GROUP / HELP), amber border on the focused pane, amber selection
  bars in lists.

## Shipped (2026-07-02)

- [x] Eddy picked: A+B hybrid, aggressive resize, strong state highlighting
- [x] `packages/cli/src/chat/layout.ts` (box/spread/columns/fitRows,
      ANSI-aware) + full `render.ts` rewrite on it; render-string assertions
      updated. Input/state machine untouched — 174 tests green.
- [x] Requests / group-info / forms / contacts / help all in the same
      language (every surface is a titled rounded panel; forms get amber
      borders; a request's composer hint says accept/block, not "write").
- [x] Width tiers: two-pane ≥ 84 cols; below that the mode picks the single
      visible pane (select → list, talk → thread+composer, forms/info →
      themselves) — the PWA's mobile collapse. Height: < 12 body rows folds
      chat rows to one line and the composer into the bottom chrome line.
- [x] State highlighting: amber-inverse chips for the brand, active header
      tab, and footer mode (CHATS/REQUESTS/FILTER/TALK/COMPOSE/CONTACTS/
      EDIT/GROUP/HELP); the focused pane's border is amber, everything else
      dim; selection bars amber-inverse. Accent unified to 256-color amber
      (PWA `--amber`), replacing the old cyan/yellow mix.
- Preview any render change without a live session:
  `bun run scripts/tui-preview.ts` (real renderChat + fixture state at seven
  size/mode combinations). Footer hints slimmed (` · ` separators; `g` moved
  to help) because the mode chip claims footer width.

## Open

- (none — revisit narrow-tier polish after real daily use)
