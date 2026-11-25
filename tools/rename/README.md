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
| `.github/workflows/rename-preview.yml` | On every push to `Rename-Migration`: merge `main`, apply, then audit, typecheck, lint, build and test, each run whatever the one before said. |

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

## Cutover scripts

Run in this order on cutover day, each first with `--dry-run`. Every script is idempotent (it
reads the state first and changes only what is missing, so a rerun after a failure continues),
and every change is appended to `cutover-log.json` (`CUTOVER_LOG` to put it elsewhere), one JSON
line with the state before it. Nothing here holds a secret: GitHub is reached with `gh`'s own
login, Azure with `az`'s, Cloudflare with `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`)
from the environment.

| Script | Does |
| --- | --- |
| `preflight.sh [--rings FILE]` | Changes nothing. Rename-Migration of both repositories has all of `main`; `gh` can administer both; the bridge (`BRIDGE_VERSION`, default 0.8.1) or later is on the feed's **stable** ring for desktops and servers; both zones are Active; the Cloudflare token is active and can read Pages, DNS, the redirect ruleset and Workers domains; `az` can read the Entra app. The ring state is rings.json: `--rings FILE` (the feed watchdog's summary prints it), or the feed reader's `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `FEED_ACCOUNT_ID`, `FEED_BUCKET` and it runs `tools/deploy/feed-r2.sh read-rings` itself. |
| `github.sh --repos [--apply-azure]` | Renames, never deletes: `Orrery` → `Orrery-placeholder` and `Orrery-Infra` → `Orrery-Infra-placeholder` (Casey's private placeholders; a public repository there stops it), then `Project_Orca` → `Orrery` and `Project_Orca_Infra` → `Orrery-Infra`. Then the Entra app `orca-infra-ci`'s federated credentials: GitHub's OIDC subject holds the repository name (`repo:cschadewitz@7377200/Project_Orca_Infra@<id>:environment:production`), so Infrastructure cannot sign in to Azure until the subject names `Orrery-Infra`. The credential ids are looked up (`az ad app federated-credential list`); the update commands are printed, and run with `--apply-azure`. |
| `github.sh --settings` | Orrery's description, homepage (https://docs.orrery-control.dev) and topics; copies every Actions variable `ORCA_X` to `ORRERY_X` (repository and environment variables, both repositories). The originals stay: workflows read `vars.ORRERY_X \|\| vars.ORCA_X` for one release. Secrets keep their `ORCA_*` names. |
| `cloudflare.sh` | The Pages project `orrery-docs`; `docs.orrery-control.dev` bound to it, with its CNAME; `orrery-control.com` and `www` 301 to the docs (one rule appended to the zone's single-redirect ruleset, over proxied 192.0.2.1 records); `feed.orrery-control.com` attached to the feed Worker `orca-desktop-feed` as a Workers custom domain (skipped with a note when Orrery-Infra's Terraform owns it through `FEED_DOMAIN_HOSTNAME`). |
| `verify.sh [--no-infra-dispatch]` | The old names redirect to the new repositories; homepage, topics and the `ORRERY_` copies; the docs answer 200; the apex and www redirect; the feed host answers as the Worker (401 with its realm); and an Infrastructure dispatch on Orrery-Infra gets through its Azure sign-in (`Plan and apply`). The dispatch runs the guarded apply, like any dispatch; `--dry-run` prints it. |
| `rollback.sh [--log FILE]` | Undoes the log newest first, moving each record to `FILE.undone` once undone, so a rerun never undoes anything twice. It deletes only what the cutover created (the `ORRERY_` copies, DNS records, the redirect rule, the Pages domain and project, the Worker domain) and renames back. |
| `relink-clones.sh [CLONE...]` / `relink-clones.ps1` | In each clone (default: the current directory), every remote URL naming `cschadewitz/Project_Orca` or `Project_Orca_Infra` (https or ssh) is pointed at the new name. GitHub's redirect keeps old clones working until then. |

`tools/test/rename-cutover.test.js` runs each script against stand-ins for `gh`, `curl` and `az`:
the dry run changes nothing, a real run changes only what is missing and logs it, a rerun is a
no-op, and rollback undoes the log.
