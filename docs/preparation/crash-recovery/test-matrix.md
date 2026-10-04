# Crash-recovery diagnostics: synthetic and native test matrix

This is test preparation for #469 under #416. It follows the lead-owned
`integration-contract.md` seam: main owns the grant generation, storage receives an
opaque bounded checkpoint, preview freezes canonical UTF-8 bytes, and diagnostic
failures cannot affect execution. It sets no consent, retention, flush, key or size
policy. Only a configurable five-minute lookback default is approved. The tests
below become implementation acceptance tests after Casey and Cal record the pending
decisions and the lead freezes the executable interface.

The helper code in `packages/app/test/recovery-preparation/` currently tests only
its disposable child-process crash orchestration and synthetic byte fixtures. It
does **not** exercise a diagnostics implementation or establish the observations
in this matrix. Do not count these helper tests as recovery coverage.

## Automated contract cases to add after the interface is frozen

Each case uses a fresh synthetic profile, a deterministic clock where possible,
closed enum observations, and a fake diagnostics-only key provider. No actual
prompt, log, credential, execution store or network endpoint is fixture input.
The outcome is a safe state or bounded omission code, never raw exception text.

| ID | Trigger / injected fault | Required observation | Pending choice |
| --- | --- | --- | --- |
| C01 | Start without an explicit capture grant, then deliver safe observations | No ring entry, checkpoint, key or preview; ordinary execution continues | None |
| C02 | Deny grant or fail the secure-storage preflight | No disk capture or plaintext fallback; UI gives a safe explanation | Consent and key availability policy |
| C03 | Queue a checkpoint for grant generation A, opt out, then release the delayed encrypt/write | A cannot publish after invalidation; only diagnostics-owned artifacts are deleted; no later read restores A | Opt-out/delete commit semantics |
| C04 | Repeat C03 across a new grant generation B | A cannot contaminate B; stale A preview/save handles fail; B remains independent | Grant/restart lifetime |
| C05 | Expire a grant, move wall clock backward/forward, suspend and resume | Capture and recovery fail closed under uncertain age; expired files are removed according to the approved rule | Expiry and clock rule |
| C06 | Kill main at each actual checkpoint boundary: before enqueue, during serialization, after sealing, during temporary write, before/after publication, and during cleanup | Restart reads at most a complete authenticated candidate; partial/old candidate behavior and tail loss match the recorded contract | Publication method, flush cadence, retained sessions |
| C07 | Graceful exit and restart on the same disposable profile | Retained candidate, deletion and re-consent behavior match the recorded contract; capture never restarts itself | Normal-exit and restart policy |
| C08 | Empty, truncated, bit-flipped, unknown-format, duplicate, oversized and noncanonical records | No content preview or crash; safe reject/omission state; bounded read/work and no raw bytes in UI or logs | Format and size limits |
| C09 | Missing, unavailable, wrong or rotated diagnostics key | No plaintext recovery or execution-key fallback; safe state and approved deletion behavior | Key lifecycle |
| C10 | Full disk, denied write, fsync/rename error, failed cleanup, slow encryption and lock contention | Diagnostics drops/omits within accepted resource bound; run control and durable execution state are unchanged | Resource/timeout policy |
| C11 | Saturate count/byte/time caps independently; pause checkpoint scheduling | Report requested versus actual coverage, capacity omissions and the uncheckpointed tail separately; never claim complete five-minute history from configuration alone | Limits and truthful lost-tail wording |
| C12 | Freeze one canonical UTF-8 preview, then mutate live observations | Display, byte count and local save come from that same immutable buffer; saved bytes match byte-for-byte | Preview expiry and save authority |
| C13 | Cancel picker, back out, retry, double-click save, opt out during save, then race recovery/delete/save | No unwanted publication; stale handle rejected; each permitted save has one observable commit point | Save/opt-out race semantics |
| C14 | Feed nested objects, arbitrary strings, paths, IDs, encoded/fragmented canaries, logger/RPC/audit/output objects to the safe ingress | Closed `(phase, code)` gate rejects content-bearing input without traversal/coercion; on-disk and exported bytes contain no synthetic canary | Producer allowlist and schema revision |
| C15 | Execute a run while all diagnostic operations fail | No execution lock, state change, retry, gate answer, credential access or wait on diagnostics; no unhandled diagnostic rejection | Accepted latency/heap budget |
| C16 | Observe process/network activity through capture, recovery, preview, save, cancel and delete | No diagnostic upload or new endpoint; export remains local and explicit | None |

For C06, `killAtBoundary` accepts only an IPC boundary name and kills a Node child
whose profile is disposable. The integrated child must signal *after* reaching
each real operation boundary; a synthetic marker file alone proves only that the
harness can kill a process. The parent must compare a surviving checkpoint with
the exact committed predecessor and record the latest event it could recover.
A process kill is evidence about main-process crash behavior, not OS or power-loss
durability. Delayed I/O and scheduler stalls mean a nominal flush interval by
itself cannot establish a maximum lost tail.

For C08, create malformed copies from a genuine valid encrypted record generated
inside the test. `truncatedCopies` covers empty/short/mid/near-complete records;
`flippedCopy` targets codec-selected authenticated header and ciphertext offsets.
Unknown version, duplicate and noncanonical examples must be made with knowledge
of the final format. Never treat a parser exception as a passing safe-state test.

For C12, compare the exact frozen byte array with the saved file, including
ordering, whitespace, Unicode and omission fields. Parsing two JSON documents
and comparing objects would miss byte drift. For C14, use
`filesContainingSyntheticBytes` only on the disposable profile and fail the test
if it cannot inspect every file within its explicit scan guard. A clean source
search is supporting evidence, not proof that no network call happened.

## Evidence to collect separately

| Environment | Required pass | Current status |
| --- | --- | --- |
| Focused Vitest, `--maxWorkers=1` | C01–C15 against the final integrated head; record exact SHA, command, case count and limits | Not run: implementation absent |
| Paired execution workload | Peak serialized bytes, heap including preview copies, encryption and I/O latency, event-loop delay, omission counts and actual retained coverage | Not run; #455 measures an earlier synthetic volatile ring on Linux/tmpfs |
| Network observation | Instrument or externally observe the built process across C16 actions, including denied/cancel paths | Not run |
| Packaged macOS | Signed identity, native Keychain behavior, owner-only file access, path/link safety, process-crash restart, accessible preview/save and no network | Not run |
| Packaged Windows | DPAPI/secure-storage behavior, DACL ownership, junction/reparse safety, path handling, process-crash restart, accessible preview/save and no network | Not run |
| Physical Apple Silicon Mac | Exact model, OS and candidate SHA; startup-before-handshake, offline, disconnect, sleep/wake, restart and human review of consent/preview/support text | Not run; #390 acceptance owner |
| Power loss | If any OS/power-loss survival claim is proposed, test actual native storage barriers and recovery after forced power loss | No claim approved; not run |

The old #416 D1–D8 proposals, #441 disabled volatile ring and #455 Linux benchmark
remain separate ownership. This matrix neither imports their work nor changes
their status. #416 stays open through the fresh reviewer and native acceptance pass.
