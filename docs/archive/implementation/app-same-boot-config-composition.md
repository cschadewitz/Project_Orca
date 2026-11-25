# Shared same-boot, configuration and delivery composition

This substantive dependent draft starts at exact [#580](https://github.com/cschadewitz/Project_Orca/pull/580)
`b45b2a0d7df15798e6ba985d71f6e9d507d9cee4`. It composes the held performance and
configuration slices with the replacement same-boot recovery contract, then includes
the delivery slice received before publication. The parent owns merges and Actions.
No milestone completion, live activation or native acceptance is claimed.

## Preserved constituents and shared delta

| Constituent | Exact head | Composition |
| --- | --- | --- |
| #578 diagnostics responsiveness | `ffc8bda2f4732a854f06048a2a9d4bc7df70bb01` | Non-squash merge; all ten owned blobs remain exact. No shared entrypoint patch. |
| #579 configuration/templates | `94425ca133899dbe6460dbbe9bf7508617271dba` | Non-squash merge; 36 of 39 blobs exact. Bridge, Config surface and protocol barrel are composed with existing first-run/guided-launch interfaces. |
| #582 same-boot first-run recovery | `6e35a801f190c376387e639362eee4cb7741d455` | Non-squash merge; 29 of 31 blobs exact. Protocol barrel retains both exports; app manifest retains #574's native build script alongside the added YAML dependency. |
| #583 delivery adapters/staging | `a648f98a2f1127417ad3aafc54007c5a98a41d33` | Clean non-squash merge; all 27 delta blobs exact, including inherited #573 preparation. Shared entrypoints untouched. |
| #573 inherited acceptance preparation | `5af9f43a8f17937ee08f1ed93d823d8ae7440c52` | Ancestry preserved through #583; preparation remains distinct from execution evidence. |

Merge commits are `0c84d894655cf42722c7b0c2dccbc8d467135ecb` (#578),
`ed14fcfb3f99fa01aa73dd04e2f2b6a40deda5c8` (#579),
`f18e910dfbc5981af677a9bdb00f85d47e1a18f5` (#582), and
`ff07734f0809c4248b5c8ce8f9a0ecadae20d206` (#583).
The earlier [#572 consolidation](shared-app-consolidation.md) and
[#580 composition](app-native-recovery-composition.md) retain the inherited exact heads.

The Config/bridge conflict resolution uses the owner's
[composition patch](patches/m21-template-config-composition.patch) against its original
#572 files. First-run setup, diagnostics, guided-launch content and the Launch work
control are preserved alongside Templates. The protocol conflict keeps both template
and first-run config exports; the Node-only lifetime fence remains a separate subpath.
Main/preload apply the [closed template dispatcher](patches/m21-template-ipc.patch).
Main/Workspace/preload apply the
[same-boot handoff](patches/first-run-same-boot-wiring-db9bdc6.patch), passing the launch
capability into the exact child, exposing recovery/review/bind routes and capturing the
exact surviving owned daemon for configuration binding.

## Delta review and corrections

1. **Updater exclusion corrected.** The handoff's first-run IPC checked only the final
   native window hold. During a drain reservation, ordinary completion IPC intentionally
   remains open, so recovery preparation could otherwise append first-run evidence.
   Workspace now exposes a read-only reservation predicate. Main checks it at route
   admission and every captured caller check, and blocks first-run Connect while held.
   The updater never writes or adopts the first-run journal. Existing completion calls
   retain their drain behavior; live config binding also retains its exact-owner checks.
2. **Frozen dependency consistency corrected.** #582 declares `yaml: ^2.9.1` but leaves
   the app lockfile importer unchanged. Add only the three-line app importer entry for
   the existing locked 2.9.1 package/snapshot. All app manifest specifiers match their
   importer. No package resolution, integrity, other importer, tool pin or dependency
   version changes. The installed workspace parser was linked locally without installing.
3. **Shared interfaces verified.** Actual main IPC rejects arbitrary template methods and
   stale epochs, and gates all four new setup routes during a reservation. Actual stripped
   CommonJS preload forwards their explicit active epoch. Workspace checks exact path,
   live child, captured client, workspace/instance identity, epoch and pending operations
   before rebind. Typechecking initially found four optional-method assertions missing in
   the expanded preload test; those assertions were corrected and root checking passed.
4. **Ancestry and disabled policy verified.** Every constituent above is reachable with
   the bounded blob exceptions recorded above. Rejected #577
   `3deeeed4b4a8f3a069263668d76065675425c307` and held #581
   `50c75cf051aadb551b5e365b1acf0110b70853fc` are not reachable. No reboot prerequisite is
   mounted. `new MacUpdateApplication()` still has no session and diagnostics production
   capture remains false. The ordinary Mac packaging lane remains unsigned and unnotarized;
   the candidate identity hook requires explicit selection. No remaining shared-delta
   source defect was observed in this bounded self-review.

## Focused verification and evidence reuse

The selected source checks use installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2.
Pinned pnpm 12.4.2 was not invoked; no dependency installation or lock regeneration occurred.
The selection totals **69 distinct passing cases across 11 files**. Name-filtered cases
were intentionally excluded; no selected case was skipped.

| Evidence | Scope/result | Limit |
| --- | --- | --- |
| This composed source: seven-file selection | 44 passed, zero skips, 16.99 s, at most two workers: Workspace 13, same-boot recovery 7, updater wiring 3, actual preload 1, performance 8, mounted template Config route 7, first-run UI 5. | Disposable CLI/owner processes and synthetic Electron boundary; no packaged/native acceptance. |
| Actual main overlap | 3 passed, 12 excluded by name filter, 3.40 s: closed template/new setup routes, existing first-run setup/frame fencing and unavailable Mac updater. | Selected overlap only. |
| Saved configuration binding | 7 distinct passed: live exact-owner binding, offline Save-before-Bind/app recreation and interrupted receipt retry, plus five target/epoch/config/receipt/review invalidations. Two filtered runs, 0.92 s and 1.31 s. | Synthetic private agent configuration; no provider operation. |
| Delivery overlap | 6 staging cases pass against actual workflow/config (0.19 s): both requested architectures, fail-closed selection/compiler and stage ordering. All 9 existing actual builder-hook/resource-copying cases pass separately (0.81 s). | Controlled compiler/resource fixtures; workflow and packaging are not executed. |
| #578 author evidence | 54 focused cases; final affected 26 pass again. Three isolated Linux preview/checkpoint observations remain below the unchanged 4 ms gate, with 8,192 events, zero omissions and exact 974,807-byte export. All ten blobs exact. | Reused; not a fresh combined Electron/Mac measurement or hard 32 MiB memory bound. |
| #579 author evidence | 52 focused author checks and supplied self-review; parser, authority, provenance, reconciliation and authoring source retained outside the three composed interfaces. | Reused; final mounted route/dispatch overlap checked above. |
| #582 author evidence | 109 passes plus one inherited Windows-only skip, five files; isolated patch has 13 Workspace passes. | Reused outside overlap. Current real Linux owner crash, surviving child, same-boot recovery and Workspace child checks pass above. |
| #583 author evidence | 162 distinct focused cases: 66 Vitest, 50 Python delivery/native ports and 46 ZIP containment; inherited #573 ancestry exact. | Reused; controlled trust/native ports do not prove signing/device acceptance. |
| Earlier baseline/stack | #580's 39 selected passes, #574's 121 author cases and #576's 294 author cases plus three patch cases; [CI 37872268414](https://github.com/cschadewitz/Project_Orca/actions/runs/37872268414) covers only the exact #567 tree, with Node 22/24 each 6,306 passes, four skips and one todo. | Earlier CI excludes every later constituent; no exact final-head CI or coverage claim. |

Root and renderer no-emit TypeScript pass. Scoped shared-source/test ESLint/Prettier,
lockfile multi-document parse/importer consistency, constituent ancestry/blob comparisons,
diff whitespace and handoff prose/local links are checked. The parent must obtain exact
combined-head CI. No broad redundant suite, coverage rerun, manual Actions, signing,
notary operation, release, deployment, access change or live installation occurred.

## Remaining authority and acceptance limits

New matching-binary first-run generations use a stable exclusive kernel lifetime fence
and durable writer attestation. Same-boot reconciliation acquires that fence and rechecks
boot/domain, directories, store and retained evidence before appending a resolution.
Legacy uncertain version-1 attempts have no retroactive lifetime proof and remain
preserved/refused. A surviving orphan daemon is reported and preserved; reattachment or
cooperative shutdown needs separate owner authority. Production recovery sends no signal,
adopts no PID and resets no credential. Reconciliation preserves auth; a later normal
Connect retains existing bootstrap credential rotation. Recovered stores suppress automatic
startup/timer continuation execution. Unsupported volume/domain/owner and torn or altered
evidence remain refused. See the [same-boot contract](first-run-same-boot-recovery.md).

Explicit live/offline Save-before-Bind reconciliation is now composed; the older #580
handoff's unbound/reboot-decision entry is superseded by this slice. Configuration Save
and Apply remain separate actions and do not confer run admission or updater authority.

#581's native updater journal/bootstrap is deliberately held: its missing initial namespace
closes startup, and the owner has not chosen initial provisioning authority or complete
protected-state topology. Complete writer exclusion across app/CLI/ACP/migrations,
independent all-write accounting, atomic full-state/matching-binary preservation/restore,
continuity proof and durable replacement-child admission still require their producers.
The app-only optional bootstrap input is not mounted production authority.
*Superseded (2026-10-14): the bootstrap is now mounted for packaged Mac launches, and main
provisions the namespace at the first launch; see
[the Mac startup gate](mac-closed-window-fixed-path.md#the-mac-startup-gate).*

#583 supplies source staging before Mac packaging, superseding #580's missing-stage entry.
Version/channel/plist/OS mapping, approved signing/runtime/entitlement policy, authenticated
publisher/protection/notary inputs and private invite/download/support route remain owner
decisions. Actual Darwin builds/loading, signed/downloaded sample and lifecycle execution,
Keychain/DPAPI/TCC/ACL durability, physical recovery and accessibility remain unrun.
Diagnostics connection/resource producers, actual 4 ms/8 MiB/combined 32 MiB and paired
execution/high-water acceptance also remain. Neither this draft nor reused evidence closes
M10/M21/M22 or their native acceptance issues.
