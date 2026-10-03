# Source evidence for the ORCA and T3 Code review

Companion to the [comparative review](t3-code-comparison-2026-10-03.md). Reviewed 2026-10-03 UTC.

All source links pin ORCA `3702da5b38dc449280c2837366615de741e9c45c` or T3
`f1dcd93931b322d587a7253856f44625a6afbce0`. Issue links below are live records
whose state can change. Paths and line anchors identify evidence, not executed tests.

## O1 Workflow runtime

Declared graph/node model, retry and child-run recovery. These are executable workflow definitions, distinct from a provider execution graph.

- [Workflow model](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/core/src/model/workflow.ts#L41).
- [Interpreter and child recovery](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/orchestrator.ts#L1452).
- [Shipped SDLC workflow](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/workflows/ai-sdlc.yaml).
- [Container recovery tests](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/test/containers.test.ts#L303).

## O2 Artifact contracts

Attempt-specific output paths, structural validation, bounded follow-ups, stored content/provenance and explicit input records. These mechanisms do not establish semantic correctness or prove an agent actually ran a claimed check.

- [Agent-step executor](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/executors/agent-step.ts#L74).
- [Artifact storage](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/store/src/artifact-store.ts#L37).
- [Input provenance](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/orchestrator.ts#L1608).
- [SDLC integration tests](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/test/sdlc.e2e.test.ts).

## O3 Planning

Persistent planning and live evaluation of item/stage/decision/external dependencies, risk exposure and schedule explanations. This is not a calendar trigger or a capacity manager.

- [Scheduler](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/core/src/plan/schedule.ts#L102).
- [Plan service](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/plan/service.ts).
- [Planning guide](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/PLANNING.md).
- [Cross-request and stage tests](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/test/plan.e2e.test.ts).

## O4 Permissions and authority

Authenticated server wiring and different lifetimes for parked gates and owner-local permission callbacks. Protected execution state is separate from public projections; this is not a claim of universal secret detection or host isolation.

- [Server authentication and composition](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/daemon/src/server.ts#L180).
- [Live input lifetime](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/live-input-continuity.md#L10).
- [Live input authority](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/daemon/src/live-input-authority.ts).
- [Protected-state contract](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/runtime-foundation-integration.md#L87).

## O5 Storage and recovery

JSONL sequencing, leases/fencing, claims and stored definitions are implemented. Current definition lookup prefers the stored snapshot; changed same-version fresh launches are rejected. Cross-record transactional guarantees and arbitrary external-effect replay remain distinct problems.

- [Lease store](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/store/src/lease-store.ts).
- [JSONL log](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/store/src/jsonl-log.ts).
- [Work-item claims](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/store/src/claim-store.ts).
- [Current definition lookup](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/orchestrator.ts#L1101).
- [Configuration generations](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/configuration-generation.ts#L134).

## O6 Operator runtime

Current production composition, not the older handoff prose, establishes mounted services. The MCP test fixture uses compiled processes and real daemon/credential/storage paths; this review did not execute it or establish external Cal connectivity.

- [CLI production composition](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/cli/src/commands/index.ts#L839).
- [Mounted operator methods](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/daemon/src/methods.ts#L825).
- [Mutation adapter](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/daemon/src/operator-mutations.ts#L19).
- [MCP server](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/src/mcp/server.ts#L20).
- [Real compiled integration fixture](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/test/mcp-operator-production-fixture.ts).
- [Revision delivery](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/revision-delivery.ts).

## O7 Agents and workspaces

ACP client, facade, model selection and local/SSH/worktree seams. Client session loading is conditional on an explicit resumeSessionId and agent support; default engine restart is different, and the ORCA facade advertises loadSession:false.

- [ACP client and optional loading](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/agents/src/acp-session.ts#L240).
- [ACP facade capability](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/src/acp-facade/orca-acp-agent.ts#L179).
- [SSH host](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/agents/src/hosts/ssh-host.ts).
- [Git worktree provider](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/workspace/git-worktree.ts).
- [Model selection](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/session-model.ts).
- [Plugin extension seams](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/engine/src/plugin.ts).

## O8 Desktop and design

Five operational surfaces and shared design primitives. The palette already starts or recovers runs, but lacks the full guided typed launch journey. Artifact versions/diffs are not a repository working-tree diff workbench. Terminal, editor, mobile and chat absence claims are bounded to this inspected surface inventory.

- [Surface registry](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/renderer/src/chrome/surfaces.ts).
- [Existing launch action](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/renderer/src/palette/start-run.tsx).
- [Artifact panel](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/renderer/src/artifacts/artifact-panel.tsx).
- [Design rules](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/design/RULES.md).
- [Unavailable data and implementation boundaries](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/design/60-implementation.md#L646).
- [Repository interface rules](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/AGENTS.md).

## O9 Semantic evaluation

The plugin is a bounded proof of concept for typed artifact judgments. Its existence does not establish calibrated workflow quality or production acceptance.

- [JEV implementation](https://github.com/cschadewitz/Project_Orca/tree/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/src/jev).
- [JEV tests](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/test/jev-eval.test.ts).
- [Integration guide](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/INTEGRATIONS.md).

## O10 First job and beta

Specifications and fixtures are useful foundations; they are not evidence of a packaged/physical-machine first-success journey. Preserve the manual diagnostics privacy contract rather than copying broad logs or captures.

- [First-job experience packet](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/preparation/cal-first-job-experience/README.md).
- [Synthetic first-job fixture](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/examples/beta-first-job/README.md).
- [Manual diagnostics contract](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/preparation/manual-diagnostics-contract/README.md).
- [Diagnostics preview and consent](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/preparation/manual-diagnostics-contract/preview-and-consent.md).

## O11 Tracked gaps

Use the live issue inventory below for remaining scope. The roadmap is explicitly dated to an older commit and must not override newly merged authentication, admission, configuration, live-input or MCP implementation.

- [Dated roadmap](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/ROADMAP.md).
- [Issue planning rules](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/CONTRIBUTING.md).
- [Workflow viewer](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/renderer/src/workflow/workflow-surface.tsx).

## O12 Notifications and performance

Renderer virtualization and local push do not establish bounded persistence costs or observation of all external writers. Existing baseline work is the right place to measure these costs before redesign.

- [Subscription owner](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/daemon/src/subscriptions.ts).
- [Renderer stream](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/renderer/src/notifications.ts).
- [Connection machine](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/app/src/main/connection-state.ts).
- [Persistence baseline](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/docs/performance/persistence-baseline/README.md).

## O13 Existing T3 adapter

Dormant V1-style scaffold, not a verified current integration. The transport throws, workspace mapping is unfinished, permission handling is absent, attachments are discarded and terminal correlation is incomplete. Tests use a fake RPC boundary.

- [Hand-written contracts](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/src/t3code/contracts.ts).
- [Session mapping and missing transport](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/src/t3code/session.ts).
- [Adapter tests](https://github.com/cschadewitz/Project_Orca/blob/3702da5b38dc449280c2837366615de741e9c45c/packages/integrations/test/t3code-session.test.ts).

## T1 Providers and ACP

Generic ACP registry support is implemented. Registry identity/distribution resolution precedes executable override; preserved registry arguments/environment prevent treating this as arbitrary command registration. Provider/account capabilities remain agent-specific.

- [ACP user guide](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/providers-acp.md).
- [Registry driver](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/provider/Drivers/AcpRegistryDriver.ts#L459).
- [Registry adapter](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.ts).
- [Registry resolution](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/provider/acp/AcpRegistrySupport.ts#L1714).
- [Configuration constraints](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/contracts/src/settings.ts#L872).
- [Provider limits](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/providers.md).

## T2 Runtime and persistence

Current v2 commits event/projection/receipt/effect intent atomically, publishes after commit and executes effects separately. Process-bound recovery retires lost work rather than asserting the old provider process survived. The older target architecture still calls the now-implemented outbox future work.

- [Current architecture](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/overview.md#L56).
- [Transaction and publication boundary](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/EventSink.ts#L230).
- [Command commit](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/EventSink.ts#L518).
- [Effect ordering](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/EffectOutbox.ts#L281).
- [Effect execution](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/EffectWorker.ts).
- [Provider process recovery](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L297).
- [V2 commands and retained RPC names](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/contracts/src/orchestrationV2.ts#L2438).

## T3 Coding surfaces

Composer, terminal, browser/device and desktop capture paths establish product breadth. Their presence does not prove equivalent platform support, full browser isolation, or that a successful tool invocation proves a requirement passed.

- [Composer and queues](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/composer.md).
- [Terminal implementation and bounds](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/terminal/Manager.ts#L96).
- [Preview tools](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/toolkits/preview/tools.ts).
- [Device tools](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/toolkits/device/tools.ts).
- [Device product constraints](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/devices.md).
- [Desktop capture](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/snap-shot.md).
- [Keybindings](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/keybindings.md).

## T4 Environments and mobile

Multiple clients and environments, pairing, relay/Tailscale and managed SSH are documented and implemented. Phone push requires T3 Connect. Optional new-thread balancing is not migration or ORCA-style dependency scheduling.

- [Remote access and balancing](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/remote-access.md).
- [Managed SSH implementation](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/desktop/src/ssh/DesktopSshEnvironment.ts).
- [Mobile notification constraints](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/mobile-notifications.md).
- [Mobile outbox](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/mobile/src/state/thread-outbox-manager.ts).
- [Relay trust boundary](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/t3-connect.md).

## T5 Git review and checkpoints

Built-in source-control review and forge drivers. Features differ by host/client. File restore is restricted by workspace/session ownership; checkpoint restore does not undo external effects or restore arbitrary native conversation state.

- [Source-control user guide](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/source-control.md).
- [Forge driver registry](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/sourceControl/SourceControlProviderRegistry.ts).
- [PR code review](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/web/src/components/pullRequest/PullRequestCodeTab.tsx).
- [Checkpoint store](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/checkpointing/CheckpointStore.ts).
- [Restore safety guards](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts).
- [Rollback product contract](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/composer.md#L111).

## T6 Context transfer

Current provider handoffs select full messages under a budget, preserve current input, and offer retrieval for omissions. They omit reasoning/tool state/attachments. Older internal prose describing uniformly compacted 240-character summaries is stale for provider handoffs; compact summaries still appear in fork-delta paths.

- [Current handoff guide](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/portable-handoffs.md).
- [Handoff service](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/ContextHandoffService.ts).
- [Selection and budget](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/ContextHandoffBudget.ts).
- [Delivery adaptation](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts).
- [Older internal description](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/context-handoffs.md).

## T7 Client state and bounds

A shared per-environment connection/state runtime separates transport from synchronization. Cached state and applied cursor move together; mutations are not automatically replayed. Bounded snapshots/replay are distinct from total server-memory guarantees.

- [Connection contract](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/connection-runtime.md).
- [Connection supervisor](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/client-runtime/src/connection/supervisor.ts).
- [Thread state/cache lifetime](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/client-runtime/src/state/threads.ts).
- [Wire projection](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/WireProjection.ts).
- [Performance contracts](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/performance-regressions.md).

## T8 Delegation and scheduling

Cross-provider child tasks, project-scoped thread tools and persisted recurring schedules are real implementations. A schedule dispatch success is not agent completion; its active guard covers dispatch rather than the full subsequent agent run. Inspected conversation command/schema, project scripts and provider workflow inspection do not provide an ORCA-equivalent authored artifact graph.

- [Registered tools](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/toolkits/orchestrator/tools.ts).
- [Delegation authority and service](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/OrchestratorMcpService.ts#L1356).
- [Schedule schema](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/contracts/src/scheduledTask.ts).
- [Dispatch and schedule settlement](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/scheduledTasks/ScheduledTaskService.ts#L460).
- [PR watch service](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/PullRequestWatchReactor.ts).
- [Project script schema](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/packages/contracts/src/t3ProjectFile.ts).
- [Provider workflow inspection](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/workflowScriptQuery.ts).

## T9 Authority and permissions

Environment RPC authority differs from internal provider-session MCP authority. Project membership is not a filesystem sandbox. ACP permission response policy does not impose a uniform sandbox on agent-owned tools. New-thread initial Full access is a documented product choice, not an ORCA recommendation.

- [Environment auth boundaries](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/environment-auth.md).
- [RPC scope inventory](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/auth/RpcAuthorization.ts).
- [Provider-scoped MCP auth](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/McpHttpServer.ts#L62).
- [MCP token lifecycle](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/mcp/McpSessionRegistry.ts#L123).
- [Permission modes and default](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/permission-modes.md).
- [ACP policy](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/provider/acp/AcpClientPolicy.ts).

## T10 Onboarding

Connect, check agents, import projects and bounded history. Import omits tool activity and attachments; constraints are explained rather than silently presenting a complete history.

- [Welcome guide](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/welcome-wizard.md).
- [Welcome implementation](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/web/src/components/onboarding/WelcomeWizard.tsx).
- [Bounded native-session import](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/project/AgentSessionImporter.ts#L175).

## T11 Usage and accounts

Provider histories/account APIs, deduplication, model pricing and explicit missing coverage. API-equivalent estimated cost is not subscription spend. This does not make usage available for every ACP agent.

- [Usage product contract](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/usage.md).
- [Usage implementation](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/usage/UsageService.ts).
- [Codex accounts](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/providers-codex.md).
- [Claude accounts](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/user/providers-claude.md).

## T12 Tests and performance evidence

Regression architecture and fixtures inspected, not executed. Budgets belong to the current transport path. Encoded payload size, compressed traffic, process heap and RSS are different measurements.

- [Performance limits and caveats](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/performance-regressions.md).
- [Provider replay harness](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts).
- [Replay integration](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts).
- [Recovery replay](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts).
- [Wire performance tests](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts).
- [Active test command](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/package.json#L35).

## T13 Source reuse

Root source license and separate third-party notice guidance. This research imports no T3 implementation or assets.

- [Root license](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/LICENSE).
- [Third-party notice guidance](https://github.com/pingdotgg/t3code/blob/f1dcd93931b322d587a7253856f44625a6afbce0/docs/internals/open-source-licenses.md).

## Issue inventory and status cautions

Read on **2026-10-03 UTC** using the authenticated GitHub issue API through `gh`.
The inventory included open and closed records (up to 500), and the recommendation
owners were checked against their titles, scope and current source. Status is only
a tracking signal; code determines implemented mechanisms, and acceptance evidence
determines proven delivery. No issue metadata or issue content was changed.

| Area | Existing issues and observed state | Interpretation for this review |
| --- | --- | --- |
| Existing runtime foundations | [#237](https://github.com/cschadewitz/Project_Orca/issues/237) closed; [#314](https://github.com/cschadewitz/Project_Orca/issues/314) closed; [#318](https://github.com/cschadewitz/Project_Orca/issues/318) closed; [#329](https://github.com/cschadewitz/Project_Orca/issues/329) closed; [#330](https://github.com/cschadewitz/Project_Orca/issues/330) closed; [#332](https://github.com/cschadewitz/Project_Orca/issues/332) closed | Closed records and current code support reuse of live-input, validation, target isolation, shared submission and configuration-generation foundations. |
| Partially delivered parent scope | [#327](https://github.com/cschadewitz/Project_Orca/issues/327) open; [#328](https://github.com/cschadewitz/Project_Orca/issues/328) open; [#331](https://github.com/cschadewitz/Project_Orca/issues/331) open; [#356](https://github.com/cschadewitz/Project_Orca/issues/356) open | All remain open in this inventory, but source at the ORCA baseline already implements substantial operator/auth/admission/revision slices. Do not classify the entire feature as missing. |
| Configuration and first job | [#333](https://github.com/cschadewitz/Project_Orca/issues/333) open; [#334](https://github.com/cschadewitz/Project_Orca/issues/334) open; [#386](https://github.com/cschadewitz/Project_Orca/issues/386) open; [#435](https://github.com/cschadewitz/Project_Orca/issues/435) open | Extend existing forms, typed launch and native setup owners; #435 is preparation, not implementation acceptance. |
| Completed first-job preparation | [#420](https://github.com/cschadewitz/Project_Orca/issues/420) closed; [#424](https://github.com/cschadewitz/Project_Orca/issues/424) closed | Closed synthetic-fixture and experience-specification work; neither establishes a complete packaged first-job product. |
| Storage and operations | [#338](https://github.com/cschadewitz/Project_Orca/issues/338) open; [#339](https://github.com/cschadewitz/Project_Orca/issues/339) open; [#340](https://github.com/cschadewitz/Project_Orca/issues/340) open; [#357](https://github.com/cschadewitz/Project_Orca/issues/357) open | Store conformance before SQLite; recovery needs explicit checkpoints and uncertain-effect review. Preserve current leases and admission records. |
| Bounded performance | [#408](https://github.com/cschadewitz/Project_Orca/issues/408) open; [#423](https://github.com/cschadewitz/Project_Orca/issues/423) open; [#255](https://github.com/cschadewitz/Project_Orca/issues/255) open | Measure current persistence first; #423 is the bounded baseline slice, while #255 owns daemon search. |
| Provider capability delivery | [#335](https://github.com/cschadewitz/Project_Orca/issues/335) open; [#336](https://github.com/cschadewitz/Project_Orca/issues/336) open; [#337](https://github.com/cschadewitz/Project_Orca/issues/337) open | Deterministic scope, execution-boundary secrets, and actual session delivery/verification. Existing ACP/model support is not a substitute for this scope. |
| Context and templates | [#355](https://github.com/cschadewitz/Project_Orca/issues/355) open; [#372](https://github.com/cschadewitz/Project_Orca/issues/372) open; [#374](https://github.com/cschadewitz/Project_Orca/issues/374) open | Reusable authored context and runtime-owned identity remain distinct; do not create a second template resolver. |
| Usage and routing | [#345](https://github.com/cschadewitz/Project_Orca/issues/345) open; [#346](https://github.com/cschadewitz/Project_Orca/issues/346) open; [#347](https://github.com/cschadewitz/Project_Orca/issues/347) open | Usage observations and reconciliation precede budget reservations, which precede authorized account routing. |
| Tracker integration | [#348](https://github.com/cschadewitz/Project_Orca/issues/348) open; [#349](https://github.com/cschadewitz/Project_Orca/issues/349) open; [#350](https://github.com/cschadewitz/Project_Orca/issues/350) open; [#351](https://github.com/cschadewitz/Project_Orca/issues/351) open; [#352](https://github.com/cschadewitz/Project_Orca/issues/352) open; [#353](https://github.com/cschadewitz/Project_Orca/issues/353) open; [#354](https://github.com/cschadewitz/Project_Orca/issues/354) open | Ownership and synchronization contracts, GitHub import/outbox, and separate tracker adapters. These are not all code-review UI issues. |
| Hosts and private access | [#342](https://github.com/cschadewitz/Project_Orca/issues/342) open; [#343](https://github.com/cschadewitz/Project_Orca/issues/343) open; [#344](https://github.com/cschadewitz/Project_Orca/issues/344) open; [#391](https://github.com/cschadewitz/Project_Orca/issues/391) open; [#392](https://github.com/cschadewitz/Project_Orca/issues/392) open; [#393](https://github.com/cschadewitz/Project_Orca/issues/393) open | Capacity/placement/recovery and private MCP deployment are separate workstreams. Remote ACP already exists; an actual private client connection needs its own evidence. |
| Diagnostics | [#416](https://github.com/cschadewitz/Project_Orca/issues/416) open; [#436](https://github.com/cschadewitz/Project_Orca/issues/436) open; [#417](https://github.com/cschadewitz/Project_Orca/issues/417) open; [#418](https://github.com/cschadewitz/Project_Orca/issues/418) open | Manual preview/export is the beta requirement; preparation and later opt-in upload/remote-request work must not be conflated. |
| Updates | [#387](https://github.com/cschadewitz/Project_Orca/issues/387) open; [#437](https://github.com/cschadewitz/Project_Orca/issues/437) open | Native update/recovery acceptance and preparation are distinct. T3 breadth does not establish ORCA packaged support. |

These references are related work and ownership pointers, not a newly asserted
hard-dependency graph. The report creates no issue, milestone or ship-group label.
Before turning its new integration/recurrence ideas into issues, repeat the inventory
under [CONTRIBUTING.md](../../CONTRIBUTING.md) and record actual prerequisites.

## Source precedence and known documentation drift

The review found several examples where document age changes the conclusion:

- ORCA's older README/architecture/integration descriptions say T3 lacks ACP. T1
  disproves that statement at the reviewed T3 commit; the accompanying documentation
  patch corrects those descriptions without claiming a tested ORCA provider.
- ORCA's roadmap is explicitly pinned to an older main and calls several now-merged
  capabilities future work. O4/O6 establish current runtime wiring; open parent
  issues do not negate it. No broad roadmap rewrite is included here.
- ORCA's architecture says a same-version live workflow wins; O5's current lookup
  prefers the stored definition and refuses changed same-version fresh launches.
  The comparison follows source, not that old paragraph.
- T3's v2 target document still lists an outbox as future work. T2's current
  EventSink, EffectOutbox and EffectWorker establish implementation.
- T3's older internal context-handoff description is not the current provider-handoff
  contract. T6's budgeted selection code and current user guide govern that claim;
  fork-delta summaries and legacy imports have separate behavior.

A useful follow-up is a broader source-to-document reconciliation with explicit
historical markers. It should preserve frozen review artifacts and distinguish
implemented source, released artifacts, and executed acceptance evidence.

## Review validation

The research used a read-only public T3 checkout outside ORCA. No T3 dependencies,
install scripts or provider processes were run. Independent reviewers checked the
ORCA inventory, T3 product scope and T3 architecture, then reviewed the synthesis.
Source paths and cited line anchors were checked against both pinned checkouts;
new local document links/reference anchors and the documentation diff were checked.

This change only edits repository documentation. The repository CI classifies
`docs/**` and non-template Markdown as documentation-only, and Prettier intentionally
ignores Markdown. Runtime test suites, app smoke tests, benchmarks and real-provider
integration tests were not run for this review. Their cited fixtures are evidence
of what to verify, not a claim that this research executed them.
