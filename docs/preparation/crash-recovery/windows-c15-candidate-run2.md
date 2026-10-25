# Windows C15 candidate run 2: verified overlap proof gap

The parent subsequently materialized and verified the unchanged raw artifact for
[run 40199888746](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746).
The only failed required stall gate is
`runs[1].allFaultsEnteredDuringExecution=false`. Memory is not failing. This is an
overlap proof gap, not evidence of a product correctness defect. C15 remains held;
there is no new acceptance claim or Windows dispatch.

## Later supported transfer and receipt diagnosis

After the original blocked-materialization event retained below, the parent used
`github_download_workflow_artifact` and supported Sediment
`download_file(file_id='file_00000000bb2081f5a56145254fdf876c')` to materialize the
ZIP for artifact 12601937371. The parent verified **61,820 bytes** and SHA-256
`ffb14af27e9ebee0bed3aeb39edcb4afc75f3964e3d69e3d0ca78ef34295a911`.
The supported file-ID transfer resolved the earlier proxy/URL failure without a
sandbox, proxy, credential or security-policy change.

The following are exact raw-receipt findings supplied by the parent with the
continuation task. This later execution environment does not expose Sediment
`download_file`. Its Cal GitHub artifact fetch succeeded with a reusable file
reference, but it did not re-hash or independently parse ZIP bytes. This is
explicit parent-verified evidence attribution, not a second local verification.
No expired URL or denied network workaround was attempted.

| Stall On observation | Verified receipt value |
| --- | --- |
| Required failing gate | `runs[1].allFaultsEnteredDuringExecution=false` |
| CLI and diagnostic exit | Both `0` |
| Member completion / diagnostic | `completed=true`, `diagnostic.ok=true` |
| Original cells | All 20 observed; all individual checks true |
| Unhandled rejections | `0` |
| Payload release | `zeroAfterEveryCell=true` |
| Owned exits / disposable cleanup | Both true |
| Managed increment / unchanged limit | `15,787,247 / 33,554,432` bytes |
| Controlled binary peak / unchanged limit | `2,490,368 / 8,388,608` bytes |
| CLI execution elapsed | `29,151.6431` ms |
| Fault campaign elapsed | `49,566.4969` ms |
| Last `nativeWrite` entry | `29,493.7383` ms |
| Last public operation elapsed | `10,014.2102` ms |

Failure On managed increment is **18,001,619 bytes**; its overlap, correctness
and memory gates pass. The stall supervisor stops at overlap before assigning
aggregate `memoryPass`, explaining the missing log-summary property. The raw
child memory values pass both existing budgets. The supplied last-entry value
places that fault after the CLI's reported completion; the cell's later public
settlement is separately bounded and does not establish overlap.

The failed receipts, frozen scripts and run-2 candidate identity remain intact.
A separate focused draft proposes a fixed real-work overlap correction with
short-workload rejection tests, while retaining the original 20 faults and memory
limits. Product source remains `95ee280be309d50f29b46cb66a12d480fdfc8a7d`.
Parent review is still required before any dispatch. This PR remains evidence-only.

## Original pre-transfer record (retained as history)

The following records what was known before the parent completed the supported
file-ID transfer. Its blocked status and uncertainty statements describe that
earlier event; the later verified diagnosis above supersedes them.

### Windows C15 candidate run 2: receipt diagnosis blocked

On 25 October 2026, [run 40199888746](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746)
completed with a failed stall comparison. The failure comparison reports both
correctness and memory passing. The stall failure has **not** been attributed to
memory, harness synchronization or product correctness: the exact raw receipt
could not be materialized for verified inspection. C15 remains held.

This is an evidence update, with no candidate, harness, workflow, budget, baseline,
activation or security-policy change. The original and corrected October 9 failed
receipts remain unchanged. The [candidate preparation record](windows-c15-candidate.md)
describes the pre-dispatch design; this follow-up records the later run.

### Identity and observed job results

The run API reports workflow run number 2, attempt 1, `workflow_dispatch`, on
`main` at harness/workflow commit `2ad2ce53d8425392c2eeedc40158199bd95a160b`.
The separate product checkout is `95ee280be309d50f29b46cb66a12d480fdfc8a7d`,
tree `8bf5c38903ec0bc13c7c8a313068ba378bda3230`. This evidence update started
from freshly fetched main `41e4da4f8847b34f6a062ead842102d39f6f7898` in an
isolated worktree.

[Job 121188627839](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746/job/121188627839)
logs were read through the authorized Cal GitHub connection. They report:

- Source/build/provenance protocol tests: 10 passes.
- Native x64 build and runtime staging reached the native Documents probe;
  the probe reports `accepted: true`.
- Failure Off then On: `correctnessPass: true`, `memoryPass: true`,
  `allOwnedExitsConfirmed: true`, `disposableStateRemoved: true`.
- Stall Off then On: `correctnessPass: false`,
  `failureCode: "Expected values to be strictly equal:\n\nfalse !== true\n"`,
  `allOwnedExitsConfirmed: true`, `disposableStateRemoved: true`.
  The printed stall summary has **no `memoryPass` property**.

These are log-reported outcomes, not independently revalidated raw receipts. The
supervisor assigns `memoryPass` only after both members, receipt validation,
semantic equality and work-item equality succeed. An earlier assertion skips that
assignment; the missing property does not mean a memory failure. The generic
assertion text does not identify a target cell or source line.

### Artifact transfer blocker

The upload log identifies [artifact 12601937371](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746/artifacts/12601937371),
61,820 bytes, with reported ZIP SHA-256
`ffb14af27e9ebee0bed3aeb39edcb4afc75f3964e3d69e3d0ca78ef34295a911`.
That size and digest are expected values, **not a locally verified hash**.

Cal's `github_download_workflow_artifact` succeeded and returned an application/zip
file reference. The supported `library_prepare_materialize` operation accepted
that reference and returned a signed GET URL, size 61,820, and
`workspace_path: null`. The execution environment's HTTPS proxy rejected GET of
the returned file URL with `Tunnel connection failed: 403 Forbidden`. The approved
escalation path produced the same proxy failure. No ZIP bytes were written,
hashed, extracted or inspected. This was a network/proxy failure; automatic
approval review did not reject the action. Transfer work stopped without changing
proxy, sandbox, credentials or security settings.

Exact blocked action: materialize this artifact's returned file bytes under
`/workspace/c15-evidence/run-40199888746`, then verify size and SHA-256 before
reading `build.json`, `setup.json`, comparison results and child receipts. The
action failed before any bytes were available; it is neither pending nor of
uncertain outcome. Artifact access through GitHub succeeded; local receipt
inspection remains blocked.

### Source comparison completed independently

The current candidate supervisor, child, manifest and workflow are byte-identical
to their versions at the run's harness commit. Their SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `windows-c15-candidate.mjs` | `e0a4bfa8045baa7e58788506a11a4e8a0437363e555afc29890170fd767dc1c3` |
| `windows-c15-candidate-child.cjs` | `810de92d31a6c15e9e3b031c496934f63f809744e29d72748499141972515466` |
| `tools/windows-c15/candidate.json` | `41e9ed1c378d7abe249bf074016ba90fc70b21be11d2025c18e238b928ed93c1` |
| `.github/workflows/windows-c15-candidate.yml` | `07eb50cdaa3eb31de5f2f97ea377025b06aba5efe830769ae12c6c7c92a0792b` |

The historical corrected gzip snapshots decompress byte-for-byte to the current
frozen supervisor and child: SHA-256
`60e3cc4efd0da3a9c9b18bd3f718957d9d8b7919699335ab75c0781ac061c2e5`
and `a02888f23a46435fb488003eda1c9a95d79a710fadd183522292bd5fe3e818fc`,
respectively. Candidate differences add exact source/build/runtime provenance,
receipt validation and aggregate allocator attribution. The cell campaign differs
only in its observed payload constructor; the portable parity test enforces this.

Both supervisors retain the check that every On cell's `enteredMs` precedes its
CLI member's `executionElapsedMs`. The child still starts after the
`execution.running` marker. Thus an overlap assertion is one possible source of
the generic boolean failure, alongside receipt correctness and semantic checks.
No observation here selects that explanation. CLI speed, overall job duration and
the historical memory failures cannot identify the current failing assertion.

### Required next step

Restore supported file materialization, or provide the unchanged ZIP through an
authorized workspace transfer. Verify the expected size/hash first and preserve
the original ZIP and extracted receipts separately. Inspect the stall On receipt's
`ok`, `failureCode`, ordered cells, last target and individual checks, then the
supervisor's member completion, cell-entry/CLI intervals and semantic/work-item
comparisons. Inspect memory directly even if the supervisor did not aggregate it.
Reconcile those receipts with the exact build seal and candidate manifest.

Only after identifying the assertion should a bounded harness or product
correction be proposed with a regression that reproduces it. Any harness edit
requires updated harness hashes in `candidate.json`; a product edit requires a
new exact source tree and compiled/native provenance. Keep the old failed receipts
and candidate identity intact. Parent review must precede any new Windows
dispatch. No rerun, larger timeout/budget, GC, baseline reset, protection weakening
or runtime activation is justified by the available evidence.

This update adds no Windows acceptance. Hosted synthetic scope, physical/native
failure limits, sampling limits, deferred timing and the Mac hold remain as stated
in the preparation and historical records.

### Verification of this evidence update

Linux Node 24.19.0 passed four selected portable cases in
`tools/test/windows-c15-candidate.test.mjs`: receipt acceptance, adversarial receipt
rejection, frozen cell parity and closed inventory. The command selected those
four by test name; this was not the complete portable source/build suite or a
Windows execution. Prettier 3.9.9 checked both changed Markdown files, and
`git diff --check` passed. The installed formatter is older than the current
manifest's requested version; no dependency or lockfile change was made.

Self-review checked log-versus-receipt attribution, exact source identities,
historical snapshot preservation, unchanged candidate/protection/activation state,
the absence of a new dispatch, and the distinction between a reported digest and
a locally verified artifact. No full build or full test suite was needed for this
documentation-only change. Final-commit hosted check status is reported with the
draft PR and cannot resolve the artifact-transfer blocker.
