# Working in this repo

ORCA is an orchestration runtime for coding agents. This file is the entry point for any
agent — Claude Code, Codex, Gemini CLI, or ORCA driving itself — doing work here.

## Before you touch the UI

Read **`design/RULES.md`** first. It is short and it is binding. The full reasoning is in
`design/README.md`, and the surface-by-surface specs are in `design/docs/`.

The three that cause the most rework if you miss them:

- **No literal colours, sizes, radii or durations in component code.** Reference a token —
  `var(--status-failed)` in CSS, `v('status-failed')` from `design/tokens.ts` in TypeScript. If
  nothing names what you need, add it to `design/tokens.json` and rebuild.
- **`design/tokens.css` and `design/tokens.ts` are generated.** Edit `design/tokens.json` or
  `design/semantics.json`, then `npm run design:build`. CI rejects stale generated files.
- **There are eight run statuses and they always render a glyph and a word.** Import
  `RunStatus` and `STATUS_PRESENTATION`; never re-declare the list, never rely on colour alone.

## Commands

```sh
npm run design:build    # regenerate tokens.css and tokens.ts from tokens.json
npm run design:check    # fail if the generated files are behind (CI)
npm run design:test     # WCAG AA contrast in both themes, plus system invariants (CI)
```

## When you are asked for a screen

The component layer already exists in `design/components.css` as token-bound classes
(`orca-tree-row`, `orca-chip`, `orca-card`, `orca-node`, …), and `design/component-api.d.ts`
says what props each React primitive should expose over them. Build on those rather than
re-deriving values. If a screen seems to need a component that does not exist, check
`design/docs/` before inventing one — most of them are already specced.

## When the data is not there

ORCA cannot currently supply a run completion percentage, an estimated time remaining, or
agent cost. Do not approximate them, and do not add a placeholder. Say so in the PR.
`design/docs/60-implementation.md` has the standing list.

## Keeping the rendered version honest

`design/` is the source of truth. There is also a rendered version of the system — live
previews, both themes, the key screens — as a Claude artifact, used for visual review. It does
not feed the build and nothing here reads from it. When the files change materially, ask for
it to be republished from `design/`; do not treat it as an authority when the two disagree.
