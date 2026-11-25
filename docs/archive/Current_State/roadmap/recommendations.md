# Improvement task specifications

These are proposed future tasks, not changes made by this review. Current facts remain in the [baseline](../baseline/index.md), qualified by [corrections](../addenda/corrections.md). [Sequenced roadmap](index.md) · [Architecture assessment](assessment.md) · [Documentation differences](../comparison/differences.md).

Priorities follow the [comparison rubric](../comparison/differences.md#classification-and-priority). Confidence refers to the problem/design recommendation, not runtime verification. Effort is deliberately approximate: **S** is a localized change with one principal owner; **M** crosses several components or contracts; **L** changes persistence, compatibility or release coordination. These are relative sizes, not calendar estimates. Dependencies name review task IDs, not an existing issue queue. Proposed tests are acceptance work for a later authorized implementation task; none were run here.

## R01

**Publish one current-capability ledger and reconcile status/navigation.** Documentation · P2 · High confidence · S · Owner: documentation/release maintainers · Dependencies: none.

**Problem and evidence:** [D01, D02, D04 and D17](../comparison/differences.md) show method-version drift, implemented features listed as future and outdated debt/navigation. [Wire inventory](../baseline/method-catalog.md), [Plan UI](../architecture/app-plan.md), and [delivery](../architecture/delivery.md) provide the current map. [Version constant](../../packages/protocol/src/version.ts#L103); [Mode registry](../../packages/app/renderer/src/plan/plan-surface.tsx#L68); [Maintenance contract](../../packages/daemon/src/maintenance.ts#L50).

**Impact if unchanged:** contributors and operators make plans from inconsistent capability lists and can duplicate existing work or miss an update prerequisite.

**Change:** maintain a compact capability table distinguishing implemented on main, released, partial and future, with one source owner and evidence link per entry. Replace duplicated status paragraphs with links; update the method reference and docs index. Keep dated release histories intact.

**Tradeoffs/alternatives:** a generated table can reduce mechanical drift but cannot decide whether an integration is complete. Start with a reviewed table plus checks for versions/method names; do not generate narrative from imports.

**Acceptance:** all four findings have explicit dispositions; maintenance shapes/errors are documented; Plan modes and selection features are correctly scoped; the index links UPDATING and every ADR; no current feature has conflicting states across the designated summary pages.

## R02

**State recovery, consistency and trust guarantees precisely.** Documentation/decision records · P1 · High confidence · S–M · Owner: engine/store/security maintainers · Dependencies: none; revise again after R04, R07, R08 and R18 decisions.

**Problem and evidence:** [D03, D05, D07–D09 and D16](../comparison/differences.md), [lifecycle baseline](../baseline/lifecycles.md), [ownership](../architecture/store-ownership.md) and [C01](../addenda/corrections.md#c01-workflow-version-identity-is-conditional). [Workflow resolution](../../packages/engine/src/orchestrator.ts#L722); [Plan queue](../../packages/engine/src/plan/service.ts#L187); [Policy fallback](../../packages/agents/src/permissions.ts#L216).

**Impact if unchanged:** callers rely on broader guarantees than the implementation establishes, particularly during resume, concurrent administration or permission-file failures.

**Change:** document an ownership/consistency table for run leases, work claims, file locks, plan service queues and notifications. Specify current behavior and unresolved guarantees separately. Clarify workflow version lookup, sticky dependency status, config activation lifetime and local-daemon caller trust. Supersede obsolete as-built text without erasing history.

**Tradeoffs/alternatives:** merely weakening wording would conceal genuine design questions. Each unresolved guarantee must link to its implementation task and intended verification; retain strong guarantees when evidence supports them.

**Acceptance:** each operation names its owner, serialization scope, durable record, recovery trigger and failure boundary; no text calls sidecar omission universally conservative or workflow versions byte-immutable; future intent is visibly separated from current behavior.

## R03

**Align contributor instructions with actual contracts and check references.** Documentation/engineering · P2 · High confidence · S–M · Owner: app/design/build maintainers · Dependencies: none; destructive-option intent requires an explicit decision.

**Problem and evidence:** [D06 and D10–D12, D14–D15](../comparison/differences.md); [engineering baseline](../baseline/engineering.md), [attention](../architecture/app-attention.md). [Invalidation consumer](../../packages/app/renderer/src/plan/use-plan.ts#L348); [CJS preload](../../packages/app/src/preload/index.cts#L45); [Option binding](../../packages/app/renderer/src/attention/card-model.ts#L35); [Keyed identity](../../packages/core/src/ids.ts#L61).

**Impact if unchanged:** routine changes begin with incorrect test commands, module-format assumptions, notification rules or keyboard guarantees.

**Change:** correct the applicable prose; define patch versus invalidation versus reconnect refresh; name concrete ACP defaults and opaque keyed IDs. Add a small documentation check for referenced local paths, supported command names and central protocol-version references. Extend the PR template with a contract-owner/documentation impact field rather than another broad checklist.

**Tradeoffs/alternatives:** links can be mechanically checked; semantics require review. A repository-wide prose linter would be brittle. Do not execute commands copied from docs merely to validate their spelling.

**Acceptance:** cited paths and scripts exist; preload/build descriptions agree; destructive-option policy has one authoritative wording and later focused validation; component/interface edits name the affected current guide; the no-poll rule explicitly permits scoped invalidation and recovery reads.

## R04

**Give semantic plan mutations a defined cross-process owner and recovery unit.** Implementation/design · P1 · High confidence in the boundary; medium in choice of mechanism · L · Owner: engine/store · Dependencies: R02's guarantee table; coordinate the ownership decision with R05.

**Problem and evidence:** [PlanService](../architecture/engine-plan.md), [document stores](../architecture/store-documents.md), [U01](../baseline/uncertainties.md). [In-memory serialization](../../packages/engine/src/plan/service.ts#L187); [Entity write](../../packages/engine/src/plan/service.ts#L881); [Journal write](../../packages/engine/src/plan/service.ts#L1354); [Per-file read/modify/write](../../packages/store/src/document-store.ts#L80).

**Impact if unchanged:** adding more CLI/daemon writers increases the reasoning needed to establish operation-level consistency; a partially applied semantic operation has no single general recovery contract. This is not a reproduced lost-update claim.

**Change:** introduce a PlanMutation boundary with an operation identity and an explicit recovery policy. Prefer one authoritative writer per active store when feasible; otherwise add cross-process per-plan exclusion spanning the semantic operation. Make entity/journal completion recoverable through recorded intent/commit state or a rigorously specified reconciliation procedure. Preserve deterministic keyed identities and existing run fencing.

**Tradeoffs/alternatives:** daemon-only writes simplify ownership but affect offline CLI usage. A filesystem operation journal preserves the current store but adds replay logic. A transactional database is a larger alternative only if measured scale and required atomicity justify migration; it is not a prerequisite assumed by this review. A lock alone does not make multiple writes crash-atomic.

**Acceptance:** two independent service instances have specified conflict/order behavior; an interrupted operation can be retried without duplicate semantic effects; each persistence boundary has a documented recovery outcome; journal/document disagreement is either repaired deterministically or surfaced explicitly; old stores remain readable under an explicit compatibility policy.

## R05

**Make every supported writer observable and define reconnect convergence.** Implementation/design · P1 · High confidence · M–L · Owner: store/daemon/client · Dependencies: shared writer-ownership decision with R04; R10 if wire shape changes.

**Problem and evidence:** [notifications](../architecture/daemon-subscriptions.md), [data synchronization](../baseline/data-contracts.md), [U02](../baseline/uncertainties.md). [Instance-local listeners](../../packages/store/src/plan-store.ts#L38); [Run event listeners](../../packages/store/src/event-store.ts#L75); [Store-wide channel](../../packages/daemon/src/subscriptions.ts#L212); [Reconnect behavior](../../packages/app/src/client/subscription.ts#L173).

**Impact if unchanged:** multi-process-safe storage can still have incomplete live observation. A screen's quiet state need not mean the underlying store is unchanged.

**Change:** select one supported convergence model: route active-store mutations through the daemon, or give the daemon a durable change/revision source that also observes external writers. Add a store generation/watermark or documented snapshot refresh contract for connection gaps. Keep run sequence cursors distinct from plan sequences and from process-local health.

**Tradeoffs/alternatives:** filesystem watches are hints and require reconciliation; global event sourcing is unnecessary if a revision/snapshot scheme suffices. Centralizing writes simplifies feeds but changes command routing. Avoid periodic renderer polling as a substitute for server ownership.

**Acceptance:** a supported external CLI mutation becomes visible to an attached client through the chosen contract; disconnect/reconnect converges each data family; overlap does not duplicate output; run-specific replay remains ordered; cursor domains and invalidation semantics are explicit.

## R06

**Add workspace-level ownership to shared-checkout execution.** Implementation · P1 · High confidence · M · Owner: engine/host adapters · Dependencies: none; use existing ownership conventions from R02.

**Problem and evidence:** [workspace providers](../architecture/engine-workspaces.md), [U03](../baseline/uncertainties.md). [Shared checkout provider](../../packages/engine/src/workspace/provider.ts#L50); [Isolated alternative](../../packages/engine/src/workspace/git-worktree.ts#L20); [planDispatchExecutor](../../packages/engine/src/plan/executors.ts#L512).

**Impact if unchanged:** run and item ownership do not establish exclusive use of one cwd/branch. Parallel provisioning or execution can act on a mutable checkout whose owner is unclear; no collision was executed here.

**Change:** declare provider isolation capabilities and assign a host-plus-canonical-workspace ownership key. For shared local workspaces, refuse or queue incompatible active owners before checkout. Guide parallel workloads to git-worktree provisioning. Specify paused-run ownership, reentry and operator recovery, including remote hosts.

**Tradeoffs/alternatives:** serializing local workspaces sacrifices throughput; worktrees cost disk and require explicit cleanup. Do not automatically reset dirty work or restore a branch without an ownership policy. Inherited child workspaces need deliberate reentrant ownership rather than blanket exclusion.

**Acceptance:** two independent runs targeting the same local checkout have an explicit queue/refusal result; children inherit ownership safely; worktree-backed parallelism remains supported; cancellation/lease loss cannot release a successor's ownership; no implicit deletion of user work is introduced.

## R07

**Make unreadable permission-policy behavior conservative by construction.** Implementation/security · P1 · High confidence · M · Owner: agents/core/daemon · Dependencies: R02 intent decision; later H01 verification.

**Problem and evidence:** [permission architecture](../architecture/agents-permissions.md), [D05](../comparison/differences.md#d05). [Overlay fallback](../../packages/agents/src/permissions.ts#L216); [Default allows](../../packages/core/src/model/agent.ts#L128); [Layer order](../../packages/core/src/model/agent.ts#L289); [Per-ask invocation](../../packages/agents/src/acp-session.ts#L94).

**Impact if unchanged:** a malformed overlay can remove restrictions as well as grants, while documentation tells operators the opposite.

**Change:** represent unavailable policy explicitly and resolve the ask through a conservative result with a visible reason. Preserve configured-deny precedence. If availability requires last-known-good rules, define their lifetime, per-agent scope and startup-with-no-cache behavior; do not silently reinterpret missing and corrupt files identically.

**Tradeoffs/alternatives:** deny-on-error is simplest but can halt useful work; ask-on-error preserves human recovery if an input channel exists. Last-known-good policy improves availability but may retain a revoked grant, so it needs a deliberate revocation model. Pick and document one policy rather than adding implicit fallbacks.

**Acceptance:** valid allow/deny/ask overlays, missing files, malformed files, atomic replacements and unavailable human channels each have an explicit result; no later default silently broadens a previously required restriction because parsing failed; diagnostics identify the policy file without leaking tool payloads or credentials.

## R08

**Define immutable execution-recipe identity and resume provenance.** Implementation/design · P2 · High confidence · M–L · Owner: core/store/engine · Dependencies: R02; coordinate store compatibility with R15.

**Problem and evidence:** [C01](../addenda/corrections.md#c01-workflow-version-identity-is-conditional), [artifact/version storage](../architecture/store-content.md), [session execution](../architecture/engine-execution.md). [Same-version live-first resolution](../../packages/engine/src/orchestrator.ts#L722); [Stored definitions](../../packages/store/src/workflow-store.ts#L48); [Live prompt preparation](../../packages/engine/src/executors/agent-step.ts#L279).

**Impact if unchanged:** a version label and content hash for outputs do not explain every change in resumed behavior when definitions/templates/configuration evolve.

**Change:** choose stored-first resume or reject conflicting content under an existing workflow version. Record a recipe digest plus resolved workflow/template identities, role/model selections and plugin/provider versions needed to explain a turn. Snapshot only the minimum reproducibility inputs with a secret policy; distinguish explainability from deterministic model output.

**Tradeoffs/alternatives:** strict version immutability makes development edits more deliberate; warning-only fingerprints are less disruptive but retain mutable replay. Full prompt/config snapshots improve diagnosis but increase storage/privacy exposure. Never persist credentials merely to complete a snapshot.

**Acceptance:** same-version edited definitions have specified behavior; older stored versions and legacy runs have explicit migration/fallback rules; run detail can explain the recipe actually selected; provenance survives restart; secret fields are excluded or referenced safely; stochastic agent output is not promised reproducible.

## R09

**Unify lifecycle completion ownership across CLI, facade and daemon controls.** Implementation/investigation · P2 · Medium confidence in required change; high in split ownership · M · Owner: engine/daemon/integrations · Dependencies: dedicated H03 trace before selecting a change.

**Problem and evidence:** [program service](../architecture/engine-program.md), [daemon controls](../architecture/daemon-controls.md), [U05](../baseline/uncertainties.md). [Request settlement](../../packages/engine/src/program/service.ts#L77); [Program wrapper](../../packages/engine/src/program/service.ts#L70); [Daemon resume path](../../packages/daemon/src/control.ts#L91).

**Impact if unchanged:** every new entry point must remember which projections belong above the interpreter. Parity is difficult to reason about and could leave Request state dependent on the calling path; this consequence remains unverified.

**Change:** first trace all root-terminal paths. Then place Request settlement in one idempotent lifecycle application service or durable projection subscriber used by every control path. Keep raw workflow runs and program Requests distinct. Document whether command completion means accepted, parked or terminal, including client disconnection behavior.

**Tradeoffs/alternatives:** wrapping all controls is small but easy for a future caller to bypass; a durable projection boundary is stronger but adds recovery machinery. Changing start/resume to asynchronous acceptance is optional API work, not necessary to fix ownership and must not silently change response semantics.

**Acceptance:** direct CLI, facade and daemon paths produce equivalent Request projections for terminal program roots; child completion does not settle its parent Request prematurely; repair is idempotent; parked and cancelled paths are covered; lower-level raw-run embedding remains documented.

## R10

**Reduce parallel representations of the daemon and desktop method contract.** Implementation/engineering · P2 · High confidence · M · Owner: protocol/daemon/app · Dependencies: none; coordinate R05 schema changes.

**Problem and evidence:** [protocol](../architecture/protocol.md), [app client/IPC](../architecture/app-client.md), [wire inventory](../baseline/method-catalog.md). [Daemon assembly](../../packages/daemon/src/methods.ts#L605); [Renderer bridge](../../packages/app/src/bridge.ts#L195); [Preload method map](../../packages/app/src/preload/index.cts#L45); [Compatibility contract](../../packages/protocol/src/version.ts#L103).

**Impact if unchanged:** method additions propagate through multiple manually maintained names, shapes, capability lists and prose. Maintenance already illustrates documentation drift.

**Change:** establish a typed method descriptor/manifest for names, parameter/result schemas, capability and notification domains. Derive repetitive client/bridge adapters and reference tables where practical, while keeping method handlers explicit. Keep privileged local maintenance authorization separate from general write capability.

**Tradeoffs/alternatives:** generated code can obscure security review. A smaller alternative is type-level exhaustiveness plus contract fixtures across existing tables. Do not expose arbitrary RPC through preload merely to remove repetitive wrappers.

**Acceptance:** adding a method has one schema owner; omitted client/bridge registration fails a meaningful check; read-only capability and method availability agree; errors and optional fields retain backward compatibility; the renderer still imports only the permitted workspace packages.

## R11

**Standardize renderer reconciliation without losing local drafts or selection.** Implementation · P2 · High confidence · M · Owner: app/daemon · Dependencies: R05's convergence contract; R03 feed vocabulary.

**Problem and evidence:** [data synchronization](../baseline/data-contracts.md), [Plan](../architecture/app-plan.md), [Config/workflows](../architecture/app-config-workflow.md), [runs](../architecture/app-runs.md). [Adopted generation refresh](../../packages/app/renderer/src/runs/use-runs.ts#L47); [Plan invalidations](../../packages/app/renderer/src/plan/use-plan.ts#L348); [Config invalidations](../../packages/app/renderer/src/config/use-config.ts#L137); [Generation producer](../../packages/app/src/client/subscription.ts#L173).

**Impact if unchanged:** independently authored hooks have different gap-recovery behavior. A short reconnect hidden by the connection-state grace period still needs data reconciliation.

**Change:** expose a common lifecycle primitive for initial snapshot, generation reset, request cancellation and revision handling. Keep each surface's explicit patch/invalidation policy. Add generation-driven reconciliation to surfaces that otherwise depend on missed store-wide messages, preserving drafts and selection.

**Tradeoffs/alternatives:** an all-purpose data store could obscure plan pagination and draft semantics. Prefer a small reusable lifecycle helper and surface-specific folds over replacing every hook or adding polling.

**Acceptance:** Plan, Config, workflow, runs, agents and attention have named gap-recovery rules; stale async reads cannot overwrite a newer generation; unsaved drafts survive refresh and retain stale-write diagnostics; list position/selection remains meaningful; one notification subscription is shared as designed.

## R12

**Define store growth budgets, indexes and retention before adding a database.** Implementation/design · P2 · Medium confidence in scale impact; high in unbounded lifecycle gap · L · Owner: store/engine/operations · Dependencies: R04 ownership and R08 provenance; measurements in R16 before optimization selection.

**Problem and evidence:** [persistence/cleanup](../baseline/data-contracts.md), [store content](../architecture/store-content.md), [projections](../architecture/daemon-projections.md). [Full artifact index fold](../../packages/store/src/artifact-store.ts#L98); [Plan snapshot composition](../../packages/engine/src/plan/service.ts#L287); [Store ports](../../packages/store/src/document-store.ts#L223); [Optional cleanup](../../packages/engine/src/workspace/provider.ts#L23).

**Impact if unchanged:** latency, disk growth and recovery cost can rise with history; response pagination alone does not bound source work. No scale threshold or measured degradation is asserted.

**Change:** define representative history sizes and diagnostic counters, then add narrowly justified indexes/checkpoints. Specify retention roots for active/paused runs, referenced artifact versions, workflow recipes and user workspaces. Provide previewable archive/cleanup operations with explicit compatibility and repair behavior.

**Tradeoffs/alternatives:** compaction loses audit detail unless an archive is retained; indexes become derived state requiring repair. SQLite may be appropriate later, but an indexed file store may suffice. Worktree cleanup must respect user modifications and cannot be inferred from session termination.

**Acceptance:** measurements drive chosen limits; retained references cannot point to silently deleted blobs/recipes; archive preview explains affected objects; interrupted cleanup is resumable; indexes can be rebuilt from authoritative records; no automatic deletion policy is enabled without explicit operator choice.

## R13

**Extract lifecycle responsibilities from concentrated coordinators.** Implementation/refactoring · P2 · Medium confidence · M per slice · Owner: engine/CLI/app · Dependencies: R04 and R09 ownership decisions before restructuring those paths.

**Problem and evidence:** [interpreter](../architecture/engine-interpreter.md), [plan service](../architecture/engine-plan.md), [CLI commands](../architecture/cli-commands.md), [Plan UI](../architecture/app-plan.md). [Orchestrator](../../packages/engine/src/orchestrator.ts#L155); [PlanService](../../packages/engine/src/plan/service.ts#L146); [Command composition](../../packages/cli/src/commands/index.ts#L622); [Surface coordination](../../packages/app/renderer/src/plan/plan-surface.tsx#L68).

**Impact if unchanged:** session pooling, lease fencing, recovery, dispatch and projection changes intersect large coordination modules, increasing change amplification. File length is a navigation signal, not proof of poor code.

**Change:** extract one coherent owner at a time: run execution ownership/lease scope, session lifecycle management, plan mutation application, and typed CLI command families. Preserve plain model/data hook/selection/markup separation already used by renderer surfaces. Give each extraction an explicit invariant and narrow interface.

**Tradeoffs/alternatives:** splitting by line count adds indirection without reducing coupling. A documented private section may suffice where logic is cohesive. Avoid a new dependency-injection framework or broad folder rename.

**Acceptance:** one lifecycle invariant can be understood and changed within its owner; mutable state is not duplicated across helpers; concrete defaults are visible at composition; public behavior stays compatible; focused existing coverage plus the relevant boundary scenarios is sufficient, without mirroring implementation in new tests.

## R14

**Make extension and executable-prompt contracts explicit at registration.** Implementation/assets · P2 · High confidence · M · Owner: core/engine/integrations/workflow authors · Dependencies: R10 for any advertised wire capability; R08 for version identity.

**Problem and evidence:** [extension inputs](../baseline/inputs-extensions.md), [authoring](../architecture/core-authoring.md), [workflow assets](../architecture/workflow-assets.md), [D13](../comparison/differences.md#d13). [Plugin API](../../packages/engine/src/plugin.ts#L14); [Permissive custom node](../../packages/core/src/model/workflow.ts#L308); [Built-in validator](../../packages/core/src/workflow/validate.ts#L104); [Prompt promise](../../templates/program/assess-risks.md#L7).

**Impact if unchanged:** custom executors can defer important shape errors until execution, and prompts can promise unsupported effects. A port declaration does not imply a ready external integration.

**Change:** allow optional executor-owned preflight validation and capability/version metadata, invoked after plugin registration and before a run. Separate plugin registration from session-factory embedding hooks in documentation. Add a small contract review/fixture for shipped templates and remove the unimplemented Maintain promise. Explicitly label T3's transport requirement and generic ACP option limitations.

**Tradeoffs/alternatives:** strict mandatory schemas could break permissive plugins; begin with optional validation plus clear unsupported diagnostics. Plugin isolation is a separate product boundary, not implied by registration metadata. Do not implement T3 or Maintain solely to make old prose true.

**Acceptance:** invalid fields in an opted-in custom node fail before invocation; extension errors identify plugin/node ownership; capability metadata distinguishes declared and discovered support; shipped prompts describe actual downstream actions; no new claim of plugin sandboxing or external interoperability is introduced.

## R15

**Establish release provenance and platform update evidence before broad distribution.** Release/verification · P1 before broader distribution; otherwise P2 · High confidence in missing assurance, not in a runtime defect · M–L · Owner: release/app/operators · Dependencies: R02 compatibility guarantees; R16 execution authorization for platform checks.

**Problem and evidence:** [delivery](../architecture/delivery.md), [desktop updates](../architecture/app-updates.md), [U12](../baseline/uncertainties.md). [Unsigned macOS configuration](../../packages/app/electron-builder.yml#L93); [Private feed and platform gate](../../packages/app/src/main/update-driver.ts#L5); [Restart coordination](../../packages/app/src/main/updates.ts#L32); [Store compatibility gate](../../tools/deploy/orca-release.py#L91); [Publishing workflow](../../.github/workflows/release-publish.yml#L25).

**Impact if unchanged:** configured packaging and tests are not evidence that installed artifacts, signing credentials or update recovery work on supported platforms. Desktop install and daemon replacement are separate ownership paths.

**Change:** define an artifact provenance/signing policy per platform and supported delivery channel. Tie release evidence to one commit and artifact hash; record the actual installed package/update scenarios, maintenance admission, draft preservation, rollback and compatibility outcomes. Keep private-development exceptions explicit.

**Tradeoffs/alternatives:** signing requires externally managed credentials and operational ownership. Restricting distribution is a valid interim alternative. Do not enable automatic update/download merely to simplify verification; preserve explicit user actions and owned-daemon checks.

**Acceptance:** each distributed artifact has revision/hash and an intentional signing status; platform capability claims match tested channels; failed restart restores admission/draft state or reports a recoverable state; external daemons are not stopped as app-owned children; incompatible stores block activation; evidence contains no credentials.

## R16

**Commission a separate, bounded runtime and correctness review.** Verification only · P1 for trust/ownership, P2 for scale/integration · High confidence in need; outcomes unknown · M–L by scenario · Owner: relevant subsystem maintainers · Dependencies: separate authorization to execute; prioritize before affected changes are relied upon.

**Problem and evidence:** [uncertainties](../baseline/uncertainties.md), [test intentions](../baseline/test-catalog.md), [future verification](future-verification.md). [Fenced ownership](../../packages/store/src/lease-store.ts#L343); [Permission fallback](../../packages/agents/src/permissions.ts#L216); [Update state machine](../../packages/app/src/main/updates.ts#L32). Test source and CI declarations were inspected, not run.

**Impact if unchanged:** architectural boundaries could be mistaken for proven runtime guarantees, or generic test volume could hide untested process interleavings.

**Change:** run focused experiments on crash/restart cut points, independent writers, connection gaps, shared workspaces, permission failure, entrypoint parity and packaged updates. Add real SSH/ACP/JEV checks only for supported integrations and with controlled credentials/data. Use representative history measurements before storage optimization.

**Tradeoffs/alternatives:** whole-suite success is useful but insufficient for these boundaries; exhaustive environment matrices are expensive. Start with deterministic fault injection and a small set of supported environments. Keep incidental correctness hypotheses out of the architecture backlog until evaluated.

**Acceptance:** each probe records commit, environment, preconditions, actions and observed outcome; failures are filed separately with reproduction evidence; untested scenarios remain explicitly unverified; no historical CI claim is substituted for evidence. [H01–H03 and V01–V08](future-verification.md) define the initial bounded queue.

## R17

**Make lifecycle diagnostics consistently joinable without adding a telemetry platform.** Implementation/operations · P2 · Medium confidence · M · Owner: core/engine/daemon/app · Dependencies: R04 operation identity, R05 revision model and R09 lifecycle ownership.

**Problem and evidence:** [engineering/observability](../baseline/engineering.md), [events and data](../baseline/data-contracts.md). [Structured logger port](../../packages/core/src/util/logger.ts#L4); [Stable coded errors](../../packages/core/src/errors.ts#L54); [Wire error boundary](../../packages/daemon/src/server.ts#L66); [Separate plan journal](../../packages/store/src/plan-store.ts#L47).

**Impact if unchanged:** a single failure can require manually joining console logs, run sequences, plan revisions, process ownership and desktop state. Existing durable logs are valuable but do not form a cross-process trace by themselves.

**Change:** define a common diagnostic context using existing IDs plus command/plan-operation identity, process/host identity and revision domains. Preserve structured causes at internal boundaries and expose safe, bounded diagnostic bundles for operators. Add only measurements needed by R12's identified read paths.

**Tradeoffs/alternatives:** introducing OpenTelemetry or a metrics service now would add dependencies without an established deployment need. Flat structured logs plus an explicit join schema may suffice. Correlation must not copy prompts, raw config or tokens into general logs.

**Acceptance:** an operator can connect one submitted intent to run/step/session/plan changes and relevant error without inferring ownership from timestamps alone; retries and lease replacement are distinguishable; sensitive payloads are excluded; diagnostic collection has a bounded size and documented retention.

## R18

**Enforce the supported daemon trust boundary at startup and access.** Implementation/security · P1 for non-loopback or multi-user operation; P2 for an explicitly trusted single-user deployment · High confidence · M · Owner: daemon/CLI/app/operators · Dependencies: R02 deployment intent; coordinate protocol changes with R10.

**Problem and evidence:** [daemon transport](../architecture/daemon-transport.md), [raw configuration editing](../architecture/daemon-config.md), [D16](../comparison/differences.md#d16). [Configurable bind](../../packages/daemon/src/server.ts#L97); [Unauthenticated dispatch](../../packages/daemon/src/server.ts#L66); [Unredacted file view](../../packages/daemon/src/config-model.ts#L150); [Explicit local caller model](../../packages/cli/src/commands/index.ts#L622).

**Impact if unchanged:** a configurable bind address can broaden access beyond the trust assumptions of controls and raw config editing. Even loopback does not identify the same OS user. No hostile access was exercised.

**Change:** state supported deployments and require explicit acknowledgement/configuration for non-loopback binding. For multi-user or remote support, add authenticated identity/authorization or an OS-restricted local transport with a supported secure proxy. Treat raw config access as privileged; separate read projections from file/secret access where necessary.

**Tradeoffs/alternatives:** an enforced trusted-local-only product is simpler than remote authentication and is a valid choice. Blindly redacting editable raw text risks destroying hidden values on save; use a structured secret reference/edit contract if that deployment needs redaction. Do not reinterpret write-capability negotiation as caller authorization.

**Acceptance:** unsupported exposure is refused or explicitly opted into with a clear trust statement; supported remote/multi-user access has caller checks; raw config access matches the chosen privilege model; read-only behavior remains distinguishable from authentication; ordinary local app discovery and owned-daemon updates continue to work.
