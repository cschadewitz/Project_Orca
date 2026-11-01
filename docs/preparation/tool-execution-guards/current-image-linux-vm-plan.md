# Disposable Linux VM: concrete M1 preparation plan

Baseline: `112334a36a731302b0ea8f2d0a15e78251556a20`, draft PR #809.
Casey selected a disposable Linux VM as the first connected-proof domain. This
resolves the guest-versus-existing-host direction in the
[architecture map](current-image-architecture-gates.md); the exact guest, owner
interfaces and runtime configuration remain unbound. It authorizes neither
provisioning nor a live run. This document is a candidate setup contract, not a
deployable unit, authority token, current-image designation or executable recipe.

## Claim, components and trust boundary

The intended future claim is current-image behavior, complete replay and original
bootstrap-to-connected lineage inside **one identified disposable Linux guest**,
using synthetic data. It excludes existing-host/fleet equivalence, production
activation and proof against a compromised hypervisor, guest kernel or trusted
management/bootstrap implementation. Those trusted components must be named and
reviewed. Faulty candidate code must not control management, observer code,
recovery records, resource policy or evidence custody. Trusted same-process
semantic checks remain cooperative assumptions, not hostile-code attestation.

Prefer the already documented Proxmox ownership lead over introducing a cloud
account or paid service. The [release-test VM plan](../release-test-vms/README.md)
names Casey for node/storage/network/VM selection and existing console access;
it is dated preparation, not an available observation platform. Its desktop
installation, network, resource and snapshot recipes do not qualify this harness.
No release-test commands or linked #779 work were executed or reviewed here.

| Component proposed for the guest design | Evidence available now | Exact unresolved contract |
| --- | --- | --- |
| Existing VM owner and recovery control outside the candidate | Repository VM ownership lead; no current inventory or authorized management endpoint | Casey names exact VM/node/storage, existing authenticated management principal, permitted operations, capacity allocation and a surviving recovery operator. No spending/access grant inferred. |
| Guest system service manager, with a fixed owner-controlled execution specification | Repository service templates and upstream systemd manager API; not installed guest evidence | Owner supplies effective version/configuration, protected service definition, exact allowed invocation and original-attempt/job association; candidate gets no management bus, general shell or unit-creation privilege. |
| Owner-trusted immutable execution media and minimal bootstrap | Kernel dm-verity mechanism and independent plugin pin precedent | Independently supplied root trust, complete Python/Node/native/tracer closure, enforceable loading policy and trusted actual-load evidence; no candidate-supplied root hash or mutable checkout trust. |
| Separate supervisor/producer confinement inside the guest | Source ownership graph and upstream isolation primitives | Exact UID/process/FD/mount boundaries compatible with the harness and replay; neither a single shared writable account nor a VM alone protects the observer from the candidate. |
| Private evidence custodian outside candidate authority | Existing private-store publication mechanisms | Named sink, access/retention/restore policy, reserved first-failure space, complete accounting and surviving uncertainty owner; current store excludes same-account compromise from its threat model. |

These are reusable mechanisms and design choices, not a verified provider. The
[guarded service launcher](../../../tools/deploy/private-mcp-service/launch-mcp.js)
authenticates a different MCP target; it cannot issue observation sessions.
The [maintenance API](../../../packages/maintenance-mcp/src/contracts.ts) is
read-only. The [stable release wrapper](../../../tools/deploy/orca-release.py)
preserves purpose-specific lifetime handles, but does not implement observation
ownership. Their contracts must not be relabeled as the missing manager.

## A. Owner handoff before setup approval

Casey supplies the existing VM management interface and identifies the platform
operator, session issuer, recovery operator, immutable-media publisher and private
evidence custodian. One person may fill several roles, but each responsibility and
authentication boundary must be explicit. Cal coordinates review and the separate
setup/live decisions; a conversation approval is not itself a runtime capability.

The handoff must bind the selected VM's identity and generation, hypervisor/guest
versions and trusted boot origin; permitted devices and management channels;
synthetic fixture roots; independently pinned media; and already approved resource
and storage allocations. Record what is proposed, what an owner documents and what
later qualification actually observes separately. No status query is performed now.

The concrete issuer interface is **missing**, not supplied by a new JSON schema.
It must support the following owner-authenticated operations with durable original
attempt identity: reserve an attempt and private capacity; consume at most one
bootstrap grant; freshly check and consume at most one connected grant; revoke;
retain uncertainty; and reconcile original owned resources without relaunching.
Bind each grant to exact guest generation, reviewed source/image/runtime/harness,
loader policy, allowed data/resources, budgets, lane and original supervisor.
Transport must authenticate the independent issuer before the first candidate
import and preserve freshness/consumption across a lost reply. Candidate possession
of a report, flag, digest, copied receipt or writable endpoint name is insufficient.

The guest manager is a possible execution backend, not that issuer. Upstream
[systemd D-Bus](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html)
provides start jobs, job-result signals and transient-unit creation. Subscribe
before starting when correlating a job result. A returned job or completed start
does not prove application readiness, ownership transfer or settlement. Transient
units disappear on reboot; they cannot be the sole recovery journal. Prefer a
fixed reviewed service specification over accepting arbitrary candidate properties.
Whether an existing authorized owner can supply this adapter is unknown.

Recovery must survive candidate/supervisor failure and guest loss. Keep the durable
attempt record outside the candidate's VM rollback domain. A guest-local protected
broker can own immediate handles, but its external owner must retain lost-ack and
VM-generation responsibility. On a missing reply, admission stops; the owner may
only reconcile the original resource association. Do not create a new attempt,
repeat launch, replay a message or infer absence from an empty journal. Guest reset
or supervisor restart permanently loses the internal connected capability.

**Exit A:** named existing owners and authenticated interfaces, explicit reservation/
consumption/revocation/lost-ack semantics and recovery custody are independently
reviewed. Today this exit is open. No candidate manager implementation is justified
until those concrete contracts arrive.

## B. Setup specification to review, not apply

After A, the platform owner prepares a fixed guest specification for separate setup
approval. It must contain the following exact entries, not permissive defaults:

| Surface | Required setup and validation evidence before candidate effects |
| --- | --- |
| Guest and management | A disposable guest with synthetic data only; exact boot/media/generation and devices. Keep existing management access outside the candidate. No shared host homes, production disks, agent forwarding, clipboard/file integration or credential mounts. Identify any necessary management channel and authenticate it separately; no channel is assumed available. |
| Network | No candidate-reachable NIC, external route, DNS, host service or metadata endpoint. Preserve only explicitly enumerated non-network control/ack pipes. Any guest management networking must remain outside the candidate namespace and inherited descriptors. Prove both absence of inherited sockets and denial of new unapproved socket paths; a trace showing no connection is not prevention. |
| Files and IPC | Immutable runtime/code mounts; only exact synthetic mutable roots writable, with no execution/loading from them. Hide private sink, management sockets and unrelated guest paths. Enumerate `/proc`, `/sys`, `/dev`, shared memory and every required query instead of mounting unrestricted host views. Read-only directories alone do not block socket communication. |
| Processes and credentials | Separate protected management/supervisor ownership from candidate writes and ptrace authority. Exact task membership and nondelegated process boundary; no privileged escape path. Empty credential environment, no token/key/agent sockets, explicit minimal environment and descriptor allowlist at every exec. Account names and privileges remain owner inputs. |
| Observer privileges | Identify the minimum descendant tracing and owned kernel-query rights compatible with existing policy. Do not disable Yama/LSM/seccomp, grant host-wide tracing, or change security settings to make it work. If this requires a broader privilege or changed trace grammar, stop for review; do not broaden it here. |
| Resources | Owner supplies existing CPU/RAM/task/disk and management-evidence allocations. Enforce them before startup without changing the source bounds below. The release-test plan's 4-vCPU/8-GiB/64-GiB suggestions are not observation budgets or capacity evidence. |

Possible system-manager building blocks are `RootImage`/independently pinned
`RootHash`, `ProtectSystem`, `ProtectHome`, `PrivateNetwork`, address-family and
syscall restrictions, explicit writable paths and descriptor inheritance. These
are a review vocabulary, not a drop-in configuration. Namespace support and
effective policy must be established; inherited sockets and writable exceptions
need separate checks. `MemoryDenyWriteExecute` conflicts with JIT, so it cannot be
blindly added to this Node workload. See
[systemd execution policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
No settings have been applied or relaxed.

[systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
can enforce memory/task/cgroup limits; the owner's actual allocation remains
missing. [Control-group emptiness](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [control-group termination](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
are useful external observations/actions only after exact original membership is
established. They do not prove evidence flush, handle release, worker settlement or
semantic closure. On uncertainty retain custody and quarantine the original guest;
do not dispose borrowed resources or claim a forced VM stop is successful proof.

**Exit B:** a reviewed, version-specific specification maps every resource and
borrower in architecture S0–S10 to prevention and original recovery. Later platform
qualification must demonstrate fail-closed behavior before granting any observation
lane. A configuration parser accepting a directive is insufficient. No such platform
qualification or provisioning is authorized in this increment.

## C. Immutable bootstrap and actual-loaded closure

The proposed trust origin is an independently reviewed publisher plus the platform
owner's protected bootstrap configuration, outside candidate write authority.
The publisher supplies immutable media and expected root identity through that
existing trusted path; the candidate cannot nominate either. Kernel
[dm-verity](https://docs.kernel.org/admin-guide/device-mapper/verity.html) checks
read-only blocks against a trusted root; it does not authenticate its own root hash
or identify everything an interpreter evaluates. Guest boot/kernel, supervisor,
loader and policy must themselves be covered by the named trust chain.

Create a **new, separately identified execution envelope**, if later approved,
around retained image bytes. This does not rebuild, repin or designate the retained
three-file image. Inventory Python interpreter/stdlib/extensions and all observer
modules, Node executable/builtins, producer/child, dynamic linker/libraries/config,
strace, `prlimit`, helper binaries and permitted generated code origins. Builds and
dependency acquisition belong outside observation; all preparatory helpers still
require containment and an owner before running. Record envelope identity separately
from [image/source identity](current-main-qualification-identity.json).

The minimal bootstrap must enforce immutable resolution **before evaluation**,
including early imports, and admit only the complete reviewed graph. CPython
[`-I` and `-S`](https://docs.python.org/3/using/cmdline.html) remove ambient import
sources/site processing, but are not a sandbox or proof of loaded modules. The
existing sibling imports need a reviewed immutable resolution path; do not fix them
by adding a writable checkout to `sys.path`. Reject unknown native loading and
mutable bytecode; no post-import pathname hash can repair missing origin evidence.

Node's static producer import currently precedes child checks. Its `createRequire`
and optional native modules need complete resolution analysis. Node 24 documents
[`--no-addons` and `--jitless`](https://nodejs.org/docs/latest-v24.x/api/cli.html),
but adopting either changes runtime behavior and needs separate compatibility
qualification; neither is selected here. Pin V8/generated-code provenance and
prevent unreviewed dynamic sources, or return an unsupported-loader blocker.
An allowlist, permission flag, digest-qualified URL or mutable loader hook alone
does not prove enforcement against the candidate. Do not equate immutable media
with immutable process memory or protection against trusted same-process mutation.

Actual-load corroboration must originate in the protected loader/observer and bind
interpreted code and native mappings to this original process; an `exec` trace alone
misses interpreted imports. It is an additional requirement after preventive loading,
not retrospective authorization. The exact compatible mechanism is still missing.
Cross-UID evidence ownership, proc visibility, clock namespaces and changed memory
maps can affect existing physical identity/replay checks; resolve those explicitly,
never by weakening assertions or fabricating successful reports.

**Exit C:** independently reviewed origin, immutable resolution and actual-load
mechanisms cover every runtime class, with unknown paths refused and all required
compatibility deltas qualified. This is not discharged by existing image hashes.

## D. Original lifecycle, bounds and private durable evidence

Keep one original supervisor alive across both lanes inside the selected guest.
The external controller owns session authority; the original supervisor owns the
nonserializable bootstrap receipt/image/handle graph. Bootstrap requires complete
replay and original settlement, acknowledged private originals and the closed-state
assertion **before** receipt sealing. Connected admission then needs fresh external
authorization and the retained original graph, followed by separate Save (zero
execution), human Allow Once and fresh-rule phases. No restart, exported receipt,
snapshot restore, or successful historical fixture can supply that graph.

The historical pin remains `3fce8bcc9afd381cd07c0e06051921307d6322b3`; the inspected
image's reviewed source model is separately
`4ebf382fe6738bb11268b47b048a3d7c7a6f2586`. Current-source designation is still open.
The VM choice does not resolve the pin/qualification delta or authorize removing
any of the four first-statement refusal guards.

| Existing source constraint | Value and distinction to preserve |
| --- | --- |
| Observation / authority / worker joins | Run 60 s; authority window 55 s; three separate control-worker joins of 1 s. No pooled timeout or automatic retry. |
| Tracer cleanup | Original tracer wait 5 s and adopted-tracee loop 5 s, separately; timeout retains uncertainty. |
| Helpers | Clock probe, tracer help/version and relevant runtime/git helpers 5 s; wrapper build subprocesses 30 s. These are effects, not free preflight. |
| Trace / per-file OS limit | Trace `LIMIT` 268435456 bytes; existing `prlimit --fsize` soft/hard 268435456 and core 0. Per-file limit is not a total disk quota. |
| Report / originals | `REPORT_LIMIT` 1048576; `ORIGINAL_METADATA_LIMIT` separately 1048576, immutable hex accounted separately. Neither allocates a new journal. |
| Runtime assets | At most 32, each at most 268435456 bytes; not an approved aggregate VM disk reservation. |
| Diagnostics / output | Diagnostic period 1 s, maximum 62 samples, each read at most 8192 bytes; sampler stop join 1 s. Producer stdout/stderr each at most 65536 bytes; retained stderr tail 4000 decoded characters stays private. Sentinel reads may consume one extra byte to detect overflow. |
| Replay mutable effects | Each mutable object at most 65536 bytes, cumulative writes at most 16777216; post-hoc checks, not preventive quota enforcement. |
| Compact association | 4096 bytes; not durable first-failure capacity. |

Source authorities are [supervisor](../../../tools/owned-read-proof/controlled_supervisor.py),
[timestamps](../../../tools/owned-read-proof/controlled_timestamps.py),
[tracer ownership](../../../tools/owned-read-proof/run.py) and
[replay](../../../tools/owned-read-proof/controlled_replay.py). All other existing
diagnostic/count/depth/read bounds remain unchanged; this table is not a replacement
for their complete source inventory or permission to select a larger value.

The private custodian reserves first-failure capacity before delegate acquisition.
It defines fixed phase/error/ownership codes, detection order, first-error precedence,
complete-write/file-sync/create-only-publication/directory-sync acknowledgment, and
lost-ack handling. Do not stringify exceptions, serialize traceback frames, argv,
environment, paths or tokens into the failure journal. Raw required originals have
separate private custody; public summaries contain only reviewed bounded codes.
Disable unintended public console/journal/core leakage through a reviewed routing
plan, not by disabling required diagnostic collection. Protect custodian keys and
readers from candidate access; encryption under the same writable account is inadequate.

[Protected storage](../../protected-execution-storage.md) supplies useful publication
mechanics but no reserved observation-journal quota. Existing metadata whitelists do
not admit a new journal. The custodian must show byte equations for records, raw
originals, temporary files, simultaneous versions and export/recovery retention,
including existing management-plane quotas. No extra file, pooled allowance or
raised bound is approved. If no compatible accounting exists, D remains blocked;
return the exact conflict for a separate architecture decision.

**Exit D:** every S0–S10 operation has all six architecture G4 exit properties,
including surviving uncertainty ownership and pre-write accounting. Inert cleanup
tests remain bookkeeping evidence. They cannot prove actual process settlement,
loaded code, physical continuity or durable media behavior.

One concrete source blocker remains: `run_traced` can raise `OwnedCleanupError`
for unsettled tracer/tracees, while the historical supervisor finalizer checks only
control-worker inactivity before disposing eight handles/provenance. The retention
requirement below needs a separately reviewed source correction and qualification;
it is not behavior established by this plan. That body remains unreachable beneath
the unchanged refusal guard and was not invoked or extracted for testing.

## Future bounded negative qualification packet

These are acceptance cases for **separately approved synthetic platform
qualification**, not instructions to execute now. Each needs the concrete A–D
mechanism, exact original identities, existing bounds and private evidence custody.
An unknown mechanism blocks the case; an inert test or report cannot mark it passed.

| Case | Responsible boundary and required bounded evidence |
| --- | --- |
| Wrong issuer, replayed lane grant, expired or revoked authority | Independent issuer and protected bootstrap refuse before candidate effects. Retain original reservation/consumption ordering and a fixed refusal code; no retried launch or synthetic successful grant. |
| Unapproved media, interpreted import, native library or generated-code origin | Protected media/loader refuses before evaluation. Bind rejected origin to the exact permitted graph privately; post-import hashes are insufficient. |
| Inherited socket/credential, unapproved writable path or IPC endpoint | Platform owner prevents candidate access before lane admission. Exact inherited resource inventory and independently qualified denial evidence are required; no host scanning or production secrets. |
| Lost reservation or start acknowledgment | Surviving recovery owner retains the same original attempt and resource association. No relaunch, inferred absence, receipt reconstruction or automatic retry; bounded private uncertainty record remains. |
| Partial private write, sync failure or lost publication acknowledgment | Custodian retains the first failure and original capacity accounting. No receipt or public success; preserve uncertain bytes and original ownership without repeating an ambiguous write. |
| Unsettled worker/tracee/borrower, supervisor restart or guest reset | Original lifecycle/recovery owners block borrowed-resource disposal and connected admission. Retain original handles where still valid and quarantine custody; external shutdown is not settlement proof. Never act on reused numeric handles or resume a lost capability. |

## Finite handoff and separate authorizations

1. **Now:** approve direction and independently review this candidate contract.
   Direction is resolved; A–D evidence remains outstanding. Keep source, guards,
   retained images and historical regression unchanged.
2. **Next M1 handoff:** Casey/owners supply the exact interface and allocation packet
   in A. Engineering maps it to B–D and the prelaunch G6 checker/G7 custody obligations.
   Reject a missing capability instead of manufacturing a mock provider. This is the
   next finite milestone, not more incidental cleanup.
3. **Only after M1 acceptance:** prepare a cohesive source/inert implementation and
   version-specific configuration, with independent review. No reachable launcher
   or authority override is introduced during preparation. Existing guards remain
   until a separately reviewed replacement is expressly authorized.
4. **Separate setup decision:** review exact guest, owner actions, management/data
   boundaries, immutable envelope, resource allocations, storage and rollback plan.
   Provisioning, security configuration, media creation and platform qualification
   are not authorized by the scope selection. Do not run even a tracer “preflight”
   under documentation approval.
5. **Separate live decision after readiness evidence:** exact original session,
   one bootstrap then at most one separately authorized connected lane, unchanged
   bounds and no retry. The reviewed current-source checker must be ready before
   effects; complete replay/settlement and independent exact-claim qualification
   follow. Failure/uncertainty stops admission and retains private custody. Export
   and disposal require the reviewed owner policy; no merge or activation follows.

## Evidence status and access limits

This increment changes prose only. Primary project documentation was read through
web browsing; no installed versions, provider availability, host resources, guest
configuration or runtime behavior were queried. Upstream systemd pages describe
version 262, Python's generic page 3.15.2 and Node's v24 page 24.22.2 at retrieval;
these do not select or upgrade the eventual guest runtimes. Version compatibility
remains an owner-supplied requirement.

The Proxmox `https://pve.proxmox.com/pve-docs/qm.1.html` fetch returned **403
Forbidden**. It was not retried and no alternate route was used. Consequently
current upstream Proxmox capability verification is blocked for this pass; the
repository plan is only a dated ownership lead. Node's v24 `permissions.html`
fetch was reported inaccessible by the browsing tool, with no further reason;
it was not retried and no permission-model guarantee is relied upon. Accessible
CLI documentation is cited only for the distinct runtime options above.

The held PR-description mutation remains unresolved with unknown classification;
no retry/comment/alternate endpoint is permitted. #779/#793/#794 denials and App
Smoke prohibition remain binding. Independent review here is bounded preparation
review, not formal security approval. No live proof or current-image qualification
is claimed.
