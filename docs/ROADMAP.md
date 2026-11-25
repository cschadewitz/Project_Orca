# Roadmap and current capabilities

Reconciled on **2026-10-25** against main
`c693e0456a7d28dc1600afab1c9f9c863f2f93b6`. Root version/release history is
**0.6.0**; main's wire protocol is **2.0**, store epoch **`operator-journals-v4`**.
A source version is not a deployment identity or a native release verdict.
See the [25 October integration checkpoint](archive/reviews/2026-10-25-integration-checkpoint.md),
[earlier dated audit](archive/reviews/2026-10-07-living-docs.md),
[release history](../CHANGELOG.md) and pending [release fragments](../changelog.d/README.md).

The [2026-09-29 historical review](archive/Current_State/README.md) and
[1 October reconciliation](archive/Current_State/addenda/2026-10-01-main-reconciliation.md)
remain preserved. Their planned/shipped classifications describe their original pins.
The tables here supersede those classifications for current main without changing history.

## Implemented foundations and their limits

“Implemented” means inspected main source and its relevant tests. A merged PR or
passing reference suite does not complete every acceptance criterion on its issue.

| Capability on main | Source/reference evidence | Remaining boundary |
| --- | --- | --- |
| ACP orchestration, local/SSH hosts, persisted role/model/item-workflow selection and prompt packs | [Agent turn](../packages/engine/src/executors/agent-step.ts), [ACP facade](../packages/integrations/src/acp-facade/orca-acp-agent.ts), [integrations](INTEGRATIONS.md); original v0.6.0 selection release | Real provider/client combinations need their own evidence. No automatic persisted session recovery, generic scoped capability delivery or working T3 Code transport. |
| Six desktop surfaces and five Plan modes, including visual workflow editing | [Plan surface](../packages/app/renderer/src/plan/plan-surface.tsx), [planning](PLANNING.md), [editor as built](design/70-workflow-editing.md), merged [#610](https://github.com/cschadewitz/Project_Orca/pull/610) | Draft/visual-editor/validation source is implemented; #180–#182 remain open acceptance issues. Dry run #183, agent cost, run percentage/ETA, capacity scheduling and automatic Maintain remain absent. Protected admission intents are not a general offline write queue. |
| Authenticated HTTP/WS, operation/resource filtering, target identity and draft isolation | [Security](daemon-security.md), [connections](daemon-connection.md), merged #368/#382/#397/#404/#607 | #328 is closed for its agreed scope. Remote listeners still require explicit credentials and trusted TLS; loopback is not identity. Source authorization does not certify every deployment or future secret-reference/editor criterion. |
| Typed launch input preflight and immutable workflow identities; builtin custom-node validation | [Workflow inputs](workflow-inputs.md), [builtin validation](builtin-node-validation.md), merged #364/#370/#371 | Same-version changed content is refused for new launches; historical generation/digest restoration fails closed. Plugin metadata/prompt contracts are separate work. |
| Save/apply separation, configuration generations and redacted launch provenance | [Generations](configuration-generations.md), merged #384/#397 | Reloadable roles/defaults/assets affect new work; agents/hosts/providers require restart. Sidecars are reread per permission ask. Executable plugins such as JEV are bootstrap-bound (#394–#396). |
| Structured Config collections/review, guided Request/direct launch and template/pack authoring | [Structured form](../packages/app/renderer/src/config/structured-form/README.md), [mounted launch](../packages/app/renderer/src/guided-launch/README.md), [M21 Windows receipt](archive/implementation/m21-windows-acceptance.md), merged [#607](https://github.com/cschadewitz/Project_Orca/pull/607) | #333/#334/#355 are closed for supported source/Windows acceptance. Prepared-local launch and exact captured choices do not establish real-agent, signed arm64 or physical first-run acceptance. |
| Shared Request/direct admission and durable retry receipts | [Submission](request-submission.md), [retry](admission-retry.md), merged #381/#413/#415/#466/#468/#524/#549/#607 | #331 is closed for its agreed supported-client contract. Acceptance remains distinct from execution attachment and delivery; source and cross-client receipts do not certify every native/keychain/provider combination. |
| Durable gates and owner-local live permission callbacks | [Live input](live-input-continuity.md), merged #383/#397 | Live replies require the original owner/boot/session/turn/invocation and current authority. Expired callbacks are not durable gates or cross-process sessions. |
| Protected explicit human revisions and continuation | [Revision input](revision-input.md), [operator integration](archive/runtime-operator-integration.md), merged #412/#415/#434/#448/#500 | Ordinary approval rationale stays out of prompts. Delivery ambiguity and current-authority/lease refusals remain explicit; no generic automatic resume is implied. |
| Inbound MCP reads/preflight plus production mutation/receipt composition | [MCP operator](mcp-operator.md), [reference acceptance](mcp-operator-production-acceptance.md), merged #414/#415/#425/#431/#434/#465/#607 | Generic actual-Cal #393 is closed; #327/#392 retain broader owner handoffs. #594 exact-command and transferred live-callback lifetime proof remain mandatory before Mac beta. Scope can omit Request/plan/config operations; no owner credential is inferred. |
| Fenced leases, claims, per-file locks and protected history | [Ownership](archive/v0.5.2-ownership-compatibility.md), [protected storage](protected-execution-storage.md), [orchestrator](../packages/engine/src/orchestrator.ts) | Plan queues are instance-local and multi-record changes are not atomic. Bounded persistence/retry benchmarks do not prove arbitrary scale/crash interleavings. |
| Opt-in owned root worktrees | [Root isolation](root-worktree-isolation.md), merged #462 | Built-in local Linux host/provider only; uncertain provisioning retains evidence and refuses automatic recreation. Shared Git metadata is not a hostile-user sandbox. |
| Windows NSIS / managed Debian updates and held Mac update/recovery composition | [Updating](UPDATING.md), [Mac native provider composition](archive/implementation/mac-native-provider-composition.md), [held integration](archive/implementation/app-held-nonmac-verification.md), merged [#607](https://github.com/cschadewitz/Project_Orca/pull/607) | Mac production activation is held pending trusted catalog/policy/installed-manifest inputs and signed N/N+1 acceptance. Installed/signing/backup/rollback proof is candidate/platform-specific. Maintenance admission never installs packages by RPC. |
| Advisory daemon-host resources and bounded authorized composition seams | [Resources](host-resources.md), [access proposal](host-resource-access-policy.md), merged #495/#503/#504 | Normal CLI deployment does not mount an injected collector/summary source or grant host telemetry. Preview fixtures do not prove live CPU/RAM/load, fleet scheduling or remote worker telemetry. |
| Several machines: SSH profiles, one-step server setup, watching several daemons, step delegation to remote daemons with their session caps | [Running across machines](MULTI-MACHINE.md), [connections](daemon-connection.md), [delegation](WORKFLOWS.md#delegating-steps-to-another-daemon), merged #902/#917/#919/#925/#926/#941/#952/#957/#959; CI: two daemons over loopback ssh and in separate containers (#885) | Text artifacts only; no code sync beyond an allowed `gitRef`; Windows parents enroll with a hand-saved credential. No placement across interchangeable workers (#343), host registry (#342) or budgets (#346). Container CI is not acceptance on real machines. |
| Independent maintenance MCP contract | [Maintenance](maintenance-mcp.md), merged #485 | Refusal-only preparation; no activated host collector, access, restart or management authority. |

## Current priorities and acceptance

These are the current owner priorities, not dates, completion percentages or a
promise that all existing ship groups have been completed. Issue acceptance and
explicitly agreed blockers remain authoritative.

| Milestone / outcome | Existing foundation | Remaining work and parallelism |
| --- | --- | --- |
| **M10 — Operate ORCA safely through Cal** | Production adapter, supported cross-client retry and generic actual-Cal #393 acceptance; #328/#331 closed | #327/#392 retain their broader handoffs; #594 exact-command and live-callback lifetime evidence remains mandatory before Mac beta. #597/#598/#600/#601 retain explicit separate deferrals, not passes. New homelab work needs current CPU/RAM/load evidence; run counts are not capacity. |
| **M21 — Configure and launch from the app** | Structured collections/review, mounted Request/direct launch, template/pack authoring and protected restart recovery integrated by #607; #333/#334/#355 closed | Reuse supported Windows/source receipts rather than replan missing UI. Real-agent/manual accessibility and physical Mac evidence remain separately owned. Optional inactive #486 is not a blanket prerequisite. |
| **M22 — Pre-Mac preparation** | Implemented setup/saved-config binding, ownership reconciliation, delivery validation, updater/recovery composition and disabled diagnostics producers | #385–#389 retain delivery/trust/guide and other owner handoffs; #416/#469 non-Mac obligations and mandatory #594 remain. Use the [current readiness ledger](archive/preparation/native-mac-beta-readiness/readiness.md); M22 preparation is distinct from M25 live acceptance. |
| **M25 — Live Apple Silicon acceptance** | Consumes implemented M21/M22 source and candidate-bound preparation | #602 signed private delivery and actual installed arm64/bundled-daemon execution; #603 exact signed N/N+1, natural drain and coherent protected-state restore; #604 native diagnostics; #390 unassisted physical journey. All remain unpassed. Canvas authoring, fleet management and Docker are not blanket beta blockers. |

The Mac/default bundle identity is `com.schadewitz.orca`, Apple Team `Q2FP9UY5T4`;
Windows retains `dev.orca.desktop`. Ordinary Mac packaging still sets
`identity: null` and `notarize: false`. Existing Mac Keychain/intent-journal/OS
permission continuity is a native old-to-new upgrade gate. Do not erase journals
or reset Keychain to obtain a pass. Linux source checks, portable stubs and packaging
configuration cannot establish Gatekeeper/TCC or physical usability.

Manual diagnostics #416/#469 retain settled default-off persistent explicit opt-in,
1–15 minutes/default five, 1 MiB complete report, 8,192 events and bounded encrypted
same-boot/up-to-24-hour recovery. [#438](https://github.com/cschadewitz/Project_Orca/pull/438)
reconciles those decisions; merged #470/#607 implement recovery, Save/export and
closed producers while production capture stays disabled. There is no in-app report
viewer. [C15 run 5](archive/preparation/crash-recovery/windows-c15-readiness-run5.md), merged
in [#663](https://github.com/cschadewitz/Project_Orca/pull/663), passes the unchanged
memory budgets for hosted synthetic Windows x64 failure/stall comparisons. Earlier
failures stay historical; this does not pass renderer Layout/combined-memory,
native consent/isolation, signed Mac or physical acceptance. #597 defers the numeric
4 ms target only. Uploads/remote requests #417/#418 remain distinct.

## Wider backlog

The following retains the existing coherent outcome labels and original recorded
relationships. This is backlog navigation, not a fresh acceptance/dependency-graph
certification. Re-read each issue before scheduling work, because merged foundations
may have satisfied an old blocker. Follow [Contributing](../CONTRIBUTING.md) to amend
issues without recreating shipped features or changing milestones implicitly.

| Existing primary label | Outcome / existing issue owners | Recorded relationships and limits |
| --- | --- | --- |
| `ship-group:scoped-capabilities` | Resolver [#335](https://github.com/cschadewitz/Project_Orca/issues/335); secret references [#336](https://github.com/cschadewitz/Project_Orca/issues/336); session delivery/verification [#337](https://github.com/cschadewitz/Project_Orca/issues/337) | [#335](https://github.com/cschadewitz/Project_Orca/issues/335) needs [#332](https://github.com/cschadewitz/Project_Orca/issues/332)/[#328](https://github.com/cschadewitz/Project_Orca/issues/328); [#336](https://github.com/cschadewitz/Project_Orca/issues/336) needs [#335](https://github.com/cschadewitz/Project_Orca/issues/335)/[#328](https://github.com/cschadewitz/Project_Orca/issues/328); [#337](https://github.com/cschadewitz/Project_Orca/issues/337) needs [#335](https://github.com/cschadewitz/Project_Orca/issues/335)/[#336](https://github.com/cschadewitz/Project_Orca/issues/336). Pure resolver and secret backend work can overlap after contracts agree. This is outbound capability delivery, separate from inbound MCP [#327](https://github.com/cschadewitz/Project_Orca/issues/327). |
| `ship-group:visual-authoring` | Workflow drafts/publish [#180](https://github.com/cschadewitz/Project_Orca/issues/180); editor [#181](https://github.com/cschadewitz/Project_Orca/issues/181); validation panel [#182](https://github.com/cschadewitz/Project_Orca/issues/182); dry run [#183](https://github.com/cschadewitz/Project_Orca/issues/183) | #610 implements drafts, editor and validation over the viewer/version store. #180–#182 remain open with older missing-implementation/acceptance wording: reconcile that issue/source mismatch before scheduling or closing work. Dry run remains future work; source presence alone does not complete every acceptance row. |
| `ship-group:operations-history` | Store contracts [#338](https://github.com/cschadewitz/Project_Orca/issues/338); SQLite [#339](https://github.com/cschadewitz/Project_Orca/issues/339); operations/history [#340](https://github.com/cschadewitz/Project_Orca/issues/340); storage benchmarks [#341](https://github.com/cschadewitz/Project_Orca/issues/341); daemon search [#255](https://github.com/cschadewitz/Project_Orca/issues/255); checkpoint recovery [#357](https://github.com/cschadewitz/Project_Orca/issues/357) | [#338](https://github.com/cschadewitz/Project_Orca/issues/338) has no hard prerequisite; [#339](https://github.com/cschadewitz/Project_Orca/issues/339)/[#340](https://github.com/cschadewitz/Project_Orca/issues/340)/[#341](https://github.com/cschadewitz/Project_Orca/issues/341) follow [#338](https://github.com/cschadewitz/Project_Orca/issues/338) in parallel. [#357](https://github.com/cschadewitz/Project_Orca/issues/357) needs [#340](https://github.com/cschadewitz/Project_Orca/issues/340)/[#338](https://github.com/cschadewitz/Project_Orca/issues/338)/[#332](https://github.com/cschadewitz/Project_Orca/issues/332)/[#331](https://github.com/cschadewitz/Project_Orca/issues/331). Fleet recovery [#344](https://github.com/cschadewitz/Project_Orca/issues/344) is related, not a blocker for local checkpoints. |
| `ship-group:managed-fleet` | Host monitor [#223](https://github.com/cschadewitz/Project_Orca/issues/223); lock liveness [#103](https://github.com/cschadewitz/Project_Orca/issues/103); managed hosts [#342](https://github.com/cschadewitz/Project_Orca/issues/342); capacity/fencing [#343](https://github.com/cschadewitz/Project_Orca/issues/343); drain/recovery [#344](https://github.com/cschadewitz/Project_Orca/issues/344) | [#342](https://github.com/cschadewitz/Project_Orca/issues/342) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338)/[#223](https://github.com/cschadewitz/Project_Orca/issues/223); [#343](https://github.com/cschadewitz/Project_Orca/issues/343) needs [#342](https://github.com/cschadewitz/Project_Orca/issues/342)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#344](https://github.com/cschadewitz/Project_Orca/issues/344) needs [#343](https://github.com/cschadewitz/Project_Orca/issues/343). |
| `ship-group:usage-routing` | Attributable usage [#345](https://github.com/cschadewitz/Project_Orca/issues/345); budgets/reservations [#346](https://github.com/cschadewitz/Project_Orca/issues/346); account routing [#347](https://github.com/cschadewitz/Project_Orca/issues/347) | [#345](https://github.com/cschadewitz/Project_Orca/issues/345) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338); [#346](https://github.com/cschadewitz/Project_Orca/issues/346) needs [#345](https://github.com/cschadewitz/Project_Orca/issues/345)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#347](https://github.com/cschadewitz/Project_Orca/issues/347) needs [#346](https://github.com/cschadewitz/Project_Orca/issues/346). ORCA does not currently collect the cost data this needs. |
| `ship-group:github-planning` | Tracker contract [#348](https://github.com/cschadewitz/Project_Orca/issues/348); GitHub import [#349](https://github.com/cschadewitz/Project_Orca/issues/349); conflict-safe outbox [#350](https://github.com/cschadewitz/Project_Orca/issues/350) | [#348](https://github.com/cschadewitz/Project_Orca/issues/348) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338); [#349](https://github.com/cschadewitz/Project_Orca/issues/349) needs [#348](https://github.com/cschadewitz/Project_Orca/issues/348)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#350](https://github.com/cschadewitz/Project_Orca/issues/350) needs [#349](https://github.com/cschadewitz/Project_Orca/issues/349). |
| `ship-group:ado-planning`, `ship-group:jira-planning`, `ship-group:linear-planning`, `ship-group:beads-planning` | Adapter outcomes [#351](https://github.com/cschadewitz/Project_Orca/issues/351), [#352](https://github.com/cschadewitz/Project_Orca/issues/352), [#353](https://github.com/cschadewitz/Project_Orca/issues/353), [#354](https://github.com/cschadewitz/Project_Orca/issues/354) respectively | Each depends on [#350](https://github.com/cschadewitz/Project_Orca/issues/350); adapters can proceed in parallel after the shared contract. |

Structured configuration and guided launch share `ship-group:configuration-studio`;
#355 template authoring is implemented and closed for its supported scope.
`ship-group:runtime-foundation` now includes
implemented mechanisms with residual acceptance; the old blanket “#329–#357 are
all planned” statement is superseded. SQLite, usage budgets, tracker outboxes,
managed fleet and residual visual-authoring acceptance remain their distinct owners.

Other standing limits include ACP terminal support and automatic `session/load`,
remote workspace synchronization, calendar/capacity planning and autonomous Maintain.
A realized risk records state; it does not create a follow-up Request. The historical
review records the risk-assessor prompt's overpromise; executable prompts are outside
this prose-only scope. An agent's own tools can still write ORCA's files when the
config directory is its workspace (ADR 0009), external-writer push observation is
incomplete, and multi-record recovery requires separate evidence. The [historical verification queue](archive/Current_State/roadmap/future-verification.md)
retains the fault/scale/deployment questions rather than treating them as reproduced
current failures or closed by a docs pass. JEV provider work, plugin restoration
and contributor tooling retain their existing follow-up owners.

## Evidence discipline

Record source/review/CI separately from deployed build, transport, scope and native
candidate. A docs-classification success can skip all runtime jobs. A failed run
remains failed after an owner publishes a correction; #502 does not establish
ORCA's autonomous one-shot approval/delivery route. #520's green source CI does not
remove its consumer-local artifact comparison blocker or prove live default-branch
activation. #517's retained production timeout and #513's native/package gaps remain
separate from merged #514. The [dated review](archive/reviews/2026-10-07-living-docs.md)
links these facts to their reported pins without polling or launching work.
