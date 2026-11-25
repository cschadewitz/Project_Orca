# Documentation differences

Comparison date: 2026-09-29. The [independent baseline](../baseline/index.md) was frozen before this phase. Apply the explicit [source-backed corrections](../addenda/corrections.md) when reading it. [Document inventory and exclusions](documentation-inventory.md) · [Roadmap](../roadmap/index.md).

## Classification and priority

A **contradiction** describes behavior incompatible with inspected source; an **omission** leaves an implemented boundary out of its applicable current reference; **obsolete guidance** describes an earlier state or command; **ambiguous terminology** admits materially different interpretations; **documented intention not implemented** presents a target as active behavior; an **unresolved discrepancy** exceeds what static inspection can prove. Multiple labels are used when needed.

**P1:** resolve before relying on the affected trust, recovery or coordination guarantee. **P2:** next maintenance cycle because it affects design, integration or prioritization. **P3:** localized clarity/onboarding work. No emergency or verified production failure is asserted. Confidence is high in the cited document/source differences; runtime consequences remain unverified.

Implementation is not presumed correct: D05, D07, D15 and D16 require intent or correctness decisions. Clearly labelled proposals and historical release claims are not judged as present-day promises. The project's own [documentation policy](../../docs/RELEASING.md#L237) says docs describe main, not the last release.

## Finding register

| ID | Difference | Classification | Priority |
| --- | --- | --- | --- |
| [D01](#d01) | Current wire reference omits maintenance | Obsolete guidance; omission | P2 |
| [D02](#d02) | Implemented capabilities still listed as future | Obsolete guidance | P2 |
| [D03](#d03) | Conflicting workflow recovery promises | Contradiction; obsolete guidance | P1 |
| [D04](#d04) | Open-debt lists retain implemented changes | Obsolete guidance | P2 |
| [D05](#d05) | Sidecar fallback described as always conservative | Contradiction; unresolved consequence | P1 |
| [D06](#d06) | No-reread rule ignores invalidation messages | Ambiguous terminology | P2 |
| [D07](#d07) | Plan lock and recovery scope unclear | Unresolved discrepancy | P1 |
| [D08](#d08) | “Nothing reloads” conflates documents | Ambiguous terminology | P2 |
| [D09](#d09) | Live dependency evaluation omits sticky states | Ambiguous terminology | P2 |
| [D10](#d10) | Binding design rule names obsolete test command | Obsolete guidance | P2 |
| [D11](#d11) | Engine transport independence overstated | Contradiction at composition boundary | P2 |
| [D12](#d12) | Preload/packaging/tooling prose conflicts | Contradiction; obsolete guidance | P3 |
| [D13](#d13) | Risk prompt promises an absent Maintain effect | Documented intention not implemented | P2 |
| [D14](#d14) | All identifiers described as ULIDs | Ambiguous terminology | P3 |
| [D15](#d15) | Destructive-option shortcut promise too broad | Contradiction; intent clarification | P2 |
| [D16](#d16) | Config access equated with filesystem access | Unresolved trust discrepancy | P1 |
| [D17](#d17) | Update guide absent from documentation index | Omission; obsolete navigation | P3 |

## D01

**Current wire reference omits protocol 1.8 maintenance — P2.**

**Claim/location:** README's current status calls the daemon protocol 1.7. The designated protocol reference omits the maintenance admission method and supervisor identity fields; the newer update guide describes 1.8. Historical “introduced in 1.7” statements are not errors. [Current status](../../README.md#L137); [Protocol reference](../../packages/protocol/README.md#L10); [Update guide](../../docs/UPDATING.md#L5).

**Baseline/evidence:** [wire inventory](../baseline/method-catalog.md), [update coordination](../architecture/app-updates.md); [PROTOCOL_VERSION](../../packages/protocol/src/version.ts#L103), [Maintenance method](../../packages/daemon/src/maintenance.ts#L50), [methodsFor wrapper](../../packages/daemon/src/methods.ts#L621).

**Impact:** client implementers can miss the admission/drain contract used during updates. **Disposition:** update documentation with method availability, shapes and errors; derive current version summaries from the constant while preserving introduction history. [R01](../roadmap/recommendations.md#r01).

## D02

**Current status lists implemented UI and selection features as future — P2.**

**Claim/location:** README/ROADMAP describe Plan graph/risk/decision modes and client agent/model selection as unfinished. ROADMAP says notification tiers are not done anywhere; PLANNING repeats the deferred-mode claim. [Status](../../README.md#L146); [Selection roadmap](../../docs/ROADMAP.md#L73); [UI roadmap](../../docs/ROADMAP.md#L144); [Plan UI status](../../docs/PLANNING.md#L391).

**Baseline/evidence:** [Plan UI](../architecture/app-plan.md), [ACP choices](../architecture/integration-facade.md), [main-process alerts](../architecture/app-main.md); [PLAN_MODES](../../packages/app/renderer/src/plan/plan-surface.tsx#L68), [createAlerts](../../packages/app/src/main/alerts.ts#L102), [setConfigOption](../../packages/integrations/src/acp-facade/orca-acp-agent.ts#L199), [CLI selection flags](../../packages/cli/src/commands/index.ts#L413).

**Impact:** planning and onboarding understate available capabilities and can commission duplicate work. Presence in source does not certify integration quality. **Disposition:** update documentation to distinguish main, shipped release, partial adapter behavior and future scope. Generic proxied agent options remain an acknowledged limitation; do not imply every upstream choice is applied. [R01](../roadmap/recommendations.md#r01).

## D03

**Workflow recovery descriptions disagree about stored versions — P1.**

**Claim/location:** the protocol reference says no definition copy is kept and old versions cannot be served. DATA-MODEL says resume must use the stored copy rather than the file. A historical as-built section in the editing proposal retains the no-copy description while its newer section and ARCHITECTURE explain conditional lookup. [Protocol version lookup](../../packages/protocol/README.md#L185); [Run persistence](../../docs/DATA-MODEL.md#L157); [Historical as-built section](../../docs/design/70-workflow-editing.md#L108); [Current architecture explanation](../../docs/ARCHITECTURE.md#L72).

**Baseline/evidence:** [C01 correction](../addenda/corrections.md#c01-workflow-version-identity-is-conditional), [interpreter](../architecture/engine-interpreter.md); [definitionFor](../../packages/engine/src/orchestrator.ts#L722), [FileWorkflowVersionStore](../../packages/store/src/workflow-store.ts#L48), [workflowsGet](../../packages/daemon/src/read-model.ts#L662).

**Impact:** operators and clients receive incompatible promises about resuming after a workflow changes. The independent baseline also required C01. **Disposition:** document same-version live-first lookup, stored older versions, legacy fallback and failure code. Label historical as-built text as superseded; retain the editor proposal. Decide stronger immutability separately. [R02](../roadmap/recommendations.md#r02), [R08](../roadmap/recommendations.md#r08).

## D04

**Open-debt lists retain changes present in source — P2.**

**Claim/location:** ROADMAP retains artifact-index locking (#102), stale writes after lease break (#197), released-item repair (#123) and automatic re-decision (#104) as open debt. PLANNING repeats #104. [Released-item debt](../../docs/ROADMAP.md#L179); [Storage debt](../../docs/ROADMAP.md#L186); [Planning limitations](../../docs/PLANNING.md#L398).

**Baseline/evidence:** [artifact store](../architecture/store-content.md), [ownership](../architecture/store-ownership.md), [program projections](../architecture/engine-program.md), [plan service](../architecture/engine-plan.md); [Locked log append](../../packages/store/src/artifact-store.ts#L107), [Ownership-fenced write contract](../../packages/store/src/lease-store.ts#L343), [recoverReleasedWorkItem](../../packages/engine/src/program/work-items.ts#L47), [Automatic decision guard](../../packages/engine/src/plan/service.ts#L1007).

**Impact:** the queue obscures current work by repeating older mechanisms. These implementations do not prove every race is solved. **Disposition:** reconcile references with source and the versioned implementation notes; move unproven scenarios to an explicit runtime-verification queue. [R01](../roadmap/recommendations.md#r01), [R16](../roadmap/recommendations.md#r16).

## D05

**Malformed-sidecar fallback is described as always conservative — P1.**

**Claim/location:** ADR 0009 says skipping an unreadable sidecar loses grants but never restrictions; the source comment repeats this reasoning. [ADR guarantee](../../docs/adr/0009-permission-grants-in-a-workspace-sidecar.md#L130); [Source claim](../../packages/agents/src/permissions.ts#L211).

**Baseline/evidence:** [U09](../baseline/uncertainties.md), [permission layering](../architecture/agents-permissions.md); [Rule schema](../../packages/core/src/model/agent.ts#L59), [Default rules](../../packages/core/src/model/agent.ts#L128), [Effective order](../../packages/core/src/model/agent.ts#L289), [Malformed-file fallback](../../packages/agents/src/permissions.ts#L216), [Per-ask consumer](../../packages/agents/src/acp-session.ts#L94).

**Impact:** sidecar rules can deny or ask as well as allow. Dropping that layer can expose a later default allow for the same workspace tool request. Configured deny rules still precede overlays; this is not a claim that all permissions are bypassed. Runtime consequences remain untested. **Disposition:** clarify intent and investigate implementation; choose a conservative unavailable-policy result or a defined last-known-good policy. Correct the guarantee. [R02](../roadmap/recommendations.md#r02), [R07](../roadmap/recommendations.md#r07), [H01](../roadmap/future-verification.md#h01).

## D06

**The no-reread rule ignores invalidation messages — P2.**

**Claim/location:** AGENTS and the renderer implementation guide say a surface never rereads a list because a notification arrived. The protocol reference describes plan.changed as invalidation. [Working rule](../../AGENTS.md#L130); [Renderer rule](../../docs/design/60-implementation.md#L448); [Plan notification](../../packages/protocol/README.md#L615).

**Baseline/evidence:** [notification domains](../baseline/data-contracts.md), [Plan](../architecture/app-plan.md), [Config](../architecture/app-config-workflow.md); [Plan invalidation consumer](../../packages/app/renderer/src/plan/use-plan.ts#L348), [Config invalidation consumer](../../packages/app/renderer/src/config/use-config.ts#L137), [Reconnect generation](../../packages/app/renderer/src/runs/use-runs.ts#L47).

**Impact:** following the universal wording would remove required refresh behavior or miss reconnect reconciliation. **Disposition:** distinguish full-object patches, one-object resolution, scoped invalidation rereads and reconnect snapshots. Preserve the no-periodic-polling rule. [R03](../roadmap/recommendations.md#r03), [R11](../roadmap/recommendations.md#r11).

## D07

**Plan serialization and crash-consistency promises need narrower scope — P1.**

**Claim/location:** PLANNING calls intake serialized per plan and says journal/show cannot disagree even if a process dies during dispatch recovery. The wire reference attributes plan writes to a per-plan lock without naming its process scope. [Serialization claim](../../docs/PLANNING.md#L173); [Crash claim](../../docs/PLANNING.md#L259); [Control lock description](../../packages/protocol/README.md#L713).

**Baseline/evidence:** [U01](../baseline/uncertainties.md), [PlanService](../architecture/engine-plan.md), [document stores](../architecture/store-documents.md); [In-memory queue](../../packages/engine/src/plan/service.ts#L187), [Document write](../../packages/engine/src/plan/service.ts#L881), [Separate journal append](../../packages/engine/src/plan/service.ts#L1354), [File-level atomicity](../../packages/store/src/document-store.ts#L80).

**Impact:** local queues, per-file exclusion and deterministic identities do not themselves establish cross-record transactions or immediate cross-process recovery agreement. No crash outcome was reproduced. **Disposition:** clarify single-process ordering, file exclusion, repair triggers and immediate/eventual consistency separately; investigate semantic operation ownership before adding writers. [R02](../roadmap/recommendations.md#r02), [R04](../roadmap/recommendations.md#r04), [R16](../roadmap/recommendations.md#r16).

## D08

**“Nothing reloads” conflates configuration documents — P2.**

**Claim/location:** config.set covers both OrcaConfig and the sidecar, then says nothing reloads until the next serve. ADR 0009 separately describes per-ask reload. [Activation claim](../../packages/protocol/README.md#L368); [Policy lifetime](../../docs/adr/0009-permission-grants-in-a-workspace-sidecar.md#L120).

**Baseline/evidence:** [input lifetimes](../baseline/inputs-extensions.md), [config editing](../architecture/daemon-config.md); [Policy consumer](../../packages/agents/src/acp-session.ts#L94), [Bootstrap config](../../packages/cli/src/bootstrap.ts#L105), [Config document owner](../../packages/daemon/src/config-model.ts#L103).

**Impact:** operators may restart unnecessarily for permissions or expect other configuration to activate live. **Disposition:** document lifetimes per document: main config at bootstrap, sidecar per ask, preferences under app ownership. [R02](../roadmap/recommendations.md#r02).

## D09

**Live dependency evaluation has sticky states — P2.**

**Claim/location:** ARCHITECTURE and ADR 0006 use an unqualified “evaluates dependencies live”; PLANNING specifies the distinction. [Overview](../../docs/ARCHITECTURE.md#L363); [ADR](../../docs/adr/0006-plan-as-persistent-dependency-graph.md#L24); [Qualified rule](../../docs/PLANNING.md#L201).

**Baseline/evidence:** [scheduler](../architecture/core-planning.md), [U10 intent clarification](../addenda/corrections.md#documentation-clarifies-one-uncertainty-without-changing-source-facts); [evaluateDependency](../../packages/core/src/plan/schedule.ts#L102) short-circuits already satisfied/waived edges.

**Impact:** reopening a target can be mistaken for automatic invalidation of every satisfied edge. **Disposition:** name sticky states, explicit reopening controls and persisted status versus derived evaluation. Do not change scheduling merely to fit an abbreviated description. [R02](../roadmap/recommendations.md#r02).

## D10

**Binding design rule names an obsolete contrast command — P2.**

**Claim/location:** RULES prescribes node --test over design/test/*.test.mjs. [Contrast rule](../../docs/design/RULES.md#L26).

**Baseline/evidence:** [design package](../architecture/design.md), [engineering](../baseline/engineering.md); [Actual test source](../../packages/design/test/contrast.test.ts#L108), [Vitest configuration](../../vitest.config.ts#L2), [Workspace test script](../../package.json#L14). The referenced test path/format does not match the tracked suite.

**Impact:** contributors following a binding rule reach the wrong verification entry point. No command was executed. **Disposition:** update the command/path and add lightweight documentation path consistency to a later task. [R03](../roadmap/recommendations.md#r03).

## D11

**Engine transport independence is overstated at composition — P2.**

**Claim/location:** ARCHITECTURE says engine uses ports and never concrete transports. [Dependency claim](../../docs/ARCHITECTURE.md#L39).

**Baseline/evidence:** [interpreter](../architecture/engine-interpreter.md), [CLI composition](../architecture/cli-bootstrap.md); [Concrete default](../../packages/engine/src/orchestrator.ts#L199), [Injected composition](../../packages/cli/src/bootstrap.ts#L160).

**Impact:** the injectable seam is real, but its ACP default matters to alternate embedders and transport setup ownership. **Disposition:** document the default/override now; move the default only if justified during a focused composition refactor. [R03](../roadmap/recommendations.md#r03), [R13](../roadmap/recommendations.md#r13).

## D12

**Build prose conflicts with preload and packaging structure — P3.**

**Claim/location:** DEVELOPMENT calls main and preload ordinary ESM before correctly describing CJS preload; it anticipates electron-builder landing and calls all tools plain JavaScript. [Module-format claim](../../docs/DEVELOPMENT.md#L45); [Packaging status](../../docs/DEVELOPMENT.md#L49); [Tooling claim](../../docs/DEVELOPMENT.md#L382).

**Baseline/evidence:** [delivery](../architecture/delivery.md), [Electron boundaries](../architecture/app-main.md); [CJS preload](../../packages/app/src/preload/index.cts#L45), [Packager dependency](../../packages/app/package.json#L14), [Python deployment tool](../../tools/deploy/orca-release.py#L241).

**Impact:** contradictory nearby guidance makes moving the preload or extending delivery harder. **Disposition:** document main ESM, preload CJS, renderer Vite, daemon resource bundle and packager separately; include Python tooling. [R03](../roadmap/recommendations.md#r03).

## D13

**The risk-assessor prompt promises an unimplemented Maintain effect — P2.**

**Claim/location:** the shipped prompt says realized risks reopen work; PLANNING explicitly leaves that loop for later. [Operational prompt](../../templates/program/assess-risks.md#L7); [Future loop](../../docs/PLANNING.md#L461).

**Baseline/evidence:** [prompt assets](../architecture/workflow-assets.md), [risk commands](../architecture/engine-plan.md); [Risk update](../../packages/engine/src/plan/service.ts#L860), [Schedule calculation](../../packages/core/src/plan/schedule.ts#L222). Document updates and risk-aware scheduling do not establish automatic follow-up Request creation or reopening.

**Impact:** an agent-facing asset promises an unavailable downstream effect. **Disposition:** qualify the prompt in a later asset change; retain autonomous Maintain as future until lifecycle and permissions are designed. [R14](../roadmap/recommendations.md#r14). No existing prompt was edited by this review.

## D14

**Identifier guidance treats all IDs as ULIDs — P3.**

**Claim/location:** DATA-MODEL opens with a blanket prefixed-ULID rule. [Identifier rule](../../docs/DATA-MODEL.md#L5).

**Baseline/evidence:** [vocabulary](../baseline/glossary.md), [domain identity](../architecture/core-domain.md); [Deterministic identity helper](../../packages/core/src/ids.ts#L61), [Planning identity consumer](../../packages/engine/src/plan/service.ts#L749).

**Impact:** consumers should not infer timestamps or parse all planning IDs as ULIDs. **Disposition:** distinguish generated temporal IDs from deterministic keyed IDs and require opaque handling in clients. [R03](../roadmap/recommendations.md#r03).

## D15

**Workflow authoring overstates destructive-option shortcut protection — P2.**

**Claim/location:** WORKFLOWS says a destructive choice is never bound to a number key; the design contract is narrower about digit 1. [Authoring rule](../../docs/WORKFLOWS.md#L176); [Design rule](../../docs/design/20-attention-and-gates.md#L47).

**Baseline/evidence:** [attention](../architecture/app-attention.md), [inputs](../baseline/inputs-extensions.md); [bindOptions](../../packages/app/renderer/src/attention/card-model.ts#L35) sorts safe options first and assigns digits by display order, including destructive options within the first nine.

**Impact:** authors need an accurate keyboard-safety contract. The all-destructive edge case is reserved for later review, not claimed tested. **Disposition:** clarify the intended contract, align the guides, and verify boundary cases separately. [R03](../roadmap/recommendations.md#r03), [R16](../roadmap/recommendations.md#r16).

## D16

**Raw-config access is equated with filesystem access without its trust assumptions — P1.**

**Claim/location:** the protocol guide says the port is loopback and unredacted config reveals nothing cat could not. CLI help explicitly permits any local process to call controls. [Config trust claim](../../packages/protocol/README.md#L322); [CLI trust statement](../../packages/cli/src/commands/index.ts#L622).

**Baseline/evidence:** [RPC boundary](../architecture/daemon-transport.md), [config editor](../architecture/daemon-config.md), [U06](../baseline/uncertainties.md); [Configurable bind address](../../packages/daemon/src/server.ts#L97), [Dispatcher](../../packages/daemon/src/server.ts#L66), [Raw document read](../../packages/daemon/src/config-model.ts#L150).

**Impact:** loopback is a default, not an invariant; network callers are not identified as the OS user allowed to read the file. Raw configuration may include environment values. This is a trust-assumption gap, not observed exploitation or a demand for multi-tenant design. **Disposition:** define trusted single-user loopback deployment, deliberate non-loopback opt-in, and authentication/secret handling where required by supported deployment. [R02](../roadmap/recommendations.md#r02), [R18](../roadmap/recommendations.md#r18).

## D17

**Documentation navigation omits the update guide and undercounts ADRs — P3.**

**Claim/location:** the index has no UPDATING entry and describes seven structural decisions; nine ADRs are tracked. [Documentation index](../../docs/README.md#L14); [Update guide](../../docs/UPDATING.md#L1).

**Baseline/evidence:** [update ownership](../architecture/app-updates.md), [delivery](../architecture/delivery.md); [Updates](../../packages/app/src/main/updates.ts#L16), [Deployment activation](../../tools/deploy/orca-release.py#L241). The [inventory](documentation-inventory.md) lists all nine ADRs.

**Impact:** an operator entering through the index can miss the guide for a coordination-sensitive release path. **Disposition:** add the guide, avoid fragile counts and link a single current-capability ledger. [R01](../roadmap/recommendations.md#r01).

## Agreements and intentionally future-facing work

Artifact-only handoffs, per-run projections, child-run concurrency, ACP isolation, injected sessions, separate plan documents/journal, protocol-only renderer access, generated design tokens and shared interaction primitives remain valuable guidance. The [assessment](../roadmap/assessment.md) links their source evidence.

The absent T3 production transport, workflow editing/publish/dry-run features, queued offline writes, capacity allocation and Maintain loop are explicitly future-facing in the applicable guides. Their absence alone is not a documentation defect. UPDATING acknowledges deployment/credential prerequisites. Historical “tests passed” statements are not adopted as current runtime evidence.

Omissions above are scoped to an applicable reference or navigation surface, not claims that a feature is undocumented everywhere. Detailed guides already contain accurate explanations for maintenance, update delivery, workflow lookup and Plan modes. Correct those summaries without replacing the useful detail.
