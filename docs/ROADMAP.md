# Roadmap and current capabilities

Reconciled on **2026-10-07** against main
`dcccd2bb849ae26c7fe0fb202431f11a6ab909c1`. Root version/release history is
**0.6.0**; main's wire protocol is **2.0**, store epoch **`operator-journals-v4`**.
A source version is not a deployment identity or a native release verdict.
See the [dated evidence map](reviews/2026-10-07-living-docs.md),
[release history](../CHANGELOG.md) and pending [release fragments](../changelog.d/README.md).

The [2026-09-29 historical review](../Current_State/README.md) and
[1 October reconciliation](../Current_State/addenda/2026-10-01-main-reconciliation.md)
remain preserved. Their planned/shipped classifications describe their original pins.
The tables here supersede those classifications for current main without changing history.

## Implemented foundations and their limits

“Implemented” means inspected main source and its relevant tests. A merged PR or
passing reference suite does not complete every acceptance criterion on its issue.

| Capability on main | Source/reference evidence | Remaining boundary |
| --- | --- | --- |
| ACP orchestration, local/SSH hosts, persisted role/model/item-workflow selection and prompt packs | [Agent turn](../packages/engine/src/executors/agent-step.ts), [ACP facade](../packages/integrations/src/acp-facade/orca-acp-agent.ts), [integrations](INTEGRATIONS.md); original v0.6.0 selection release | Real provider/client combinations need their own evidence. No automatic persisted session recovery, generic scoped capability delivery or working T3 Code transport. |
| Five desktop surfaces and five Plan modes | [Plan surface](../packages/app/renderer/src/plan/plan-surface.tsx), [planning](PLANNING.md), [design implementation](design/60-implementation.md) | No agent cost, run percentage/ETA, workflow editor, capacity scheduling or automatic Maintain. Protected admission intents are not a general offline write queue. |
| Authenticated HTTP/WS, operation/resource filtering, target identity and draft isolation | [Security](daemon-security.md), [connections](daemon-connection.md), merged #368/#382/#397/#404 | #328 retains cross-feature/editor/secret-reference migration and deployment criteria. Remote listeners require explicit credentials and trusted TLS; loopback is not identity. |
| Typed launch input preflight and immutable workflow identities; builtin custom-node validation | [Workflow inputs](workflow-inputs.md), [builtin validation](builtin-node-validation.md), merged #364/#370/#371 | Same-version changed content is refused for new launches; historical generation/digest restoration fails closed. Plugin metadata/prompt contracts are separate work. |
| Save/apply separation, configuration generations and redacted launch provenance | [Generations](configuration-generations.md), merged #384/#397 | Reloadable roles/defaults/assets affect new work; agents/hosts/providers require restart. Sidecars are reread per permission ask. Executable plugins such as JEV are bootstrap-bound (#394–#396). |
| Shared Request/direct admission and durable retry receipts | [Submission](request-submission.md), [retry](admission-retry.md), merged #381/#413/#415/#466/#468/#524 | Acceptance is distinct from execution attachment and delivery. #331 retains the full cross-client stable-key/new-intent matrix; CLI/ACP CI opt-ins do not prove every app/keychain/provider flow. |
| Durable gates and owner-local live permission callbacks | [Live input](live-input-continuity.md), merged #383/#397 | Live replies require the original owner/boot/session/turn/invocation and current authority. Expired callbacks are not durable gates or cross-process sessions. |
| Protected explicit human revisions and continuation | [Revision input](revision-input.md), [operator integration](runtime-operator-integration.md), merged #412/#415/#434/#448/#500 | Ordinary approval rationale stays out of prompts. Delivery ambiguity and current-authority/lease refusals remain explicit; no generic automatic resume is implied. |
| Inbound MCP reads/preflight plus production mutation/receipt composition | [MCP operator](mcp-operator.md), [reference acceptance](mcp-operator-production-acceptance.md), merged #414/#415/#425/#431/#434/#465 | Actual Cal discovery is observed; #327/#393's full actual-client matrix remains. Scope can omit Request/plan/config operations; no owner credential is inferred. |
| Fenced leases, claims, per-file locks and protected history | [Ownership](v0.5.2-ownership-compatibility.md), [protected storage](protected-execution-storage.md), [orchestrator](../packages/engine/src/orchestrator.ts) | Plan queues are instance-local and multi-record changes are not atomic. Bounded persistence/retry benchmarks do not prove arbitrary scale/crash interleavings. |
| Opt-in owned root worktrees | [Root isolation](root-worktree-isolation.md), merged #462 | Built-in local Linux host/provider only; uncertain provisioning retains evidence and refuses automatic recreation. Shared Git metadata is not a hostile-user sandbox. |
| Windows NSIS desktop and managed Debian daemon update mechanisms | [Updating](UPDATING.md), [driver](../packages/app/src/main/update-driver.ts), [maintenance admission](../packages/daemon/src/maintenance.ts); #306 | Main has no Mac update driver. Installed/signing/backup/rollback proof is candidate/platform-specific. Maintenance admission never installs packages by RPC. |
| Advisory daemon-host resources and bounded authorized composition seams | [Resources](host-resources.md), [access proposal](host-resource-access-policy.md), merged #495/#503/#504 | Normal CLI deployment does not mount an injected collector/summary source or grant host telemetry. Preview fixtures do not prove live CPU/RAM/load, fleet scheduling or remote worker telemetry. |
| Independent maintenance MCP contract | [Maintenance](maintenance-mcp.md), merged #485 | Refusal-only preparation; no activated host collector, access, restart or management authority. |

## Current priorities and acceptance

These are the current owner priorities, not dates, completion percentages or a
promise that all existing ship groups have been completed. Issue acceptance and
explicitly agreed blockers remain authoritative.

| Milestone / outcome | Existing foundation | Remaining work and parallelism |
| --- | --- | --- |
| **M10 — Operate ORCA safely through Cal** | Production adapter, authenticated reference matrix, live discovery and scoped historical worker/service evidence | #327/#393: exact build/scope, existing-run investigation, direct versus Request launch, retained-key recovery, gate negatives and confirmation/tool-selection. #392 retains disruption/reboot/revocation/rollback. New homelab work needs current CPU/RAM/load evidence; run counts are not capacity. |
| **M21 — Configure and launch from the app** | #318/#329/#330/#332/#237 foundations are merged; existing raw/scalar editor, protected palette intents and preflight | #333 structured create/delete/reorder and semantic preview; #334 guided Request/direct launch and asset/workspace choices. [#440](https://github.com/cschadewitz/Project_Orca/pull/440) is reconciled preparation awaiting accepted packet/runtime freeze, not implementation. #424/#428 and #420/#427 are preparation already accepted; optional inactive #486 is not a blanket prerequisite. |
| **M22 — Invited native Apple Silicon beta** | arm64 DMG/ZIP packaging, bundled authenticated daemon probe, approved identity and fixture-only validation/identity producer | #385 signed/notarized/stapled private candidate; #386 clean-account first run/Finder/PATH; #387 approved automatic installation after specific update approval, safe idle/defer, signed N-to-N+1 and protected recovery; #388 actual packaged arm64 execution; #389 matching guide; #390 physical journey and consented diagnostics. Native implementation can progress alongside MCP acceptance; the release gates differ. Canvas authoring, fleet management and Docker are not blanket beta blockers. |

The Mac/default bundle identity is `com.schadewitz.orca`, Apple Team `Q2FP9UY5T4`;
Windows retains `dev.orca.desktop`. Ordinary Mac packaging still sets
`identity: null` and `notarize: false`. Existing Mac Keychain/intent-journal/OS
permission continuity is a native old-to-new upgrade gate. Do not erase journals
or reset Keychain to obtain a pass. Linux source checks, portable stubs and packaging
configuration cannot establish Gatekeeper/TCC or physical usability.

Manual diagnostics #416/#469 retain settled default-off persistent explicit opt-in,
1–15 minutes/default five, 1 MiB complete report, 8,192 events and bounded encrypted
same-boot/up-to-24-hour recovery. [#438](https://github.com/cschadewitz/Project_Orca/pull/438)
reconciles those decisions; #470 is still production-disabled preparation with
producer/privacy/native/actual-consent and acceptance gaps. Uploads/remote requests
#417/#418 remain distinct. [#439](https://github.com/cschadewitz/Project_Orca/pull/439)
is the merged updater/recovery preparation contract; it does not supply a Mac engine.

## Wider backlog

The following retains the existing coherent outcome labels and original recorded
relationships. This is backlog navigation, not a fresh acceptance/dependency-graph
certification. Re-read each issue before scheduling work, because merged foundations
may have satisfied an old blocker. Follow [Contributing](../CONTRIBUTING.md) to amend
issues without recreating shipped features or changing milestones implicitly.

| Existing primary label | Outcome / existing issue owners | Recorded relationships and limits |
| --- | --- | --- |
| `ship-group:scoped-capabilities` | Resolver [#335](https://github.com/cschadewitz/Project_Orca/issues/335); secret references [#336](https://github.com/cschadewitz/Project_Orca/issues/336); session delivery/verification [#337](https://github.com/cschadewitz/Project_Orca/issues/337) | [#335](https://github.com/cschadewitz/Project_Orca/issues/335) needs [#332](https://github.com/cschadewitz/Project_Orca/issues/332)/[#328](https://github.com/cschadewitz/Project_Orca/issues/328); [#336](https://github.com/cschadewitz/Project_Orca/issues/336) needs [#335](https://github.com/cschadewitz/Project_Orca/issues/335)/[#328](https://github.com/cschadewitz/Project_Orca/issues/328); [#337](https://github.com/cschadewitz/Project_Orca/issues/337) needs [#335](https://github.com/cschadewitz/Project_Orca/issues/335)/[#336](https://github.com/cschadewitz/Project_Orca/issues/336). Pure resolver and secret backend work can overlap after contracts agree. This is outbound capability delivery, separate from inbound MCP [#327](https://github.com/cschadewitz/Project_Orca/issues/327). |
| `ship-group:visual-authoring` | Workflow drafts/publish [#180](https://github.com/cschadewitz/Project_Orca/issues/180); editor [#181](https://github.com/cschadewitz/Project_Orca/issues/181); validation panel [#182](https://github.com/cschadewitz/Project_Orca/issues/182); dry run [#183](https://github.com/cschadewitz/Project_Orca/issues/183) | Build on existing viewer, layout, version store and delivered [#314](https://github.com/cschadewitz/Project_Orca/issues/314) validation. Re-read each issue's blockers; editor fixtures need not wait for every backend implementation. |
| `ship-group:operations-history` | Store contracts [#338](https://github.com/cschadewitz/Project_Orca/issues/338); SQLite [#339](https://github.com/cschadewitz/Project_Orca/issues/339); operations/history [#340](https://github.com/cschadewitz/Project_Orca/issues/340); storage benchmarks [#341](https://github.com/cschadewitz/Project_Orca/issues/341); daemon search [#255](https://github.com/cschadewitz/Project_Orca/issues/255); checkpoint recovery [#357](https://github.com/cschadewitz/Project_Orca/issues/357) | [#338](https://github.com/cschadewitz/Project_Orca/issues/338) has no hard prerequisite; [#339](https://github.com/cschadewitz/Project_Orca/issues/339)/[#340](https://github.com/cschadewitz/Project_Orca/issues/340)/[#341](https://github.com/cschadewitz/Project_Orca/issues/341) follow [#338](https://github.com/cschadewitz/Project_Orca/issues/338) in parallel. [#357](https://github.com/cschadewitz/Project_Orca/issues/357) needs [#340](https://github.com/cschadewitz/Project_Orca/issues/340)/[#338](https://github.com/cschadewitz/Project_Orca/issues/338)/[#332](https://github.com/cschadewitz/Project_Orca/issues/332)/[#331](https://github.com/cschadewitz/Project_Orca/issues/331). Fleet recovery [#344](https://github.com/cschadewitz/Project_Orca/issues/344) is related, not a blocker for local checkpoints. |
| `ship-group:managed-fleet` | Host monitor [#223](https://github.com/cschadewitz/Project_Orca/issues/223); lock liveness [#103](https://github.com/cschadewitz/Project_Orca/issues/103); managed hosts [#342](https://github.com/cschadewitz/Project_Orca/issues/342); capacity/fencing [#343](https://github.com/cschadewitz/Project_Orca/issues/343); drain/recovery [#344](https://github.com/cschadewitz/Project_Orca/issues/344) | [#342](https://github.com/cschadewitz/Project_Orca/issues/342) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338)/[#223](https://github.com/cschadewitz/Project_Orca/issues/223); [#343](https://github.com/cschadewitz/Project_Orca/issues/343) needs [#342](https://github.com/cschadewitz/Project_Orca/issues/342)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#344](https://github.com/cschadewitz/Project_Orca/issues/344) needs [#343](https://github.com/cschadewitz/Project_Orca/issues/343). |
| `ship-group:usage-routing` | Attributable usage [#345](https://github.com/cschadewitz/Project_Orca/issues/345); budgets/reservations [#346](https://github.com/cschadewitz/Project_Orca/issues/346); account routing [#347](https://github.com/cschadewitz/Project_Orca/issues/347) | [#345](https://github.com/cschadewitz/Project_Orca/issues/345) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338); [#346](https://github.com/cschadewitz/Project_Orca/issues/346) needs [#345](https://github.com/cschadewitz/Project_Orca/issues/345)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#347](https://github.com/cschadewitz/Project_Orca/issues/347) needs [#346](https://github.com/cschadewitz/Project_Orca/issues/346). ORCA does not currently collect the cost data this needs. |
| `ship-group:github-planning` | Tracker contract [#348](https://github.com/cschadewitz/Project_Orca/issues/348); GitHub import [#349](https://github.com/cschadewitz/Project_Orca/issues/349); conflict-safe outbox [#350](https://github.com/cschadewitz/Project_Orca/issues/350) | [#348](https://github.com/cschadewitz/Project_Orca/issues/348) needs [#338](https://github.com/cschadewitz/Project_Orca/issues/338); [#349](https://github.com/cschadewitz/Project_Orca/issues/349) needs [#348](https://github.com/cschadewitz/Project_Orca/issues/348)/[#339](https://github.com/cschadewitz/Project_Orca/issues/339); [#350](https://github.com/cschadewitz/Project_Orca/issues/350) needs [#349](https://github.com/cschadewitz/Project_Orca/issues/349). |
| `ship-group:ado-planning`, `ship-group:jira-planning`, `ship-group:linear-planning`, `ship-group:beads-planning` | Adapter outcomes [#351](https://github.com/cschadewitz/Project_Orca/issues/351), [#352](https://github.com/cschadewitz/Project_Orca/issues/352), [#353](https://github.com/cschadewitz/Project_Orca/issues/353), [#354](https://github.com/cschadewitz/Project_Orca/issues/354) respectively | Each depends on [#350](https://github.com/cschadewitz/Project_Orca/issues/350); adapters can proceed in parallel after the shared contract. |

Structured configuration and guided launch share `ship-group:configuration-studio`;
#355 template authoring is later work. `ship-group:runtime-foundation` now includes
implemented mechanisms with residual acceptance; the old blanket “#329–#357 are
all planned” statement is superseded. SQLite, usage budgets, tracker outboxes,
managed fleet and visual authoring remain their distinct owners.

Other standing limits include ACP terminal support and automatic `session/load`,
remote workspace synchronization, calendar/capacity planning and autonomous Maintain.
A realized risk records state; it does not create a follow-up Request. The historical
review records the risk-assessor prompt's overpromise; executable prompts are outside
this prose-only scope. Unreadable permission sidecars can drop deny/ask rules,
external-writer push observation is incomplete, and multi-record recovery requires
separate evidence. The [historical verification queue](../Current_State/roadmap/future-verification.md)
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
separate from merged #514. The [dated review](reviews/2026-10-07-living-docs.md)
links these facts to their reported pins without polling or launching work.
