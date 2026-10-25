# Hosted Windows C15 allocator candidate — review before dispatch

This separate test-only candidate selects allocator PR [#643](https://github.com/cschadewitz/Project_Orca/pull/643)
head `95ee280be309d50f29b46cb66a12d480fdfc8a7d`, tree
`8bf5c38903ec0bc13c7c8a313068ba378bda3230`. PR643 is the reviewed portable
allocator correction, now merged. This candidate has **not been dispatched**.
Parent review is required before a manual Windows run. `app-smoke.yml` does not
execute C15. No new Windows acceptance result is recorded here.

The historical [paired](windows-c15-paired-followup.md) and
[corrected](windows-c15-corrected-followup.md) records retain their failures.
The original `windows-c15-paired.mjs` and `windows-c15-child.cjs` remain byte-identical
and retain their historical pins. This candidate never treats those failed runs
as passing or overwrites their evidence.

## Candidate and provenance

The manual-only [workflow](../../../.github/workflows/windows-c15-candidate.yml)
uses `windows-2025` x64, a 20-minute job limit, `contents: read`, two checkouts with
`persist-credentials: false`, and no user inputs, secrets, signing, release,
deployment, activation or security-setting changes. It installs the exact selected
source's locked dependencies without lifecycle scripts, using Node 24.21.0 and
pnpm 12.4.2. Ordinary PR CI remains separate from this manual Windows workflow.

The [candidate manifest](../../../tools/windows-c15/candidate.json) pins:

- The selected **entire source tree**, not merely an ancestor or a runtime-supplied
  source label. Every tracked file's actual bytes are compared with the selected
  commit's Git blob, including files hidden by `assume-unchanged`. Unexpected
  unignored source files refuse setup.
- All **365 compiled executable JS/CJS/MJS/JSON files** from the source solution,
  including CLI/store/core dependencies and diagnostics. Added or substituted
  executable output refuses setup. TypeScript 7.0.2 compiles the solution; generated
  text is normalized to LF before byte verification on Windows. Declarations/maps
  are not executed and are outside this executable inventory. No renderer is built.
- Native source digest `555b8b174c43fa2b11aa3cd16466b04a0872819d3f73f6987262e11ec7a305b5`,
  independently checked against the selected checkout through the native packaging
  helper. The workflow reuses `desktop.yml`'s official checksum-verified Node
  headers/import-library and installed MSVC/SDK pattern, requesting only x64.
  Header and import-library checksums must each have one exact SHASUMS entry.
- Official `electron-v44.9.1-win32-x64.zip`, SHA-256
  `41bd7900bd42d0f49110a81617876137041fbbf473466920248ddb076349ef91`.
  This archive pin comes from the locked Electron 44.9.1 package's checksums.
  The stage helper verifies it before extraction into a fresh owned runtime.
- Frozen and candidate harness files, manifest/build/stage/probe logic, protocol
  tests, and workflow hashes. The JSON specification is identified separately by
  its SHA-256 in the build and comparison receipts.

The [stage helper](../../../tools/windows-c15/stage.mjs) copies only the verified
native package into `resources/native/diagnostics/win32-x64` in that owned Electron
tree. It verifies the copied package with the existing native packaging helper,
including PE x64 shape, Node-API 8, exact source digest and per-binary hashes.
There is no repository addon fallback in the Electron child.

`evidence/build.json` records the selected source commit, **separate harness HEAD**,
specification digest, native package manifest, Node executable digest and the full
runtime file inventory. The staging step exports a separate SHA-256 of that receipt
through `GITHUB_ENV`; every probe/comparison must receive that expected digest.
Changing runtime files and rewriting a nearby receipt does not satisfy that digest.
The supervisor rechecks source, compiled, harness, receipt and runtime pins before
each Off/On member. The runtime is staged by this workflow, rather than accepted
from an arbitrary caller-selected runtime and its self-description. Compiler/toolchain
and runner integrity remain trusted build infrastructure; these hashes are not
reproducible-build or independent supply-chain attestation.

## Native ancestry gate

The [root probe](../../../tools/windows-c15/root-probe.mjs) considers only the
**existing** `os.homedir()/Documents` directory. It does not create or repair that
parent, assume Temp/workspace/home trust, or select a weaker fallback. It asks the
actual selected native storage addon to create and verify a fresh, owned private
probe beneath Documents. Native NTFS volume, ancestry ownership/DACL and identity
checks must pass. Only the new disposable private root receives the native
creation policy; existing ACLs and credentials are never changed.

The probe writes `evidence/setup.json` on acceptance or refusal. Missing Documents,
noncanonical/reparse ancestry, unsuitable ACL/ownership, incompatible native code,
or an unconfirmed cleanup fails setup. A refused native probe that cannot be safely
confirmed remains in place and is reported; no speculative recursive cleanup runs.
A successful empty probe is closed and removed. Later comparison roots are checked
again by the same native adapter. Hosted runner Documents ancestry is **unproven**
until this workflow is reviewed and run, and may legitimately refuse.

## Protocol and accounting

The new [supervisor](../../../packages/app/test/recovery-preparation/windows-c15-candidate.mjs)
and [child copy](../../../packages/app/test/recovery-preparation/windows-c15-candidate-child.cjs)
preserve the original sequential Off/On demo and full ordered 20-cell failure/stall
campaign. The portable parity test compares the entire cell campaign against the
frozen child, allowing only the observer constructor name. No focused regression
subset qualifies. Each schedule runs once; failure in one schedule remains failed
while the independent stall schedule can still run if setup succeeded.

The original 8,192-event input, 128 pressure refusals per stalled cell, 1,000 ms
ordinary operation timeout, shipping 10,000 ms native-write timeout, 90-second child
deadline, CLI/receipt/settlement bounds, disk limits and semantic 29-artifact/work-item
oracle remain. Every fault must enter during live CLI execution. Writer settlement,
revocation, zero reservations, zero controlled storage, saved-byte checks, sentinels
and exact owned-root/process cleanup remain gates. Any incomplete/duplicate cell
receipt, missing check, stale runtime or weakened bound refuses acceptance.

The child records one aggregate baseline **before the entire campaign**, the
aggregate `heapUsed + external` peak, separate RSS, controlled binary peak, allocator
backing growth totals/largest growth and sampled per-phase managed increments.
No per-cell baseline reset, Off subtraction, forced GC, raised budget or performance
retry is used. Observer overhead remains inside the measurement. The managed gate
is still **33,554,432 bytes** and the controlled binary ceiling is **8,388,608 bytes**.
Failure receipts preserve partial accounting. Allocation-growth and phase observations
support attribution but do not decompose V8/provider/native memory. Two-millisecond
samples and operation boundaries do not establish continuous managed/native peaks.

## Reproduction after parent review

Keep the source checkout at the exact selected commit and the harness checkout at
the reviewed candidate commit. The workflow builds and stages the runtime, then
runs the following command once for each of `failure` and `stall`:

```powershell
node harness/packages/app/test/recovery-preparation/windows-c15-candidate.mjs <exact-source-checkout> <fresh-owned-Electron-runtime> <evidence-directory> failure <native-probed-Documents-parent> <evidence/build.json> <separately-retained-build-receipt-SHA256>
node harness/packages/app/test/recovery-preparation/windows-c15-candidate.mjs <exact-source-checkout> <fresh-owned-Electron-runtime> <evidence-directory> stall <native-probed-Documents-parent> <evidence/build.json> <separately-retained-build-receipt-SHA256>
```

The same evidence directory contains the accepted `setup.json`; existing schedule
results refuse replacement. `always()` uploads only sanitized JSON/checksum receipts
for seven days. Profiles, runtime/native binaries, raw child output, DPAPI material
and execution stores are not uploaded. No dispatch command is provided or executed
before parent review.

## Portable validation and remaining acceptance

On 25 October 2026, Linux x64 Node 24.19.0 compiled the exact selected source with
TypeScript 7.0.2, and all 365 executable pins matched after the candidate build helper.
The focused payload-memory/report-performance suite passed **34 tests**. The new
portable protocol/pinning/static-workflow tests passed **9 tests, zero skips**.
Scoped ESLint, Prettier, whitespace checks and actionlint 1.7.7 passed.

The selected source's existing standalone allocation probe ran metadata, failure
and stall once each, with 20 cells each and no forced GC. Retained receipts:

| Probe | Managed increment, bytes | Controlled peak, bytes | Extra stalled prepares refused |
| --- | ---: | ---: | ---: |
| [Metadata](native-packaging-evidence/windows-c15-candidate/portable-metadata.json) | 2,480,196 | 131,072 | 0 |
| [Failure](native-packaging-evidence/windows-c15-candidate/portable-failure.json) | 28,381,580 | 1,310,720 | 0 |
| [Stall](native-packaging-evidence/windows-c15-candidate/portable-stall.json) | 15,232,156 | 1,310,720 | 2,560 |

All probe charges settled to zero. These portable probes use synthetic POSIX/key/fault
ports and a single Node process; they are not the paired hosted Windows C15 campaign.
The local package manager was pnpm 11.19.0 with frozen-lockfile/ignored lifecycle
scripts; the candidate workflow explicitly selects repository-pinned pnpm 12.4.2.
Initial development attempts using a nonexistent test path and TypeScript's removed
legacy JS builder API were corrected before final validation; neither is a passing
check. The environment's shell GitHub identity query returned `Forbidden`; publication
uses the explicitly authorized Cal connector, whose verified profile is Calcifer
Schadewitz, rather than retrying that shell identity operation.

Self-review covered frozen-file preservation, cell parity, unchanged bounds,
whole-tree and compiled substitution (including `assume-unchanged`), extra executable
refusal, runtime/receipt replacement, native source verification, fixed addon location,
owned cleanup and manual-only workflow scope. There is no independent candidate
review yet. Final-head hosted CI status is reported with the draft PR; ordinary CI
does not dispatch the Windows proof or execute these Node-test cases automatically.

Even a future passing hosted run proves only **hosted synthetic Windows x64
Electron/native disk/DPAPI/clock** behavior under this protocol. It is not physical
interruption, durable-media failure, Mac, ARM64, second-user isolation, a signed
installed app, continuous managed/native accounting, continuous renderer acceptance
or a complete execution-graph/network/credential-call oracle. Timing remains deferred;
no 4 ms responsiveness or renderer Layout acceptance is claimed. Production capture
stays disabled, Mac remains held, and historical failures stay failures.
