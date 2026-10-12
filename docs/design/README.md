# ORCA design system

The source of truth for how the ORCA desktop app looks and behaves. Everything here is files:
no account, no network, no URL needed to know what a token is worth.

## Layout

The system is split between the code the app consumes and the prose that explains it:

```
packages/design/               the @orca/design workspace package
  tokens.json                ← EDIT: every colour, type, spacing, radius, shadow, size, motion value
  semantics.json             ← EDIT: the words and glyphs for statuses, schedule classes, connections
  build-tokens.js              the generator
  css/tokens.css               GENERATED — custom properties, both themes, type-style classes
  src/tokens.ts                GENERATED — typed token names, status maps, raw values per theme
  css/components.css           the component layer: token-bound classes, no hardcoded values
  src/component-api.d.ts       the props each React primitive should expose over those classes
  test/contrast.test.ts        WCAG AA for every documented pairing, in both themes

docs/design/                   this folder
  README.md                    this file: layout, how to consume it, the brand book
  RULES.md                     the checklist an agent holds in context on every task
  claude-design-prompt.md      the brief the system was designed from
  10-…80-*.md                  information architecture, attention, long-running content,
                               connection states, a11y, implementation, workflow editing, plan graph
```

## Build and check

```sh
pnpm run design:build    # regenerate css/tokens.css and src/tokens.ts from tokens.json
pnpm run design:check    # fail if the generated files are behind (CI runs this)
pnpm test                # the contrast and invariant tests run with the rest of the suite
```

`design:check` fails when the generated files are behind `tokens.json`; CI runs it beside the
test suite so a stale token file or a contrast regression cannot merge. The generated files
are committed, marked generated in `.gitattributes`, and skipped by Prettier and ESLint.

## Consuming it

Load `@orca/design/css/tokens.css` once at the app root, then `@orca/design/css/components.css`.
Put the theme on `<html>`:

```html
<html data-theme="dark">
```

Omit the attribute to follow the OS — the generator emits a `prefers-color-scheme` block for
every theme after the first, `color-scheme` included. Density is a second attribute on a
surface root, `data-density="compact"`, which rebinds `--row-h` and nothing else. In the
desktop app both attributes are set by `packages/app/renderer/src/appearance.ts` from the
app's own preferences file, and nothing else reads them in JavaScript (`60-implementation.md`).

From TypeScript, reference tokens through `v()` and states through the maps:

```ts
import { v, STATUS_PRESENTATION, type RunStatus } from '@orca/design';

const s: RunStatus = 'failed';
const { word, glyph, fg, bg } = STATUS_PRESENTATION[s];   // '✕', 'failed', 'var(--status-failed)', …
element.style.color = fg;                                  // never '#a32a24'
```

`rawTokens` holds literal values per theme, for the few places a CSS variable cannot be
resolved — canvas 2D, an image export, a native menu. Everywhere else, use `v()`.

## Adding a token

1. Add it to `packages/design/tokens.json` with a `usage` note that names the grounds it sits on.
2. `pnpm run design:build`.
3. `pnpm test` — the contrast suite checks it in both themes.
4. Commit `tokens.json` and the generated files together.

---

# The brand book

ORCA is an orchestration runtime you watch. The app's job is to let one person understand,
at a glance, what a fleet of coding agents is doing on their behalf — and to make the one
thing that needs a human answer impossible to miss. Design for comprehension first, polish
second, and never spend a person's attention on something that does not need it.

## Voice

Write in the app the way a careful engineer writes a commit message.

- **Sentence case everywhere.** Buttons, headers, menu items, column headers. The only
  uppercase is the `eyebrow` style, used for sidebar and palette group headers, never for
  a sentence.
- **Name the thing, then say what happened to it.** "Build step failed after 3 attempts",
  not "Failure occurred". Put the subject first so a truncated row still means something.
- **Second person for asks, no person for facts.** A gate reads "Approve the plan for
  `auth-sso-epic`?"; a status reads "Waiting for approval since 14:02".
- **Never apologise and never congratulate.** No "Oops", no "Great!", no exclamation marks.
  A failed step is information, not an accident the app feels bad about.
- **Say what you cannot show.** When the daemon is unreachable, the app says which data is
  last-known and how old it is; it does not silently display stale numbers.
- **Machine strings stay verbatim.** Ids, node names, paths, expressions, agent output and
  artifact bodies are never re-capitalised, translated or truncated in the middle. Truncate
  at the end with a character-count affordance, or in the middle only for ids, where the
  head and tail are what identify them.
- **No emoji, anywhere, including in empty states.**

## Colour

- Ground the window in `surface-canvas`; put every reading pane on `surface-base`; put
  machine text in a well of `surface-sunken`; float only menus, popovers, dialogs and the
  command palette on `surface-raised`.
- `accent` means *interactive*, never *state*. Links, the primary button, the active nav
  item, the selection edge and the focus ring are teal; a running step is not.
- Status colour is the only saturation in a resting screen. If a screen shows a colour that
  is not a status and not `accent`, it is a bug.
- Statuses map one-to-one onto tokens: `status-running`, `status-waiting`,
  `status-succeeded`, `status-failed`, `status-cancelled`, `status-blocked`, `status-held`,
  `status-stale`. Each has a `-bg` companion for chips and rails. Never introduce a ninth.
- **Success is quiet.** `status-succeeded` appears at chip scale only. A run where everything
  worked should read as a column of grey text with one green glyph per row, not a green screen.
- **Waiting is loud.** `status-waiting` is the only status permitted in the title bar, the
  sidebar count and the dock badge, because it is the only status that costs the person
  something while it persists.
- Colour never carries a status alone. Every status renders a glyph and a word as well:
  `◐` running, `◆` waiting, `✓` succeeded, `✕` failed, `⊘` cancelled, `▣` blocked, `⏸` held,
  `◷` stale. `status-cancelled` and `status-stale` deliberately share the neutral ramp — they
  are told apart by glyph and by stale's dashed border, never by hue.
- Both themes are authored, not derived. Check a new colour against `surface-canvas`,
  `surface-base`, `surface-raised` and `surface-sunken` in *both* themes before adding it.

## Type

- `body` is the interface default. `label` is the workhorse for rows and tables; `caption`
  for the second line of a two-line row.
- **Mono means "ORCA produced this".** Run ids, step and node names, file paths, expressions,
  tool names, agent output and artifact bodies are set in the Machine group. Prose a person
  wrote — a request summary, a gate question, a decision rationale — is set in sans. The
  distinction is load-bearing: it is how a reader knows whether a string is a value or a
  sentence.
- `mono-log` is the only style used for streamed output. `mono-id` is tracked out so two
  truncated ids can be compared by eye.
- The font stack is `IBM Plex Sans` and `IBM Plex Mono`, both bundled with the application as
  woff2 rather than fetched at runtime — an Electron app that needs a CDN to render its own
  text is broken offline. The files are in `packages/design/fonts`, subset to Latin plus the
  punctuation the UI sets (mono also carries box drawing, for the stream rules), and
  `tokens.css` declares them with `font-display: block`: a flash of the fallback face on
  window open reads as a bug. The fallbacks in `type.families` are ordered so that Linux,
  macOS and Windows each land on a reasonable face if a font file fails to load; no OS's
  system font is assumed.
- **The status glyphs are bundled too, and they are not Plex.** Plex contains none of
  ◐ ◆ ✕ ⊘ ▣ ⏸ ◷ ● — left to the fallback stack they render in whatever face the OS supplies,
  differently on each platform, at 11px next to the word they qualify. Two subsets of Noto
  (Symbols 2, and Math for ⊘ alone) carry exactly the glyphs ORCA renders and no Latin at
  all, so they sit in front of Plex in both stacks without their metrics touching text.
  Adding a glyph to `semantics.json` means adding it to `tools/font-build/build-fonts.js` and
  rerunning `pnpm run design:fonts`; the suite fails if you do not.

## Structure, not shadow

- Separate things with `border-hairline`. Reach for `shadow-popover` or `shadow-modal` only
  when an element genuinely floats above the window, and never show more than one at a time.
- `shadow-sticky` is applied to a sticky header *only while content is scrolled beneath it*,
  so the seam appears when it means something.
- Radius is tight: `radius-xs` for chips, `radius-sm` for controls, `radius-md` for cards and
  graph nodes, `radius-lg` for floating surfaces. Tables and the risk matrix are square.
- Controls and graph nodes take `border-control`, which holds 3:1 in both themes. Row rules
  and pane splits take `border-hairline`, which does not need to and should not try.

## Density and rhythm

- `row-comfortable` (32px) is the default row height. The density toggle swaps every list to
  `row-compact` (24px) and is remembered per surface, so a person can keep the run tree dense
  and the config form comfortable.
- Indent one `space-3` per level of the run tree, with a `graph-edge` guide line per level.
  Past six levels, stop indenting and show the ancestor chain in the sticky header instead.
- Horizontal row padding is `space-3`; pane padding is `space-4`; the gap between sections in
  a pane is `space-6`.

## Motion

Motion orients; it never decorates. `duration-fast` for disclosure, `duration-medium` for the
right panel and the palette, `duration-pulse` for the running dot and the streaming caret.
Hover and selection use `duration-instant` so a fast keyboard user never chases a lagging
highlight. Under `prefers-reduced-motion` every transition is dropped and the running pulse
is replaced by a static filled glyph — the state is still legible without the animation.

## Iconography

No icon library is bundled. Status is drawn with the eight glyphs listed above, set in the
sans family at `icon-sm` or `icon-md`; node types, tool kinds and connection states are drawn
as inline SVG at `icon-md` on a 16px grid with a 1.5px stroke in `currentColor`. Two rules:
an icon is never the only label for an action, and a status glyph is never used for anything
that is not that status. When an icon set is eventually chosen, pick one with a 16px optical
grid and replace the inline SVGs; nothing else in the system depends on it.

## Building on this

Every value here compiles to a CSS custom property, and `components.css` is the
reference implementation: token-bound classes, no hardcoded colours, no JavaScript. Build the
React layer on top of those classes rather than re-deriving the values — `component-api.d.ts`
describes the props each primitive should take. If you need a value that no token names, add
the token; do not inline the number.

---

## Where the rest is written down

| Question | File |
| --- | --- |
| How the surfaces relate, window layout, palette, deep links | `10-information-architecture.md` |
| Gates, permission asks, counts, notifications | `20-attention-and-gates.md` |
| Virtualisation, following vs held, buffers, time | `30-long-running-content.md` |
| Live, reconnecting, disconnected, file mode, version mismatch | `40-connection-states.md` |
| Contrast, status without colour, focus, the keyboard map, live regions | `50-accessibility-and-keyboard.md` |
| Theming, density, virtualised rows, streaming, and what ORCA cannot supply | `60-implementation.md` |
| The workflow editor: structured edits, drafts, validation, run pinning | `70-workflow-editing.md` |
| The two dependency-graph options and the recommendation | `80-dependency-graph-options.md` |
| The brief the system was designed from | `claude-design-prompt.md` |
| How closely the app matched the Claude Design artifact, and the drift still open | [`../reviews/2026-10-10-design-conformance.md`](../reviews/2026-10-10-design-conformance.md) |

The rendered version of this system — live component previews, both themes side by side, and
the seven key screens — lives in a Claude artifact. It is the review surface, not the source:
when these files change and you want the visual review refreshed, republish it from this
folder.
