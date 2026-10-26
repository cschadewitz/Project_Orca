# Exact retained attempt inspection — incomplete qualification

This is a sanitized, read-only evidence attestation for the **existing** attempt
`/tmp/orca-controlled-replay-2g8h3hs1`. No bootstrap, build, tracer capability
probe, connected command or new verifier was run for this inspection. Existing
decoder, clock, retained-provenance, event/interval, notification and AEAD/schema
functions were reused locally. Raw/private files and the local inspection script
remain unpublished. This note changes no code, bounds or phase gate.

## Implementation and image correspondence

The reviewed preparation is `2448f9aeae83a05f0c1812cc720a08004a9f6502`.
Its observer files equal merge `d53288a6ca19c3d928fcaeea7f6ee15bf5d408b4`
byte-for-byte; only the preparation evidence document differs. That merge's
tested tree is `d65be8effc03ce0fc658bc86cce5fd51fe3a5964`. The original execution
record identifies the pre-author-correction merge `82196c8142829eb055596cbe4ec85e67b05e86b0`,
which has exactly that same tree. The retained attempt packet itself does **not**
contain an observer-source/self-image hash: the run-to-observer-tree association
uses the prior execution record and reviewed source, not a self-contained
measurement within `supervisor-originals.json`.

Current inspected Git blob identities at the reviewed preparation:

| Observer file under `tools/owned-read-proof/` | Git blob SHA-1 |
| --- | --- |
| `controlled_supervisor.py` | `c91c18e3334d0688be9fd01c938fe01a2f4441c9` |
| `controlled_replay.py` | `31e8f3828ee8775d220a63246c8b9fe5e5f203e9` |
| `controlled_notifications.py` | `1f711c9a74518736e0994107c8045605054689d0` |
| `controlled_semantics.py` | `461cdcbf76dae8a0073158975aa75535bb069943` |
| `controlled_timestamps.py` | `9347cb6c04dcd70f3f3f1baa51643cfcf7585838` |
| `kernel_runtime_queries.py` | `15f7e87cd15c98bdbcbbf52a88b7f8d66c0e222b` |
| candidate `verify.py` | `d70d17bd5ac5716c0deeb166991c01b8e2cd33eb` |

The source-owned producer pin is
`557f62fbe86fc8371d48f11ec37bf9db71cac436`. All **194 repository inputs** in
the retained build manifest were read from that exact Git commit and their
SHA-256 values matched. All **20 immutable entries** in retained originals were
decoded and independently rehashed. Retained image bytes equal both their
original immutable entries and the actual retained image files. Build metadata
equals `original.controlledBuild`; producer/child/build hashes equal the report.
Dependency inputs remain manifest-pinned build inputs, not independently
designated trusted source.

## Packet hashes actually inspected

These SHA-256 values were computed over the complete files, before and after
inspection; size and digest stayed identical during inspection. The report also
equals the separately retained captured-stdout report. The trace digest/size
match the previously published checkpoint exactly. No previously published
digest exists for the originals/report files themselves: their hashes below
establish this inspection checkpoint, not independent proof of all prior custody.

| Retained file relative to attempt root | Bytes | SHA-256 |
| --- | ---: | --- |
| `bootstrap/trace` | 112905714 | `6439f3cfa76fdf4b653747569e61cb24cac3729ff0109a9e4a686f4377a83e56` |
| `supervisor-originals.json` | 268617485 | `a7e8fbcd2f12b07855a66714c573b65c450bdf0cd306cce1d17e2e570fcdda50` |
| `attempt.json` | 3686 | `77eee8596678a6935a207782f3e77134739067d633640b7b0459400c3f396b06` |
| `clock-probe.trace` | 2832 | `f9eb79867b2c81c37b693e833e4c9c9086d4def52617c5f2f3d72fe8f5a3cee2` |
| `image/controlled-build.json` | 47722 | `d1fcc114c726ef11d77c31d9a862e7b407d03bf82b5c195a2270add15b0d0ad0` |
| `image/controlled-producer.mjs` | 2171433 | `c81477f96d56bdc89e56d96aaf35fa8c62c418080406c07c63db9f75b56585fd` |
| `image/controlled-child.mjs` | 5254 | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |

## Complete trace, clock and phase inspection

The complete raw trace, including its final newline, was read and decoded with
the published timestamp adapter and candidate interval decoder: **162606 raw
lines**, **155471 decoded records**, first record `execve`, last `settled`.
Every record was passed through the existing replay event and interval methods;
all syscall counts match the retained successful report. No prefix-only sample,
selected schedule or incomplete tail was used. All **12 known threads settle**;
there is exactly one original service read, offset 2, length 4, bytes `73706f73`,
with matching reported resource identity and detached/closed resource handles.

The existing retained-provenance constructor accepted the original process,
namespace, mount and four-query observations, including `verifiedBeforeRelease`.
It checks original leader/TGID/starttime/tracer/group correspondence and exact
held procfs/cgroup2 bindings. This inspection validates the retained observations;
it does not claim to reopen a dead process or replace them with current mounts.
Canonical compact-JSON SHA-256 of the retained provenance object is
`4bc8ef3e16a2317900bad9c179551ff65213ccf6afd9c77b5212fa3fd03c8afe`;
its exact mountinfo string hashes to
`4e35a624f0a7e066dfe3e25c6d188426ae33f8ee85871fbe10dcf311d05ed72f`.
The cgroup mount root remains opaque kernel metadata.

The original clock capability probe was also decoded completely, matched to its
retained digest and first/last prefixes, and bracketed by its retained independent
samples. Existing clock validation accepted the complete common-offset
realtime/monotonic sample set and exact nine-digit UNIX prefixes for this trace.
The retained tracer is strace 6.13, SHA-256
`69f88291a4e47f258b8e32b089c919a247509f063ef3d6afe5389939051102b3`,
help-output SHA-256
`683a562c1d4a0e0abd681a1b678d14b685bc4b89428d0fbb1425c36d3d5b2a90`,
with `--absolute-timestamps=format:unix,precision:ns`. No current probe/tracer
observation substitutes for these retained observations. Prefixes remain entry
samples, not absolute completion times.

The report's original phase log exactly equals the retained bootstrap phase's
sent/received sequence, including its private token (not reproduced here).
Existing event replay validates the actual command/ack bytes. Retained independent
wall-clock samples, all integer UNIX nanoseconds:

| Sample | Value |
| --- | ---: |
| Start S | 1793046926095108031 |
| Before command write | 1793046927066288180 |
| After command write | 1793046927066311932 |
| After acknowledgement read | 1793046939583807357 |
| Finish F | 1793046939890146618 |
| Validated resource create-entry C | 1793046928459455051 |
| Authenticated expiry E | 1793046983457000000 |

The existing expiry function rechecked exact source/image binding and
`S <= C <= F < E <= C+55000000000`. Reported monotonic process elapsed is
**13795040008 ns**, within the unchanged 60-second limit; trace size is within
256 MiB. C is a conservative post-owner entry anchor, not observed issuance.

## Counter, authenticated bytes and publication positions

The existing complete-history notification proof was recomputed from all original
events and equals the report exactly: **901 unit writes**, **893 leader drains**,
**final counter zero**, **one overlap**. Factory entry is 427 and qualifying epoll
ADD entry 3955 (zero-based raw positions). This finite single-reader/unit-write
counter witness has `authority: none`; it supplies no unrelated effect ordering
or callback/work identity.

All four ciphertexts reconstructed from the trace were independently AEAD
decrypted using their original traced key and filename/AAD binding. Their bytes
equal the retained private payload files, their outer/inner kinds correspond,
and the capture action passes the published finite action/coverage schema.
The inspected report records four completed authenticated semantic correlations,
including separate enrollment authority and resource projection. Full semantic
authentication was **not rerun with invented physical fields**.

Existing publication-sequence inspection returns these raw completion positions:

| Semantic object | Creation entry | Publication | Directory sync | Temp cleanup / sequence completion |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 23596 | 23648 | 23673 | 23701 |
| Capture | 37413 | 37466 | 37493 | 37520 |
| Authorization | 124614 | 124663 | 124689 | 124715 |
| Producer observation | 158786 | 158838 | 158864 | 158890 |

These validate the write/data-sync/writer-close/publication/directory-sync/cleanup
sequence in existing code. They are positions, never measured absolute completion
timestamps. Sequence completion alone is not full physical publication proof.

## Same-invocation physical checks and exact evidence limits

The report has **no refusal**, producer exit **0**, kernel and semantic results,
and status `unavailable-effect-audit-and-source-review-pending`. Inspected
`controlled_supervisor.py:277–310` checks original clock/tracer state, phases,
held mount/descriptor provenance, image inventory and flock, then obtains kernel
and semantic results in that **same supervisor invocation**. In
`controlled_replay.py:505–556`, every final named-object comparison and required
readonly-open/fstat/bounded-content/name binding precedes returning the kernel
result; physical durability fields precede semantic authentication. The retained
successful report therefore attests that this inspected implementation completed
those checks, under trust in the supervisor and its recorded implementation
association. It is not merely the producer's report.

However, the packet does **not separately retain** the final supervisor
open/fstat/named-observation tuples for each published object, or an observer
source hash captured at invocation. In particular, only the baseline physical
binding is available from the child trace alone; capture, authorization and
observation obtain their final physical bindings in the supervisor. Consequently
this inspection cannot independently reconstruct those original final bindings
from raw trace/originals alone. The exact missing evidence for that stronger
self-contained claim is the same-invocation final per-object observation record
and invocation-bound observer implementation measurement. No current `/dev`,
inode or mount observation was used to fill those gaps. The earlier historical
replay refusal remains unchanged.

This note distinguishes newly inspected bytes, reproduced counter/clock/schema
checks and source-control comparisons from conclusions carried by the original
trusted-supervisor report. Report/originals custody and run-to-observer association
retain the explicit limits above. The existing exit rule is still **2** for this
incomplete evidence; the prior execution result recorded that exit. No independent
exit-status receipt is embedded inside `attempt.json` itself.

Trusted reviewed source/supervisor/native runtime and kernel, stable mounts,
clocks/hostname and the cooperative same-UID single owned process group remain
assumptions. Random UUID issuance, unprojected owner memory and permit/callback/
dispatch identity are not independently measured. This is no hostile same-UID or
root containment claim, global policy theorem or connected-lane qualification.
No accepting exit/token exists; connected execution remains unsupported. #748,
main, producer/runtime, candidate verifier, security settings and user workspaces
remain unchanged. Aggregate gate decisions remain with the parent.
