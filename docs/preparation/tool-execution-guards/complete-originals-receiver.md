# Complete originals: inventory and read-only upload verification

Baseline: `1b2366bd539a97f28b8e7cbfcd8a3f01a62c5931`, draft PR #809.
The selected direction remains Casey's console-operated pve2 host controller with
private host evidence outside guest snapshot rollback. This source increment
advances G7 byte delivery/integrity and G4 custody accounting through a **read-only
receiver for an independently specified complete upload inventory**. It does not
claim that a received inventory is the complete original observation, perform
semantic replay, authenticate its origin or restore a live capability.

No host, SSH, VM260, pve2, network/security configuration, credential/access,
deployment, live observer or VM operation occurs. Observer entry refusals, original
whitelists, source/image pins, timeouts and independent source bounds stay unchanged.

## Actual source artifact inventory

These are the retained artifacts/effects in the currently disabled controlled
wrappers and supervisor, not permission to run them or a new export allowance.
Presence depends on the original reached stage. A missing artifact after failure
is not silently optional; an independently trusted owner must retain its original
disposition. Receiver byte checks cannot infer that disposition from absence.

| Artifact or original | Source and applicability | Existing bound / exact distinction |
| --- | --- | --- |
| `image/controlled-build.json`, `controlled-child.mjs`, `controlled-producer.mjs` | `build-controlled.mjs`; shared image before observation | Designation `snapshot()` limits each to 16 MiB and requires exact three-file inventory; current fixed inspected sizes are 48027 / 5713 / 2248652 bytes with existing hashes. The builder itself has no preventive output-byte quota. These separate native files and image physical lineage are distinct from the image hex also embedded in each originals packet. |
| `<lane>-attempt.json` | `controlled_supervisor.observe`, bootstrap and separately connected | `REPORT_LIMIT` 1048576 bytes; metadata grammar checked before report write. Reports are evidence/correlations, never receipt capabilities. |
| `<lane>-originals.json` | Supervisor before launch, refreshed during/finally | `ORIGINAL_METADATA_LIMIT` separately 1048576 bytes plus immutable hex. The restrictive raw-source aggregate is 536870912 bytes, giving at most **1074790400 bytes (1025 MiB)** for a canonical packet. Runtime inventory remains at most 32 entries, each at most 268435456 bytes. This does not allocate an export copy or an additional metadata file. |
| `<lane>/trace` | Original tracer output in each lane | `LIMIT` and the observation's per-file `prlimit --fsize` are 268435456 bytes. Complete exact raw lines, timestamps, partial/resumed framing and their hash are required; a tail/summary is insufficient. |
| `<lane>-clock/clock-probe.trace` | `probe_clock` before original capture/start | **No explicit source byte cap.** Its separate `run_traced` call has a five-second timeout but no observation `prlimit` or byte ceiling; it later calls `read_text()`. Main-trace LIMIT cannot be borrowed for this helper. Hash/time correlations are retained in originals, but do not replace raw probe bytes. |
| `<lane>-diagnostics.json` | Optional `diagnostic=True`; retention after owned original settlement | At most 62 samples; each counter read at most 8192 bytes; three process roles and four resource names. These are **not an enforced total serialized-artifact byte limit**. Writer takes already encoded bytes without a total length check. Exact standalone source/custodian accounting remains open; no new 1 MiB allowance is inferred. |
| `bootstrap-association.json` | Only after full original bootstrap closure and receipt construction | Existing compact receipt at most 4096 bytes. It references original report, originals and trace/image digests; JSON cannot recreate the closed-graph callback or designation. It is not first-failure journal capacity. |
| `sanitized-checkpoint.json` | `observe_new` / `diagnose_bootstrap` wrapper final projection, including refusal paths | Fixed public schema, fixed strings, at most two summaries and bounded counters. For the canonical current writer, maximum public summary is 305 bytes and maximum checkpoint is **933 bytes**, derived from projection construction. This is not a new journal/export allowance or proof that raw originals were retained. |
| `<lane>/controlled-plan.json`, `workspace/.orca/workspace-identity/id`, `lifetime.lock` | Supervisor preparation | Existing source-capture maxima 65536 bytes, 37 bytes, zero content bytes respectively. Exact plan/identity/lock bytes and metadata are also embedded in originals. FD/flock ownership is live original state; uploading a zero-byte lock file does not preserve it. |
| `<lane>/control/never-typed` | Prepared enrollment witness, then consumed/unlinked in successful bootstrap | At most 130 bytes; exact retained bytes and consumed lineage are in originals/replay. Successful consumption means there is no surviving standalone file to export. An exporter must not manufacture or resurrect it. |
| Remaining named mutable state: config/sidecar, credentials, private execution/key/payload files, workflow state, leases and journal | Created by the producer under the lane; final states checked by `Replay.run` | Accepted replay limits each mutable object to 65536 bytes and cumulative writes to 16777216 bytes. These are post-hoc acceptance limits, not a preventive filesystem quota or a fixed filename list. The actual final inventory comes from the original replay/owner, not a candidate-provided allowlist. Private paths, keys and tokens need explicit raw-export review. |
| Unlinked resource/temporary files and original pipe messages | Original process/replay graph | Some original bytes exist only in raw trace plus retained original/replay data after unlink/consumption. Do not replace missing physical lineage with newly created files. Phase tokens, pipe/FD ownership and live callback/permit identity cannot be uploaded as capabilities. |
| Producer stdout/stderr | Bounded pipe reads after settlement | Each checked at 65536 bytes (with one sentinel byte). No separate raw output artifact is retained; only the last 4000 decoded stderr characters enter the report. That field is not full stderr. No new stdout/stderr files or budget is introduced here. |
| Observer/source/runtime/query/clock provenance | Originals record hashes, metadata, selected complete immutable bytes | Image/runtime originals contain retained bytes; observer implementation records file hashes/commit, and tracer/help/kernel provenance includes hashes/selected data. These are not a complete independently authenticated loaded-code envelope. Interpreter/stdlib/native loader origins remain G3 obligations. |

The private path families recognized by existing replay include
`control/{intent,enrolled}.json`, `workspace/orca.permissions.json` and its PID
staging file, `credentials.json` and staging files, the controlled lease and
mutation locks, private-execution key/inputs/UUID and capture/evidence payloads
and publication staging files, lock-owner tokens, the detached service fixture,
and (connected only) `workspace/.orca/runs/controlled.jsonl` and its lock/token.
These are source grammar descriptions, **not** permission to glob or export a host
tree. The actual original replay path/object graph selects the final named set;
consumed staging names are represented by the trace instead of manufactured files.

Additional helper stdout (`ldd`, Git, tracer help/version) is captured in memory
with helper deadlines but without a general capture-byte cap. Selected versions,
hashes and provenance enter originals; full standalone helper-output files are
not retained. If complete review needs those raw outputs, acquisition, privacy and
bounded storage must first be specified; this receiver does not invent them.
Unrelated older `run.py` scenario-harness `inventory.json`/`binding.json`/`plan.json`
outputs are not silently substituted for this controlled observation's artifacts.

The successful lane report/originals/trace subtotal is **1282 MiB per lane** under
existing ceilings. It excludes separate image copies, helpers, diagnostics,
mutable-tree copies, compact association, checkpoint, filesystem metadata, another
lane, transport index/chunks and retention. The 16 MiB mutable-write ceiling is not
extra export capacity. There is currently no justified finite preventive *complete
packet* reservation: clock-probe bytes lack a source cap, diagnostics lack an
enforced serialized cap, and the owner has not allocated aggregate export/index/
copy space. This exact conflict blocks host export/admission, not read-only checking
of already approved received bytes.

Physical checks in `Replay.run` still read original absolute paths and compare
native inode/state observations. No mapping, path substitution, re-created inode,
receipt deserializer or relaxed checker is added for cloud copies. Complete byte
agreement would still be insufficient for original physical/loaded-code/authority
qualification.

## Receiver boundary and data trust

The source receiver operates on a preopened private local upload directory FD.
It reads a strict versioned index and fixed derived chunk filenames. It receives
both an **independently supplied expected index SHA-256** and an **independently
supplied exact artifact inventory of opaque IDs, sizes and whole SHA-256 values**.
The caller must not derive these expectations from the same untrusted index and
then call that independent evidence. Source/attempt identity and authenticity of
those expectations need the future trusted custodian/approved disclosure route.
They are data-correlation inputs, not signatures, issuer authority or quota grants.

Actual native files and complete hashes are checked. The receiver verifies the
entire declared inventory and every chunk before returning a byte-integrity result.
A smaller self-declared packet cannot stand in for the independently expected set.
An index that matches a maliciously supplied expected set can establish only that
set's byte agreement, never completeness of an original run.

The receiver creates **no artifact, journal, output/reassembly file or export copy**.
Whole-original SHA-256 is computed by streaming ordered chunk bytes through one
hash state; chunk boundaries do not alter the original hash. Native observations
are rechecked and handles are consumed once on close. Failure is terminal for that
receiver object, the original private exception remains private, and public errors
contain fixed text/codes. There is no automatic retry, repair, archive extraction,
path reconstruction, observer invocation, semantic acceptance or receipt factory.

A separate explicit request to certify complete current-source evidence refuses.
Current helper/source-budget, owner-policy, physical and authority gaps cannot be
cleared by an index field, Boolean, checksum, caller success callback or byte match.

## Concrete receiver protocol and resource bounds

The incoming directory contains exactly `packet-index.v1` plus code-derived
`chunk-00000000.bin`, `chunk-00000001.bin`, etc. The ASCII index begins with
`ORCA-UPLOAD-1` followed by LF. Each artifact, in strictly increasing 32-character
lowercase-hex ID order, has an `A <id> <size> <whole-sha256> <chunk-count>` line,
followed by its ordered `C <global-eight-digit-number> <offset> <size> <sha256>`
lines. Tokens have one space and every line ends in LF; decimal forms are canonical.
IDs are opaque correlation data, not source paths or grants. Canonical chunks are
16 MiB except the last; a zero-byte artifact has zero chunks and SHA-256(empty).

Independent expected inventory and index digest are validated before native
acquisition. The complete index is hash-checked before line decoding. Every index
artifact must equal the independent expectation; exact derived counts, offsets,
lengths, directory membership and distinct native regular-file identities must
match. Chunk hashes and the ordered whole-artifact hash are both required.
Missing, extra, duplicate, reordered, overlapping, gapped, truncated or changed
inputs refuse. The independent inventory does not itself prove authentic source
provenance or the completeness of an observation.

Receiver-only defensive limits are **4 MiB index**, **512 bytes/line**,
**4096 artifacts**, **8192 chunks**, and **8 GiB total declared payload work**,
with native reads at most **65536 bytes**. These are local decoder/verification
ceilings, not a new artifact/journal allowance, a source cap, a user-upload promise
or approved host index/export allocation. The payload ceiling bounds streamed work,
not resident RAM; no whole-original buffer or disk reassembly is made. Metadata,
EOF-sentinel and filesystem checks are additional bounded receiver work. Existing
FD/filesystem limits can refuse; no host limit is raised. As with the prior custody
component, byte/count bounds do not impose a native filesystem I/O deadline.

Known index/chunk names are pinned without read-open effects, validated as regular
files, then read-opened only through the original owned pin under the trusted local
procfs assumption. Original PID/thread and root/file correspondence are retained;
all owned handles are consumed once and borrowed root state is preserved. Native
UID/mode checks are local access mechanics, not uploader authentication or hostile
same-account isolation. The result's scope is fixed to
`declared-upload-bytes-only`; source certification remains a separate refusal.

## Complete delivery and policy decisions still required

Before a host exporter or any raw original leaves custody, the owner must supply:

1. The exact original-artifact/disposition inventory, including helper/diagnostic
   budgets and original-attempt binding. No omitted or consumed original is
   silently relabeled as absent, summarized or recreated.
2. A privacy review of complete raw originals, including disposable auth tokens,
   private paths, keys and retained protected material. Redacting bytes changes
   their whole hash and can break replay; a safe summary is not a full substitute.
3. Existing host principal/root, metadata and aggregate capacity/retention/recovery
   policy. Keeping chunks alongside B original bytes requires B additional chunk
   payload bytes, plus the exact index, metadata and staging. Streamed export may
   reduce simultaneous copies only under an explicitly reviewed acknowledgment/
   retention policy; ambiguous or sole originals cannot be deleted automatically.
4. Authenticated guest-to-host acquisition and the actual pve2→user upload→assistant
   procedure. Console ownership and cloud attachment tooling do not themselves
   instantiate that transport or grant new access. No SSH/network fallback is added.

The earlier probe established only **165 fixed nonsecret cloud bytes** retrieved
and hash-verified across executors. The parent reports a 32 MiB per-file attachment
receiver ceiling; 16 MiB chunks fit below it. User-interface upload limits, batching,
full-size/private transfers and the pve2/guest legs remain unqualified. The source
receiver's local read/work/decoder ceilings are additional restrictive *receiver*
limits, not source-observer changes or approval to allocate host export capacity.

Uploaded originals remain copied bytes. They cannot restore the original
supervisor, process graph, native handles, callbacks, permit, bootstrap receipt or
connected designation after a restart. Existing first-statement launch refusals
remain intact. The next substantial host/export operation stops for the explicit
inventory/budget/privacy/transport decision above; the receiver can be tested and
used locally for byte checks without inventing that policy.


## Final source checks and independent review

The [checks record](complete-originals-receiver-checks.json) pins the source, test
and explicit selector bytes. Final normal selection passed **62 tests** (26 receiver,
29 prior report-custody and seven qualification boundaries), in 0.382 seconds.
Optimized receiver selection passed **26 tests**, in 0.129 seconds. The explicit
non-live selection passed **582 top-level plus seven historical child tests**, in
26.920 seconds (child 6.742 seconds). Before refreshing the mandatory historical
fixture, 67 harness/reference files were checked disjoint from 199 protected Git
inputs. No full discovery or real-tracer cases ran.

Independent **gpt-6.1-sol, xhigh** review covered the complete source/test/selector
and inventory delta. It found a pre-open native-type gap: nonblocking/no-follow
read-open was insufficient to exclude device-open effects. The fix validates an
owned `O_PATH` pin before read-opening only that regular inode through trusted
local procfs; uncertain pin close blocks further reads. Native FIFO/symlink and
fault-injected device-metadata regressions exercise refusal without opening a real
device. The original process/thread, first-error and close-once tests remain.

The final independent normal and optimized runs each passed **26 tests**, in
0.149 and 0.134 seconds. The reviewer independently confirmed the source inventory
findings and the 305/933-byte public projection maxima. No remaining actionable
finding exists in declared-upload byte verification. Python compilation and diff
checks pass. Source completeness, original lineage, custody isolation, host export
and the actual private/full-size delivery path remain unqualified; ordinary CI
is separate evidence and does not supply those missing proofs.
