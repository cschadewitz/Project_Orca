# Held non-Mac integration verification

This local integration preserves #584 `a991fbfea9da6d39dea2f0c513cc5a000d993c14`,
#580 `b45b2a0d7df15798e6ba985d71f6e9d507d9cee4` and #572
`db9bdc6c5fe086b905a702dd44fe5dc0ff2313aa`. It adds the inherited CI assertion fix
`32d6765387e6145dad61a3928af0a7d35eb2dcff` and merges pinned updater #586
`34c0d60cff6e13dc37a7c020603cf8cacfd9646e` through local merge
`6e89119ed694634e7161fffc9298b0fc71865d4b`. The explicitly requested #586 integration
supersedes the earlier decision to leave #581 unmounted: its exact native-journal
ancestry `50c75cf051aadb551b5e365b1acf0110b70853fc` is retained. Reboot-only #577
remains excluded. Windows #585 is still being completed and is not integrated here.

Remote main was reverified as `db579fb7ac9cfce2e4e6901713088a80602311da`; the #584
remote branch remains at its original head. Casey's latest publication/merge/CI hold
supersedes the earlier authorization for a canonical main-target draft. No push,
main-target draft, workflow change, dispatch, rerun, cancellation, release, signing,
activation or access change was performed. Existing #584 remains the integration-base
draft, not a main-target canonical candidate. The earlier serial duplicate lookup found
no canonical main-target draft for that combined head.

## Findings and shared fixes

The supplied #586 patch was checked against its exact #584 main/IPC inputs and applied.
Its disabled app-root bootstrap now precedes ordinary producer initialization. Updates
remain sessionless and diagnostics remain disabled.

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
ancestry. In particular, #583's 27 delivery/staging blobs remain exact; #582's recovery
producers remain intact, with only its IPC boundary additionally tracked here.

| Evidence | Use and limit |
| --- | --- |
| #584 selected integration: 69 cases / 11 files | Reused for unchanged composed surfaces, first-run/configuration, preload and delivery staging. Updated main/Workspace boundaries receive the checks below. |
| #578 | Reuse 54 author cases and its final affected 26-case pass. Linux synthetic responsiveness is not Mac acceptance. |
| #579 | Reuse 52 author checks outside the corrected assertion and shared integration boundaries. |
| #582 | Reuse 109 author passes, one conditional skip and 13 applied-wiring passes. |
| #583 | Reuse 162 author passes; all 27 owned delta blobs remain exact. Staging source is not a signed package. |
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

## Remaining non-Mac blockers and authority

This candidate is not activation-ready and does not close all M10/M21/M22 work.

1. Complete trusted config/store/app root enrollment and rejection of overlaps must be
   bound before those producers start. The mounted bootstrap slice enrolls only userData.
   Native catalog/session, exact target authorization, fixed-path commit/recovery ports,
   whole-image verification, continuity checks and the owned one-use closed child launch
   still require production composition. No permissive substitute is supplied here.
2. The already running daemon does not bind its dispatch admission gate to the durable
   update window. CLI lifetime enrollment refuses new process launches; daemon Maintenance
   currently reads only its runtime token and optional ORCA_ADMISSION_FILE. Thus the
   durable-close-to-runtime-drain interval is not yet a complete new-admission fence for
   direct external clients. Bind a new-admission-only predicate while retaining completion
   and maintenance/defer RPCs, then verify this interval before activation.
3. The supported writer authority boundary requires an explicit decision: participating
   managed app/CLI/daemon lifetimes, or exclusion of arbitrary older/unmanaged filesystem
   writers. Cooperative kernel slots prove only participating ownership. The latter choice
   needs separately authorized OS launch/isolation authority. An independent all-write
   ledger or immutable live-directory topology is not assumed necessary under the
   continuously closed fixed-path proof.
4. Windows #585 completion and its final pinned evidence remain outstanding. #583's
   release mapping, signing/runtime/entitlement policy, publisher/notary and private
   delivery inputs still require owner decisions. Diagnostics connection/resource producer
   coverage and paired execution/high-water evidence remain incomplete; diagnostics stay off.
5. One final combined automatic CI run and canonical main-target draft are deferred by
   the current hold. No exact combined-head CI result exists. Earlier #579 CI
   37880844822 failed both Node 22/24 test jobs; its identified assertion is locally fixed.

Actual Darwin signed packaging/loading, APFS durability/metadata, native supervisor and
Keychain/TCC continuity, physical smoke and accessibility remain Mac-only acceptance.
See [the pinned updater contract](mac-closed-window-fixed-path.md) for their full limits.

All integration commits use Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>` as both
author and committer. This note accompanies source changes and is not a docs-only push.
