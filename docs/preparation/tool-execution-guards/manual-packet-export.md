# Native packet export and the demonstrated manual delivery route

Baseline: `32cfcd019ac3f3b8bd6f13e82aa3b4e84589e654`, draft PR #809.
The subsequent [runnable nonsecret controller](runnable-nonsecret-controller.md)
packages this API with native custody and receiver integration. Its hard-pinned
public-pilot command is runnable; private/raw export and host installation remain
unavailable without the actual owner/privacy binding.
This increment implements the G7 declared-byte export boundary and part of G4 S8
copy/failure accounting. It does not close S0, M1 issuer/recovery binding, complete
original acquisition/settlement, privacy admission or original receipt continuity.

## What the operator has actually demonstrated

Casey generated one nonsecret 16,777,216-byte file in a unique `/var/tmp` pilot
directory on pve2. User-operated Windows SCP used the already existing root/password
SSH access, followed by private ChatGPT upload. The parent materialized the bytes
and independently matched the pve2 SHA-256:
`080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e`.

The [pilot record](manual-scp-single-file-pilot.json) records that trusted handoff.
The exact private host path and raw pilot bytes are not retained in this checkout.
This task neither contacted pve2 nor repeated/regenerated that pilot as evidence.
No password was supplied to the assistant. This supersedes the missing basic
host-to-workstation route question, without implying that every SSH client,
configuration or subsystem has been independently inspected here.

This is **one actual 16 MiB file**, not the earlier proposed P 16 MiB plus Q 1-byte
two-chunk/index pilot. Index `.v1` upload acceptance, exact packet inventory,
multi-file/full-size/private transfers and source/issuer authority remain open.
The earlier 165-byte cloud probe remains separate historical evidence.

## Real source component

[`PacketExporter`](../../../tools/owned-read-proof/packet_exporter.py) takes
preopened owner-controlled source file descriptors, an independently specified
tuple of opaque artifact IDs/sizes/whole hashes, a preopened empty private output
directory FD and a restrictive data-byte capacity. It selects no installed host
path, walks no source tree, reads no caller JSON, opens no transport and invokes no
observer. These inputs describe approved bytes; they do not authenticate the owner
or identify a complete original run. A caller-created inventory cannot supply M1.

The original process/thread owner has two stages:

1. `prepare(...)` snapshots strict bounded scalar expectations and validates all
   readonly regular source FDs and distinct native inodes. Complete whole-source
   hashes and retained source metadata/stamps precede every output allocation. It requests the exact
   chunk and index data reservation using Linux `O_TMPFILE` and `posix_fallocate`,
   **before the first copy write**. Unsupported semantics, allocation/FD exhaustion
   or uncertainty refuse without application allocation fallback.
2. The preexisting trusted custodian independently retains the returned data-only
   plan's index SHA and whole-original expectations through its already approved
   management path. The source helper supplies no new journal/budget or callback
   that purports to prove this retention. `publish()` rechecks the native sources
   and copies, consumes one attempt, links readonly chunks with create-only native
   operations, and publishes `packet-index.v1` last. Directory sync and eligible
   close/final checks precede its local result.

The wire bytes match the existing read-only receiver: canonical 16 MiB chunks,
fixed flat `chunk-00000000.bin` names and exact ASCII `ORCA-UPLOAD-1` index grammar.
Whole-artifact SHA-256 is independent of chunk boundaries. The immutable plan is
ordinary correlation data; copying, editing or deserializing it cannot recreate
the original exporter, native handles, issuer or receipt. Caller input/returned
record mutation cannot change the owner's internal manifest.

All reads/writes are at most 65536 bytes. Payload is streamed; bounded index metadata
is buffered. The receiver's defensive ceilings remain 4096 artifacts, 8192 chunks,
4 MiB index and 8 GiB **declared payload**. Several hash/copy/readback passes perform
several times the payload in actual I/O; 8 GiB is neither total work nor RAM/quota.
At most 4096 source duplicates + 8192 output chunk FDs + one index FD + one root FD
+ one scandir-owned FD coexist: **12291 owned FDs**, plus at most 4097 caller-borrowed
source/root FDs. Existing OS limits can refuse; none is raised. Native filesystem
I/O has no new deadline; existing observation/helper budgets and deadlines stay
unchanged.

Required file-data allocation is exactly `sum(artifact.size) + exact_index_size`.
There is no second payload staging file: reserved unnamed inodes become the same
published files. The source originals retain their independent existing allocation.
Directory/inode metadata, allocation rounding, sync and owner management retention
still require the actual host quota/protection review. Fallocate does not create
or qualify that quota. The component relies on the native API's allocation contract;
tests verify actual calls, exact sizes and reported errors, not every libc/kernel/
filesystem implementation or physical extent. Those installed semantics still need
qualification. The prior conservative 12 GiB whole-profile proposal remains
a proposal; this source change applies no host allocation or policy.

## Failure, privacy and physical custody

The first original exception remains private, with fixed public errors/codes.
Every owned handle closes once; ambiguous close consumes its number and blocks
success, further reads/writes and retry. Borrowed source/root descriptors and their
offsets remain untouched. Preparing failure closes only this component's unlinked
temporary copies, leaving the borrowed originals intact. Visible publication
partials are retained; no unlink, overwrite, automatic repair or resend exists.

Index-last publication makes an incomplete set refuse in the receiver. Lost reply,
sync or close failure after index visibility remains uncertain even when a later
read-only receiver matches all bytes. Such inspection is byte reconciliation, not
recovered original acknowledgment, media durability, session ownership or permission
to execute/delete. The original trusted recovery owner must resolve that state.

Source FDs may represent a recorded one-link source or a two-link host report
custody inode. The actual prior `HostReportCustody` transaction is exercised in the
tests: its two aliases remain intact; export creates a different inode with one
link, accepted by `PacketReceiver`. This does not relabel the host copy as the
guest's original physical lineage. No original evidence checker is relaxed.

Native UID/mode/stamp checks, readonly publication and source hashes assume the
trusted cooperative process/ancestors and local procfs. They do not authenticate
Casey, enforce isolation from hostile root/same-UID actors, detect hostile ABA or
establish loaded-code closure. Raw originals can contain private keys, disposable
tokens and paths. No private artifact selection or export is authorized by a
successful public pilot or this callable filesystem component. Complete-source
certification and all four observer entry refusals remain unchanged.

## Small next operator step and stop condition

There is no need to repeat the successful one-file transfer or install a host
controller to make that fact stronger. The next setup review should bind this
component to the **existing host principal and a named private export directory**,
the exact original artifact/disposition inventory, approved capacity/privacy and
the existing recovery/management retention path. Consumed/unlinked originals must
retain their authentic disposition, not be silently omitted or recreated. No
candidate JSON, filename glob or success flag can fill this ownership gap.

After that binding, the intended manual path stays simple: one owner operation
prepares the finite packet, the owner retains its independent plan and publishes
once, then Casey copies only the fixed published chunk/index files using the same
already working SCP access and attaches them privately. Passwords remain solely
in local authentication prompts. Unexpected fingerprint, authentication, SFTP or
upload-type errors stop; there is no legacy fallback, service change, zip/rename
workaround or regeneration on Windows.

Until the owner binding and raw disclosure review exist, **private preparation/
publication and host installation stop**. No controller CLI, live observer adapter,
new credentials/access, network/security changes, launch override or host commands
are installed or executed by this task. The source API and tests are real local
file operations, while the missing external owner interface remains explicit.

## Verification

The [checks record](manual-packet-export-checks.json) pins the exporter, tests and
explicit selector. The focused exporter/receiver/report-custody/qualification
selection passes **91 tests** normally in 0.769 seconds and **91** under optimized
Python in 0.749 seconds. The complete explicit non-live selection passes **651 outer
plus seven historical child tests**, in 25.508 seconds (child 6.390 seconds).
Before refreshing the separate historical harness, 71 Python/reference files were
verified disjoint from 199 protected inputs whose bytes equal fixed historical Git
source. No full discovery, observer/tracer/probe body or host operation ran.

The 29 new tests include native data reservation before copy, last-index allocation
failure with no copy writes, exact capacity/no fallback, multi-chunk and empty
artifacts, mutation of source/output/caller records, real two-alias report-custody
integration, foreign target refusal, partial publication, index-link lost reply,
final sync/close uncertainty, consumed FD-number reuse, private first-error
precedence and original PID/thread restrictions. Exact borrowed handles/offsets,
original source bytes and complete-source refusal remain covered.

Independent **gpt-6.1-sol, xhigh** review independently passed 29 normal tests
in 0.426 seconds and 29 optimized tests in 0.400 seconds, with no skips. It found no
remaining source issue within the documented trust boundary and verified that
native reservation semantics are qualified separately from installed host quota or
physical-media claims. Three Python files compile and diff checks pass. Ordinary
exact-head CI is separate evidence and does not provision the historical fixture,
authenticate an owner or qualify private transport.
