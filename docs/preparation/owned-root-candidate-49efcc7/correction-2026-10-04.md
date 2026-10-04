# Correction and owner recovery - 2026-10-04 UTC

This addendum supersedes the packet's inactive/preactivation status and any suggestion
that a pre-switch snapshot or binary-only downgrade is a verified rollback after new
admissions. The original preparation, build, test and preflight observations remain
historical evidence. The accompanying `.log` files are unchanged. This correction did
not rebuild, rerun those tests, access the homelab, or perform activation or recovery.

## Corrected identity and provenance

Runtime source remains `49efcc7236ac127c952bb1f7a50fc6ef72f7df84`. The documentation
head inspected for this correction was `796ddd0a8c48e2b002ae8ff1b13f5ee02ed41657`;
documentation commits do not identify a different runtime build.

The owner verified `packages/engine/dist/workspace/owned-root-worktree.js` as
SHA-256 `ef7861dfa9e894a04087fc78d1313b4054051c735d82b613e25cba338b9ee78a`.
Both candidate and installed full compiled manifests matched the reviewed pin
`ffc4e42345db96f5103613ac3a82be16409770f9b6df1a14c755d1a00b6aaf5f`.
The correction is based on that complete-set verification, not a guessed digit.

Historical invalid digest (63 characters; never use as a pin): `ef7861dfa9e894a04087fc78d1313b4054051c735d82b613e25cba338b2814a`.

The corrected individual value replaces the malformed one in `activation-preflight.md`
and `validation-report.txt`; it is explicitly a later owner verification, not a new
local hash observation. The original value remains above to explain the failure.

The [owner correction comment](https://github.com/cschadewitz/Project_Orca/pull/480#issuecomment-5977770834),
created and last updated at 07:38:34 UTC, was read through the authorized GitHub API
during this correction. It independently records the corrected digest, matching full
manifests, bounded recovery, and first isolated smoke. It does not establish the later
parallel result. The later history below is attributed to the owner's update and the
parent's report/patch review supplied with this documentation task; this editor did
not fetch live run artifacts or rerun those smokes.

## Recovery and smoke chronology

1. Cal's generated offline shell copied the malformed digest and used `set -euo pipefail`.
   A failure inside `hash_is` exited with status 1 without the intended STOP message
   because `ERR` inheritance (`-E`) was absent.
2. The owner verified and retained the original backup. Original config/workflow
   hashes were unchanged at the stop. After checking candidate and installed manifests,
   the owner authenticated the original script by SHA-256 and resumed only the remaining
   verification/configuration stages with `set -Eeuo pipefail` and prerequisite checks.
   There was no backup recreation, repeated runtime extraction, or snapshot restoration.
   The candidate was started on the existing endpoint; the old runtime and tunnel were retained.
3. The first isolated read-only smoke, `run_77644190-568b-4691-9bc4-2a7d6d32c5b8`,
   passed at 07:34:18 UTC. Fresh discovery retained the existing principal, owned-run
   and workflow scope, and six grants. Workflow v3 was observed at configuration
   generation `bc51f216-11be-4119-ac94-af5f9a164d65`. This first result alone did not
   establish concurrent-run acceptance.
4. Two later concurrent smokes encountered full `/tmp`: B failed; A lost its lease
   and was explicitly cancelled with files retained. These failures remain part of
   the history and are not reclassified by later successful runs.
5. The owner retained inactive Windows build folders on disk, freeing 1.9 GB, and
   configured private `TMPDIR=/srv/dev/orca-temp-cal` for both daemon and `codex-worker`.
   The restart completed. These owner actions were not performed by this correction.
6. Single sandbox-only smoke `run_c760211d-8aa4-4806-a9d0-ad2cfb8accd3` passed.
   Two overlapping sandbox-only runs then passed:
   `run_971adec5-5bd7-47c3-9c88-87ae9095f18b` and
   `run_78c570d4-fc19-4cf9-9331-37763499103d`, completed by 08:12 UTC on October 4.
   The parent verified both reports and patches: each had its own distinct owned root
   and branch, pinned base/HEAD `8875f4585d7e5cd038ec974f5c6c270f8c5f01c3` unchanged,
   clean source, no source changes, and no escalations.

Basic parallel execution is verified by that reported evidence. Dependency availability
in fresh worktrees and service supervision remain open; these Git/shell-only checks
do not establish either. Workflow prompt text still does not enforce an independent-run
capacity cap. No additional run or runtime action is authorized by this addendum.

## Reuse and recovery boundaries

The preflight's process IDs, absence checks, config hashes, capacity readings and
pre-admission conditions describe the original observation time. Do not replay the
historical activation sequence against the current state or reuse the original smoke
idempotency key for a new run. The later TMPDIR mitigation does not retroactively make
the original capacity check or failed smokes pass.

After new admissions, binary-only downgrade or pre-switch snapshot restoration can
discard or strand work and is **NOT a verified rollback**. Preserve the old runtime,
verified backup, current protected state, generations, private inputs, auth/audit state,
and all run branches, worktrees and owned receipts, including retained failed/cancelled
run files. Any recovery requires a separately reviewed reconciliation/recovery plan;
the historical pre-admission restore recipe is not applicable now.

Reusable Bash guards now use `set -Eeuo pipefail`, an inherited `ERR` trap that emits
STOP and preserves the failing status, and strict 64-lowercase-hex checks before file
comparison. The Python checksum helper also rejects malformed expected pins. Call
the Bash helpers as standalone commands in the same initialized shell; conditional
call sites can suppress Bash error handling. The activation snippets remain historical,
not executable recovery instructions for the present runtime.

## Focused documentation validation

Run from this checkout, without dependencies, builds, installs or runtime access:

```text
node --check docs/preparation/owned-root-candidate-49efcc7/validate-documentation.mjs
node docs/preparation/owned-root-candidate-49efcc7/validate-documentation.mjs <bash-executable>
git diff --check
```

The validator checks hexadecimal digest lengths in the packet (allowing only the
explicit historical invalid value above), the corrected individual and manifest pins,
and Bash syntax of every preflight shell block. It extracts only the marked reusable
guards for execution against disposable local fixtures: matching digest, malformed
expected/actual digests, mismatch, missing file, and pipeline/helper failure. It checks
nonzero exit, visible STOP output, preserved failure status, and that failure prevents
the following sentinel command. No activation block is executed.

Results recorded for this correction on the selected Windows computer (Node v24.19.0,
Git for Windows Bash at `C:/Program Files/Git/bin/bash.exe`):

- `node --check .../validate-documentation.mjs`: passed.
- `node .../validate-documentation.mjs 'C:/Program Files/Git/bin/bash.exe'`: passed;
  33 SHA-256 literals, the single explicitly historical malformed value, and all eight
  Bash blocks checked. Nine fixture cases passed: matching file (exit 0); malformed
  expected, nonhex expected, mismatch, malformed actual, missing file and failed
  manifest capture (exit 1); pipeline failure (exit 7); nested helper failure (exit 9).
  Every failure emitted STOP and prevented the following sentinel command. The initial
  sandbox attempt could not spawn Bash (`EPERM`); the local-fixture retry with process
  permission passed. This was not a runtime or smoke retry.
- `git diff --check`: passed. Historical `.log` files, proposed YAML, smoke JSON and
  `validate-proposal.mjs` were checked unchanged against the inspected documentation head.
- Markdown is excluded by the repository's `.prettierignore`. The initial correction
  did not locate Prettier in the checkout or filename-based cache search and claimed
  no formatter pass. The subsequent cache-index inspection and formatter result below
  supersede that availability assessment. No dependencies were installed. The compiled
  proposal validator and original build/source/acceptance suites were not rerun.

## Formatter follow-up - 2026-10-04 UTC

The lockfile pins Prettier **3.9.9** (the package manifest requests `^3.9.9`). A read-only
copy of the selected computer's pnpm v11 SQLite cache index contained this exact version
under the lockfile's integrity key. All 56 cached package files were checked against
their recorded SHA-512 digests and sizes, then copied into a temporary task directory.
The copied executable reported `3.9.9`. No download, package-manager install, changes to
another checkout, or cache mutation was needed. Editor-bundled versions 3.6.2 and 2.8.8
were also found, but were not used for validation.

At correction head `5b877d41241517e33bd2ec013fb452052c1189dc`, these checks passed:

```text
node ../cached-prettier-3.9.9/bin/prettier.cjs --check docs/preparation/owned-root-candidate-49efcc7/validate-documentation.mjs
node ../cached-prettier-3.9.9/bin/prettier.cjs --check 'docs/preparation/owned-root-candidate-49efcc7/*.{mjs,yaml,json,md}'
```

The first command checked the new validator in the isolated checkout. The second
checked the packet in a temporary export produced by `git -c core.autocrlf=false archive`,
including the repository's `.prettierrc.json` and `.prettierignore`. A direct packet
check in the Windows checkout initially warned about CRLF in four unchanged files;
comparison with formatter output confirmed line endings were the only difference.
The export without line-ending conversion passed for both validators, both YAML
proposals and the smoke JSON. Markdown remains excluded by repository policy. Original
logs, launch inputs and proposal files were not rewritten. This is a focused packet
formatting result, not a new whole-repository `pnpm run format:check` result.

[CI #458](https://github.com/cschadewitz/Project_Orca/actions/runs/37188953622) succeeded
for that correction head, but only change classification ran; the main check job was
skipped for documentation-only changes. It supplied no formatter or runtime validation.
The full-repository format pass recorded in the original preflight belongs to the
historical preparation published at `796ddd0a8c48e2b002ae8ff1b13f5ee02ed41657` and must
not be presented as a fresh check of the correction.
