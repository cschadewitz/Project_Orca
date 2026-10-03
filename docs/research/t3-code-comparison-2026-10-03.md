# Project ORCA and T3 Code comparative review

Reviewed **2026-10-03 UTC**. This review is for ORCA maintainers deciding what to
build, integrate, and preserve. It compares implemented source, user experience
contracts, tests, and existing ORCA plans. It does not treat similar names as
equivalent capabilities.

**Recommendation:** keep ORCA focused on repeatable, inspectable workflow execution
and cross-request planning. Borrow T3's approach to starting work, reviewing changes,
provider capability discovery, and recovering a trustworthy client view. Investigate
using T3 as an optional front end before duplicating its full coding environment.
T3 now implements meaningful orchestration itself, so “T3 is just chat” would be a
poor basis for product decisions.

The most consequential factual correction is that **T3 now has an ACP client**.
ORCA's older integration description is stale. However, neither ORCA running inside
T3 nor ORCA driving current T3 threads was established by this review. T3's registry
requirements and ORCA's obsolete adapter assumptions still require integration work. [T1] [O13]

## Scope and confidence

| Project | Inspected source | Meaning of the baseline |
| --- | --- | --- |
| ORCA | [`3702da5b38dc449280c2837366615de741e9c45c`](https://github.com/cschadewitz/Project_Orca/tree/3702da5b38dc449280c2837366615de741e9c45c) | Current task checkout before this documentation change; includes the operator runtime and production MCP integration merge. |
| T3 Code | [`f1dcd93931b322d587a7253856f44625a6afbce0`](https://github.com/pingdotgg/t3code/tree/f1dcd93931b322d587a7253856f44625a6afbce0) | Public default-branch source downloaded for this review. This is a source snapshot, not an assertion that every feature is in a stable release or every installed client. |

Three independent source passes covered ORCA, T3 product behavior, and T3 runtime
architecture; findings were reconciled against source. ORCA's open and relevant
closed issue inventory was read on the review date. No issues, labels, milestones,
or release commitments were changed.

Evidence references below resolve to the companion [source ledger](t3-code-evidence-2026-10-03.md),
with immutable source links and implementation/test entry points. **Implemented**
means a source path exists and is wired or corroborated by focused tests; it does
not mean this review executed it. **Gap** means no equivalent first-class feature
was found in the inspected contracts, services, and surfaces. It does not mean an
agent could never approximate it with prompts or shell commands. Recommendations
and relative effort assessments are judgments, not measured outcomes.

Neither app was installed or exercised interactively, no real provider was called,
and no benchmark or security assessment was run. Consequently this report makes
no comparative claims about actual latency, reliability rates, model quality,
accessibility compliance, operating-system support quality, or production readiness.
Existing test names establish verification intent and coverage structure, not new
passing test results.

## What the products organize

ORCA organizes **work that should traverse a defined process**. A Request becomes
work items; workflow steps consume and produce validated artifacts; branching,
review loops, gates, and plan dependencies determine what may happen next.
Its desktop app exposes the operational state of that process. [O1] [O2] [O3]

T3 organizes **coding conversations and their execution environments**. Projects
contain threads; a thread contains successive user-visible runs and execution
nodes, provider conversations, requests, checkpoints, and delegated tasks. Its
web, desktop, and mobile clients bring agent interaction, code review, Git, terminals,
and remote environments into one working surface. [T1] [T2] [T3] [T4]

These models overlap, but the following distinctions matter when designing an adapter:

| Concept | ORCA | T3 Code | Consequence |
| --- | --- | --- | --- |
| Run | A workflow graph execution, potentially containing many agent turns and child runs | A counted user-visible turn in an app thread, with execution nodes inside it | A T3 run is closer to an agent turn than an ORCA workflow run. Preserve both IDs. |
| Plan | Persistent cross-request dependencies, schedule explanations, risks, decisions and journal | Conversation/provider plans, task delegation and scheduled prompts | A plan-mode response is not an ORCA dependency or decision record. |
| Completion | Step result, artifact validation, graph routing and final outcome | Provider/run terminal state plus separately settling checkpoints and other follow-up work | Agent idle, accepted cancellation, and settled result are different facts. |
| Handoff | Explicit artifact references with provenance and validation | Native session/fork when supported; portable history transfer and delegated results otherwise | Context transfer does not establish a workflow deliverable contract. |
| Recovery | Reconstruct workflow progress, reuse recorded children and completed steps, respect leases | Recover thread projections, receipts, outbox effects and provider/session state; checkpoint policies vary | Neither event sourcing nor a file checkpoint guarantees exactly-once external effects. |

Sources: [O1] [O2] [O5] [O6] [T2] [T5] [T6] [T7].

## Capability comparison

### Where ORCA has the stronger first-class model

| Area | ORCA evidence | T3 evidence and remaining distinction |
| --- | --- | --- |
| Reusable workflow language | Named graphs with agent, decision, gate, loop, parallel, subworkflow, set and extension nodes; templates and configurable completion/retry rules. [O1] [O2] | Execution graphs and delegated tasks are implemented. No equivalent authored graph language with reusable stage routing and artifact contracts was found. T3's “workflow” references also include provider-native background work and forge CI jobs. [T2] [T8] |
| Validated deliverables | Attempt-specific paths, front-matter/field/content validation, bounded correction prompts, content-addressed storage and producer/input provenance. [O2] | Checkpoints, diffs, attachments and context transfers preserve work and context; these are not required typed outputs governing progression to a next workflow stage. [T5] [T6] |
| Cross-request planning | Work-item and stage dependencies, external dependencies, explicit waivers, explainable scheduling and durable claims. [O3] | Recurring tasks, cross-thread messages and child delegation exist. No equivalent dependency scheduler spanning a durable portfolio of Requests was found. [T8] |
| Risk and decision policy | Risk exposure and weighted decision matrices are domain entities that influence scheduling, with journaled decisions. [O3] | Agent plan/review text can discuss risk, but no corresponding first-class risk register, weighted decision matrix or dependency waiver model was found. [T2] [T8] |
| Gates that survive the agent turn | Workflow gates can park durably; live provider permission callbacks have a distinct owner/session/turn/invocation lifetime. [O4] | Runtime requests and human approvals exist, including capability-specific handling. The missing equivalent is a reusable workflow-stage gate and its artifact-driven routing, not human approval generally. [T2] [T9] |
| ACP facade and lightweight remote workers | ORCA is both an ACP client and an ACP agent; SSH can carry an agent's stdio plus remote filesystem operations without installing an ORCA worker daemon. [O7] | T3 is an ACP client and manages remote T3 server environments, including SSH setup. An ACP server facade exporting the whole T3 orchestrator was not found. These are different deployment boundaries. [T1] [T4] |
| Enforced operational design system | Token generation, status glyph plus word, shared menus/splitters/lists, keyboard registry and structural/accessibility tests. [O8] | T3 provides extensive keyboard and platform interactions. This review did not establish equivalent repository-wide design invariants; it also did not establish inferior accessibility. [T3] |

ORCA should retain these strengths while acknowledging their limits. Artifact
validation checks declared structure and values, not the truth of an agent's claims.
A passed test-report artifact does not itself prove the tests ran. Workflow recovery
can retry an interrupted agent step, which may already have performed an external
mutation. Existing file-store locks and fences do not turn all related records into
one atomic transaction. JEV remains a proof of concept, not demonstrated semantic
validation of arbitrary deliverables. [O2] [O5] [O9]

### Where T3 provides more of the coding experience

| Area | T3 implementation | ORCA position at the inspected source |
| --- | --- | --- |
| First-run and provider setup | Welcome flow selects environments, checks installed/authenticated agents, and imports projects and bounded native history. Registry provider setup is integrated into settings. [T1] [T10] | CLI/bootstrap, agent ping, config editing and synthetic first-job fixtures exist. A complete guided configuration/launch journey and packaged Mac first-run acceptance remain tracked work. [O7] [O10] |
| Conversation interaction | Rich composer/context references, queued and steered messages, provider/model selection, history and provider switching, native-session import, forks and delegation. [T1] [T3] [T6] [T8] | Workflow prompts, ACP model/options, step output, gates and explicit revision input exist. A persistent general-purpose coding chat/composer is not an ORCA surface. [O2] [O4] [O6] [O8] |
| Reviewing and delivering code | File diffs, Git status, commits/branches/worktrees, linked PRs and review/merge actions across supported forge drivers, including stack workflows. [T5] | Artifacts and logs can report code changes; workspace providers create/select checkouts. No comparable built-in repository diff/staging/PR workbench was found. Tracker adapters and conflict-safe publishing are planned. [O2] [O7] [O11] |
| Terminal and project actions | Server-owned PTY terminals, project actions and terminal lifecycle shared with the clients. [T3] | Agents can execute their own command tools and ORCA displays summaries. No interactive PTY terminal surface; the ACP client advertises `terminal: false` and provides no ACP terminal service. [O7] [O8] |
| Visual feedback and browser work | Image/context attachments, collaborative browser automation, semantic snapshots/recordings, desktop SnapShots, and simulator/emulator tools, including remote device hosts. Platform constraints apply. [T3] | Artifact inspection exists, but no comparable capture-to-composer/browser/device workflow was found. This is optional coding-environment scope, not a prerequisite for ORCA orchestration. [O8] |
| Mobile and remote access | Native mobile plus web/desktop, multiple environments, pairing, SSH management and relay/Tailscale paths. [T4] | Remote ACP hosts and remote daemon attachment exist. No equivalent mobile app, browser client or consumer pairing experience; private MCP access has separate tracked deployment/acceptance work. [O7] [O10] |
| Usage and account visibility | Provider/account usage, model breakdowns, API-equivalent cost estimates, limits and account management with provider-specific availability. [T11] | Model selection exists; attributable usage, budgets and account routing remain planned. ORCA cannot currently supply agent cost, run completion percentage or ETA; do not add approximations or placeholder metrics. [O8] [O11] |
| Recurring work | Persisted interval/fixed-time tasks, controls and MCP scheduling. Successful dispatch is distinct from successful agent completion. [T8] | The plan scheduler orders eligible work; it is not a recurring wall-clock task scheduler. Autonomous Maintain and calendar/capacity scheduling remain future work. [O3] [O11] |
| External change monitoring | Server-owned PR watching can wake work on checks, reviews and conflicts, with terminal/limit stopping rules. [T5] [T8] | External plan dependencies exist; forge import, ownership and publishing adapters remain tracked work. Monitoring could feed those dependencies rather than create a competing scheduler. [O3] [O11] |
| Checkpoints and conversation forks | Workspace snapshots, checkpoint diffs and rollback coordinated with provider capabilities; fork and portable continuation behavior. [T5] [T6] | Event-log resume and explicit continuation/revision paths exist. General checkpoint-based new attempts with external side-effect review remain broader work. [O5] [O6] [O11] |
| Shared client state across platforms | A common per-environment connection/state runtime, bounded history pages, cached state plus cursor, and separate transport/synchronization state. [T7] | The Electron main process owns connection/reconnect and subscriptions; the renderer uses typed streams. Cross-process observation and complete convergence across data families remain limitations. [O8] [O12] |
| Queues while disconnected | Mobile has a durable draft/attachment outbox. Server-side follow-up queues persist and are held for explicit Resume after restart. [T3] [T4] | Retained direct-admission intent supports recovery of a specific action; it is not a general offline message/write queue. [O6] [O8] |

“More” here means implemented product breadth, not measured quality. For example,
T3 native-history import is deliberately lossy and bounded; portable handoffs omit
provider reasoning/tool state and attachments; not every provider supports every
operation. Usage estimates are not subscription billing. ORCA should copy the
explicitness of those limitations along with the features. [T6] [T10] [T11]

### Important shared foundations

Both projects already have typed contracts, persistent events, provider abstractions,
human approvals, model selection, worktree-related support, cancellation, reconnect
logic, and tests using deterministic substitutes for external providers. Both have
MCP-related implementation. T3 can delegate across providers and inspect other
threads; ORCA's operator interface can inspect and control workflow execution.
Those are different scopes, not “MCP versus no MCP.” [O1] [O4] [O6] [O7] [T2] [T8] [T9]

ORCA's current source includes authentication, typed admission, retry receipts,
configuration generations, live permission continuity, and production operator
composition. Older roadmap prose and still-open parent issues do not erase those
implementations. Conversely, source wiring and synthetic integration coverage do
not establish a real Cal connection or packaged beta acceptance. [O4] [O6] [O10]

## Lessons from T3 engineering

### Commit intent before performing effects

T3's current EventSink commits orchestration events, projections, command receipts,
and pending effects within a SQLite transaction. The effect worker performs provider
and filesystem work afterward, feeding outcomes back into orchestration. This makes
“accepted” a precise durable milestone while leaving execution and finalization
separate. Its existing design document still describes an outbox as future work;
the implementation and newer architecture document establish that it exists. [T2]

Two details are useful beyond adopting a transaction: post-commit publication keeps
sequence order so a cursor cannot skip an earlier event, and a retrying rollback
blocks later lifecycle effects on that thread. Metadata work has a separate lane.
These are ordering contracts worth testing explicitly. [T2]

**Application to ORCA:** build the planned store contracts and SQLite backend around
the invariants that actually need a shared commit: admission identity, dispatch
intent, related metadata, and receipts. Preserve the existing protected payload,
lease and authorization boundaries. Do not replace recent admission/recovery work
with an unrelated generic event bus. An outbox alone cannot make an arbitrary
provider command exactly once: a crash between an external effect and its recorded
result still needs reconciliation or an explicit uncertain state. [O5] [O6] [O11]

### Treat lifecycle identities as data

T3 separates app threads/runs/nodes from provider threads/turns and from later
checkpoint/finalization work. A child completion cannot complete the parent.
Interrupt request acceptance is not terminal execution. Late results must not
overwrite a newer run attempt. ORCA has similarly important workflow, child-run,
step-attempt and live-input identities. [T2] [T8] [O1] [O4]

**Application to ORCA:** make adapter conformance fixtures include late completion,
duplicate terminal events, child-before-parent completion, cancellation races and
restart after acceptance. This is especially urgent for the dormant T3 adapter,
which currently treats several idle/error/interrupted signals as `end_turn`
without an exact active-turn match. [O13]

### Separate transport health from data freshness

T3 has one connection owner per environment. Transport reconnect, authorization
renewal, shell synchronization and thread history synchronization are separate
operations. Cached data can remain readable while stale. State and its cursor are
retained together; disconnect does not automatically replay mutations. [T7]

**Application to ORCA:** extend the existing connection machine and notification
stream with explicit resynchronization evidence where missing. A green socket must
not imply that Plan, Config, catalog and externally written runs have converged.
Preserve the existing five-second connection-blip policy rather than reproducing
it in every screen. Retry intent belongs to the durable admission client, not to a
generic reconnect callback. [O6] [O8] [O12]

### Bound the entire history path

T3 has regression tests for the active v2 wire path: a recent-history target, older
HTTP pages, event and byte budgets for replay, indexed sequence reads, and startup
selection of only relevant recovery candidates. Wire projections omit raw command
output and tool result bodies while keeping status and retrieval paths. The docs
explicitly distinguish payload bytes from process memory and warn that old v1
benchmark fixtures can miss the current path. [T7] [T12]

**Application to ORCA:** measure growth in both histories and catalog size. Enforce
limits before expensive decode/hydration, not only in the renderer or final response.
Keep raw/protected records separate from bounded display models. Use ORCA's existing
persistence baseline work before selecting a backend or optimization. A virtualized
list does not establish bounded daemon work or network payloads. [O5] [O8] [O12]

### Make provider differences explicit

T3 capability policy distinguishes native support, fallback behavior and unavailable
operations. Its generic ACP client negotiates supported versions and session/model
features; permission and rollback semantics vary by agent. Portable handoffs have
budgets, omissions and retrieval references rather than claiming native context
parity. [T1] [T6] [T9]

**Application to ORCA:** use declared and observed capability data to preview whether
a selected role/model can perform a workflow requirement. Report “not probed” and
“unsupported” separately from failure. Preserve artifact contracts when provider
conversation continuity changes; a transcript summary must not silently substitute
for a required specification or review artifact. [O2] [O7] [O11]

### Keep permission and recovery boundaries visible

T3's initial new-thread default is Full access. Its generic ACP Auto/Full access
modes approve incoming requests automatically, while some native providers implement
Auto through provider review. Agent-owned tools still run under the agent's own
sandbox and mode. Likewise, T3 environment/project authorization is not a per-project
filesystem sandbox, and its relay is a trusted broker. Integrated remote access
should not be read as stronger tenant isolation. ORCA should retain its own authority,
tool-permission and workflow-gate distinctions. [T1] [T4] [T9] [O4]

T3's file restore requires an isolated worktree and rejects shared or overlapping
directories and conflicting sessions. Generic ACP cannot rewind native conversation;
after file rollback it starts a fresh agent session. This is a useful model for an
ORCA recovery preview: state exactly which files, artifacts, workflow progress and
conversation state will change, then recheck ownership before execution. A Git
checkpoint cannot reverse a published PR, deployment or other external effect.
[T1] [T5] [O5]

### Test the real seams and keep their evidence current

T3's replay harness substitutes the provider transport while exercising orchestration,
SQL state, projections and recovery. Its targeted tests also cover limits on history
and wire payloads. ORCA already has scripted ACP subprocess tests and newer compiled
MCP tests through real daemon/auth/storage boundaries. These are foundations to
extend, not missing testing disciplines. [T12] [O6] [O7]

**Application to ORCA:** collect sanitized protocol fixtures and run the same
behavioral contract against adapters. Include persisted histories from previous
versions and failed/restarted operations. Tie performance and packaged acceptance
to the exact source and artifact identity. Avoid equating a mocked turn, a passing
schema test, and a successful real-provider/platform journey.

## Integration assessment

The earlier integration premise needs replacing in three places: ORCA's README,
architecture guide and T3 integration section. This documentation change corrects
those descriptions. The adapter source remains unchanged and its old introductory
comment should not be used as a current description of T3. [O13] [T1]

| Direction | Reusable foundation | Work still required | Judgment |
| --- | --- | --- | --- |
| T3 launches ORCA as an ACP agent | ORCA exports `orca acp`; T3 implements generic ACP. | T3 currently resolves an official registry ID and distribution before considering an executable override. The override retains registry arguments/environment; it is not a general command-plus-args provider. Establish a legitimate registry entry/distribution or supported custom driver, then test facade compatibility, gates, cancel, model options and restart limitations. | Most promising experiment for using ORCA as one agent in a rich coding surface; not a verified drop-in integration. |
| A T3-hosted agent operates ORCA through MCP | ORCA has stdio MCP and an authenticated HTTP handler; providers can have their own MCP configuration. | Validate configuration in the selected underlying provider, credential/target scoping, tool discovery, retry keys, bounded results and exact approval identity. T3's own provider-scoped MCP server is not proof of a generic user-configured MCP client. | Potentially useful when the agent should inspect or operate existing ORCA work rather than wrap an entire conversation as an ORCA Request. |
| ORCA drives T3 threads as its agent backend | ORCA has `AgentSession` and a dormant T3 adapter. | Pin current v2 command/envelope/event contracts, authenticated transport, workspace binding, exact turn completion, approvals/questions, cancellation, failure propagation and reconnect/idempotency. | Largest maintenance surface. Justify it by a concrete need for T3-managed providers/workspaces before implementing it. |

Sources: [O6] [O7] [O13] [T1] [T2] [T8] [T9].

The existing adapter is more than one transport implementation away from completion:

- `UnimplementedT3CodeRpc` still throws `NOT_SUPPORTED`.
- Its hand-written contracts use old `thread.turn.start`, `thread.turn.interrupt`
  and session-event shapes. Current T3 uses v2 commands such as `message.dispatch`,
  `run.interrupt`, `runtime-request.respond` and `provider-session.detach`. Some RPC
  method strings remain the same; that does not make their payloads compatible.
- It defaults to `full-access`, models but does not implement approval responses,
  flattens prompt blocks to text, and always sends an empty attachments list.
- Workspace/worktree mapping is explicitly unfinished. Receiving a thread ID does
  not prove the agent is editing the directory ORCA will read for deliverables.
- Its tests use a fake RPC boundary; they do not prove compatibility with current T3.

These are dormant-adapter limitations, not reproduced failures of a working
integration. Avoid spending time on a WebSocket connector that leaves the underlying
contract wrong. [O13]

For any combined deployment, select one owner for workspace creation, agent/provider
credentials, permissions, cancellation and retries. If both systems independently
create worktrees or retry a lost launch, the result can be duplicated work or artifacts
read from the wrong checkout. A successful integration should expose a correlation
from T3 thread/run to ORCA Request/run/step and preserve the distinction between a
one-time tool approval and a durable workflow gate.
For permissions, define which system presents a request, which validates authority,
and how both policies compose; choosing an owner must not bypass either boundary.

## Recommended improvements and existing owners

Priority expresses the recommended order of attention, not a release plan. Effort
is relative to ORCA's existing foundations: small is bounded research/docs or one
seam, medium crosses a few established layers, and large changes a product or
storage boundary. The acceptance examples below are proposed additions to existing
work; they do not create issues or override their recorded hard dependencies.

| Priority | Improvement | Expected benefit | Relative effort | Existing work to extend |
| --- | --- | --- | --- | --- |
| 1 | Complete the first-job setup and launch journey | A new user reaches a real reviewed result without assembling configuration knowledge | Medium to large | #333, #334, #386, #435; reuse #424 experience and #420 fixture |
| 1 | Make completed work reviewable as evidence | Users can see what changed, what was checked and what still needs a decision | Medium | #340, #334 and #424; related tracker work #348–#350 |
| 1 | Preserve lifecycle/retry invariants across adapters | Prevent false completion, duplicated admission and misdirected approvals | Medium | Current #331/#327/#356 foundations; #357 and adapter conformance follow-up |
| 1 | Bound history, replay and startup work | Maintain usable operations as runs and histories accumulate | Medium | #408, #423, #338, #339, #340, #255 |
| 2 | Prototype ORCA as an ACP provider in T3 | Test a complementary product direction before duplicating a coding workbench | Small investigation, unknown delivery effort | Existing ACP facade and T3 groundwork; no dedicated tracked issue identified |
| 2 | Expose provider readiness and capability constraints | Fail early with an actionable reason before launching a costly workflow | Medium | #333, #334, #335–#337, #386 |
| 2 | Add explicit context selection and provenance | Make prompt inputs understandable and reusable without hidden context changes | Medium | Artifact input records; #355, #372, #374 |
| 2 | Improve recoverable client state and synchronization | Show useful history offline and converge correctly after reconnect | Medium | #318, #340; reuse current connection and admission-intent owners |
| 2 | Add trustworthy usage before enforcing budgets | Explain consumption and availability without invented costs | Large | #345 before #346 before #347 |
| 2 | Ship minimal previewable diagnostics for beta | Make failures supportable without exporting source or sensitive logs | Medium | #416, #436; #417/#418 remain separate later decisions |
| 3 | Consider scheduled workflow triggers | Support periodic review/maintenance jobs without conflating time and dependency scheduling | Medium | Plan/workflow foundations; no dedicated recurring-trigger owner identified |
| 3 | Expand code-host and remote surfaces selectively | Reduce handoffs where they block real ORCA workflows | Large | #348–#354 trackers, #342–#344 hosts, #391–#393 private MCP access |

The [issue inventory](t3-code-evidence-2026-10-03.md#issue-inventory-and-status-cautions)
records scope and status cautions. Open parent issues can contain implemented slices.

### First job and reviewed result

Follow T3's progressive setup: select where work happens, establish that the provider
is usable, then import/select the workspace and start. For ORCA, show workflow, agent,
model, effective configuration and authority before admission. Reuse typed preflight,
active-generation guards and persisted admission intent. Preserve the repository's
existing first-job decision boundaries rather than inventing a parallel launch API.

Acceptance should include an absent agent, expired authentication, a switched daemon,
stale workflow/configuration, and a lost admission acknowledgement. One action must
resolve to one run, with the user's draft intact. On completion, display changed-file
evidence, referenced artifacts, observed check outcomes separately from agent-reported
test claims, remaining failures and next actions. Start with a bounded result-review surface or a deep link to the owning
worktree/PR; a full editor and staging UI are not required for that outcome.

### Reliability and storage

Use T3's receipt/outbox split as a concrete reference for #338/#339, and its lifecycle
fixtures as ideas for #357. Preserve uncertainty after external side effects rather
than quietly retrying. Acceptance should kill the process before/after durable
admission, after provider dispatch but before acknowledgement, and during completion
settlement. It should prove identities, authorization and outcomes rather than merely
that the process restarted. Include bounded catalog/history workloads from #423;
do not make SQLite adoption depend on an unsupported speed claim.

### Context and provider readiness

Expose which instructions, artifacts, configured tools and selected options a step
will receive, with their source and omissions. Keep runtime-owned identities and
workspace facts protected from authored context. For provider choice, distinguish
installed, authenticated, configured, probed and capable. Acceptance should cover
unsupported session resume/terminal/model operations and changed live options.
Missing support should produce an explicit fallback or refusal, not a false success.

### Diagnostics and usage

T3 demonstrates the value of provider/environment visibility, but ORCA already has
a deliberately narrower privacy contract for diagnostics. Reuse #416's allowlisted,
bounded preview/export design; do not copy raw protocol capture, screenshots or
prompt retention into that product flow. Developer replay fixtures and user support
bundles serve different purposes. For usage, keep source, time, units and pricing
provenance; an absent observation stays unknown. Reconcile corrected totals and
shared-account duplication before budgets or routing use them. [O10] [O11] [T11] [T12]

### Recurring triggers and remote access

A future timer should submit through ORCA's existing admission path with a stable
scheduled-occurrence identity, explicit overlap policy, timezone behavior, missed-run
policy, and separately recorded dispatch and execution outcomes. It should trigger
the workflow/dependency scheduler rather than replace it. Remote access should
likewise retain the daemon's authority boundary; a phone or relay connection is not
permission to approve every gate. Explore a small mobile approval/inspection surface
only if operator demand justifies it, or obtain it through a tested integration.

## Product decisions this comparison helps make

| User journey | Present fit | Implication for ORCA |
| --- | --- | --- |
| Ask an agent for a small change, iterate, inspect the diff and open a PR | T3 provides the more complete built-in interaction surface | Reduce ORCA's first-job friction and result-review gap; do not require every small task to become a full program decomposition. |
| Execute the same build/test/review process with explicit outputs and routing | ORCA has the stronger reusable process model | Invest in clear workflow authoring, validated inputs and evidence, not just additional chat controls. |
| Coordinate work from several requests with risks and prerequisites | ORCA has explicit domain support | Make schedule explanations and blocked reasons easy to act on; preserve the planning layer as a differentiator. |
| Monitor or answer an agent from another device | T3 has the broader client/access product | Prefer integration or a narrowly scoped operator surface before a complete second client stack. |
| Recover interrupted work without duplicating external actions | Both have useful mechanisms and boundaries | Select by tested scenario and provider support, not an “event sourced” or “checkpoint” label. |

These are source-based fit assessments, not results from a usability study.

The main strategic risk is spending ORCA's effort rebuilding T3's breadth while its
own launch, evidence and recovery journeys remain incomplete. The opposite risk is
underestimating T3's delegation and scheduling and describing generic orchestration
as exclusive to ORCA. A defensible ORCA proposition is **repeatable process with
explicit evidence and cross-request policy**, accessible through the coding surfaces
users already prefer.

Do not import a framework merely because T3 uses it. Effect services, its SQL stack,
React Native client, and provider drivers solve needs within T3's architecture.
Adopt the behavioral contracts and test ideas first. T3's root license is MIT; any
future source reuse should preserve applicable notices and check the specific files
and dependency assets involved. This review imports no T3 code or assets. [T13]

## Validation work before committing to integration or parity

1. **ACP compatibility experiment:** establish a supported ORCA provider definition,
   then run one synthetic workflow through T3 with a streamed update, durable gate,
   live permission, cancellation, model option, and restart. Record supported and
   refused cases. ORCA's ACP facade advertises `loadSession: false`; its downstream
   ACP client separately supports explicitly requested session loading, while default
   engine restart opens a fresh session.
2. **MCP alternative:** configure one supported provider with ORCA tools and a scoped
   credential. Verify discovery, read, admission with response loss, result retrieval,
   and exact gate answering without broadening authority. Test the real configuration
   path rather than inferring it from T3's built-in MCP tools.
3. **Result-review prototype:** use ORCA's synthetic first-job fixture to evaluate
   launch-to-diff/artifact/check navigation with the existing design primitives.
   Measure completion of the journey and error comprehension before expanding scope.
4. **Recovery/performance comparison:** run equivalent synthetic workloads on pinned
   builds, separate cold/warm and disk/memory conditions, and inject the same process,
   transport and acknowledgement failures. Publish observations and limits; this
   review provides no performance winner.

These experiments can proceed independently as research. Production integration
depends on an agreed provider/transport contract and demonstrated lifecycle and
authority behavior. Broader storage, UI and deployment work retains the hard
dependencies recorded in its existing issues.

<!-- Evidence aliases keep the comparison readable; targets are defined below. -->

[O1]: t3-code-evidence-2026-10-03.md#o1-workflow-runtime
[O2]: t3-code-evidence-2026-10-03.md#o2-artifact-contracts
[O3]: t3-code-evidence-2026-10-03.md#o3-planning
[O4]: t3-code-evidence-2026-10-03.md#o4-permissions-and-authority
[O5]: t3-code-evidence-2026-10-03.md#o5-storage-and-recovery
[O6]: t3-code-evidence-2026-10-03.md#o6-operator-runtime
[O7]: t3-code-evidence-2026-10-03.md#o7-agents-and-workspaces
[O8]: t3-code-evidence-2026-10-03.md#o8-desktop-and-design
[O9]: t3-code-evidence-2026-10-03.md#o9-semantic-evaluation
[O10]: t3-code-evidence-2026-10-03.md#o10-first-job-and-beta
[O11]: t3-code-evidence-2026-10-03.md#o11-tracked-gaps
[O12]: t3-code-evidence-2026-10-03.md#o12-notifications-and-performance
[O13]: t3-code-evidence-2026-10-03.md#o13-existing-t3-adapter
[T1]: t3-code-evidence-2026-10-03.md#t1-providers-and-acp
[T2]: t3-code-evidence-2026-10-03.md#t2-runtime-and-persistence
[T3]: t3-code-evidence-2026-10-03.md#t3-coding-surfaces
[T4]: t3-code-evidence-2026-10-03.md#t4-environments-and-mobile
[T5]: t3-code-evidence-2026-10-03.md#t5-git-review-and-checkpoints
[T6]: t3-code-evidence-2026-10-03.md#t6-context-transfer
[T7]: t3-code-evidence-2026-10-03.md#t7-client-state-and-bounds
[T8]: t3-code-evidence-2026-10-03.md#t8-delegation-and-scheduling
[T9]: t3-code-evidence-2026-10-03.md#t9-authority-and-permissions
[T10]: t3-code-evidence-2026-10-03.md#t10-onboarding
[T11]: t3-code-evidence-2026-10-03.md#t11-usage-and-accounts
[T12]: t3-code-evidence-2026-10-03.md#t12-tests-and-performance-evidence
[T13]: t3-code-evidence-2026-10-03.md#t13-source-reuse
