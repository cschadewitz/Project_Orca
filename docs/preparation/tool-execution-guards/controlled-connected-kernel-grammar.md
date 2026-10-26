# Connected designation and kernel/journal grammar — incomplete

Refs #699 / #706. This bounded preparation starts from
`03bd68fb6558ad78496c4cec76fe41783101dee9`, on
`cal/706-connected-observer-grammar`. The source-owned producer remains exactly
`557f62fbe86fc8371d48f11ec37bf9db71cac436`.

The [bootstrap gate decision](controlled-bootstrap-gate-decision.md) and its
[exact-attempt attestation](controlled-exact-attempt-attestation.md) apply only to
retained attempt `2g8h3hs1` under their cooperative trusted-supervisor assumptions.
Its reviewed observer preparation is `2448f9aeae83a05f0c1812cc720a08004a9f6502`,
implementation tree `d65be8effc03ce0fc658bc86cce5fd51fe3a5964`, and complete trace
digest `6439f3cfa76fdf4b653747569e61cb24cac3729ff0109a9e4a686f4377a83e56`.
This change does not reinterpret that decision, replay those originals, or grant
authority through a document/hash/child flag. Bootstrap runtime still exits 2.

## Source-grounded scope and implementation

The source contract is
[controlled-owned-read-producer-contract.md](controlled-owned-read-producer-contract.md).
The plan is to retain an explicit parent designation of the original closed
bootstrap and unchanged three-file image, then extend only the kernel phase and
actual journal grammar. The finite emitters are:

* `controlled-child.mjs`: exact `save`, `human-read`, `rule-read` command/ack pipes.
* `controlled-owned-read-producer.ts`: original human invocation, separate Save,
  original delivery with final ownership acknowledgement, then a fresh rule turn.
* `human-input.ts` and `live-input.ts`: requested, waiting and original once answer.
* `protected-scoped-permission-owner.ts:recordApproval`: distinct Save marker.
* `protected-event-store.ts`: encrypted payload before the public event projection.
* `event-store.ts`, `jsonl-log.ts`, `file-lock.ts`, and `core/util/jsonl.ts`: gap-free
  per-run numbering and ordinary append under one exclusive lock acquisition.

`ConnectedDesignation` is an explicit trusted-supervisor object held in memory,
with no JSON/report/CLI reconstruction. Its original closure assertion must be a
callable that raises on failure; a success boolean refuses. The assertion includes
the parent's exact bootstrap review decision and permanent service closure. That
fact is trusted original-supervisor source authority, not measured by a new file
hash. Designation independently retains and rechecks full physical stamps and
complete bytes of the original three image files and the designated evidence
file. It calls the existing `assert_image_sources` checker against the exact
producer pin; matching a manifest's sourceHead string alone is insufficient.
Dependency inputs retain their existing pinned-build-input trust status.

`prepare_connected` only prepares new association bytes. It requires a separate
fresh run base, distinct original lifetime file, actual supervisor flock and
independent lock exclusion, distinct control FIFOs and exactly three fresh-format
phase tokens. It binds the original evidence file into `originalFiles` and binds
the exact installed inventory/profile. It sends no pipe command and starts no
child. There is no connected command-line entrypoint or launcher. A future launcher
must retain the existing process/namespace/mount/clock observations, reserve
tokens against the supervisor's complete replay history before sending, and
perform the original same-invocation physical checks. Preparation does not do
those future launch duties by proxy.

The separate offline `ConnectedKernelReplay` requires that explicit designation.
The default `Replay` still refuses connected originals and still requires exactly
one bootstrap resource pread. Small method extractions retain bootstrap behavior;
the connected class supplies six boundaries and distinct per-phase obligations.
Every event still reaches the original interval and syscall replay, including
startup and outside-window effects. The connected addition retains named-resource
open exclusion, open intervals, physical alias checks, close/reuse checks,
notification proof, native query and clock provenance and final file comparisons.
The only new path family is the exact `runs/controlled.jsonl` and its own lock.
There is no private-root or `runs/*` exemption.

| Phase | Journal append grammar | Actual service preads |
| --- | --- | --- |
| Save | seq 0 `human.requested`, seq 1 `step.waiting`, seq 2 `agent.permission` Save marker | 0 |
| Original human read | seq 3 `human.answered`, original request/once/operator projection | 1 |
| Fresh rule read | no new journal append or answer | 1 further |

Each journal append requires the exact source append flags/mode, a unique settled
exclusive owner-token lineage for the original leader/host/run clock range,
one complete bounded JSONL write and writer close. Another append cannot reuse
that lock acquisition. Token unlink/empty-directory removal use the existing
namespace replay. A token need not have a separately observed physical inode:
its exclusive create/write/close/path lineage is tracked; no physical tuple is
invented for deleted tokens. Journal reads/stats/syncs use base replay byte and
descriptor lineage. The source's small normal records are one write each in this
finite grammar; split/torn/multiple-line writes refuse rather than being repaired.

Closed public shapes check event IDs, unique UUID payload references, integer
gap-free sequence, run/step/session, exact original live target/options, distinct
Save projection and original once/operator projection. Duplicate keys, nonfinite
JSON, scalar-type aliases, unknown fields and reused identities refuse. A phase
ack cannot leave a journal lock or journal handle open. Reads require the original
answer append to have closed and cannot duplicate, move into Save, or swap human
and rule windows. No new mapping/vector-write/truncate permission is admitted.

## Evidence status and remaining obligations

This is kernel/journal grammar preparation, **not connected acceptance**. Its
output says `authority: none`, record `controlled-connected-kernel-grammar-only`,
and qualification `unavailable-connected-semantics-and-effect-audit-pending`.
The executable supervisor remains bootstrap-only. No accepting token/exit or
connected command release is added. No new bootstrap, connected process, tracer
probe, live provider, Mac acceptance or deployment was run for this slice.

The public journal is not authenticated execution authority. A closed ordinary
append is not an independently proved durable final lease acknowledgement. In
particular this kernel layer deliberately cannot prove the original callback,
in-memory permit identity or successful settled final ownership acknowledgement.
A test shows that an answer journal alone supplies no `acceptedAnswerRef` or live
delivery verdict. Those obligations remain mandatory for the next semantic slice:

* Reconstruct the actual empty initial sidecar, original protected authority facts
  before capture, genuine require-human and all current actor/lease/epoch bounds.
* Authenticate every connected immutable record and public/private reference,
  distinct persistence-review authority, bridge review, protected Save approval,
  exact typed sidecar rule/revision and one-time facade refresh. Save must have no
  resource pread, answer or execution authorization.
* Correlate the new review and separate Allow once with the original callback and
  settled final ownership acknowledgement before canonical human authorization
  and the original service read. The diagnostic final-ack payload is correlation
  only, not live authority. Deferred/lost ack and cancellation need adversarial
  semantic/effect controls; durable history cannot recreate live delivery.
* Validate fresh rule invocation/turn/capture after current protected facts, exact
  saved rule/revision, separate automatic capture with no live query/options or
  delivery, canonical rule verdict/permit/read and duplicate-dispatch receipt
  reuse. The kernel read window does not establish those semantic facts.
* Integrate all additional immutable/sidecar histories, causal durability and
  physical observations, then collect a fresh complete connected trace with the
  same original image under the existing 256 MiB, 60-second process and 55-second
  owner bounds. Unknown/missing effects must refuse at their exact first cause.

Trusted reviewed supervisor/source/native runtime/kernel, stable mounts, clocks
and hostname, and cooperative same-UID single owned process group remain explicit
assumptions. Random UUID issuance and unprojected owner/callback/permit/dispatch
memory identity are not independently measured. This is not a universal ACP
system, hostile same-UID/root containment, provider qualification, mandatory-judge
theorem, or production acceptance. Other providers and shared lockfiles are
unchanged. Parent owns independent review, integration and any later gate decision.

## Local validation

The new controls use explicitly synthetic fixtures. They call the real grammar
and base event/interval paths, but do not represent a full connected trace or
claim physical/source acceptance from their mocked image checker.

The final complete Python suite passes **197 tests** (4.800 s), including **31
connected controls**. Those 31 controls also pass under `python3 -O` (0.068 s).
`git diff --check` passes. The TypeScript producer and its dependencies are
unchanged; no new producer build or TypeScript acceptance is claimed. Markdown
uses the repository's hand-wrapped prose convention (`.prettierignore`).

```
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_connected.py' -v
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_connected.py'
git diff --check
```

The dedicated controls cover substitution of original bytes/inodes/source/profile,
bootstrap lifetime/base reuse, missing closure/source assertions, copied child
flags/digests, token/phase replay, Save/wrong/duplicate read windows, duplicate or
malformed journal projections, wrong original request/actor/option, reused or
unsettled locks, cross-phase writers, readonly reopen/close, mapping/vector-write
refusal and shared-descriptor overlap. Runtime bootstrap guards remain covered by
the existing full observer suite. Raw traces, protected bytes and secrets remain
local and are not publication artifacts.

## Independent-review correction: token close completion

Parent-coordinated independent source review found a journal causality defect in
initial head `2e54dc021657955c9c47edf3db0829f47c2d0321`. Base replay visits paired
syscalls at their raw entry index, sets `writer_closed` there and separately
retains `writer_close_completion`. A token close spanning raw indices 5–20 could
therefore satisfy that flag before another thread's journal open at index 10.
The token and journal have different interval entities, so the general overlap
check alone cannot establish their publication ordering.

`lock_owner(before_entry)` now requires integer raw indices satisfying
`0 <= writer_close_entry <= writer_close_completion < before_entry` for journal
open/write/close. It does not synthesize completion timestamps. The adversarial
cross-thread close 5–20/open 10 regression failed before this correction with
`RuntimeError not raised`; settled close 5–9/open 10 remains valid. Missing,
boolean, same-boundary and later completion indices also refuse. These controls
use the actual base close/event and interval methods. This is an incomplete
grammar correction, not an exploit against an existing accepting path; no
connected launcher/release, semantic authority or gate is introduced.
