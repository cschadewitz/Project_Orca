> Decision 9 (4 October 2026) and the current implementation instruction supersede any pending-owner-review wording below for fixed private plaintext staging, same-filesystem no-replace destinations, content-free key-independent metadata and visible residual plaintext cleanup failures. Acknowledged summaries are removed on opt-out after cleanup completes; unresolved obligations remain until safely resolved. Native/independent acceptance remains separate.

# Crash-recovery diagnostics: synthetic and native test matrix

This is the #469 acceptance plan under #416. The lead-owned
`integration-contract.md` is the authoritative engineering contract; this matrix
must not introduce a different clock, lifetime, resource or race policy.
[Consolidated owner decisions 1–6](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976190374)
approve a persistent explicit opt-in (off by default), a configurable 1–15 minute
lookback with a five-minute default, one previous opted-in session after a
main/full-app crash, up-to-24-hour retention, approximately five-second checkpoint
cadence with one write in flight, a complete uncompressed canonical report of at
most 1 MiB and at most 8,192 events, and an OS-protected diagnostics-only key.
Technical/privacy review, actual user consent, independent review and native
acceptance remain separate gates. [Decision 8](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976828540)
approves explicit acknowledgement and a separate new Save after proven writer cessation
and verified staging cleanup; it does not resolve the earlier unknown result.
A test plan passing review is not an implemented
or activated feature.

The helper code in `packages/app/test/recovery-preparation/` tests only disposable
child-process crash orchestration and synthetic byte fixtures. It does **not**
exercise a diagnostics implementation or establish any observation below. Do not
count these six helper tests as recovery coverage. The product choices supersede
the earlier per-session restart re-consent and proposed 4,096-event ceiling.

The test-only `export-observations.ts` oracle checks independently supplied observations
for unsafe acknowledgement, release, dispatch, callback, prior-file and accounting
behavior. Its mutation tests verify that these assertions detect selected violations;
they do not execute a storage coordinator, native adapter or durable acknowledgement.
Seven explicitly pending adapter cases cover C21–C26. A future adapter must gather
writer/file/record evidence independently of reported UI/controller state and exercise
real boundaries; a hand-written passing trace cannot establish native or runtime safety.

## Frozen engineering parameters to verify

These are the lead-selected contract parameters for technical/privacy review,
not measured results or permission to activate. Keep this table synchronized with
`integration-contract.md`; reopen any material retention/consent/exposure change
with Casey and Cal.

| Boundary | Test oracle |
| --- | --- |
| Retention clock | Same-boot, suspend-inclusive native elapsed clock plus private boot identity. Missing clock, boot change or rollback makes age uncertain and recovery is refused. Immutable checkpoint snapshot anchor expires after 24 hours; recovery/rewrap cannot renew it. |
| Owned disk allowance | 4 MiB aggregate retained workspace, including all ciphertext, keys, control records, old generations and temporary files; at most one additional 1 MiB explicitly authorized export temp. Enforce both individually and combined. |
| Preview | One preview, at most five minutes, clipped to source expiry; expiry invalidates save authority and releases owned copies. |
| Memory | At most 8 MiB explicitly owned payload buffers across operations, plus a measured 32 MiB incremental heapUsed + external acceptance target across processes (arrayBuffers reported as a subset, not added twice; RSS/native costs separate). The latter is not a hard JavaScript heap guarantee. |
| Work | Two-second preparation deadline, ten-second key/file operation deadline, no snapshot queue, no second operation while timed-out work remains alive. Deadline handling must not pretend to interrupt synchronous CPU work or uncancellable OS calls. |
| Keys | Independent per-session diagnostics data key, OS-wrapped through the selected asynchronous safeStorage adapter; verify missing/rotated key behavior and native identity separately. |
| Acknowledgement | No admission until old writers cannot write, staging verified cleared and explicit acknowledgement durably committed; current consent/preview and fresh picker/Save remain necessary. One current record plus one latest unknown summary/olderUnknowns boolean; all metadata copies within existing 8 KiB/64 KiB/16-entry bounds. |
| Save authority | Serialized publication commit dispatch wins over later revocation. Earlier revocation prevents dispatch. Once dispatched, a pending publication cannot be reported as cancelled; report actual completion/failure and cleanup state. |

## Automated contract cases

Each case requires a fresh synthetic profile, a deterministic wall/monotonic clock
and suspend source where applicable, closed enum observations, and a fake
independent key provider. No actual prompt, log, credential, execution store or
network endpoint is fixture input. Outcomes use bounded safe states/omission codes,
never raw exception text. Run the integrated cases only after the corresponding
contract is reviewed and implemented, with `--maxWorkers=1`.

| ID | Trigger / injected fault | Required observation |
| --- | --- | --- |
| C01 | Fresh install, missing setting, first-start prompt dismissed, or explicit refusal; deliver otherwise valid observations | Setting stays off; no ring entry, checkpoint, diagnostics key or content preview; ordinary execution continues. No product decision, fixture startup or prompt display supplies consent. |
| C02 | Remember explicit opt-in and restart; repeat with corrupt/unknown consent version and failed secure-storage/ownership preflight | Same-scope remembered opt-in permits capture after current preflight without routine restart re-consent. Missing or incompatible authority fails closed; no plaintext fallback. Material scope expansion requires a new owner decision and consent. |
| C03 | Delay sealing/write/publication for generation A; opt out, then release each delayed operation | Authority revokes before cleanup; A cannot gain publication admission after revocation or restore logical authority; already-dispatched native work is reconciled under the contract ordering. Only diagnostics-owned artifacts/key material are removed. Cleanup failure remains visible and is not reported as successful deletion. |
| C04 | Repeat C03, then opt in to generation B; replay old handles, renderer messages and callbacks | A cannot contaminate B or delete B's artifacts. Revoked preview/save handles remain invalid after opt-in. Persistent preference and transient generation identity are distinct. |
| C05 | Test just before, at and after expiry; backward/forward clock jumps, nonfinite time, drift, suspend/resume, process restart and reboot | Age and uncertainty follow the lead's clock contract. Reopen, preview, rewrite and restart never refresh retention origin. Refused/expired content cannot become a preview or save; cleanup occurs when ORCA next runs, without promising deletion while closed. |
| C06 | Kill main before enqueue, during serialization/sealing, temporary write, before/after publication and cleanup | Restart admits at most a complete authenticated candidate bound to its session/generation. Record actual recovered tail, not a five-second guarantee; no OS/power-loss claim. |
| C07 | Clean exit; crash twice; start current capture while a previous candidate exists; kill during replacement | Clean exit removes the current checkpoint. One previous-session bound and lead-defined replacement ordering hold without extending the previous candidate's age. Removed/stale candidates cannot reappear; persisted opt-in remains subject to preflight. |
| C08 | Empty, truncated, bit-flipped, unknown-format, duplicate, oversized, noncanonical and deeply nested records; forged session/generation/age headers | Bounded reads/allocation/validation precede content exposure; authenticated binding and schema checks reject invalid candidates with safe results. No parser exception, raw bytes or fallback content reaches UI/logs. |
| C09 | Missing, locked, unavailable, wrong or rotated diagnostic key; crash between wrapped-key and checkpoint publication | Key lifecycle follows the shared contract, including incomplete-generation cleanup. No execution-key lookup, plaintext fallback, silent restoration of unreadable history or deletion of shared app/keychain material. |
| C10 | Full disk, denied access, fsync/rename failure, failed unlink, hung encryption/I/O, lock contention; complete a timed-out operation late | Queue, operation and disk bounds hold; a timeout is not proof work stopped. One physical checkpoint write remains in flight until resolved/fenced; late completion cannot resurrect data or evade accounting. Failure affects diagnostics alone. |
| C11 | Saturate event, complete-report byte and lookback bounds independently and simultaneously; stop checkpoint scheduling | At most 8,192 events and 1,048,576 canonical UTF-8 bytes including envelope, formatting and omission metadata. Oldest eligible events drop first. Compression does not evade the cap; buffer/validator/preview/export use the same report limit. Requested versus actual coverage, capacity omissions and unknown/uncheckpointed tail remain distinct. |
| C12 | Freeze a canonical preview; mutate live observations, request another preview or reconnect/destroy its renderer | Exact display, byte count and authorized save derive from the same immutable bytes. Contract-defined single-preview ownership, expiry and invalidation hold; stale renderer callbacks do not recreate a preview. |
| C13 | Cancel picker, back out, retry, double-click save; interleave expiry, replacement, opt-out, discard and delete with every save boundary | Native dispatch orders publication. Earlier revocation prevents dispatch; later revocation leaves an honestly pending outcome that may succeed after opt-out. A successful user export remains user-owned. Timeout never implies cancellation; no cleanup success while late writes remain possible. No recollection, duplicate operation or hidden publication; failed temp cleanup remains visible. |
| C14 | Pass objects, strings, paths, IDs, encoded/fragmented canaries, logger/RPC/audit/output objects to ingress | Reviewed closed producer mapping rejects content-bearing input without traversal/coercion. Actual checkpoint and export bytes contain no synthetic canary. Source inventory identifies every producer and verifies there is no diagnostic execution retry. |
| C15 | Run paired execution work while every diagnostic operation fails or stalls | No execution lock, state change, retry, gate answer, credential access or wait on diagnostics; no unhandled diagnostic rejection. Measure execution latency and event-loop delay against the contract budget. |
| C16 | Observe built-process network activity through capture, recovery, preview, save, cancel, delete and denied paths | No diagnostic upload or new endpoint. Local save requires explicit reviewed intent; remembered capture opt-in grants no sharing permission. |
| C17 | Fill previous and current records, begin replacement, wrap keys, hold preview and local-export temp, then inject partial-write/cleanup failure | Aggregate disk accounting includes ciphertext, authenticated headers/tags, wrapped keys, manifests and all temporary/old generations. Reserve before write; rejection or failed cleanup cannot create unaccounted allowance. User-owned committed export is distinguished from pending operation-owned files. |
| C18 | Maximum report/events with simultaneous ring, serialization, encryption, decryption, preview, IPC/renderer copies and local save | Account for all retained copies, bounded queue cardinality and operation overlap. Instrument allocation/high-water behavior and measure heap/RSS externally; the 1 MiB serialized limit is never presented as a RAM guarantee. No unlimited preview, promise or timer accumulation. |
| C19 | Cross-app restart/reboot, clock uncertainty while picker is open, restore an old disk/key pair, failed delete followed by relaunch | Durable opt-out/revocation overrides stale checkpoint/manifest copies; coordinated whole-profile rollback is outside the threat model. Apply clock/replay limits honestly; document platform limitations instead of claiming forensic erasure or stronger same-user protection. |
| C20 | Plaintext export staging, target replacement/link race, restricted-access failure, cancellation and crash before/after final publication | Capture/checkpoint files and their temps stay encrypted. Under the approved export-cleanup contract, plaintext occupies one fixed private slot with durable intent and verified identity before plaintext write. Test cleanup with every diagnostics key lost/unavailable/deleted; no external locator or retained cleanup key. Test same-filesystem restriction, intent/identity/publication crash gaps, unsafe/moved paths, failed unlink and new-Save refusal while unresolved. No overwrite/path substitution outside selected authority; cleanup failure does not claim success. |
| C21 | Timeout/native call still pending; request acknowledgement repeatedly; then inject late success/failure and stale completion after a newer operation | Pending or uncertain old writer blocks acknowledgement and new Save, retaining reservations. A real late outcome before acknowledgement is reported honestly; old callbacks cannot mutate new state, release its reservation or change an acknowledged unknown. Test revocation both before and after dispatch. |
| C22 | Writer cessation proven; staging unlink denied, identity substituted, root moved, cleanup record unsafe; repeat with all diagnostics keys lost | Acknowledgement cannot bypass cleanup/identity checks, and missing name alone is insufficient. No external scan/key retention; new Save remains blocked until verified owned staging is safely cleared. |
| C23 | Kill before/after acknowledgement write, flush/replacement, reservation release and next intent; fail acknowledgement persistence | Recover valid predecessor or committed successor only, otherwise block. No implicit acknowledgement, auto-replay, double release or new write from restart. A committed acknowledgement records completed old checks; restart freshly verifies the fixed slot empty and no current/incomplete operation capable of writing, never bypassing unexpected state. |
| C24 | Repeated/stale acknowledgement and Save clicks; old picker token, expired preview, consent revocation between actions | At most one durable acknowledgement and one independently authorized new operation. Current exact preview and fresh picker token are required; acknowledgement grants no consent, extends no TTL and dispatches nothing. Old operation ID never reused. |
| C25 | Earlier unknown Save actually produced a user file; acknowledge after safe cleanup, then select its existing name, race creation at new name, finally choose a nonexistent name | Earlier export bytes remain unchanged throughout; native atomic no-overwrite refuses both collisions. New Save at fresh selected nonexistent name can succeed; its bytes match current preview and earlier result stays unknown. No durable old destination path or automatic retry. |
| C26 | Many unknown → safe cleanup → acknowledge → new Save cycles, crashes during compaction, known later success and opt-out/restart | One current operation plus one latest unknown summary/olderUnknowns boolean only, all replacement copies charged; <=8 KiB cleanup metadata inside 64 KiB/16 entries. No accumulating files/IDs/paths; latest unknown remains explicit, older uncertainty shown without pretending complete history. Unacknowledged obligation never dropped for space. |

## Adversarial schedules and assertions

For C05, use independent control of wall time, elapsed time, suspend notification
and boot identity. Verify lookback eviction separately from retained-candidate
expiry. Advance time while secure storage, picker, decrypt and write are pending,
then release each result; validity at operation start is insufficient. Test the
contract's exact uncertainty checks and expiry boundary, including an old
checkpoint whose latest successful publication greatly predates the crash.

For C06/C07, `killAtBoundary` accepts only an IPC boundary name and kills a Node
child whose profile is disposable. The integrated child must signal *after*
reaching each real operation boundary; a synthetic marker file alone proves only
that the harness can kill a process. Compare the surviving checkpoint with the
exact committed predecessor and record the latest recoverable event. Kill between
removing a superseded candidate and publishing its replacement, and between
committing bytes and recording completion. Never silently substitute a rolled-back
candidate to make recovery look successful. Process kill evidence does not prove
OS/power-loss durability. A nominal five-second target cannot bound lost tail under
scheduler or I/O delay.

For C08, make malformed copies from a genuine valid encrypted record generated by
the eventual implementation. `truncatedCopies` covers empty/short/mid/near-complete
records; `flippedCopy` targets authenticated header and ciphertext offsets. Include
validly authenticated but unsupported schemas and cross-session/generation swaps.
Never treat a parser exception as a passing safe-state test.

For C11/C17/C18, use limit-minus-one, exact-limit and limit-plus-one inputs, then
combinations. Include omission counters increasing their encoded length, Unicode
UTF-8 byte size, envelope overhead, encryption/tag overhead, preview replacement
and failed cleanup retaining an old generation. Measure at the agreed 8,192-event
ceiling: #455's earlier burst offered 5,250 events, retained 4,096, evicted 1,154 and
covered 238.95 seconds; it supplies no measurement of these new limits. Use the
lead contract's aggregate disk/memory/deadline values without inventing independent
test defaults. Record both deterministic allocation bounds and empirical memory
results; garbage collection timing cannot establish a hard whole-process ceiling.

For C12/C13/C20, compare exact frozen bytes with the committed file, including
ordering, whitespace, Unicode and omission fields. Parsed JSON equality misses
byte drift. Use barriers before/after every asynchronous boundary and the final
publication operation, testing both orderings against expiry, opt-out and deletion.
Track private temp ownership separately from native dispatch and physical completion.
Logical revocation is immediate, but cleanup cannot be reported complete while a
previously dispatched write can still appear. Barrier both sides of dispatch, then
time out and complete late with success/failure/unknown; retain reservations and
prevent another Save. A cancellation that loses to dispatch must report the eventual
outcome honestly, without restoring revoked authority. Verify exported user files survive later opt-out/expiry and that an
existing destination is never destroyed on a failed save.

For C21–C26, record native dispatches and file identities independently of controller
status; a synthetic state machine cannot prove its own safety. Include late callbacks
after confirmed cessation separately from an OS writer that is still capable of writing.
Use barriers at acknowledgement commit and fresh-intent replacement. Assert complete
prior-export bytes before/after every action and preserve old unknown alongside a
known new result. Missing/corrupt records, identity failure and uncertain termination
are refusals, never a shortcut to an acknowledgement-ready state.

For C14, scan only disposable profiles with
`filesContainingSyntheticBytes`; fail when its explicit scan guard prevents
complete inspection. Pair this with inspection of decoded canonical content,
because absence of a plaintext canary in ciphertext is not content review. A clean
source search supports but does not establish C16's network observation.

For C20, apply every row of the approved [export-cleanup fault plan](export-cleanup-proposal.md#fault-and-native-evidence-plan).
The fixed-slot design and narrowed destination support are approved in decision 9. Plans below are not acceptance evidence; actual execution is recorded in the implementation handoff.

## Evidence to collect separately

| Environment | Required pass | Current status |
| --- | --- | --- |
| Focused Vitest, `--maxWorkers=1` | C01–C15 and C17–C26 against final integrated head; exact SHA, command, counts and contract constants | Implemented Linux filesystem/controller/UI tests; exact commands and outcomes in [implementation handoff](implementation-handoff.md). Native acceptance remains separate. |
| Paired execution workload | Serialized bytes, aggregate owned disk bytes, copy/queue peaks, heap/RSS, checkpoint latency, event-loop delay, omissions and actual retained coverage | Approved 8,192-event standalone disk/preview probe now executable; final numerical artifact in handoff. Paired execution and combined Electron memory gate remain not run; #455 is historical. |
| Network observation | Instrument or externally observe built process across C16, including denied/cancel paths | Not run |
| Packaged macOS | Signed identity, native Keychain behavior, owner-only file access, path/link safety, crash restart, actual checkpoint latency, accessibility and no network | Not run |
| Packaged Windows | DPAPI/secure-storage behavior, DACL ownership, junction/reparse safety, publication/path behavior, crash restart, actual checkpoint latency, accessibility and no network | Not run |
| Physical Apple Silicon Mac | Exact model, OS and candidate SHA; startup-before-handshake, offline, disconnect, sleep/wake, restart and human review of consent/preview/support text | Not run; #390 acceptance owner |
| Independent technical/privacy review | Coherent frozen contract, exact candidate SHA and producer inventory; verify all scope/retention/exposure deviations return to Casey and Cal | Required before activation; fresh independent final review remains separate |
| Power loss | Native storage barriers and recovery if a stronger survival claim is ever proposed | No guarantee approved; not run |

#438/#441/#455 remain separate ownership. The lead adopted the pinned #441 ring/schema for this candidate;
this changes none of the peers’ acceptance status. Production activation stays off;
recorded product choices are not actual tester consent. #416 stays open through
the fresh independent reviewer and native/physical acceptance pass.
