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
  `pnpm run lint` enforces this now, in the renderer's CSS and in inline `style={{ … }}`
  objects, and says so in the failure; `docs/DEVELOPMENT.md` has what it rejects and the
  one escape hatch.
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
pnpm run lint           # eslint, then the CSS token check (rule 1 above)
pnpm run app:smoke      # Playwright drives the built app against a demo daemon
```

## When you are asked for a screen

The component layer already exists in `packages/design/css/components.css` as token-bound
classes (`orca-tree-row`, `orca-chip`, `orca-card`, `orca-node`, …), and
`packages/design/src/component-api.d.ts` says what props each React primitive should expose
over them. Build on those rather than re-deriving values. If a screen seems to need a
component that does not exist, check `docs/design/` before inventing one — most of them are
already specced.

**A component class no longer carries a type size (#211).** `components.css` sets no
`font-size` at all: an element gets its size by *also* taking an `.orca-text-*` class
(`orca-text-caption`, `orca-text-mono-log`, …), and every rule in `components.css` carries a
`/* type: <style> */` note saying which one it expects. `class="orca-chip"` alone inherits the
shell's 14px rather than the chip's intended size, so both classes go on the element. The
sans/mono distinction, weight and colour still come from the component class — only the size
moved.

Screens live in `packages/app/renderer` — React, bundled by Vite, with `tokens.css` and
`components.css` imported at the top of `renderer/src/main.tsx`. `pnpm --filter @orca/app dev`
runs it with hot reload; `docs/DEVELOPMENT.md` ("The renderer build") has the rest.

The primitives are already built: `renderer/src/ui` wraps the `orca-*` classes as
`StatusChip`, `Button`, `Chip`, `Card`, `Well`, `Text`, `Duration`, `Time`, `ConfigField`,
`ObjectHeader`, `StateView`, `ScheduleBadge`, `ConnectionIndicator` and `Menu`. Compose those
rather than writing class names, and see them all in both themes at `#preview` in a dev build
(`#type` proves the bundled faces and glyphs). If an implementation has to diverge from
`component-api.d.ts`, correct that file in the same PR.

**Every popover is a `Menu`.** Roving focus with `↑`/`↓`/`Home`/`End`, `Enter` to choose,
typeahead on a letter, focus onto the first item on open and back to the trigger on close —
including on `Esc`. Placement flips rather than clips. Do not add an `Escape` handler, an
outside-click listener, a `tabIndex` dance or a `useState` for open: all of that is the
primitive's, and a second implementation is the thing #202 exists to prevent. If a popover's
body is not a list of choices, extend `Menu` rather than growing a rival — the keyboard and
focus contract has to stay in one place.

**Lists do not poll. The daemon pushes.** `window.orca.notifications.subscribe` is the raw
envelope stream; wrap it with `createNotificationStream` (`renderer/src/notifications.ts`)
and listen to one method — `run.changed`, `step.changed`, `agent.update`, `input.opened`,
`input.answered`, `event.appended` — with an optional `runId` filter. Never re-read a list
because a notification arrived; a notification for an object the list has never seen is
resolved with one `runs.get` and inserted. Every notification carries `seq`, the cursor, and
the main process owns reconnection and resume, so a screen only has to unsubscribe when it
goes away. Agent output arrives coalesced (one `agent.update` per step per 100ms, many lines
inside) — render the batch, do not assume one line per frame. And a push can never tell you
a run went `stale`: that is a lapsed lease, which is nothing happening, so it shows up only
on a read.

`renderer/src/runs/` is the worked example of a surface and the shape the next one should
take: the arithmetic in a plain module with a plain test, the data in one hook, selection and
its keys in another, and the markup composed from `ui/`. Filtering is a filter, not a search
— status is a `runs.list` parameter the daemon applies to the whole store, text is applied
locally to what is held, and the count says which ("3 of 7 runs").

**Every shortcut goes in the keyboard map.** Register `{ scope, key, label, action }` on the
`KeyboardMap` (`renderer/src/keyboard-map.ts`) rather than adding a `keydown` listener — the
command palette is a view of that registry, so a shortcut that skips it is a shortcut nobody
can discover. Mark the subtree that owns a scope with `scopeProps("run-tree")`; `Esc` belongs
to the layer stack, not to your component. `docs/design/60-implementation.md` has the rest.

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
