## What

<!-- What changed, in a sentence or two. -->

## Why

<!-- The motivation. Link an issue if there is one. -->

## How it was verified

<!-- Commands run, tests added, manual checks. CI runs lint/test/build automatically. -->

## Checklist

- [ ] `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm test` and `pnpm run build` pass locally
- [ ] New files follow the conventions in `docs/DEVELOPMENT.md` (one concern per file, leading comment saying what it is for)
- [ ] Docs under `docs/` updated if behaviour or architecture changed
- [ ] Entry added to `CHANGELOG.md` under `## Unreleased`, or the change needs none (see `docs/RELEASING.md`)
