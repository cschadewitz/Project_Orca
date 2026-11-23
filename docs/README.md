# Documentation index

Start here to understand ORCA without installing it or supplying credentials.
Current source is described in the [capability ledger](ROADMAP.md); the
[25 October 2026 integration checkpoint](reviews/2026-10-25-integration-checkpoint.md)
pins current evidence and remaining acceptance; the [7 October audit](reviews/2026-10-07-living-docs.md)
preserves the earlier inventory. Documentation and source
access invite developer insight; they do not require code changes or host access.

## Orientation and contributing

| Document | Read it when you want to… |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | understand engine, persistence, ACP/MCP directions, daemon and desktop boundaries |
| [Current capabilities and roadmap](ROADMAP.md) | distinguish implemented foundations from M10 operator, M21 configuration/launch and M22 native beta acceptance |
| [Development](DEVELOPMENT.md) | set up source tools, understand command effects and choose scoped checks |
| [Contributing](../CONTRIBUTING.md) / [agent guidance](../AGENTS.md) | review repository conventions and plan outcomes without duplicating shipped work |
| [Data model](DATA-MODEL.md) | understand domain entities, events and expression/template context; feature docs below extend the overview |
| [Planning](PLANNING.md) | understand cross-request dependencies, risk/decision matrices, scheduling and the five Plan modes |
| [Workflow authoring](WORKFLOWS.md) / [typed inputs](workflow-inputs.md) | define nodes, completion, templates and validated launch inputs |
| [Extensibility](EXTENSIBILITY.md) / [builtin validation](builtin-node-validation.md) | implement plugin seams and understand bootstrap/restoration constraints |
| [Design](design/README.md) / [binding UI rules](design/RULES.md) / [workflow editor](design/70-workflow-editing.md) | inspect the design system and implemented editor; #180–#183 remain open acceptance owners |
| [ADRs](adr/) | read settled architectural decisions with their historical context |

## Runtime, clients and safe operation

| Document | Read it when you want to… |
| --- | --- |
| [Protocol reference](../packages/protocol/README.md) | inspect protocol 2.0, discovery, version history and current wire boundaries |
| [Daemon security](daemon-security.md) / [connections](daemon-connection.md) | understand token/grant/resource checks and app target/draft isolation |
| [Configuration generations](configuration-generations.md) | distinguish saving from activation and restore exact admitted choices |
| [Request submission](request-submission.md) / [retry receipts](admission-retry.md) | separate Request/direct launch, acceptance, execution attachment and lost-response retry |
| [Live input](live-input-continuity.md) / [human revisions](revision-input.md) | understand owner-local callbacks, durable gates and protected correction delivery |
| [Protected execution storage](protected-execution-storage.md) / [replay errors](protected-replay-error-contract.md) | inspect privacy, complete backup/key boundaries and fail-closed error behavior |
| [File locks and shared volumes](storage/file-locks.md) | see why a store must live on one host's local disk, and recover an abandoned lock |
| [Recovering interrupted work](recovery.md) | preview resume, new run and checkpoint attempts with uncertain-effect review before anything runs |
| [Owned root worktrees](root-worktree-isolation.md) | understand opt-in local Linux isolation and retained-evidence recovery limits |
| [Running across machines](MULTI-MACHINE.md) | choose between local only, SSH-hosted agents, the app watching several daemons and delegating steps to remote daemons |
| [Integrations](INTEGRATIONS.md) | separate inbound MCP, ACP/Kepler, downstream servers, SSH and JEV; T3 Code transport is groundwork |
| [MCP operator](mcp-operator.md) / [production acceptance](mcp-operator-production-acceptance.md) | inspect supported tools and reference-client evidence versus actual-Cal acceptance |
| [Operator integration](runtime-operator-integration.md) | read the current source evidence map and dated integration/native checkpoints |
| [Private MCP preparation](preparation/private-mcp-access/handoff.md) | review deployment/bridge contracts; use dated owner evidence before treating old recipes as current instructions |
| [Host resources](host-resources.md) / [access-policy proposal](host-resource-access-policy.md) | understand bounded advisory measurement and unmounted production telemetry/grant limits |
| [Independent maintenance MCP](maintenance-mcp.md) | inspect the read-only refusal-only preparation; it does not activate host controls |
| [Installing on Linux](INSTALL-LINUX.md) | install the desktop app on Ubuntu 24.04+ with its sandbox on, and see why the `.deb` is the supported Linux path |
| [Updating](UPDATING.md) / [releasing](RELEASING.md) / [held Mac composition](implementation/mac-native-provider-composition.md) | inspect Windows/Debian mechanisms, implemented but inactive Mac update/recovery and remaining signed/installed acceptance; operator recipes need their own scope |
| [CI shadow selection](ci-shadow-selection.md) | understand advisory selection, full-check authority and uncompleted rollout/release parity |
| [CI runner selection](ci-runners.md) | understand how `check` picks self-hosted (Tyler) or GitHub-hosted runners, how to force hosted, and what the self-hosted runners can reach |
| [Performance evidence](performance/persistence-baseline/README.md), [credential admin](performance/mcp-credential-admin/README.md), [retry worker](performance/admission-retry-worker/README.md) | inspect exact synthetic workload pins and measurement limits |

## Preparation and research

These include implemented source handoffs, contracts, fixtures and research; a completed
preparation issue is not installed/native/product acceptance. Current evidence is linked in the
[roadmap](ROADMAP.md#current-priorities-and-acceptance); their merge does not establish
product or platform acceptance.

| Document | Purpose and boundary |
| --- | --- |
| [Native Mac delivery](preparation/native-mac-delivery/current-state.md) / [native testing](preparation/native-mac-testing/implementation-handoff.md) | dated source audits, signing prerequisites and candidate/physical acceptance handoffs |
| [Mac readiness ledger](preparation/native-mac-beta-readiness/readiness.md) / [acceptance runbook](preparation/native-mac-beta-readiness/acceptance-runbook.md) | current owner handoffs for implemented setup, delivery, recovery and disabled diagnostics versus signed/physical #602–#604/#390 gates |
| [First-job sample](../examples/beta-first-job/README.md) / [offline acceptance](preparation/beta-first-job/acceptance.md) | harmless scripted fixture and refusal checks; no paid provider or physical beta proof |
| [Cal first-job experience](preparation/cal-first-job-experience/README.md) / [mounted guided launch](../packages/app/renderer/src/guided-launch/README.md) | experience specification and implemented Request/direct route; supported #333/#334 acceptance is closed, physical Mac proof remains separate |
| [Configuration/launch packet](preparation/configuration-launch-implementation/README.md) / [Windows acceptance](implementation/m21-windows-acceptance.md) | earlier contract plus integrated Config/launch/template evidence through #607; source-built Windows results do not establish signed Mac acceptance |
| [Beta feedback](preparation/beta-feedback/README.md) | tester/report/triage preparation; physical walkthrough remains separate |
| [Manual diagnostics contract](preparation/manual-diagnostics-contract/README.md) | original typed privacy/export fixtures; later #469 decisions and disabled #470 work are mapped in the roadmap |
| [Diagnostics decisions](preparation/manual-diagnostics-implementation/README.md) / [C15 run 5](preparation/crash-recovery/windows-c15-readiness-run5.md) | implemented Save/export and producers stay production-disabled; narrow hosted Windows synthetic memory pass, with native/physical/renderer acceptance separate |
| [Beta update/recovery](preparation/beta-update-support/README.md) / [integrated held app](implementation/app-held-nonmac-verification.md) | approved-update contract and implemented drain/recovery composition; activation held, signed N-to-N+1 proof unpassed |
| [Owner service evidence](preparation/private-mcp-access/agent01-owner-staging/README.md) | historical cutover/worker/post-SSH observations; command recipes are preserved audit records |
| [Trusted prepared roots](preparation/trusted-prepared-roots/README.md) | offline copier/asset contract and fixtures, not an activated controller |
| [ACP command conformance](preparation/acp-command-conformance/README.md) / [versioned proposal](implementation/594-command-evidence-v1.md) / [dispatch prototype](preparation/acp-command-conformance/dispatch-seam/README.md) | merged offline #676/#678 preparation; exact-command support remains unavailable pending maintained upstream pair, installed correspondence and actual-Cal proof |
| [Tool-call safety](research/tool-call-safety/README.md) | proposed implicit policy/approval layer and assurance limits |
| [Apple Watch research](preparation/apple-watch-approvals/README.md) / [iOS research](preparation/ios-companion/README.md) | proposed mobile scope/security/framework tradeoffs |
| [SwiftUI read-only pilot](preparation/swiftui-readonly-pilot/README.md) | portable synthetic contracts and device/spike prerequisites |

## Historical evidence

The [frozen Current_State review](../Current_State/README.md) describes its
2026-09-29 implementation baseline; the [1 October addendum](../Current_State/addenda/2026-10-01-main-reconciliation.md)
records its later reconciliation. Its 186 baseline checksums and evidence remain intact.
[Real-agent setup/runs](REAL-AGENT-TEST.md) and [session logs](session-logs/README.md)
record September observations, not current host/provider status. The v0.5.2 checklists,
`runtime-*-parallel-contract.md`, dated integration checkpoints and `patches/` preserve
handoffs. Use their pins and the current feature references above; do not reapply settled
patches, reopen product choices or substitute historical CI for a newer candidate.
