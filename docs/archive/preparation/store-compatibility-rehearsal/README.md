# Store-compatibility rehearsal: v0.6.0 to the next candidate

**Status: preparation. No installed rehearsal has been run.** Tracked by
[#787](https://github.com/cschadewitz/Project_Orca/issues/787), for readiness row C3 of
[#773](https://github.com/cschadewitz/Project_Orca/issues/773) (audit merged in #775).
Verified against `v0.6.0` (`c5c7cd3ba957f737f0e3ec65d2a5d103a94f9f4c`) and `main`
(`7f42c3a7699a8da24cfbf4a1ab1f796947bfff14`, 27 October 2026). This document chooses no
version, date or candidate. Nothing here was installed, updated, migrated, downgraded,
deployed, tagged or published, and no real workspace or credential was used. Apple
Silicon/macOS is out of scope.

This is about **historical store compatibility**: what happens to state that v0.6.0 wrote when
a later build opens it, and how to get back. Artifact identity and installer inspection belong
to [#772](https://github.com/cschadewitz/Project_Orca/issues/772) /
[#779](https://github.com/cschadewitz/Project_Orca/pull/779). The operator contract is
[UPDATING.md](../../UPDATING.md) "Recovery and store compatibility"; this document checks it
against code and does not replace it.

## Evidence words

Each row claims only the strongest of these it has, following the readiness audit's
vocabulary:

- **Source**: read in the code at the commits above. Nothing was executed.
- **Offline test**: a dedicated test in this change passes. Only synthetic stores and
  temporary directories are involved.
- **Synthetic rehearsal**: `rehearse.js` ran v0.6.0 and `main` on this Linux x64 container
  (Node 24.21.0), from source and from compiled `dist` builds (section 3). The store is
  v0.6.0's own scripted `demo` output, generated here. It is not an installed store and not
  installed evidence.
- **Installed-unverified**: needs the installed run in [section 5](#5-installed-windowslinux-rehearsal-prerequisites-and-expected-evidence).
  Not run.

## 1. The contracts, checked against code

| Fact | v0.6.0 | `main` | Where |
| --- | --- | --- | --- |
| Store epoch | `ownership-fences-v1` | `operator-journals-v4` | `release-compatibility.json` at each ref |
| Protocol | 1.8 | 2.0 | same; `packages/protocol/src/version.ts:116` |
| Release capabilities | 5 | 7 (adds `workflows.validateInputs`, `inputs.live`) | same |
| Node engine | `>=22` | `>=24` | root `package.json`. Not enforced at startup in either; `mise.toml` pins `node = "24"` at both |
| Event types | 32 | 34: adds `continuation.recorded`, `revision.recorded` | `packages/core/src/events/events.ts:327,341` |
| Event envelope | `z.object` (unknown keys dropped) | `z.object`, adds optional `executionPayloadRef`, `journal` | `events.ts:31-43`; v0.6.0 `events.ts:20` |
| Store directories | none of the ones on the right | `private-execution/`, `private-workflows/`, `workspace-identity/`, `admission-retries/`, `continuation-locators/`, `request-admissions.json`, `request-admission-locks/` | `packages/store/src` at each ref. The rehearsal observed all of them except `private-workflows/` and `continuation-locators/` |
| Daemon authentication | none | bearer token by default; `auth/` written beside the config | `packages/cli/src/commands/index.ts:1048-1066` |
| Updater RPC | sends no credential | reads `auth/local-client.token` | `tools/deploy/orca-release.py:146` vs v0.6.0 `:73` |
| Hello across versions | refuses a different protocol major | same | `packages/daemon/src/methods.ts:369` |

What the existing statements in UPDATING.md, the release-compatibility notes and the
`0-v060-upgrade-boundary` fragment turn out to mean in code:

1. **"Managed activation and recovery refuse cross-epoch operation."** Confirmed, for the
   Debian adapter only. `compatible()` (`orca-release.py:197`) is the only check, and the
   adapter is the only non-macOS reader of `release-compatibility.json`. It compares
   `.orca-release.json` copies that `stage` writes from each release's manifest. Activation
   calls it first (`:421`), before the journal, process inspection, health or the admission
   barrier, and so does `restore` (`:462`). The v0.6.0 adapter has the same check.
2. **"Direct CLI and daemon startup do not enforce the marker."** Confirmed, and wider than
   it reads. No Windows or Linux desktop path consults it either, nor the wrapper launch,
   nor the manual pointer switch used at bootstrap. No store carries a marker of the epoch
   that last wrote it, so there is nothing for these paths to check.
3. **"Direct downgrade is unsupported."** Confirmed: nothing in a direct path refuses it.
   The managed path refuses it only because the epochs differ (M4).
4. **"Old full-schema event readers throw on a valid but unknown event."** True only when a
   `revision.recorded` or `continuation.recorded` event exists (D5). Otherwise v0.6.0's
   full schemas parsed every record the rehearsal's 2.0 writer produced, and silently
   dropped the new fields, including `executionPayloadRef`. "Appears to work" covers
   full-schema readers too, not only filtered ones.
5. **"Upgrade clients and daemons together."** Confirmed. A different protocol major is
   refused at `hello` in both directions, and a v0.6.0 client sends no token, so a token-mode
   daemon refuses it before `hello` (D6).

## 2. Compatibility matrix

Every entry path where the managed/direct distinction matters. "Candidate" means a build of
`main` carrying `operator-journals-v4` / protocol 2.0.

### Managed Debian deployment (`tools/deploy/orca-release.py`)

| Row | Path | What happens at this boundary | Evidence |
| --- | --- | --- | --- |
| M1 | `update vCAND` run by **the candidate's** adapter | `stage` touches no operator store: `validate` writes nothing (D4), and `demo` and the health check use temporary directories. Activation is then refused with `Store compatibility changed. Automatic activation/rollback refused` before any journal, process inspection, health check, admission change, service action or pointer change. The staged release directory stays. | Offline test `test_m1_*`, against the current adapter and the v0.6.0 blob |
| M2 | `update vCAND` run by the **installed v0.6.0** adapter | Bootstrap copies `orca-release.py` outside `releases/`, so an installed v0.6.0 host runs v0.6.0's adapter. Its `rpc()` sends no credential. The candidate's `serve` is token-authenticated by default, so the scratch health check in `stage` gets `HTTP 401`. Staging fails as `Health check failed`, leaving a `.staging-*` directory, and **never reaches the epoch check**. | Synthetic: opt-in `test_m2_*` against this checkout's real daemon, with both adapters; manual probe |
| M3 | `recover` with a journal naming releases of different epochs | Refused. `activation.json` is kept, CLI and ACP launches refuse with "pending", and the daemon still starts under the closed-admission file. The epoch check makes such a journal unreachable through `update`. This row checks that recovery cannot be the way across. | Offline test `test_m3_*` (in-process and through the adapter's own `recover`) |
| M4 | Attempted downgrade: `update v0.6.0` with `releases/v0.6.0` retained, or activating an older release | The epoch check refuses it before the version comparison (`:424`). An older release of the same epoch is refused with "Updates must move forward". | Offline test `test_m4_*` |
| M5 | Wrapper launches (`cli`, `acp`, `daemon`) | They exec whatever `current` resolves to. Nothing between the pointer and `exec` compares epochs. A hand-edited pointer reaches a cross-epoch binary unchecked. | Offline test `test_m5_*`, which pins today's behaviour |
| M6 | Bootstrap of the candidate as the first managed release, over stores a v0.6.0 install wrote | UPDATING.md's bootstrap is `stage` plus a manual `ln -s ... current`. Nothing compares epochs. | Source (UPDATING.md "Bootstrap once"; M5) |
| M7 | A retained release whose pinned Node is gone | `metadata()` refuses (`Pinned Node executable is missing`), so it cannot be launched, health-checked or restored to. The binary and its toolchain are one unit. | Offline test `test_m7_*` |

### Direct CLI, daemon and standalone `orca-daemon-X.Y.Z.mjs`

| Row | Path | What happens | Evidence |
| --- | --- | --- | --- |
| D1 | Candidate read commands on a v0.6.0 store (`runs` in the harness and `events` in a manual probe; the others share the same bootstrap) | They succeed. They also create `private-execution/.execution-key` and a `*.generation.json` record. Existing bytes are untouched. | Offline test (old-shaped synthetic store); synthetic rehearsal (v0.6.0 store) |
| D2 | Candidate `serve --read-only`, which is also the desktop's **File ▸ Open a store…** | It succeeds and writes `.workspace-identified`, `workspace-identity/id`, the private-execution key, a generation record and `auth/` (`credentials.json`, `local-client.token`, `audit.jsonl`, `.gitignore`) beside the config. "Read-only" omits run controls. It does not make the first open write-free. | Offline test; synthetic rehearsal |
| D3 | Candidate writers (`serve`, `run`, `resume`, `submit`, `acp`, and `demo` in the rehearsal) | All of the above, plus admission state. In the rehearsal: 560 entries added and 7 existing store files changed, with no removals. Five shared collections were rewritten whole (`requests.json`, `work-items.json`, `plans.json`, `dependencies.json`, `risks.json`). The artifact index and the plan journal were appended to, with their earlier bytes intact. | Synthetic rehearsal |
| D4 | Candidate `validate` (also run by `stage`) | Writes nothing. | Synthetic rehearsal |
| D5 | **v0.6.0** reading an upgraded store (direct downgrade) | Nothing refuses it. Judged by v0.6.0's own schemas in-process, in the rehearsal: 987 run events, 0 refused, 19 field paths silently dropped (`executionPayloadRef` on every candidate-written event, `executionInputsStored`, configuration-generation `provenance`, `continuity`, `actor`, `requestAdmissionId`). All 98 plan-journal and 54 artifact-index records and every collection record parsed with nothing dropped. `revision.recorded` and `continuation.recorded` are refused (`invalid_union`); the scripted demo writes neither. Unread by v0.6.0 at all: `private-execution/`, `workspace-identity/`, admission and continuation state. The v0.6.0 binary was not allowed to open or write the upgraded store, so what it would do next is not shown. | Synthetic rehearsal (`schema-read.js`); the same mechanism in the current code is an offline test |
| D6 | Cross-version client and daemon | A v0.6.0 app or CLI against a candidate daemon is refused (`401` without a token; `hello` refuses major 1). A candidate client against a v0.6.0 daemon is refused (`hello` refuses major 2). | Source (`methods.ts:369`, both refs); the M2 test shows the 401 |

### Desktop

| Row | Path | What happens | Evidence |
| --- | --- | --- | --- |
| W1 | Windows in-app update from v0.6.0 | **v0.6.0's** driver runs this step. It checks nothing about the store or protocol: it takes whatever `latest-ARCH.yml` offers, ignores versions containing `-` and refuses feed downgrades (v0.6.0 `update-driver.ts:24,35`). It closes admission on the owned daemon and stops it before the installer. After installation, the candidate app starts its bundled daemon over the same workspace, which is D2/D3. | Source; installed-unverified |
| W2 | Windows installer timeout or error during that update | v0.6.0's semantics apply, not #660's. After a 10 s timeout or an error event, v0.6.0 resumes admission and reconnects, starting its own daemon again (v0.6.0 `updates.ts:60-64`, `workspace.ts:148-155`) while the installer may still be running. The #660 contract (timeout = unknown, stay closed) applies only to updates driven by a build that contains it, that is, from the candidate onward. | Source; installed-unverified |
| W3 | Windows rollback | The feed refuses downgrades (`allowDowngrade = false` at both refs). Installing the retained v0.6.0 NSIS installer by hand over an upgraded workspace is D5 and unsupported: restore the backup first. Whether NSIS accepts an older installer over a newer install was not checked. | Source; installed-unverified |
| W4 | Linux AppImage / `tar.gz` replaced by hand | No updater. On launch, the bundled daemon is D2/D3. | Source |

### Failed or interrupted upgrade, and restore

| Row | Case | What happens | Evidence |
| --- | --- | --- | --- |
| F1 | Managed, across the epoch | Never activates (M1, M2). Nothing to recover. A staged or `.staging-*` directory is left for the operator. | Offline test |
| F2 | Managed, same epoch | The existing journal restores the previous release and keeps admission closed on failure (`test_release.py`, `test_integration.py`). It cannot be used across this epoch. | Existing tests |
| F3 | Direct or desktop upgrade interrupted after the first open | No journal, no marker and no automatic rollback. The first open has already written new state (D1/D2), so the store is partly upgraded. The only way back is restoring the whole backup. Writes made after it need separate reconciliation. | Synthetic rehearsal (restore and reconcile) |
| R0 | Certifying the pre-upgrade backup with the store's own recovery inventory (#538) | It enumerates the store, but reports `IDENTITY_MISSING`, so integrity is `failed`. Recovery stays `RECOVERY_DISABLED`. It cannot certify a store written before workspace identity existed, so the backup is checked with byte manifests instead (`snapshot.js`). | Offline test |
| R1 | Whole-backup restore to the original path | Bytes and permission bits match the pre-upgrade manifest. The v0.6.0 binary's `validate` and `runs` then exit 0 on the restored store and write nothing. | Synthetic rehearsal; offline test (current-code synthetic) |
| R2 | Partial restore: one run log missing | Detected (`removed`). | Synthetic rehearsal; offline test |
| R3 | Mixed restore: one file from the upgraded store | Detected (`changed`). | Synthetic rehearsal; offline test |
| R4 | Writes made after the backup | Listed rather than recovered: 560 added and 10 changed in the rehearsal (the 7 store files above plus the demo's own `orca.config.yaml` and `.orca-demo/` state). | Synthetic rehearsal; offline test |

## 3. Harness and tests

Everything is under `tools/store-compat-rehearsal/` (helpers) and
`tools/test/store-compat-rehearsal/` (tests). No production code, manifest or workflow is
changed.

| File | What it is |
| --- | --- |
| `snapshot.js` | Byte manifests of explicitly named roots (path, kind, permission bits, size, SHA-256). It refuses links, special files, overlapping roots and entries that change mid-read. `compareSnapshots` ignores inode and times. `copyToNew` creates only a destination that does not exist and verifies the copy. Nothing in it deletes or overwrites. |
| `schema-read.js` | Parses a store's records with **one checkout's** schemas using `readFileSync` only. It constructs no store, so it takes no lock and creates no key or identity. It reports refused records, dropped fields and unread top-level entries. |
| `rehearse.js` | The cross-version driver, steps 1-8 below. It writes only under a new `--work` directory and never deletes. |
| `test_managed_boundary.py` | M1, M3, M4, M5, M7, and opt-in M2, against `orca-release.py`. `ORCA_REHEARSAL_ADAPTER` selects another adapter file. |
| `managed-boundary.test.js` | Runs the Python rows in the normal suite, as `deployment.test.js` does. |
| `snapshot.test.js`, `store-boundary.test.js` | Helper behaviour, plus D1, D2, the D5 mechanism, and R0-R4 against the current code with old-shaped synthetic stores. |

`rehearse.js` steps:

1. v0.6.0's own `demo` writes a store.
2. With nothing running, take a manifest, make a verified copy (the backup) and compare them.
3. On fresh copies, the candidate runs `validate`, `runs` and `serve --read-only`; record each write set.
4. The candidate's `demo` runs on the live store (the first upgraded writer); record the write set.
5. Judge the upgraded store with the v0.6.0 schemas, and with the candidate's as a control.
6. Move the upgraded store aside and restore the backup to the original path; compare, and list what needs reconciliation.
7. The v0.6.0 binary runs `validate` and `runs` on its own restored store.
8. Partial and mixed restores must be detected.

Reproduce (Node 24 and pnpm on Linux; about five minutes):

```sh
WORK=$(mktemp -d)                           # any empty scratch directory
git worktree add --detach "$WORK/v0.6.0" v0.6.0
(cd "$WORK/v0.6.0" && pnpm install --frozen-lockfile)
pnpm install --frozen-lockfile              # in the candidate checkout
node tools/store-compat-rehearsal/rehearse.js --old "$WORK/v0.6.0" --new . --work "$WORK/run"
# Optionally --entry dist after `pnpm run build` in both checkouts; --old-node/--new-node pin toolchains.

git show v0.6.0:tools/deploy/orca-release.py > "$WORK/orca-release-v0.6.0.py"
python3 -B tools/store-compat-rehearsal/test_managed_boundary.py
ORCA_REHEARSAL_ADAPTER="$WORK/orca-release-v0.6.0.py" python3 -B tools/store-compat-rehearsal/test_managed_boundary.py
ORCA_REHEARSAL_NODE=$(command -v node) python3 -B tools/store-compat-rehearsal/test_managed_boundary.py AdapterAgainstCandidateDaemon
ORCA_REHEARSAL_NODE=$(command -v node) ORCA_REHEARSAL_ADAPTER="$WORK/orca-release-v0.6.0.py" \
  python3 -B tools/store-compat-rehearsal/test_managed_boundary.py AdapterAgainstCandidateDaemon
pnpm exec vitest run tools/test/store-compat-rehearsal
```

`$WORK/run/report.json` holds every result above with both commits, versions, manifests and
Node versions. `pre-upgrade.manifest.json` sits beside it.

The driver now requires an existing canonical, link-free parent for the new `--work`
directory, disjoint from both checkouts. Copy destinations have the same ancestry check
before mutation and are claimed exclusively. Use directories you own and keep their
ancestry stable: these path-based helpers do not provide protection against another
process concurrently replacing checked ancestors. Links, junction aliases, preexisting
destinations and overlapping paths are refused before the copy or first binary probe.

`report.json` records `status: "passed"` only when command exits, daemon readiness,
backup and restore equality, unchanged old-binary validation, and both negative restore
controls pass. A failure after work-directory creation preserves completed steps and
failure details with `status: "failed"`; the CLI exits nonzero. Unsafe work paths are
refused without creating a report there. Before every old-binary validation launch,
the complete restored tree must equal the pre-upgrade manifest. These checks and their
disposable sentinel fixtures remain synthetic evidence; they do not add installed proof.

Runs recorded for this document: old `c5c7cd3`, new `7f42c3a`, Node 24.21.0, neither checkout
modified. The reports stay in the session scratch area and are not committed.

| Entry | Backup entries | Results |
| --- | --- | --- |
| `source` | 122 | Every count in section 2 |
| `source` (repeat) | 122 | Identical |
| `dist` (both sides built with `pnpm run build`) | 121 | Identical apart from the backup size. The two demos' outputs differ by one entry. |

The managed rows passed against the current adapter and against the v0.6.0 blob
(`git show v0.6.0:tools/deploy/orca-release.py`). The opt-in M2 check passed for both: the
current adapter completes `hello`, and the v0.6.0 adapter is refused with `401`.

## 4. Procedure: backup, matched retention, explicit migration, offline restore

This is the procedure for the real upgrade, once the operator decisions in
[section 7](#7-operator-decisions) are made. Nothing here has been run on an installed host.

**Before anything else, know there is no migration command.** The candidate migrates lazily:
its first open of a store writes the new state (D1-D3). "Explicit migration" therefore means
starting the candidate deliberately, once, in an idle window, after the steps below. It never
means letting any candidate entry point touch the store first, including a read-only open,
`orca runs` or the desktop's Open a store….

1. **Inventory every root.** On Debian this is every root in UPDATING.md: both stores
   (`.orca` and `.orca-kepler`), plan journals and artifacts (inside the stores), configs,
   permission sidecars (`orca.permissions.json` beside each config), task worktrees,
   `deployment.json`, `daemon.env`, the wrappers and the unit. On Windows it is the
   workspace and its `.orca`, plus the app's `userData` directory: v0.6.0 keeps
   `preferences.json` there, and later builds add `admission-intents.enc` and `first-run/`.
   v0.6.0 has no `auth/` and no private-execution keys. Any that appear mean something newer has already opened the store; stop and
   investigate.
2. **Stop every writer.** Managed Debian: stop admitting launches, let active CLI, ACP and
   Kepler sessions finish, and stop the daemon through its observed supervisor (the same
   idle procedure as UPDATING.md's bootstrap step 1). `orca-release.py update` cannot do
   this across the epoch. Windows: quit ORCA; the owned daemon stops on quit. Confirm with
   the process list that no ORCA process remains.
3. **Take a consistent backup and prove it.** Manifest the roots, copy each to backup media
   with permission bits preserved, manifest the copy, and compare. `snapshot.js` does this
   and refuses a root that changes while it is read. Any tool giving per-file SHA-256 and
   mode is equivalent. Manifest the live roots once more. If anything differs from the first
   manifest, a writer was still running: start again. Never copy a live store.
4. **Retain the matching pair.** Keep the binary and its toolchain together with the
   backup, never one without the other:
   - Debian: `releases/v0.6.0` with its `.orca-release.json`, the exact Node it names, and
     the v0.6.0 `orca-release.py`.
   - Windows: the v0.6.0 NSIS installer for the architecture, with its SHA-512 from
     `latest-ARCH.yml`.
   - Standalone: `orca-daemon-0.6.0.mjs` and the Node it ran on.

   Record the commit (`c5c7cd3`) and the Node and Electron versions.
5. **Validate the restore offline before upgrading.** Restore the backup to a scratch
   location and compare it with the manifest. Then run the retained v0.6.0 binary's
   `validate` and `runs` against it. If the config's `storeDir` is absolute, change it only
   in the scratch copy, never in the backup. This must pass before step 6.
6. **Migrate explicitly.** Start the candidate once and confirm `hello` reports protocol
   2.0 and the expected version. List the runs, then manifest the result. On Debian, how to
   move `current` across the epoch is an open decision (A2). The managed updater refuses,
   which is correct.
7. **Take a new backup baseline.** From the first open on, the store holds a new
   `private-execution/.execution-key`. Losing it makes protected payloads unreadable.
   Every later backup must include it with the store (`docs/protected-execution-storage.md`).
8. **Roll back, if needed, by restoring and never by switching binaries.** Stop the
   candidate. Move the upgraded roots aside without deleting them, restore the whole
   backup to the original paths and compare with the step 3 manifest. Then start the
   retained v0.6.0 with its retained toolchain. Diff the moved-aside roots against the
   backup manifest: that list is the work done since the backup, and it needs separate
   reconciliation. Never copy individual files between the two.

## 5. Installed Windows/Linux rehearsal: prerequisites and expected evidence

**Prerequisites:**

- The coordinator selects a stable candidate tag. The Windows client ignores versions
  containing `-`, so a prerelease cannot exercise W1; this matches #779.
- The published v0.6.0 assets: the NSIS x64 and arm64 installers, AppImage and `tar.gz`,
  and `orca-daemon-0.6.0.mjs`. The candidate's assets, with #779's per-file SHA-256
  manifest.
- Disposable hosts with snapshots: a Windows VM with a fresh profile, and a Linux VM with a
  systemd user session for the managed path.
- A disposable feed with a throwaway read-only token, shared with #779's U-runs.
- Scripted agents only. No real workspace, provider credential, deployment or operator
  account.
- A store produced by the installed v0.6.0 itself, recorded with exactly how it was produced.

**Evidence to keep from every run:**

- Artifact names and SHA-256.
- Both commits, and the Node and Electron versions.
- Before and after manifests (`snapshot.js` JSON).
- Command transcripts with exit codes.
- `hello` results (version, protocol, capabilities).
- `orca-release.py` stderr.
- Whether `activation.json` exists, and the service's MainPID.
- Desktop screenshots.
- A list of what was not run.

| Run | Steps | Pass when |
| --- | --- | --- |
| IL1 | Bootstrap a v0.6.0 managed deployment by UPDATING.md and populate the store. (a) `update vCAND` with the installed v0.6.0 adapter. (b) Replace the adapter with the candidate's and repeat. | (a) Fails at staging with `Health check failed ... 401`: a `.staging-*` directory is left, `current` is unchanged and the v0.6.0 `hello` is 1.8 (M2). (b) Fails with `Store compatibility changed`, exit 1, no `activation.json`, and `current` and the service unchanged (M1). In both, the store manifest is unchanged. |
| IL2 | Only if A2 is decided. Backup and offline validation (section 4, steps 1-5), the decided cross-epoch switch, then rollback (step 8). | After the switch: `hello` 2.0, old runs listed, and only D2/D3 write classes in the manifest diff. After rollback: the manifest equals the backup, `hello` 1.8, and `runs` succeeds. |
| IW1 | Windows v0.6.0 to the candidate through the in-app update, with the workspace and `userData` backed up first. | No compatibility refusal (W1), stated as observed. The candidate lists the old runs, `hello` is 2.0, and the manifest diff shows only D2/D3 classes. |
| IW2 | During IW1's restart, force an installer timeout or error (with #779's U-runs). | v0.6.0's reconnect is recorded as W2 behaviour, not as a #660 failure. |
| IW3 | Quit the candidate, restore the workspace and `userData` from backup, and install the retained v0.6.0 installer by hand. | The manifest matches before launch, v0.6.0 starts with `hello` 1.8 and lists the runs. Whether the installer accepted the downgrade is recorded either way. |
| IL3 | Replace a Linux `tar.gz` or AppImage over a copy of the workspace. | Only D2/D3 write classes. The old runs are listed. |

## 6. Ambiguities found, and proposed production changes (not made here)

Only the first entry is about wording alone; each of the rest needs an owner's decision or a
reviewed production change.

- **A1. The adapter must be replaced before `update`.** UPDATING.md's normal update runs the
  installed adapter, and a v0.6.0 adapter cannot stage a token-mode candidate (M2).
  Proposed: the candidate's notes and UPDATING.md say to copy the candidate's
  `orca-release.py` into place first.
- **A2. There is no supported way across the epoch on Debian.** The managed updater refuses,
  correctly. UPDATING.md requires a deliberate migration but names no mechanism for
  `current`. A manual `ln -sfn` with the service stopped skips the closed-admission start
  and the health gate (M5, M6). Proposed: an explicit adapter command that requires a
  stopped service and a fresh manifest equal to a supplied backup manifest, starts the
  candidate closed, checks `hello` and journals the migration, with a matching restore.
  Until then, the owner decides the manual procedure.
- **A3. Read-only opens write.** D1 and D2 mean that opening a v0.6.0 workspace with a
  newer app is itself the migration. Proposed: refuse to initialize new-epoch state from
  read-only and read paths, or state it plainly in the notes.
- **A4. Stores carry no epoch.** Direct and desktop paths cannot refuse what they cannot
  see. Proposed: a store-resident epoch written by the first writer of an epoch and checked
  on every open, with the explicit migration of A2. This is a store-format change and needs
  its own issue.
- **A5. Downgrade wording.** As described in section 1, item 4. Proposed: UPDATING.md says
  that a full-schema read of an upgraded store can succeed while dropping protected-payload
  references.
- **A6. Windows failure semantics for this step.** W2: #660 starts with the candidate.
  Proposed: say so in UPDATING.md and the notes.
- **A7. The recovery inventory cannot certify a pre-identity store.** R0. If the store's own
  validator should certify the v0.6.0 backup, it needs an explicit pre-identity mode.
- **A8. Node floor.** Nothing refuses Node below 24 at startup. The installed run records the
  Node version actually used.
- **Not an issue for v0.6.0 stores:** `ProtectedEventStore` withholds "legacy sensitive"
  runs until an explicit migration that does not exist (`protected-event-store.ts:47`).
  v0.6.0 had no `inputSchema` or sensitive fields, so v0.6.0 runs cannot trigger it (source).
- **Out of scope (macOS), seen in passing:** the CLI's closed-update receipt reports
  `orca-file-stores-v1` (`update-bootstrap.ts:41`). `mac-update-restart.ts:534` compares that
  receipt epoch with the manifest's `storeEpoch`, which `native-mac-identity.js` takes from
  `release-compatibility.json` (`operator-journals-v4` on `main`). Two epoch vocabularies
  meet there. Source reading only; flagged for the #387/#603 owners.

## 7. Operator decisions

1. Is installed C3 evidence (IL1 at minimum) required before the release, or will the notes
   state it as unverified (readiness D2)?
2. A2: the cross-epoch Debian procedure. Either approve a manual one or wait for a reviewed
   command.
3. Notes and UPDATING.md wording for A1, A3, A5 and A6, through the owners of those
   documents.
4. Hosts and the candidate for section 5, shared with #779's runs.
5. Whether A2, A3, A4 and A7 become issues.

## 8. What this does not establish

- Anything about an installed host, a packaged artifact, signing, Windows or a real feed.
- Coverage beyond the scripted demo. It writes no `revision.recorded` or
  `continuation.recorded`, sensitive inputs, plugins or Kepler ACP store, so those families
  rest on source reading and the synthetic tests.
- The release artifacts themselves: the `dist` runs used local builds, not the bundled
  `orca-daemon-X.Y.Z.mjs` or a packaged app. Runs were as root on Linux x64, so permission
  refusals that apply to other users were not exercised. Windows ACLs are not covered.
- Dropped fields inside array elements. `schema-read.js` compares object keys only.
- What a v0.6.0 binary would do after reading an upgraded store. That was measured at the
  schema level only and was never executed.
