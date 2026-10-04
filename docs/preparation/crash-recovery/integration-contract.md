# Crash-recovery diagnostics: shared interface draft

This is the #469 lead's policy-neutral integration seam, based on main
`94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`. It does not authorize capture,
disk retention, recovery, or use on tester data. The only approved product setting is
a configurable pre-trigger window with a five-minute default. The owner decision
packet is recorded on #469; Casey and Cal must record the unresolved product and
security decisions before any implementation crosses the gates below.

## Ownership and source boundaries

| Owner | Boundary | Existing work |
| --- | --- | --- |
| #469 lead | Shared contract, schema reconciliation, main/preload/bridge methods, grant authority and integration commits | This document |
| Storage track | Encrypted checkpoint adapter research and fault model; no policy-dependent storage yet | Separate #469 worktree |
| UI track | Consent, recovered candidate, exact preview and local-save state model; no activation yet | Separate #469 worktree |
| Test track | Disposable synthetic fixtures and crash/fault matrix; bounded workers | Separate #469 worktree |
| #436 / draft #438 | D1–D8 preparation and source inventory | `5201922e795e6e614f427d35ffba1ee8bee82337`; documentation only |
| Draft #441 | Disabled volatile ring, closed enum input and canonical snapshot | `97097ea076044555b401d49b8e75da8cc1e42df9`; do not recreate or silently import |
| Draft #455 | Synthetic Linux workload harness and measurements stacked on #441 | `38a50e0c0ca4465afc4ec7f6ecaef496739756b3`; no native durability claim |

Main's contract in `docs/preparation/manual-diagnostics-contract/` is a proposal, not
an accepted runtime schema. The #441 branch changes that proposal and adds
`PretriggerBuffer` with `start`, `stop`, `record(phase, code)` and `snapshot` methods.
Its `start()` is explicitly **not** consent. The lead must recheck moving heads and
obtain agreement before integrating those files; #455 remains a benchmark branch.

## Proposed boundaries, with policy values deliberately absent

The interfaces below name operations and the owner of each authority. They are not
executable code or an approval of current D1–D8 defaults.

1. **Safe observation ingress (main).** A producer maps an already-authorized typed
   outcome to a closed `(phase, code)` pair. It passes no source object, string
   message, path, identifier, logger line, RPC payload or private-store record. The
   main-owned consent gate checks the active grant *before* calling #441's ring.
   Missing observations remain `unknown`; no diagnostics read retries execution.
2. **Capture authority (main).** One explicit user action creates a grant with an
   unguessable identity and a monotonically changing generation. The grant gate owns
   start, stop, expiry and invalidation. A `record`, snapshot or queued checkpoint
   carries that generation; after opt-out, restart, expiry or a failed preflight, the
   prior generation cannot publish data. The grant's restart lifetime, timeouts and
   limits are pending decisions, so no production constructor exists yet.
3. **Checkpoint adapter (main, platform).** A diagnostics-only port accepts bounded,
   already minimized canonical bytes and the current generation, returns a safe
   result code, reads at most a bounded candidate, and deletes only its own files and
   key material. It never opens execution stores/keys. The adapter must reject
   unknown format, partial publication, tampering, unsafe paths and unavailable
   protection without plaintext fallback. Publication must recheck generation after
   asynchronous work; a serialized writer or equivalent fence must keep opt-out from
   being undone by a late write. Encryption and publication details await review.
4. **Recovery intake (main).** On a later launch, main may discover a candidate but
   does not resume collection, open a daemon, or export it automatically. Validity,
   age, source session, key availability and deletion results become safe UI states.
   Content and ciphertext never go to renderer until the approved explicit preview
   path validates, freezes and authorizes a bounded report. Which states may be shown
   before renewed consent is pending.
5. **Frozen preview (main to renderer).** Preparation creates one immutable canonical
   UTF-8 byte buffer. A bridge response can carry its exact text, byte length and an
   opaque preview handle; the handle is scoped to one renderer/grant generation and
   expires or revokes. The human summary is derived from these bytes. The renderer
   does not receive a producer, store path, key, ciphertext or network operation.
6. **Local save (main).** The UI asks the native destination picker, displays the
   selected destination and sharing warning, then separately requests save by preview
   handle. Main checks current authority and destination, writes the *same frozen
   bytes*, and reports either the precise publication outcome or a safe failure.
   Cancel/back/retry never recollects or silently publishes. An opt-out versus save
   race has one observable commit point; its exact revocation semantics require the
   owner decision.
7. **Failure channel (main).** Every diagnostic operation resolves to a bounded safe
   result/omission state. It cannot throw into run control, hold an execution lock,
   retry admission/resume, alter execution state or widen a daemon capability.
   Diagnostic keys and failures stay separate from execution keys and failures.

The bridge is the sole renderer authority. Existing `OrcaBridge` in
`packages/app/src/bridge.ts`, `src/preload/index.cts` and `src/main/index.ts` are
lead-owned integration points. The app's daemon protocol remains untouched unless an
independently reviewed safe projection is necessary. There is no diagnostic upload,
remote request, raw log, crash dump, credential change or live activation in #469.

## Decisions that block implementation

| Gate | Required record before crossing it |
| --- | --- |
| Durable capture | Crash scope; prior-session count; post-crash/normal-exit/expiry behavior; consent and restart re-consent; closed producer allowlist |
| Checkpoint implementation | Flush cadence and truthful lost-tail language; byte/event/time/heap/I/O limits; diagnostics-only key lifecycle, secure storage and native ACL policy |
| Recovery preview and save | Recovery visibility, opt-out/delete and stale-preview behavior; exact schema/scan revision; save/cancel commit semantics, destination/support wording |
| Activation | Focused security/privacy review, runtime and native evidence, explicit tester consent; acceptance remains with #416/#390 |

A configured five-minute lookback describes the requested horizon, not retained
coverage. #455's 4,096-event burst retained 238.95 seconds, and a checkpoint may omit
events since its last successful publication. The UI and report need separate capacity,
expiry and lost-tail disclosures once the policy and format are agreed. A checkpoint
interval alone does not prove a maximum crash tail under scheduler or I/O delay.

## Evidence plan

Synthetic tests should cover default-off, denied consent, zero pre-consent bytes,
generation fencing across opt-out and in-flight writes, expiry/clock uncertainty,
malformed/truncated/tampered/unknown input, missing keys, full disk, cleanup errors,
and exact preview-to-save byte equality. Controlled disposable-profile termination
must distinguish graceful restart from main-process crash; OS/power-loss survival needs
separate native proof. Pair resource measurement with ordinary execution and observe
network traffic, rather than inferring isolation from source review. Packaged Mac and
Windows key, identity, ownership/DACL, path safety and accessibility evidence, plus a
physical Mac acceptance pass, remain for the second lead and #390.
