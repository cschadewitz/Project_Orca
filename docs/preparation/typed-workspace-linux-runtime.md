# Default-off Linux managed owner checkpoint — Refs #702 / #706

Development base: main `bc0c57d82925cefa001513b8431355b912e4d462`.
Explicit unmerged dependencies incorporated without rewriting history:

- Persistence #731 `c6157bddec40b438e3425baf52cf65d12355c216`.
- Accepted managed design #730 `9316577892659ee7f758801442adb97913f392d0`.

This checkpoint implements a disposable-testable filesystem owner and stable wrapper
refusals. **Production typed access and enrollment remain unavailable.** The accepted
real build map is empty. It does not complete #702/#706, establish native acceptance,
or authorize a deployment. Parent owns integration, independent review and merge.

## Concrete owner and handoff

`packages/cli/src/typed-workspace-gate.ts` is an internal module, not a public CLI
package export or RPC. `createManagedTypedWorkspace(ports)` is trusted composition
only. It requires original root bindings, genuine retained lifetime ownership,
exact build verification and the canonical persistence qualifier. There is no
permissive production implementation of these ports. Returning unchanged parsed
JSON or a boolean is not a lifecycle or build proof.

`resolveManagedRootBinding` retains config, sidecar and store logical roles, each
mapped to its covering physical target. Duplicate/descendant physical directories
collapse; omitted/conflicting roles, aliases, changed identities, a broadened target
set and control/release/restore overlap refuse. Sidecar placement is fixed at the
config root's `orca.permissions.json`. The digest binds canonical directory device/
inode identities, original workspace identity file and directory identity/content,
and the external control and release-directory relationship. Policy file inode is
deliberately not retained across its canonical atomic publication.

Metadata reads use bounded no-follow descriptors, regular/single-link and owner/access
checks, and before/after handle/path identity checks. Inspection does not initialize
workspace identity. A clone, replaced identity file or reconstructed current root
set cannot satisfy the original retained binding. The trusted external inventory
must retain that original binding; a newly calculated digest cannot supply it.

Parent's UI/protocol handoff is `ManagedTypedStoreProvider`, a zero-argument async
provider returning `ManagedTypedStoreAvailability`. Its available result carries
only the existing canonical store and contract. `owner.currentStore` implements it
under the retained owner; `unavailableManagedTypedStore` is the default. False
availability has the bounded reason `trusted-linux-owner-unavailable`. The daemon
can receive this provider through trusted composition; clients never provide an
owner, marker, path, build declaration or construction parameters. The protocol/UI
worker owns registration/request/response types. No peer routing/schema is edited.

Canonical store operations recheck the same retained lifetime, image, original roots
and canonical marker before and after awaited IO. The persistence owner's required
`assertCompatibilityCurrent` runs synchronously. Managed launch dispatch also repeats
the full enrollment observation in the same call stack immediately before callback
dispatch, without an intervening await. Failed qualification remains unavailable.
The protected approval/current-credential dispatch guarantees documented by #731
remain requirements; this checkpoint adds no approval implementation.

## Enrollment-only durable evidence

The protected control directory must already exist, outside every policy restore
target and selected release directory. There is deliberately **no startup provision,
repair or registry-reset command**. Disposable fixtures provision an original
`never-typed` witness containing exactly the original workspace digest and root
binding digest, separated by LF. That file is not independent authority: the trusted
inventory/lifetime/build ports establish its meaning. Missing inventory/witness does
not become never-typed from missing/v1/corrupt policy bytes.

Under exclusive enrollment ownership, `enrollFresh`:

1. Requires authoritative never-typed state and an absent sidecar.
2. Removes the never-typed witness and flushes the control directory. A crash here
   is unavailable, even before the intent exists.
3. Creates and flushes `intent.json` exclusively, using #731's exact pending marker.
4. Binds #731's pending owner and calls its `initializeFresh` once.
5. Creates and flushes `enrolled.json` exclusively, preserving the exact intent refs
   with state `enrolled`, then confirms the canonical policy read/revision.

`parseTypedCompatibilityMarkerBytes` is the sole marker parser. The two retained
files use the existing marker type; no Python/schema/parser fork is added. Pending
ordinary access, enrolled reinitialization, missing/corrupt/mixed evidence and v1
bytes after enrollment stay closed. Existing policy bytes are never migrated/deleted.
An exception after transition begins invalidates that in-memory owner's authority.
Lost confirmation acknowledgement can leave an actually enrolled disk state; it is
never reported as definitely pending. Only a new current owner may explicitly inspect
the actual outcome. No automatic initialization retry is provided.

Intent persists across normal edits. Canonical create/revoke owns exact policy byte
revisions and retained revocations; no external per-policy-edit history is written.
Enrolled update, rollback, retarget, reset and legacy-write dispatch categorically
refuse. The checkpoint does not supply recovery or an equality-based restore exception.

## Stable Linux boundary and precise remaining proof

`tools/deploy/orca-release.py` must be installed outside selected release trees, as
its existing contract requires. A new independent `typed-lifetime.lock` is held in
shared mode across **daemon, CLI and ACP** exec, separate from `admission.lock`.
Its descriptor is inherited. Direct `exec_release` callers take the same boundary.
Stage/activation/recovery also hold shared lifetime ownership, so enrollment cannot
start after their initial inspection while an effect remains in flight. Exclusive
`typed_enrollment_window` is an internal mechanism, not an enrollment command.
No lock-age/PID/idle-based recovery is implemented. The no-follow lock validates
regular/single-link ownership and its retained inode before dispatch.

Temporary subprocess tests demonstrate a stopped daemon holding this lock while
the old admission lock is free, and a surviving child retaining it after supervisor
exit. These prove the implemented kernel mechanism. They do **not** establish that
all pre-existing incompatible daemons have been migrated into that mechanism.
The existing launch-audit manifest string and process scans do not establish that
stronger enrollment proof.

The wrapper's `typed_inspector` injection is trusted test/composition code only,
never manifest/flag/environment configuration. It receives all three original launch
roles and recovery's previous/candidate roots, and returns a retained synchronous
assertion, not JSON/bool. Stable guards run before stage/build, activation journals,
service stop, pointer selection, recovery and exec; retained assertions run at
effect dispatch. Automatic rollback re-enters the same guard and preserves evidence
when refused. The default wrapper refuses surviving `typed-workspace`,
`typed-enrollment.intent` or `.orca-typed-workspace` claims without parsing them or
asking selected release code for permission.

**Missing production proof:** no installed stable artifact currently connects that
wrapper to the canonical parser/owner under original immutable inventory, accepted
image identity and the inherited lifetime descriptor. No audited transition excludes
every pre-existing daemon/CLI/ACP writer. Those two integration facts are required
before enrollment or a positive typed runtime can be constructed. The new lock alone
does not retrofit old binaries, and test injection is not a production bridge.
No configured control-path omission can be used as a production never-typed proof.
The legacy-only adapter retains historical behavior where no typed enrollment is
supported; it must not be used for a future enrolled deployment whose registry is lost.

CLI config/update bootstrap checks opaque `.orca-typed-workspace` refusal locators
before ownership, stores, plugins or credentials, including direct bootstrap/auth
entrypoints and resolved store roots. The locator is never positive authority and
does not replace the required external stable inventory. Help/version remain usable.
No enabled typed daemon is composed, so no claim is made that existing daemon legacy
config/always writers are enabled-safe. Parent must compose their guard/provider
before any accepted build mapping is added. App/remote/plugin/arbitrary launch
inventories cannot acquire a production owner. App/Mac/Windows typed activation
remain unavailable; no Mac hardware or native launch/update path was touched.

## Validation scope

New temporary-root tests cover nested/shared roles, aliases/identity replacement,
corrupt/missing/pending/reset evidence, fresh enrollment, competing enrollment,
initialization failure before/after rename, lost confirmation acknowledgement,
normal policy publication without external witness edits, synchronous assertion
requirements and ownership/image loss during an awaited policy read. Actual CLI
argv and direct bootstrap/config/auth calls refuse before producers. Python fake
build/service tests cover all launch kinds, categorical refusal before effects,
previous-root recovery, retained journals and real inherited lifetime concurrency.

No live system/service/update operation, real enrollment, operator credential,
permission change, policy migration/deletion, deployment or native workflow occurs.
The dependency lockfile, lifecycle allow/deny policy, signing and sandbox controls
are unchanged. These synthetic/static checks cannot replace exact-head CI and
independent ownership/bridge review.
