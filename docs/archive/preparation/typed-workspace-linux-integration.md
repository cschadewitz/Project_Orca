# Linux managed gate integration checkpoint (#702 / #706)

Implementation plan against the **unapproved** persistence candidate
[#731](https://github.com/cschadewitz/Project_Orca/pull/731) at
`7c37a5018844d894ecc32f9c9ad21a8053db53f0`. The
[managed design](typed-workspace-managed-gates.md) at
`f90c3dbf681f4cb19454767ae558f60a539da086` is independently approved. Schema/authority
and lock/publication reviews of #731 are pending, and its owner is syncing main.
No dependent runtime integration is committed here. Parent must identify the reviewed
final persistence head before that work starts. This checkpoint adds no marker format,
activation, endpoint, migration, existing workspace mutation or runtime-safety claim.

## Interface assessment and requests

The exported `TypedCompatibilityMarker`, `TypedSidecarOwnerPorts`,
`bindInactiveTypedSidecarOwner` and `createInactiveTypedSidecarStore` provide the needed
in-memory seam. The final pending/enrolled split is sufficient: pending permits only
fresh initialization; a separately bound enrolled token permits ordinary access. The
captured exact marker plus `checkCompatibility` can bind boot/session/lifetime authority
in the managed closure. **No additional persisted marker field is requested.**

One persistence export is missing for a filesystem owner: canonical runtime parsing of
retained marker bytes. `validMarker` is private; `TypedCompatibilityMarker` alone is a
TypeScript interface, while `parseTypedSidecar` parses the policy, not the marker.
Request a persistence-owned marker-byte parser, with a name selected by that owner,
that returns the existing marker type and refuses invalid UTF-8, duplicate JSON names,
unknown/missing keys, versions/contracts and unsupported phases. The managed owner
provides bounded, no-follow, owner/access-checked bytes; parsing remains structural and
does not mint ownership. Do not copy `validMarker`, reinterpret a failed sidecar parse,
or add a second marker schema in CLI/Python. The existing trusted binder still validates
the marker when constructing its WeakMap capability.
The assessed exports and phase checks are pinned in
[`typed-sidecar.ts`](https://github.com/cschadewitz/Project_Orca/blob/7c37a5018844d894ecc32f9c9ad21a8053db53f0/packages/agents/src/typed-sidecar.ts).

Two runtime owner components are integration work, not missing persistence fields:

- Resolve `rootBindingRef`, `workspaceRef`, `sidecarRef` and `enrollmentRef` against the
  retained trusted enrollment owner. Verify original logical config/sidecar/store roles,
  their physical identities and deduplicated protection targets, plus the external control
  identity. A digest/reference does not itself supply that relationship. No registry
  filesystem encoding/locator is selected by this checkpoint; parent reviews its owner
  implementation before production construction.
- Hold genuine exclusive managed writer lifetime/root ownership, including the daemon
  that bypasses `Deployment.launch`'s shared flock. Retain it until every dispatched
  read/write settles. `checkCompatibility` checks that same owner before/after awaited
  marker/binding inspection and returns the exact retained phase marker only while
  current. Do not acquire sidecar locks there: managed lifetime precedes persistence's
  strict lock. Current update writer slots are participating shared ownership; an update
  window's migration/validation capability is not ordinary typed runtime authority.

`read()` is the sole owner-bound policy structural read; its byte revision is the current
policy content binding. `readRules()` additionally requires the real protected approval/
scope/current-authority qualifier. The managed gate does not implement that qualifier or
promote raw diagnostics/empty records to execution authority. Missing qualification can
stay unavailable while disabled guard tests use synthetic owners. Genuine final policy
publication ownership stays with the storage review; the managed closure cannot make
an unsafe policy lock safe by returning an unchanged marker.

Python deployment integration also needs a trusted bridge to the same enrollment owner.
It cannot duplicate marker parsing or execute a selected old release to ask whether that
release is compatible. The first guard seam may use a trusted injected inspection callback
in disposable tests; that is not a production bridge. A stable bridge/owner outside selected
releases is an enabling prerequisite, not permission to introduce a config/flag/env bypass.

## Exact first guard work, after the reviewed-head signal

Proposed files below are managed-owner work; persistence's schema, parser, command,
strict lock and source files remain its sole ownership.

1. Add `packages/cli/src/typed-workspace-gate.ts`: a default-off internal decision/owner
   adapter importing #731's exported types/factories. Its trusted dependencies supply
   canonical marker parsing, enrollment inspection, binding resolution and retained lifetime
   ownership. It distinguishes authoritative never-typed legacy from pending, enrolled and
   unavailable; absent/v1 sidecar bytes never certify legacy. No public boolean/JSON receipt
   becomes a capability. No flag, RPC, environment variable or ordinary config enables it.
   Unknown build mapping prevents enabled operation but not construction/testing of the
   disabled gate. Enrolled unsupported actions categorically refuse.
2. Implement pending-to-enrolled orchestration only behind that trusted owner: close/exclude
   all original writers; durably publish pending intent; bind the pending token; invoke
   `initializeFresh()` once on an absent sidecar; retain its exact revision; durably commit
   enrolled status; bind a new enrolled token only after confirmed completion. Failure or
   uncertain acknowledgement preserves intent/evidence and keeps admission closed/unavailable.
   After an attempted enrolled-status commit, lost acknowledgement does not prove the durable
   state is still pending. Do not bind an enrolled owner or retry automatically; later inspect
   the actual durable outcome. Do not retry initialization over existing bytes or erase intent.
   Ordinary writes use `createScopedRule`/`revokeScopedRule` and their existing authority/receipt
   contracts; the gate adds no standing-write command.
3. Hook `packages/cli/src/main.ts`, `bootstrap.ts`, `update-bootstrap.ts` and
   `commands/auth.ts` before producers. Preserve help/version. Resolve actual config/store
   roles without plugins or store/identity/auth creation, verify the retained binding, then
   recheck under the same lifetime owner before file stores/plugins/auth/resume. Cover direct
   exported bootstrap/auth callers as well as argv dispatch. Initial enrolled mode refuses
   plugins, remote/App launches, arbitrary root layouts and unsupported commands. A known
   enrolled workspace without its trusted owner is unavailable, never a legacy fallback.
4. At daemon `config-model.ts` and `control.ts` seams, pass an internal trusted guard from
   CLI composition. While enrolled, refuse legacy permission replacement/append, saved
   config/apply and retarget/reset. Reject a legacy `always` request before claiming or
   recording its answer. Allow-once/deny gain no standing-write path. Wire no typed RPC or
   UI command in this slice. Persistence retains sole in-lock policy validation; the gate
   prevents managed legacy callers from reaching it for enrolled/pending/unknown roots.
5. Add a trusted enrollment-inspection hook to `tools/deploy/orca-release.py` at `launch`,
   `exec_release`, and before update/stage/activation/recovery effects. Check all CLI/ACP/
   daemon role bindings; unsupported root/config overrides refuse. Enrolled/pending/unknown
   denies every update/rollback/recovery before downloads/builds, journal writes, maintenance,
   stop/start, pointer selection or exec. Keep existing pending journals/evidence intact.
   Ordinary enabled daemon launch also requires its explicit lifetime owner; shared flock
   alone is insufficient. Legacy behavior retains existing guards. Production bridge and
   artifact mapping remain unavailable until independently accepted.

App/Mac/Windows paths stay unsupported for this Linux mode. No App renderer, updater,
native driver, signed manifest or OS security setting is changed. The reviewed App fallback
and native recovery findings remain future platform obligations, not Linux implementation
or legacy beta prerequisites. All activation/defaults stay off.

## Synthetic acceptance tied to that work

| Test target | Required observation |
| --- | --- |
| New `packages/cli/test/typed-workspace-gate.test.ts` | Canonical parser refusal propagates; injected pending/enrolled markers use #731's real binder/store against disposable sidecars. Pending ordinary reads/writes refuse; enrolled initialization refuses. Publish failure/unknown acknowledgement never binds an enrolled owner, deletes intent or retries. |
| Same gate tests | Legacy requires authoritative owner classification. Accept nested config/store and exact shared-directory roles with all bindings retained; refuse missing/conflicting roles, aliases/hardlinks, changed identity, broadened physical targets or stale enrollment. Owner loss/marker/root change across awaits discards positive results. |
| New `packages/cli/test/typed-workspace-compatibility.test.ts`; existing `update-bootstrap.test.ts` | Actual argv plus direct bootstrap/auth seams refuse before plugin, store/identity, credential, resume or policy writer callbacks. Help/version and legacy behavior remain. Unsupported App/remote/plugin/root overrides and unknown build mapping cannot construct enabled ownership. |
| `packages/daemon/test/config-methods.test.ts`, `control-methods.test.ts`, `live-input-integration.test.ts` | Enrolled/pending/unavailable legacy replacement, `always`, config/apply/retarget/reset refuse with zero policy publication or answer delivery. Initial refusal precedes callback claim and recorded answer; failures after an in-flight operation retain existing uncertain-state semantics. No create-scoped-rule endpoint appears. |
| `tools/deploy/test_release.py` | Inject trusted owner states; all enrolled update/recovery variants, old journals and automatic rollback refuse before side effects. Existing files, journal and pointer are byte-identical. Every launch kind checks the exact role binding; a paused daemon blocks exclusive enrollment despite launcher flock availability. |
| Real disposable subprocess ownership fixture | A live/paused owner prevents a second owner and opt-in; supervisor exit does not release an independently live child writer. Unknown/dead ownership does not auto-reclaim or resume enrollment. Test the accepted owner implementation, not a fake boolean. Storage owns paused strict-lock/revocation publication regressions. |

Run only focused synthetic checks and required package statics on the reviewed combined
head, with existing bounded workers and pinned lifecycle/lockfile controls. No live daemon,
installer/update, Mac access, credentials, network-permission change or existing policy
mutation is needed. This plan is not runtime or native acceptance evidence.
