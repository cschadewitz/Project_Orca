# ORCA → Orrery rename tools

These tools rename ORCA to Orrery without freezing `main`. The plan is in the project's
"Orrery rename and cutover plan" doc; this file is the part agents need while they work.

## Two layers

| Layer | What | Where it lives |
| --- | --- | --- |
| **Hand** | Compatibility code, scripts, brand assets, docs rewrites, `rename-keep` markers, codemod rules | Committed on `Rename-Migration` (through `rm/<cohort>` branches) |
| **Mechanical** | About 20,000 find-and-replace edits and about 20 file renames | Never committed before cutover. `codemod.mjs` regenerates it over the final tree. |

Because the mechanical layer is regenerated, `main` stays open and its new code gets renamed too.

## Files

| File | Does |
| --- | --- |
| `map.json` | The naming map: ordered rules, keep patterns, excluded paths. The only place a name is decided. |
| `codemod.mjs` | Applies the map. Dry run by default; `--apply` rewrites and `git mv`s; `--only <path>` limits it. Idempotent. |
| `audit.mjs` | Lists every ORCA name the codemod left, exits 1 if any. Run after `--apply`. |
| `allowlist.json` | Leftovers that are right, each with a reason, for files that cannot hold a comment. |
| `convert-branch.sh` | After cutover, moves a branch that was still open onto the new names. |
| `.github/workflows/rename-preview.yml` | On every push to `Rename-Migration`: merge `main`, apply, audit, typecheck, lint, build, test. |

## Working on your area

```sh
node tools/rename/codemod.mjs --only packages/core    # what would change
# in a scratch worktree, never on your branch:
node tools/rename/codemod.mjs --apply && node tools/rename/audit.mjs && pnpm run typecheck && pnpm test
```

When the result is wrong, fix it on your branch with one of these, never by committing codemod output:

- **A rule is wrong everywhere:** change `map.json` and add a case to `tools/test/rename-codemod.test.js`.
- **One line must keep the old name** (a legacy read, a fixture, a sentence about the old name): add `rename-keep` in a comment on that line, with the reason. For several lines, wrap them in `rename-keep-start` / `rename-keep-end`.
- **A file can't hold a comment** (JSON, a fixture): add an entry to `allowlist.json`.
- **The renamed code needs a different shape** (a fallback, a migration): write it by hand, already using the new names, and mark the legacy half `rename-keep`.

## What is never renamed

Excluded paths and keep patterns are listed in `map.json` with their reasons: old-store fixtures,
the CHANGELOG body, archived docs, the Windows `appId dev.orca.desktop`, the R2 bucket
`orca-desktop-feed`, the Entra app `orca-infra-ci`, Actions secret names, the `orca1` daemon
token prefix and the `ORCADP01` diagnostics header.
