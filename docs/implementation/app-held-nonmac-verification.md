# Held non-Mac integration verification

This local integration preserves #584 `a991fbfea9da6d39dea2f0c513cc5a000d993c14`,
#580 `b45b2a0d7df15798e6ba985d71f6e9d507d9cee4` and #572
`db9bdc6c5fe086b905a702dd44fe5dc0ff2313aa`. It adds the inherited CI assertion fix
`32d6765387e6145dad61a3928af0a7d35eb2dcff` and merges pinned updater #586
`34c0d60cff6e13dc37a7c020603cf8cacfd9646e` through local merge
`6e89119ed694634e7161fffc9298b0fc71865d4b`. The explicitly requested #586 integration
supersedes the earlier decision to leave #581 unmounted: its exact native-journal
ancestry `50c75cf051aadb551b5e365b1acf0110b70853fc` is retained. Reboot-only #577
remains excluded. Windows #585 `455ac202f7afa00da17dd91a595988b0250003a9` is
integrated through merge `6d9ea708448b434bbfd90cb250b3e74185a539e4`. Its one storage
interface conflict retains both Windows platform support and #586 updater capabilities.

Remote main was reverified as `db579fb7ac9cfce2e4e6901713088a80602311da`; before the
authorized transfer the #584 remote branch remained at its original head. Casey's latest publication/merge/CI hold
supersedes the earlier authorization for a canonical main-target draft. Source transfer at
`a664d890d5630dc3ba1cb9d5bda34e19fd0d6a52` was pushed to the existing integration branch.
No main-target draft, integration-owner workflow change, dispatch, rerun, cancellation, release, signing,
activation or access change was performed. Existing #584 remains the integration-base
draft, not a main-target canonical candidate. The earlier serial duplicate lookup found
no canonical main-target draft for that combined head. The latest transfer authorization
permits a substantive push to the existing integration-target branch so Windows current-user
acceptance can fetch the exact candidate; main-target publication and CI remain held.

## Findings and shared fixes

The supplied #586 patch was checked against its exact #584 main/IPC inputs and applied.
Its app-root bootstrap now precedes ordinary producer initialization. Reviewed workspace
and resolved configuration/store roots are enrolled before their first producer. The
managed session/commit/recovery composition is mounted with missing delivery authority
and an independent false activation gate. Diagnostics remain disabled.

Three shared boundaries needed correction:

- Durable admission closure must retain existing completion/observation during the
  exact reserved runtime drain. A held writer may finish only in open, draining or
  deferring phases. Main permits an explicit completion/read channel set, rechecks
  immediately before dispatch, and continues refusing new runs, setup, template/config
  mutation and preferences. Workspace permits completion only with the same reservation;
  final freeze, stop, lost ownership and changed epoch still refuse. Startup is never
  reopened by this completion permission.
- First-run receipt/configuration operations, direct daemon connection and cold-start
  first-run work must retain app writer ownership through their asynchronous settlement.
  They now participate in the same main barrier as generic IPC and diagnostics.
- Quit must retain the app writer through dispatch and background storage settlement.
  Workspace shutdown starts immediately so a stuck RPC cannot postpone owned-child
  shutdown; writer release waits for its result and diagnostic settlement. Updater-owned
  drain reservations retain their existing no-forced-shutdown behavior.

The #579 CI failure was a capitalization-sensitive reconciliation assertion after a
target disappeared and refresh restored source visibility. The intended private-edit
state/message remains unchanged; the assertion now accepts its lowercase reconciliation
wording. This corrects that known case, not every possible combined CI failure.

## Evidence reuse and focused checks

Reuse the exact 69-case selection and constituent map in
[the #584 composition note](app-same-boot-config-composition.md), and the #580 map in
[the native recovery note](app-native-recovery-composition.md). No broad local suite was
repeated. Source outside the shared delta remains pinned to its retained constituent
ancestry. At #584, #583's 27 delivery/staging blobs were exact; #582's recovery
producers remain intact, with only its IPC boundary additionally tracked here. After #585,
its Windows additions change the shared desktop staging workflow and builder target mapping;
those two #583 delivery interfaces receive the fresh packaging checks below rather than an
unchanged-blob claim. No workflow file is edited by the integration owner.

| Evidence | Use and limit |
| --- | --- |
| #584 selected integration: 69 cases / 11 files | Reused for unchanged composed surfaces, first-run/configuration, preload and delivery staging. Updated main/Workspace boundaries receive the checks below. |
| #578 | Reuse 54 author cases and its final affected 26-case pass. Linux synthetic responsiveness is not Mac acceptance. |
| #579 | Reuse 52 author checks outside the corrected assertion and shared integration boundaries. |
| #582 | Reuse 109 author passes, one conditional skip and 13 applied-wiring passes. |
| #583 | Reuse 162 author passes outside the Windows-composed desktop staging/builder mapping; fresh shared packaging checks cover those interfaces. Staging source is not a signed package. |
| #580 / #574 / #576 | Reuse 39 selected, 121 author, and 294 author plus three patch cases respectively. |
| #586 | Reuse 100 Linux tests / 10 files and its 18 applied-main cases as prior evidence. Main, Workspace, IPC and the two modified durable-phase cases are checked below. Native code is unchanged here. |
| #567 CI 37872268414 | Baseline only: each Node 22/24 job had 6,306 passes, four skips and one todo. The owner-approved 95% app function threshold remains unchanged. No final-candidate CI or coverage claim. |

Fresh checks on Node 24.19.0 / Vitest 5.0.2 / TypeScript 7.0.2:

- Actual main IPC file: 21 passes. Workspace updater wiring: three passes. These include
  real daemon natural completion through a reserved drain, cold bootstrap refusal,
  first-run tracking and settlement-before-release at pause/quit.
- Durable update-window phase boundaries: two passes, ten intentionally excluded by
  name filter. Existing held writers can finish during drain/defer, not after stop.
- Template assertion: all three source/target/permission freeze cases pass, 27 excluded
  by name filter. Only the previously failing target case failed before the fix.
- Root and renderer typechecks, scoped ESLint, Prettier and `git diff --check` pass.
  A missing `reason` field in the new first-run test fixture was corrected and its
  affected case rechecked. Quit was rechecked after self-review preserved immediate
  child shutdown. Rechecks do not add distinct cases to the 29-case fresh total.

The app's existing manifest and lockfile already specify YAML 2.9.1. The preinstalled
checkout lacked its app dependency link; the existing installed package was linked
locally for checks. No dependency install, manifest edit or lockfile regeneration.

### Subsequent managed production composition

The final source delta adds reviewed-root enrollment, retained-root startup inspection,
live daemon new-work/completion observers and a managed application factory. That factory
connects exact authenticated Workspace facts, fresh-window approval, checked candidate
revalidation, fixed-path backup/commit, native handoff and explicit closed verification/
restoration. Its delivery/native authority input remains absent in main and its separate
activation gate is false. A constructed session cannot bypass that gate. The factory
adds no renderer paths, persisted consent, catalog polling or automatic recovery replay.

Focused checks for this delta pass 123 distinct cases in ten files: actual main 25,
session guards 16, app/preload approval 15, managed owner/authority 3, candidate download/
session 49, actual CLI bootstrap 5, authenticated main handshake 1, enrollment/retained-root
checks 5, live daemon admission 2 and first-run enrollment 2. The selected root/daemon/
first-run invocation filters 66 unrelated cases. Both TypeScript projects pass. Scoped
lint, formatting and whitespace checks pass after correcting two unbound test-spy references.

The first session-guard run failed fourteen old fixture expectations: the fixture omitted
the required #580 drain owner and expected the earlier prepare-before-drain sequence.
It now captures the real Workspace drain owner and scopes proof fault injection to final
prepare; all sixteen checks pass without relaxing missing-owner refusal. Initial first-run
assertion and main Electron mock/native-singleton access issues were corrected and the
affected checks rerun. The native singleton is now resolved only at authorized activation.
These local failures are not CI results. The previously pinned 69-case selection and
constituent evidence retain their stated limits; this additional delta receives the checks
above instead of a blanket unchanged-evidence claim.

## Remaining non-Mac blockers and authority

This candidate is not activation-ready and does not close all M10/M21/M22 work.

1. The approved private catalog/invitation source and freshness/revocation policy remain
   unknown (delivery D3). The exact question has been raised; candidate declarations
   cannot supply that authority. The mounted managed composition requires the approved
   download/native inspection provider, independently accepted installed-image policy,
   existing secure-storage/intent/TCC continuity inspection and owned one-use closed-child
   producer. These production authority providers are not supplied by main yet. This is
   remaining implementation/configuration work, not a claim of Mac acceptance alone.
2. Root enrollment and live daemon admission are implemented. Enrollment serializes new
   roots before first-run writes/managed CLI bootstrap, retains immutable existing anchors,
   refuses overlaps/closed windows and closes ordinary work after torn publication. The
   daemon observes durable new-work and existing-work predicates on live dispatch, closing
   the pre-drain interval for direct clients while preserving completion and maintenance.
   The supported boundary is managed participating app/CLI/daemon lifetimes, as directed.
   It does not claim isolation from arbitrary same-user filesystem writers; no additional
   all-write ledger or immutable directory topology is introduced.
3. Windows #585 source is composed. First-run fence boot/volume authority still refuses
   Windows; Windows diagnostics native clock/storage do not silently grant that separate
   authority. Exact MSVC/SDK x64/arm64 staging and packaged Electron/safeStorage loading,
   paired execution/resource high-water, second-user refusal, physical recovery/durability,
   traffic/privacy and accessibility acceptance remain Windows work. #583's
   release mapping, signing/runtime/entitlement policy, publisher/notary and private
   delivery inputs still require owner decisions. Closed diagnostics connection/run/admission
   producers are now composed; paired execution/high-water evidence remains incomplete.
   Diagnostics stay off.
4. One final combined automatic CI run and canonical main-target draft are deferred by
   the current hold. No exact combined-head CI result exists. Earlier #579 CI
   37880844822 failed both Node 22/24 test jobs; its identified assertion is locally fixed.

Actual Darwin signed packaging/loading, APFS durability/metadata, native supervisor and
Keychain/TCC continuity, physical smoke and accessibility remain Mac-only acceptance.
See [the pinned updater contract](mac-closed-window-fixed-path.md) for their full limits.

All integration commits use Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>` as both
author and committer. This note accompanies source changes and is not a docs-only push.

## Windows-integrated source and acceptance handoff

The pinned owner patch SHA256 is
`640b3f0e3bc2c634d8e0999470d5698aa34f5bb02d3909f1fefd521df6ab73d5`.
It was adapted manually because its #584 main context predates #586 wiring. Current-client
and validated run-failure facts are forwarded as closed phase/code pairs. Quit and updater
pause detach power listeners and suppress late source/lifecycle facts; late initialization
cannot publish app_started after stopping. Existing consent, target and renderer lifetime
checks remain intact and capture is still disabled.

Fresh composed checks: 36 passes in actual main (24), Workspace drain (3) and source
producers (9); the added updater-pause power variant passes separately, for 37 distinct
cases. Shared Mac/Windows staging and builder hooks add 25 passes in three files. Root and
renderer typechecks, scoped lint, formatting and whitespace checks pass. Initial new
fixture defects (missing Electron background-color method and notification fields) were
corrected; the clean final run has no unhandled errors. An accidental invocation under
Node's test runner was corrected to Vitest; it was not a source failure or CI run.

Reuse #585's eleven actual Windows native case groups, actual x64 PE/builder probe and
126/93 overlapping regression selections with their 62/46 platform skips. They are not
fresh Electron, arm64, second-user, resource-limit or physical acceptance. All four Windows
native input blobs remain byte-identical to the pinned Git head.

For this LF checkout, the production helper's Windows native source SHA256 is
`a8842b8ddc5c1f2553c1eca9e11df4faa129f22c559533f408a1251d991197ea`.
Historical Windows evidence's `5fe5178654fff7a2e3c0f799f5da07bbed738acd87d485ff2fca3939870aacd9`
matches the same sources with CRLF in binding.gyp/clock.c and LF in the two new C files.
The helper hashes actual file bytes. Rebuild/stage from the acceptance checkout and retain
its newly emitted manifests; do not copy an old source digest into a new manifest.

In the existing authorized Windows MSVC/SDK environment, use exact locally verified Node
headers and import libraries laid out as include/node, x64/node.lib and arm64/node.lib:

```powershell
node tools/packaged-windows/stage-native-addons.js --headers $verifiedNodeRoot
```

This stages both configured targets into packages/app/dist/diagnostics-native/win32-x64
and win32-arm64. Use the matching target's exact packaged Electron host to load
resources/native/diagnostics/win32-<arch>/diagnostics_clock.node and diagnostics_storage.node,
then test its actual async safeStorage. Node-only GNU binaries from historical evidence
are not Electron acceptance binaries. Existing bounded Node probes are reproduced by the
commands in [the Windows implementation handoff](../preparation/crash-recovery/windows-native-implementation.md).
No toolchain install, signing, release, desktop occupation, access change or workflow
dispatch is authorized by these build instructions.
