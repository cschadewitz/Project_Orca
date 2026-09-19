# Working in this repo

ORCA is an orchestration runtime for coding agents. This file is the entry point for any
agent — Claude Code, Codex, Gemini CLI, or ORCA driving itself — doing work here. For the
build, test and layout conventions read `docs/DEVELOPMENT.md`; for the architecture read
`docs/ARCHITECTURE.md`; for the desktop app's design system read on.

## Before you touch the UI

Read **`docs/design/RULES.md`** first. It is short and it is binding. The full reasoning is in
`docs/design/README.md`, and the surface-by-surface specs are the numbered files next to it.

The design system as code is the `@orca/design` workspace package (`packages/design`):

```
packages/design/
  tokens.json            EDIT: every colour, type, spacing, radius, shadow, size, motion value
  semantics.json         EDIT: the words and glyphs for statuses, schedule classes, connections
  build-tokens.js        the generator
  css/tokens.css         GENERATED — custom properties, both themes, type-style classes
  src/tokens.ts          GENERATED — typed token names, status maps, raw values per theme
  css/components.css     the component layer: token-bound classes, no hardcoded values
  src/component-api.d.ts the props each React primitive should expose over those classes
  fonts/                 GENERATED — the bundled woff2 subsets and their OFL licences
  test/contrast.test.ts  WCAG AA for every documented pairing, in both themes
  test/fonts.test.ts     every declared face has a file, every glyph has a bundled face
```

The three rules that cause the most rework if you miss them:

- **No literal colours, sizes, radii or durations in component code.** Reference a token —
  `var(--status-failed)` in CSS, `v('status-failed')` from `@orca/design` in TypeScript. If
  nothing names what you need, add it to `packages/design/tokens.json` and rebuild.
- **`css/tokens.css` and `src/tokens.ts` are generated.** Edit `tokens.json` or
  `semantics.json`, then `pnpm run design:build`. CI rejects stale generated files.
- **There are eight run statuses and they always render a glyph and a word.** Import
  `RunStatus` and `STATUS_PRESENTATION` from `@orca/design`; never re-declare the list, never
  rely on colour alone. The glyphs come from a bundled symbol face, not from Plex and not
  from the OS — a new glyph in `semantics.json` also goes into
  `tools/font-build/build-fonts.js`, then `pnpm run design:fonts`.

## Commands

```sh
pnpm run design:build   # regenerate css/tokens.css and src/tokens.ts from tokens.json
pnpm run design:check   # fail if the generated files are behind (CI)
pnpm run design:fonts   # re-subset packages/design/fonts from the upstream releases
pnpm test               # the whole suite, including the contrast and invariant tests
```

## When you are asked for a screen

The component layer already exists in `packages/design/css/components.css` as token-bound
classes (`orca-tree-row`, `orca-chip`, `orca-card`, `orca-node`, …), and
`packages/design/src/component-api.d.ts` says what props each React primitive should expose
over them. Build on those rather than re-deriving values. If a screen seems to need a
component that does not exist, check `docs/design/` before inventing one — most of them are
already specced.

Screens live in `packages/app/renderer` — React, bundled by Vite, with `tokens.css` and
`components.css` imported at the top of `renderer/src/main.tsx`. `pnpm --filter @orca/app dev`
runs it with hot reload; `docs/DEVELOPMENT.md` ("The renderer build") has the rest.

The primitives are already built: `renderer/src/ui` wraps the `orca-*` classes as
`StatusChip`, `Button`, `Chip`, `Card`, `Well`, `Text`, `Duration`, `Time`, `ConfigField`,
`ObjectHeader`, `StateView`, `ScheduleBadge` and `ConnectionIndicator`. Compose those rather
than writing class names, and see them all in both themes at `#preview` in a dev build. If
an implementation has to diverge from `component-api.d.ts`, correct that file in the same PR.

The app (`packages/app`) may import only `@orca/protocol` and `@orca/design` from the
workspace — the renderer included; everything it knows about a run comes over the wire from
the daemon (ADR 0008).

## When the data is not there

ORCA cannot currently supply a run completion percentage, an estimated time remaining, or
agent cost. Do not approximate them, and do not add a placeholder. Say so in the PR.
`docs/design/60-implementation.md` has the standing list.

## Keeping the rendered version honest

`packages/design` and `docs/design` are the source of truth. There is also a rendered version
of the system — live previews, both themes, the key screens — as a Claude artifact, used for
visual review. It does not feed the build and nothing here reads from it. When the files
change materially, ask for it to be republished from these folders; do not treat it as an
authority when the two disagree.
