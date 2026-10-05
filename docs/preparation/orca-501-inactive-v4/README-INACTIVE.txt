INACTIVE ORCA #501 WORKFLOW / TRUSTED-BASE PROPOSAL
Prepared 2026-10-05. No activation, import, daemon restart, admission, agent launch or agent-01 filesystem change is performed by this packet.

Decision proposed
Keep installed runtime source 49efcc7236ac127c952bb1f7a50fc6ef72f7df84 and the existing ORCA home/store/authentication/provider identities. Import the reviewed integration commit into a fresh non-force ref in the EXISTING source repository, without switching its HEAD or touching its index/worktree. Then, after separate owner approval, change workspace.baseBranch and activate the same workflow ID at the next confirmed-unused version, proposed as "4".

Pins
Integration commit: 1b8f196e4df22066efda3c0ed1331a64d9061c4d
Integration tree: 4480c23ce8683f2d6c2df4bf4977a6bf2ad069eb
Prepared candidate: /srv/dev/worktrees/Project_Orca-501-source-assembly-20261005-5c782ac5
Dependency lock Git blob: bc1e0fa854fdb999ea672b0ba41657cece49719e
Existing source repository: /home/casey/.local/share/orca-worktrees/mac-beta-codex
Existing worktree root: /home/casey/.local/share/orca-worktrees/cal-codex-roots
Existing ORCA home: /home/casey/.orca-codex-work
Old base: 8875f4585d7e5cd038ec974f5c6c270f8c5f01c3

Files
- baseline-work-v3.yaml: exact nonsecret published #480 baseline, not an export of the live file.
- work-v4.proposed.yaml: complete inactive proposal (JSON syntax accepted as YAML).
- workflow-structural-delta.json: review-only JSON Patch over the parsed baseline. This is NOT an ORCA config.set payload or an instruction to patch a live file.
- workspace-block.proposed.yaml: inactive reference block; only baseBranch is intended to change. Never replace the full live configuration with this fragment.
- dependency-copy-handoff.txt: later owner-only copy/readiness contract; no copy has occurred.
- source-schema-review.json: precise static verification and remaining validation.
- owner-handoff-comment.txt: bounded inactive owner staging/validation assignment; publication is not activation.
- SHA256SUMS: packet file integrity.

Exact behavioral delta
Version 3 -> proposed 4; expectedHead enum -> integration commit.
start -> dependencyReady (human gate).
ready -> unchanged work agent; stop -> new failure terminal retaining root/evidence.
All existing agent instructions, selection, sandbox expectations, completion policy, deliverables, artifact limits and remaining graph are unchanged. The first gate option is stop. There is no autoApproveWhen, executable setup node or custom plugin.

The question renders assigned cwd, branch, recorded base and expectedHead before the agent. On the supported daemon, human gates park durably. The owner must verify preparation and explicitly choose ready; the gate itself does not audit files, install dependencies or enforce same-user filesystem isolation. The root already exists by this point because provision precedes run.created. Admitting a run to reach this gate is still a real admission and needs separate authorization.

Current evidence
Candidate install: https://github.com/cschadewitz/Project_Orca/issues/501#issuecomment-6002126437
Five readiness passes: https://github.com/cschadewitz/Project_Orca/issues/501#issuecomment-6002265303
Lightning CSS completion: https://github.com/cschadewitz/Project_Orca/issues/501#issuecomment-6002359951
Those receipts concern the prepared candidate only. They do not prepare a future root, establish build/test/browser acceptance, or certify a full-metadata-only offline bootstrap.

Owner preconditions before any active change
1. Confirm the live cal-codex-work v3 parsed definition matches this published baseline, and version 4 has never been recorded with other content. Otherwise stop and return the nonsecret difference; do not overwrite historical pins or guess a version.
2. Confirm the listed nonsecret workspace block and same H/store/identity are current, with isolateRoots true, local Linux host and the current offline workspace-write/on-request agent profile. Share no full config, environment, auth files or tokens.
3. Verify candidate commit/tree/lock and owner-controlled bundle/import provenance; create only a fresh non-force ref in the existing repository. Retain existing HEAD/index/files, refs, worktrees, receipts and common directory. Pin baseBranch to the full commit, not the ref name.
4. Review current active/pending admissions, continuation recovery and capacity before a controlled restart. Preserve all protected store/key/generation/workflow/ownership data and old roots. Startup can reconcile continuations, so zero agent processes alone is insufficient.
5. Stage and checksum the packet in a NEW task-private disk-backed folder. If existing access/dependencies permit, use the exact installed 49ef module-level parser/schema/graph/input/render helpers on these INACTIVE files, with compile cache disabled. Verify matching/mismatched/unknown inputs, synthetic gate render and authoritative parsed workflow revisions. No daemon/CLI bootstrap or admission is needed. Stop on unavailable modules/permissions; no installs or escalation. This validation has NOT been performed in this packet; see owner-handoff-comment.txt.
6. Obtain explicit approval for the exact field/workflow change and controlled restart. Workspace changes are restart-required; config.apply(validateOnly) returns restart-required before asset validation and does not substitute for step 5.
7. After any approved restart, confirm same workspaceId/principal/scope/six grants, expected new instance/config generation, intended workflow version/revision and no unexpected execution. The separate local-owner bootstrap token normally rotates; do not restore old auth state.
8. Before a separately approved admission, review task scope, exact commands, output limits and the unresolved #498 async-publication-fence issue. This packet grants no code fix, broader tests or acceptance.

Rollback limit
A config-selection rollback under the same compatible runtime must retain every new generation, run, object, ref, receipt and owned worktree. Do not restore a pre-admission store snapshot, delete evidence, reset branches or downgrade the binary as an automatic rollback.

Source baseline
https://github.com/cschadewitz/Project_Orca/blob/27dc5fdf82579f9b0e558077baead9ccfa38d251/docs/preparation/owned-root-candidate-49efcc7/work-v3.proposed.yaml
Git blob: 77ff0b3a6b462278ce688ba7c6094548cc1cd50e
