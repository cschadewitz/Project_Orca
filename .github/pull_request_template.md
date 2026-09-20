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
- [ ] Changelog fragment added under `changelog.d/` (`<issue>-<slug>.<section>.md`), or the change needs none and carries the `no-changelog` label — CI checks this for any change under `packages/` (see `changelog.d/README.md`)
