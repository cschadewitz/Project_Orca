"""Independent baseline prose, grounded in the source evidence ledger."""
from author_baseline import ROOT,OUT,VIEWS,ev,link,COMMIT
from pathlib import Path
import json,csv,re,subprocess
views={v['id']:v for v in VIEWS}
def c(k,n=1):return link(views[k]['evidence'][n-1])
def s(path,needle):return link(ev(path,needle))
def put(name,body): (OUT/'baseline'/name).write_text(body.strip()+'\n')
put('index.md',f'''# Independent current-state baseline

Reviewed revision: `{COMMIT}` on `casey/Review-Prompt`. The initial working tree was clean; no pre-existing uncommitted implementation is included. [Revision record](revision.json).

This baseline was authored from implementation, declarations, executable assets and configuration **before reading existing project documentation**. The comparison has not yet begun at the baseline checkpoint. The root AGENTS instructions were necessarily available and contain architectural prose; [scope](scope.md) records this exposure and the steps taken to limit its influence. This is static architecture evidence, not a runtime certification or a correctness audit.

1. [Scope, method and classifications](scope.md).
2. [Vocabulary, actors and boundaries](glossary.md).
3. [Coverage matrix: every package and major component](coverage.md).
4. [End-to-end lifecycles and ownership](lifecycles.md).
5. [Data, APIs, persistence and synchronization](data-contracts.md).
6. [Inputs, customization, permissions and extension points](inputs-extensions.md).
7. [Engineering, delivery, diagnostics and test intentions](engineering.md).
8. [Uncertainties and explicitly unsupported conclusions](uncertainties.md).
9. [Manifest dependency inventory](dependencies.md) and [source ownership map](source-map.md).

Start with the [system specification](../architecture/system.md) and [system SVG](../diagrams/svg/system.svg). The coverage matrix links all {len(VIEWS)} specifications, SVGs and editable sources. The diagram [notation](../diagrams/notation.md) is shared. Detailed package views link source symbols with both relative and commit-pinned locations.

The independent baseline is preserved by the later `BASELINE-MANIFEST.sha256` and checkpoint record at the review root. Subsequent documentation comparison and recommendations are separate. Later source-backed corrections, if required, belong in an addendum rather than in these files.
''')
put('scope.md',f'''# Scope and evidence method

## Revision and allowed work

The source snapshot is commit `{COMMIT}`, branch `casey/Review-Prompt`, origin `https://github.com/cschadewitz/Project_Orca.git`. Initial `git status --short` was empty. The only new working-tree content created for this task is this review directory. Repository implementation is therefore described at the pinned commit; review files themselves are uncommitted deliverables. Existing work was neither reset nor cleaned.

The first filesystem mutation was creation of `Current_State/`; it did not previously exist. The mandatory root `AGENTS.md` was read for constraints first. No nested AGENTS files were discovered. No README, `docs/` content, prior review, proposal, architecture image or explanatory document was opened before the independent checkpoint. A directory listing can reveal a document's name; its body was not used to select investigation subjects.

The root AGENTS text, also supplied directly by the user, contains implementation descriptions, design rules and pointers. Complete ignorance of those statements was impossible. They were treated as working constraints, not baseline evidence. In particular, its instruction to consult development/architecture documentation was deferred under the user's explicit independent-investigation requirement. No higher-priority instruction required further documentary exposure.

## Coverage and granularity

Discovery used tracked file paths, workspace/package manifests, public barrels, executable entry points and imports. A component is a cohesive lifecycle owner, service, projection, persistence family, protocol boundary or UI surface family. Small helpers remain inside their owner. Thirteen workspace manifests comprise eleven product/support packages and two tooling packages; delivery configuration and executable workflow assets are additional owners. The [matrix](coverage.md) accounts for every discovered major family. The [census](source-census.tsv) hashes 614 tracked non-document source/configuration/test/assets files; the [source map](source-map.md) records ownership and separately marks source mapping versus selected semantic tracing.

Cross-boundary traces followed callers and implementations: CLI composition → engine → store; program → plan dispatch → child runs; agent invocation → ACP/host → artifact collection; daemon methods → control/read models → engine/store; Electron renderer → preload → main client → daemon; notifications → UI reconciliation; plugin → JEV provider. Every view includes selected concrete evidence. This is exhaustive **inventory coverage at the stated granularity**, not a claim that every code branch, security property or test assertion has been audited.

## Classifications

| Label | Meaning | Appropriate conclusion |
| --- | --- | --- |
| Implemented | Directly supported by source statements and traced call/data paths | “The implementation routes the answer to the orchestrator.” |
| Inferred | Interpretation of source with reasoning stated | “Separate file mutations imply no shared transaction across these records.” |
| Declared | Schema, test, comment or configuration intention not fully traced | “CI declares a two-version Node matrix.” |
| Unverified | Static review cannot establish it, or the path was not sufficiently traced | “Remote-agent compatibility and crash durability remain unverified.” |

A parsed schema is evidence of validation only where a parser call is traced. Tests express intended coverage and useful scenarios; no test result is assumed. Comments can disagree with executable branches. Diagrams are structured interpretations of cited implementation, not observed process traces. The word “supports” in a specification means a traced code path exists, unless explicitly qualified as declared.

## Citation and exclusion conventions

Specifications use relative Markdown links with `#L` line locations and a companion commit-pinned GitHub link. GitHub provides a reliable immutable source target; a local viewer may not implement source-line anchors. Symbols make locations usable in either viewer. All source links refer to clean committed content. The baseline's review documents use relative navigation links.

Excluded from execution: application startup, builds, tests, migrations, services, integrations, generated-asset builds, dependency installation and external diagram rendering. Only source reads, Git metadata reads and standalone standard-library Python documentation/diagram/checksum checks were used. No repository Python/JavaScript/TypeScript module was imported or executed. Existing binary/font/image artifacts were inventoried by path where relevant, not interpreted as proof of rendering. Prompt bodies were deferred; parsers, template identifiers/frontmatter and workflow YAML were inspectable executable inputs.

No live credentials, external service behavior, performance, actual deployment state, test pass rate, packaging/signing outcome, recovery timing or OS isolation can be established here. Recommendations and documentation evaluation are deliberately absent from this factual baseline.
''')
put('glossary.md',f'''# Vocabulary and system boundaries

Terms below use source names. “Ownership family” and “read projection” are organizational terms used by this review; they are not new runtime types.

| Source term | Meaning and relationship | Evidence |
| --- | --- | --- |
| `Request` | Durable user intent with title/body/source/status and optional program run. It is neither a plan nor a run. | {s('packages/core/src/model/request.ts','export const RequestSchema')} |
| `WorkItem` | Durable task/epic/feature/spike, optionally parented; belongs to a request, can join a plan and acquire a run. Carries dependencies, produced artifacts and deferral. | {c('core-domain',3)} |
| `Plan` / `PlanService` | Portfolio document and service managing registered requests/items, dependencies, risks, decisions, journal and scheduling policy. A schedule is a derived view, not the plan document itself. | {c('engine-plan',1)} |
| `WorkflowDefinition` | Authored graph of typed nodes/edges, variables and id/version. Reusable by many runs. | {c('core-authoring',1)} |
| `Run` / `RunState` | One execution of a versioned workflow. `RunState` is projected from events; relationships connect parent/child runs, request and work item. | {c('core-domain',1)}, {c('core-domain',2)} |
| `Step` / attempt | An execution attempt at a graph node within a run. Retries and interrupted re-execution create distinguishable attempts. | {c('engine-interpreter',1)} |
| `AgentSpec` | Configured identity, executable, host, roles, model, permissions, MCP servers and timing settings. This is not an active process or an authenticated user. | {s('packages/core/src/model/agent.ts','export const AgentSpecSchema')} |
| `Host` | Process/filesystem interface implemented locally or through SSH. A host need not be an agent. | {c('agents-hosts',1)} |
| `AgentSession` / ACP session | Live invocation channel with prompt/cancel/config/update/close operations; engine may reuse it during a run. Distinct from both agent configuration and durable run. | {c('agents-session',1)} |
| Facade session | In-memory upstream ACP interaction with ORCA acting as an agent. It launches work and forwards events to a client; it is not the downstream agent session. | {c('integration-facade',1)} |
| `Artifact` | Indexed provenance plus content-addressed bytes; filename identifies a produced deliverable, kind supports planning dependencies. Multiple versions can share a filename. | {c('store-content',1)} |
| Deliverable | Template-declared expected output, collected from the host and validated before becoming an artifact. Merely writing a file does not establish recorded provenance. | {c('engine-execution',1)} |
| Lease | Expiring run ownership with fencing/heartbeat; determines which executor may append owned run events. | {c('store-ownership',2)} |
| Claim | Persistent work-item dispatch ownership, tied to parent run/branch; prevents independent dispatchers from assigning the same item. Separate from lease and without the same expiry semantics. | {c('store-ownership',1)} |
| Human input / gate / permission | Human input is the persisted envelope; a gate is a workflow decision; ACP permission is an agent's request to use a tool. Gate parking and live permission answering have different lifetimes. | {s('packages/engine/src/human-input.ts','export async function askHumanInput')}, {c('agents-permissions',1)} |
| Program | `ProgramService` coordinates request submission and root-run settlement, and shipped `program` workflow composes planning/dispatch. It is not an independent daemon scheduler. | {c('engine-program',1)} |
| Workspace | Host id/cwd and optional repository/branch metadata on a run; provider chooses or creates it. Kepler task directories and Git worktrees are different providers. | {c('engine-workspaces',1)} |
| Registry / plugin | In-process collections and ESM registration function for workflows/templates/executors/agents and injected services. Not an isolated external plugin host. | {c('cli-bootstrap',2)} |

## Status vocabularies are projections, not synonyms

Implemented: core run statuses are `created`, `running`, `waiting`, `paused`, `completed`, `failed`, `cancelled`; step statuses include `scheduled` and `skipped`. Run outcome (`success`, `failure`, `cancelled`) carries a separate result dimension. {s('packages/core/src/model/run.ts','export const RunStatusSchema')}

Implemented: the protocol/design vocabulary is `running`, `waiting`, `succeeded`, `failed`, `cancelled`, `blocked`, `held`, `stale`. Display folding combines core state, wait reason, plan state and lease liveness. `held` can describe undispatched planning work; `stale` is a read-time ownership observation, not a stored terminal event. Thus “eight run statuses” refers to presentation vocabulary, not the core enum. {s('packages/protocol/src/status.ts','export const DISPLAY_STATUSES')}, {c('daemon-projections',1)}

Implemented: `agent.changed` reports configured-agent health, `agent.update` is run/step output; `event.appended` carries a persisted run event; `plan.changed` invalidates plan projections. These names have different keys and replay behavior. {c('daemon-subscriptions',1)}

## Actors and boundaries

Human contributors author configuration, workflow graphs and templates; operators start daemon/CLI and control releases; upstream ACP clients submit requests; desktop users inspect/answer/control runs; downstream ACP agents run tools and produce files. The implementation divides these through CLI/integration entry points and the daemon bridge, not through authenticated user accounts. {c('system',1)}, {c('system',2)}, {c('system',6)}

The engine owns orchestration; stores own persistence primitives; core owns reusable models and pure interpretation/planning; daemon owns protocol projections/control adaptation; Electron main owns desktop process/network access; renderer owns interaction and displayed state. The package and process maps are deliberately distinct: daemon models and engine normally share a Node process while renderer/main do not. {c('system',1)}, {c('system',3)}

Configured executables, ESM plugins, workflow/template authors and writable store/config files are trusted inputs at different boundaries. ACP permission callbacks and file-path checks limit cooperating agent operations; they are not OS sandboxing of arbitrary configured subprocesses. {c('agents-hosts',1)}, {c('agents-session',3)}, {c('cli-bootstrap',2)}
''')
put('lifecycles.md',f'''# Lifecycles, execution and recovery

Each numbered flow traces source ownership across packages. These are implemented control paths, not observed executions. Detailed graphs accompany the linked specifications.

## User intent to durable outputs

| Stage | Producer → consumer and state boundary | Evidence |
| --- | --- | --- |
| 1. Entry | CLI arguments or upstream ACP text → bootstrap / facade. A workflow can be launched directly; program submission first creates a Request. Desktop starts runs through daemon controls. | {c('cli-commands',1)}, {c('integration-facade',2)}, {c('daemon-controls',1)} |
| 2. Composition | Config loader → stores, host/agent registries, workflows/templates, plugins, PlanService, Orchestrator, ProgramService. Plugin registration precedes final graph validation. | {c('cli-bootstrap',1)}, {c('cli-bootstrap',2)} |
| 3. Start | `startRun` resolves workflow/version, validates variables, records workflow definition, provisions or accepts workspace, then appends run creation with identity/relationships. | {c('engine',1)}, {c('engine-workspaces',1)} |
| 4. Execute | Run lease and fenced context → node executor. Agent nodes select agent/session and render prompts; container/program nodes can create child runs. | {c('engine-interpreter',1)}, {c('engine-execution',1)}, {c('engine-dispatch',1)} |
| 5. Capture | ACP updates → buffered event recorder. Host files → deliverable validation → content-addressed artifact store → artifact event → optional plan signal intake. | {c('engine-execution',1)}, {c('engine-execution',3)}, {c('store-content',1)} |
| 6. Present | Event reducer/read models → daemon results/notifications → main bridge → renderer feeds. Human answers return through the reverse control path. | {c('daemon-projections',1)}, {c('daemon-subscriptions',1)}, {c('app-client',1)}, {c('app-attention',1)} |
| 7. Settle | Engine records terminal or paused state and closes run sessions; work-item and plan hooks update projections. ProgramService settlement additionally updates Request when its root run is terminal. | {c('engine-program',1)}, {c('engine-plan',2)} |

The direct workflow path need not create a Request or WorkItem. A Request may own a program run plus a tree of work items/child runs; there is no one-to-one equivalence among these identifiers. Caller participation matters for Request settlement: the facade/CLI use ProgramService; daemon controls call the orchestrator. Unification of those lifecycle owners is not established by this trace. {c('engine-program',1)}, {c('daemon-controls',1)}

## Plan lifecycle

1. Configuration names a default plan and policy. Program workflow/executors call `PlanService` to ensure a plan, register a request and its work items, and translate item dependencies. The plan stores relationships; actual request/item records live in separate collections. {c('engine-plan',1)}, {c('engine-program',2)}
2. Artifact intake extracts risks, decisions and dependency signals. Service mutations update documents and append plan journal entries; mutation queues are local to the service instance, while individual document writes have file locks. Exceptions in intake are handled separately from the success/failure of the agent's artifact collection. {c('engine-plan',2)}, {c('store-documents',1)}
3. `computeSchedule` reads a supplied snapshot and time. Hard dependency cycles can make work unschedulable; soft edges influence ordering unless cycle-closing; decision/risk/dependency conditions distinguish ready, waiting, held and blocked work. Estimates weight ordering/critical path rather than supplying elapsed time or completion percentages. Persisted `satisfied`/`waived` dependency states short-circuit evaluation. {c('core-planning',1)}, {c('core-planning',2)}, {c('core-planning',4)}
4. The plan dispatcher recomputes eligibility, takes a persistent claim for a ready leaf item, constructs upstream context and starts a child run. Request scope is the ordinary default; plan scope can dispatch other registered work. Concurrency is a dispatcher/fan-out setting, not a system-wide host quota. {c('engine-dispatch',1)}, {c('engine-dispatch',2)}
5. Child completion, stage artifacts, a decision, waiver, risk update or deferral changes eligibility. The dispatcher listens for journal changes and also has a polling/deadline fallback. A plan is therefore not a permanently running scheduling service: a dispatching execution owns the wait loop. {c('engine-dispatch',2)}, {c('engine-plan',2)}
6. Work-item projection synchronizes linked run status; claims retain ownership across parent interruption and need guarded recovery. Deferred/held/blocked work remains represented; join strategy and fail-fast behavior determine the enclosing container's result. Plans and journals remain persisted after a particular run ends. {c('engine-program',2)}, {c('engine-dispatch',4)}, {c('store-ownership',1)}

## Agent session lifecycle

1. Resolve explicit selector or role mapping to an AgentSpec and host; apply model/session configuration. Defaults include local host, per-step sessions, 30-minute turn timeout and 10-second cancellation grace. These are schema defaults, not measured durations. {s('packages/core/src/model/agent.ts','export const AgentSpecSchema')}, {c('engine-execution',1)}
2. Host spawns configured executable locally or via SSH. ACP session initializes capabilities and creates a new session with cwd and configured MCP server definitions. File read/write callbacks check lexical workspace/additional roots; terminal capability is disabled, although configured agents may use their own tools. {c('agents-hosts',1)}, {c('agents-hosts',2)}, {c('agents-session',1)}, {c('agents-session',3)}
3. Engine resolves visible artifacts and explicit inputs, merges execution context/variables, selects template pack and renders. Agent-step deliverables target a private attempt directory. This reduces stale-output reuse; it does not prevent agent access to the rest of its process environment. {c('engine-execution',1)}
4. One session turn receives the prompt. Updates are streamed through a serialized recorder; tool permission callbacks consult effective policy or ask HumanInputPort. Follow-up prompts can be issued for missing deliverables or continuation according to executor options. {c('engine-execution',3)}, {c('agents-permissions',1)}
5. Completion can be normal ACP turn completion or an artifact-presence trigger that cancels the turn. Collection validates expected outputs/frontmatter, hashes content and records provenance. A content hash proves identity of recorded bytes, not semantic correctness of their contents. {c('engine-execution',1)}, {c('store-content',1)}
6. Per-run sessions are pooled in memory by run and agent; model drift can require reconfiguration/reopening. Execution return closes sessions, including parking. Resume replays the durable run and creates needed sessions; the `AgentSession` interface exposes no durable session-load operation. ACP facade also declares `loadSession: false`. {c('engine-execution',1)}, {c('agents-session',4)}, {c('integration-facade',1)}

## Branching, answers, retries and cancellation

Implemented: routing checks conditional edges in order and then the unconditional route; unmatched routing can fail the run. Decision/end outcomes are explicit. Parallel/loop/subworkflow executors share child-run machinery but preserve branch/parent identities. Join `any`/`all` and fail-fast affect sibling cancellation. {c('engine-execution',4)}, {c('engine-execution',2)}

Implemented: failed attempts can consume node retry budget. On resume an interrupted attempt is distinguished from a new attempt; completed steps and terminal paths are replayed rather than indiscriminately rerun. A lease fences execution and writes; heartbeat loss/cancellation limits who can continue. These mechanisms express recovery intent but do not prove all crash interleavings safe. {c('engine-interpreter',2)}, {c('store-ownership',2)}

Implemented: gates record offered options and can park through a pending-human-input result. ACP tool permissions need a live agent callback; pause-mode behavior cannot persist that in-memory callback across restart. Answers validate option membership and ownership. “Always” may record only a derivable, scoped standing permission; refusal to record does not imply the current answer was ignored. {s('packages/engine/src/human-input.ts','export async function askHumanInput')}, {c('agents-permissions',4)}, {c('daemon-controls',1)}

Implemented: cancellation coordinates abort signals, child runs and sessions; ACP cancellation has a grace period then subprocess termination. Durable claim release is a separate guarded operator action. App/deployment updates have admission and recovery barriers separate from run cancellation. {c('agents-session',2)}, {c('engine-program',3)}, {c('app-updates',2)}, {c('delivery',2)}

## Ordering and ownership limits

Run-event and plan-journal sequence domains are per object. File locks serialize individual writes; the PlanService's reentrant queue serializes local service mutations. No one transaction spans a request, work item, plan document, journal, artifact and run event. Same-process notification listeners do not observe another process's append. Local workspace checkout is separate from run/claim fencing. These are source-backed boundaries, not claims of an observed race. {c('store-logs',1)}, {c('store-logs',3)}, {c('store-documents',2)}, {c('engine-plan',1)}, {c('engine-workspaces',1)}
''')
put('data-contracts.md',f'''# Data, contracts and synchronization

## Persistence ownership

The file-store factory defines the following topology. Memory stores implement the same application ports for injected/testing use. There is no SQL database or database migration subsystem in the inspected store implementation. {c('store',1)}, {c('store',2)}

| Data | Authoritative owner and relationships | Persistence / lifetime | Evidence |
| --- | --- | --- | --- |
| Run events | Engine fenced context; run id + monotonic per-run seq; step/parent/input references | `runs/<runId>.jsonl`, append/replay | {c('store-logs',1)}, {c('core-domain',2)} |
| Run/step state | Reducer over run events | Derived; summaries and engine caches are not independent history | {c('core-domain',2)} |
| Requests / work items | ProgramService and work-item projection; requestId, parentId, planId, runId | Whole-collection JSON files | {c('engine-program',1)}, {c('store-documents',1)} |
| Plans/dependencies/risks/decisions | PlanService; linked plan/request/item/decision identifiers | Separate whole-collection JSON files | {c('engine-plan',1)}, {c('store',2)} |
| Plan history | PlanService journal producer | `plans/<planId>.jsonl`; notifications on local append | {c('store-logs',3)} |
| Artifacts | Artifact store; artifact id, run/step, filename, kind, parents, hash and size | `artifacts/index.jsonl` + `blobs/<hash>` | {c('store-content',1)} |
| Workflow versions | Workflow store; id/version key | `workflows/<id>@v<version>.json`, first stored definition retained | {c('store-content',2)} |
| Run leases / item claims | Dedicated ownership stores | Ownership records and locks, guarded acquisition/release | {c('store-ownership',2)}, {c('store-ownership',1)} |
| Main config / standing rules | Operator edits or revision-aware ConfigModel / permission writer | `orca.config.*`, adjacent `orca.permissions.json` | {c('daemon-config',1)}, {c('agents-permissions',4)} |
| Desktop preferences | Electron main | User-data JSON; theme/density/panes/alerts persist independently of run store | {c('app-shell',3)} |

Identifiers are produced by core helpers rather than inferred from display labels. Artifact content identity is a SHA-based hash; run/step/request identity and JSONL sequence are distinct dimensions. {s('packages/core/src/ids.ts','export')}, {s('packages/core/src/util/hash.ts','export')}

## Atomicity, schemas and compatibility

Implemented: JSONL appends take a keyed queue plus filesystem lock, allocate a sequence and repair a non-newline tail before writing. Readers can skip invalid JSON lines; schema-invalid parsed events are a different case. There is no global ordering between separate logs. Document stores reload under a lock, merge collection entries, write a temporary file and rename; caches compare file metadata. That protects collection replacement but is not an atomic read-modify-write business transaction across callers or files. {c('store-logs',1)}, {c('store-logs',2)}, {c('store-documents',1)}, {c('store-documents',2)}

Implemented: lock ownership is conservative about remote/unknown owners and incomplete lock metadata. Leases fence run writes and expire; claims represent durable assignment and use guarded release. These three mechanisms are not interchangeable. Crash durability under actual filesystem/OS failure remains unverified. {c('store-ownership',3)}, {c('store-ownership',2)}, {c('store-ownership',1)}

Implemented: Zod models validate configuration, workflow parsing, protocol input/results and persisted-record reads at their respective boundaries. Some legacy forms are transformed/defaulted in schemas, including gate options. Managed release compatibility uses a `storeEpoch` gate rather than a general automatic store migration. Protocol compatibility separately checks major/minor versions. {c('core-authoring',1)}, {c('protocol',1)}, {c('delivery',3)}

Implemented: workflow definition versions are pinned, but prompt template bodies/effective configuration are separately loaded. Prompt hashes/previews and artifact hashes aid provenance without establishing a complete reproducible invocation snapshot. {c('store-content',2)}, {c('engine-execution',1)}, {c('engine-execution',3)}

## Process contracts and ownership

| Contract | Producer → consumer | Validation/version/error semantics | Evidence |
| --- | --- | --- | --- |
| CLI configuration | File/argv → bootstrap | Zod parse, relative paths from config directory; invalid loaded graphs rejected | {c('cli-bootstrap',1)}, {c('core-authoring',1)} |
| Internal engine ports | Engine → Stores/Host/Session/HumanInput/Executor/WorkspaceProvider | Typed interfaces and implementation guards; not all in-process objects are reparsed | {c('engine',2)}, {c('agents',1)} |
| ACP downstream | AgentSession → stdio child/SSH transport | SDK protocol exchange; initialization capabilities, prompt/cancel/config/permission/update | {c('agents-session',1)} |
| ACP upstream | External ACP host → facade | In-memory sessions and supported prompt content; no durable loadSession | {c('integration-facade',1)} |
| ORCA wire | Client → `/rpc`, `/socket` | Custom `kind` request/response/notification envelopes; id correlation and schema maps; HTTP body bound | {c('protocol',1)}, {c('daemon-transport',1)} |
| Desktop IPC | Renderer → preload → main | Fixed named methods and notification channels; results parsed by daemon client | {c('app',2)}, {c('app-client',1)} |
| JEV HTTP | Plugin/provider → external TypeSafe endpoint | Bearer credential from environment, bounded selected text, timeout/retry/status handling and response validation | {c('integration-jev',2)}, {c('integration-jev',3)} |
| T3 RPC | Session adapter → injected `T3CodeRpc` | Handwritten contract, absent built-in working transport | {c('integration-t3code',1)}, {c('integration-t3code',2)} |

ORCA's wire protocol is not a generic JSON-RPC 2.0 endpoint. Its own message discriminators and `hello` version/capability negotiation are the contract. `PROTOCOL_VERSION` is 1.8; equal major and sufficiently new minor is the client compatibility rule. Error messages preserve machine codes and structured data where provided; the wire error schema allows string codes for domain errors. {c('protocol',1)}, {c('protocol',2)}

Method ownership is explicit: `methodsFor` assembles read models and optional controls; hello advertises actual available methods/capabilities. Run control and plan/config writes are withheld in read-only mode; `agents.ping` is separately available and has active effects. Health GET is a transport/service check, not proof every agent or store record is healthy. {c('daemon',2)}, {c('daemon-transport',2)}, {c('daemon-projections',3)}

## Events, cursors and UI state

Implemented: daemon subscriptions subscribe before replay and buffer concurrent arrivals, then stream notifications. Run-scoped resumption uses `runId` plus `since` in that run's sequence domain. High-volume `agent.update` is coalesced by step; terminal transitions flush. Store-wide plan/config/agent changes have different keys, and no global replay cursor exists. {c('daemon-subscriptions',1)}, {c('daemon-subscriptions',2)}

Implemented: Electron main owns one store-wide subscription. Reconnection generations let adopting hooks refresh snapshots; runs/attention/agents have reconciliation paths while the plan feed uses invalidations and scoped rereads. A lost connection does not itself replay a global history. Cross-process appends also bypass local event listeners. Thus “push” does not imply every writer or disconnection gap is represented without a reread. {c('app-client',2)}, {c('app-runs',1)}, {c('app-plan',1)}, {c('store-logs',3)}

Implemented: the connection machine folds handshake/subscription state and delays visible loss for five seconds. Writability comes from connection capabilities, not a failed speculative write. Lease expiry is inactivity, so stale display classification is read-derived. {c('app-main',3)}, {s('packages/app/renderer/src/chrome/use-connection.ts','export function useWritability')}, {c('daemon-projections',1)}

Caches include document metadata caches, JSONL tails, per-read projection data, engine artifact content/terminal states, configured-agent health and renderer snapshots. They have different invalidation domains. Artifact index reads and plan snapshot composition still traverse persisted collections; scale and memory bounds under long histories remain unverified. {c('store-documents',1)}, {c('store-content',1)}, {c('daemon-projections',1)}, {c('engine-interpreter',3)}

## Retention and cleanup

Inferred absence, scoped to inspected store interfaces, CLI command registrations and providers: no general archival/retention policy, blob garbage collector, whole-store compaction or migration runner is exposed. Worktree provider has a release operation, but the orchestrator does not automatically release every completed run's workspace. Run/session cancellation and release activation cleanup are narrower mechanisms. No operational deletion policy should be inferred from them. {c('store',1)}, {c('cli-commands',1)}, {c('engine-workspaces',3)}, {c('delivery',2)}
''')
put('inputs-extensions.md',f'''# Inputs, customization and extension contracts

## Input catalog and downstream effects

The categories below cover meaningful input families, grouping individual flags/fields under their owning parser. Source links identify their authoritative definitions rather than reproducing a potentially misleading second configuration reference.

| Audience/input | Entry, validation and defaults/precedence | Persistence and effect | Evidence |
| --- | --- | --- | --- |
| User intent | CLI command/flags or ACP prompt text; selected workflow versus program submission | Request/run records and downstream prompts | {c('cli-commands',1)}, {c('integration-facade',2)} |
| Run selection/variables | CLI role/model/template overrides; daemon `runs.start` validated params; workflow vars validated by engine | Run vars and selected execution recipe | {c('daemon-controls',1)}, {c('engine',1)} |
| Workflow authorship | YAML/JSON graph, built-in node settings, edges/conditions/retry; load + graph validation | Registry plus pinned version when used | {c('core-authoring',1)}, {c('store-content',2)} |
| Prompt/template authorship | Frontmatter deliverables, body/partials, pack-qualified template resolution; custom renderer | Files loaded at bootstrap; rendered context and collected artifacts | {c('core-authoring',3)}, {c('workflow-assets',2)} |
| Planning | Requests/items/dependency signals, risk matrix, scheduling policy, decisions/waivers/deferrals | Separate plan collections and journal; changes derived eligibility | {c('engine-plan',1)}, {c('core-planning',1)}, {c('daemon-controls',3)} |
| Agent/operator configuration | Command/args/env/host/roles/model/MCP/timeouts/sessionMode; Zod AgentSpec | Config file; subprocess and session behavior | {s('packages/core/src/model/agent.ts','export const AgentSpecSchema')} |
| Store/workspace configuration | Config directory resolves paths; file vs injected memory store; local/Git worktree/Kepler provider | Persisted run cwd/branch metadata and host file effects | {c('cli-bootstrap',1)}, {c('engine-workspaces',1)} |
| Permission answers | Offered option id, optional standing decision; validate live/recorded input and rule derivability | Human-input events and optional sidecar rule | {c('agents-permissions',4)}, {c('daemon-controls',1)} |
| Human-input mode | `pause`, CLI and configured auto decisions selected by bootstrap | Park gate or interact with live agent; automation chooses offered options | {s('packages/cli/src/bootstrap.ts','function makeHumanInput')}, {s('packages/engine/src/human-input.ts','export async function askHumanInput')} |
| Config editor | Schema-field patch or whole text with expected content revision; YAML structure preserved where possible | File replacement; stale refusal retains renderer draft; most settings need restart | {c('daemon-config',1)}, {c('app-config-workflow',1)} |
| Desktop appearance/navigation | Theme/system, per-surface density, boundary widths/ratios, alert preferences, route/deep links | User-data preferences; IPC patches and renderer presentation | {c('app-shell',3)}, {c('app-shell',1)}, {c('app-interaction',3)} |
| Desktop workspace/transport | Explicit `ORCA_DAEMON_URL` before managed workspace/daemon selection; read-only store opening | Main process selects client/owned process and resets subscriptions | {c('app-main',1)} |
| Operator release inputs | Version/SHA/compatibility, service paths, admission, feed URL/token file | Managed release dirs/journal/symlink; desktop explicit update state | {c('delivery',2)}, {c('app-updates',1)} |
| Developer hooks | ESM plugin module paths or injected engine ports | In-process code runs with host privileges and extends registries | {c('cli-bootstrap',2)}, {c('engine',2)} |
| Evaluation service inputs | JEV node/plugin/env model selection, env API key/base URL, artifact/body bounds | External HTTPS request and optional evaluation artifact | {c('integration-jev',1)}, {c('integration-jev',2)} |

Implemented configuration search/defaults: nearest upward `orca.config.yaml`, `.yml` or `.json`; default store `.orca`, workflow globs `workflows/**/*.yaml`/`.yml`, template glob `templates/**/*.md`, program workflow `program`, item workflow `ai-sdlc`, planning id `default`, local workspace, pause human input and no plugins. Config-relative path resolution is bootstrap's responsibility. These are actual schema defaults, not a claim every launch uses them. {s('packages/core/src/config.ts','export const OrcaConfigSchema')}, {c('cli-bootstrap',1)}

Permission precedence is first match: configured rules, then sidecar rules, then built-in workspace rules only if configured `default` is absent. Explicit `default: ask` suppresses those implicit rules just as explicit allow/deny does. Built-in rules allow read/search/edit/delete/move within workspace and think; fallback is ask. Sidecars carry rules, never a global default; operator configuration outranks machine-written grants. Rules are reread per permission request, unlike most bootstrap configuration. {s('packages/core/src/model/agent.ts','export function effectivePermissionPolicy')}, {c('agents-permissions',1)}, {c('agents-permissions',4)}

Agent selection, role overrides, template packs and model selectors are different layers: a pack selects prompt text; a role resolves configured agent identity; a model changes a session option when available. JEV model resolution is separately node → plugin → environment and rejects alias-like model identifiers. Neither mechanism demonstrates reproducibility of external model behavior. {c('cli-bootstrap',3)}, {c('core-authoring',3)}, {c('engine-execution',1)}, {c('integration-jev',1)}

## Actual extension surfaces

| Mechanism | Configuration-only change | Requires code / limits | Evidence |
| --- | --- | --- | --- |
| New workflow / template pack | Add matching files and configure paths; select pack | Existing node types/DSL only; reload usually requires new bootstrap | {c('workflow-assets',2)}, {c('core-authoring',3)} |
| New ACP agent | Configure executable/args/env/roles/host/MCP | Agent must implement compatible ACP; no built-in vendor HTTP adapter inferred | {c('agents-session',1)} |
| New host | Select local or SSH | New Host implementation and registration/wiring for another transport | {c('agents-hosts',1)}, {c('agents-hosts',2)} |
| Plugin executor/registry additions | Configure trusted ESM module path | Implement PluginApi callback/custom executor; permissive custom-node schema does not validate plugin options comprehensively | {c('cli-bootstrap',2)}, {c('core-authoring',4)} |
| Custom session provider | No general bootstrap plugin selector found | Engine accepts SessionFactory programmatically; T3 adapter needs a concrete injected RPC implementation | {c('engine',3)}, {c('integration-t3code',3)} |
| Custom human input/workspace | Built-in mode/provider settings | Plugin can replace ports; lifecycle and trust are the plugin's responsibility | {c('engine',3)}, {c('engine-workspaces',1)} |
| Store backend | File store through normal bootstrap | Implement Stores ports and embed/inject; transaction semantics not abstracted as a unit | {c('store',1)}, {c('store',3)} |
| Desktop surface | No runtime surface plugin registry | Add React surface/route/semantics and use interaction substrates; daemon contracts for new data | {c('app-shell',1)}, {c('app-interaction',1)} |
| JEV integration | Opt into plugin, configure provider values | Provider interface injectable; shipped provider sends selected text outside ORCA | {c('integration-jev',1)}, {c('integration-jev',2)} |
| Kepler workspace | Configure task directory/repo preference | Filesystem adapter reads attached repository directories; no built-in Kepler MCP client traced | {c('integration-kepler',1)} |

## Trust and secrets

Implemented: local child processes inherit environment with configured/invocation overrides; SSH relies on configured command/identity and remote shell. Plugins execute in-process. ACP path checks operate on normalized paths and do not establish symlink-safe or OS-enforced containment. File permissions and trusted executable/config authors remain material boundaries. {c('agents-hosts',1)}, {c('agents-hosts',2)}, {c('agents-session',3)}, {c('cli-bootstrap',2)}

Implemented: daemon defaults to loopback but accepts a configured bind host; dispatch validates message shape, not caller identity. Config reads include raw text. Read-only removes mutation methods but is not an authentication mechanism or universal side-effect-free mode. Electron's renderer isolation and fixed bridge reduce renderer authority, while main retains network/filesystem/process authority. {c('daemon-transport',1)}, {c('system',6)}, {c('daemon-config',1)}, {c('app',2)}

Implemented: JEV credentials come from environment; update credentials come from a configured token file. Prompt/log/artifact/config data may contain user or agent-provided sensitive text. No end-to-end redaction guarantee, encrypted store, tenant separation or secret-management service was found in these boundaries. This is an absence scoped to the inspected implementations, not a penetration-test conclusion. {c('integration-jev',2)}, {c('app-updates',1)}, {c('store',2)}
''')
put('engineering.md',f'''# Engineering structure and maintainability evidence

## Workspace and dependency direction

Declared: pnpm workspaces include `packages/*` and `tools/*`; lockfile and package-manager version pin dependency resolution. TypeScript project references compile the product packages and separate app preload. Workspace manifests are private; root release version and package versions are distinct metadata. See [dependency inventory](dependencies.md). {s('pnpm-workspace.yaml','packages:')}, {s('tsconfig.build.json','"references"')}, {s('package.json','"packageManager"')}

Implemented dependency direction: core has no workspace runtime dependency; store/agents depend on core; engine composes store/agents/core; protocol uses browser-safe core schemas; daemon adapts engine/store to protocol; integrations compose engine/agents; CLI composes them all. App imports protocol/design, with daemon used during bundle production. `@orca/testing` is also a CLI runtime dependency for demo. Public barrels/subpaths define imports rather than an external package release compatibility promise. {c('core',1)}, [all manifests](dependencies.md), {c('tool-eslint',1)}

Declared: lint restricts app workspace imports and literal style values; root compilation and lint tooling use separate TypeScript dependency closures. This separation can be intentional tool compatibility management; no unsupported-version conclusion was drawn. {c('tool-eslint',1)}, {c('tool-eslint',3)}

## Patterns directly evidenced

| Pattern | Concrete use and boundary | Evidence |
| --- | --- | --- |
| Ports/adapters with composition root | Stores, Host, AgentSession, executors, HumanInputPort, workspace and optional session factory composed in bootstrap | {c('cli-bootstrap',1)}, {c('engine',2)} |
| Event-derived run state | Typed run events reduce to state and summaries; plan documents/journal follow a different model | {c('core-domain',2)}, {c('engine-plan',1)} |
| Projection/control split | Daemon read/plan/agent/config/workflow models separated from orchestration controls | {c('daemon',1)}, {c('daemon',2)} |
| Pure algorithms around side effects | Expressions, scheduling, matrix/risk and UI plain models accept values; services own I/O | {c('core-planning',1)}, {c('app-interaction',2)} |
| Registries and strategy selection | Workflow/template/executor/agent registries, plugins and providers | {c('cli-bootstrap',2)} |
| Ownership fencing | Per-run lease keeper plus guarded event writes; persistent work claims | {c('store-ownership',2)}, {c('store-ownership',1)} |
| Shared interaction substrate | KeyboardMap/layers/Menu/VirtualList/PaneSplitter and shared graph layout | {c('app-interaction',1)}, {c('app-interaction',2)}, {c('app-config-workflow',2)} |

The architecture is not uniformly event sourced: request/item/plan collections are mutable documents; journal and run events have different authority. Calling all persistence “event sourcing” would hide those differences. {c('store',2)}, {c('engine-plan',1)}

## Build, packaging and operational delivery

Declared build chain: TypeScript references → desktop renderer Vite output → daemon esbuild bundle → Electron packaging. The renderer resolves safe source aliases and bundles design assets; preload is CJS. Generated design TS/CSS derive from tokens/semantics, fonts from dedicated font tooling and installed upstream font sources. Generated files are committed artifacts with source definitions, not independent editing targets. {c('delivery',1)}, {c('design',1)}, {c('tool-fonts',1)}, {s('packages/app/scripts/build-daemon.mjs','esbuild') if (ROOT/'packages/app/scripts/build-daemon.mjs').exists() else c('app',2)}

Declared CI: Node 22/24 validation lanes, build/demo, design freshness/lint/format/type checks, tests/coverage; separate desktop and app-smoke workflows; changelog/release preparation and publication workflows; manually dispatched CodeQL; Dependabot. Declaration establishes intended gates only. Desktop outputs target Linux/macOS/Windows, while built-in private-feed updater is restricted to packaged Windows x64/arm64. macOS signing/notarization is disabled in checked-in packaging config. {c('delivery',1)}, {c('delivery',4)}, {c('app-updates',1)}

Implemented managed deployment: stage source-based releases, record version/SHA/store epoch, validate compatibility and forward movement, close admission, persist activation journal, stop service, switch symlink, start/check, reopen admission and clean journal. Recovery retains/recloses admission when state is uncertain. Managed launchers use admission locking and pin a selected release path; desktop-owned daemon shutdown uses a related but separate maintenance flow. No deployment was attempted. {c('delivery',2)}, {c('delivery',3)}, {c('app-updates',2)}

## Tests as intended coverage

Declared: Vitest uses source aliases, package and renderer tests, bounded workers and per-file thresholds with explicit exclusions. Engine/daemon/agents tests exercise scripted ACP subprocesses; filesystem/ownership tests specify concurrency/recovery scenarios; protocol tests specify schema/status contracts; renderer tests use happy-dom and architecture sweeps; Playwright smoke source covers real-window layout; standalone Node/Python tool tests cover delivery and release helpers. [Test declaration catalog](test-catalog.md) lists discovered test files and literal test/describe labels without running them. {s('vitest.config.ts','defineConfig')}, {c('testing',1)}, {c('design',3)}

Selected sources traced include lease/claim fencing, multi-process plan service, agent permission sidecars, daemon subscription replay, app reconnection, update recovery and interaction sweeps. In particular, the multi-process PlanService scenario refreshes data across service instances with sequential calls; its presence alone does not establish concurrent semantic mutation safety. {s('packages/engine/test/plan-service-multiprocess.test.ts','it("ensures one plan')}

No tests were executed. Coverage percentages, success, flakiness, runtime race handling and platform parity are unverified. A test title is a declaration, not an assertion that the subject works.

## Observability and diagnostics

Implemented: structured domain events and per-plan journals expose run/step/input/artifact/ownership transitions; console logger has levels; CLI inspection, leases/claims/plan commands, daemon health/read methods, renderer logs/artifact views and configured-agent health provide diagnostic surfaces. Prompt hash/preview and tool/output events allow partial provenance, with bounded output/body handling. Correlation is primarily domain identifiers and per-run sequence. {s('packages/core/src/util/logger.ts','export')}, {c('cli-commands',1)}, {c('daemon-projections',1)}, {c('app-runs',2)}, {c('engine-execution',3)}

Inferred absence, scoped to inspected manifests, source imports and diagnostics: no dedicated metrics exporter, distributed tracing backend, central audit ingestion service or general retention scheduler. JEV usage metadata is provider-specific; it does not establish total agent cost. There is no reliable run completion percentage/ETA implemented by the planning weights or display schemas. {c('core-planning',1)}, {c('protocol',1)}, {c('integration-jev',3)}

## Concentrations and change surfaces

Implemented structure places substantial coordination in Orchestrator, PlanService, CLI command dispatch, daemon read/plan projections, Electron main and PlanSurface. Large modules are evidence of concentrated responsibility, not automatic defects. The [source map](source-map.md) records line counts. Adding a method can touch protocol constants/schema maps, daemon assembly, main IPC, preload/type bridge and renderer hooks; this is a concrete change-amplification path. {c('engine',1)}, {c('engine-plan',1)}, {c('cli-commands',1)}, {c('daemon',2)}, {c('app',2)}

Permission-sidecar/config locking is distinct from store locking; request settlement is distinct from run/work-item/plan settlement; UI snapshot/reconciliation logic differs by surface family. These separations sometimes follow package boundaries or different safety requirements. Whether they should converge is assessed in the later roadmap, not assumed here. {c('agents-permissions',4)}, {c('daemon-config',1)}, {c('store-ownership',3)}, {c('engine-program',1)}, {c('app-plan',1)}
''')
put('uncertainties.md',f'''# Uncertainties and negative findings

Every entry limits what this baseline establishes. No item is a runtime failure report.

| ID | Boundary / unresolved question | Static basis | Status |
| --- | --- | --- | --- |
| U01 | Concurrent semantic plan mutations across processes, and recovery between document/journal writes | Local service queue plus per-file locks; no shared multi-record transaction. {c('engine-plan',1)}, {c('store',3)} | Inferred boundary; crash/race outcomes unverified |
| U02 | Visibility of writes by another CLI/daemon process and changes missed during store-wide disconnection | Object-local listeners; no global replay. {c('store-logs',3)}, {c('app-client',2)} | Implemented boundary; operational symptom frequency unverified |
| U03 | Isolation of concurrent local-provider runs sharing cwd/branch | Local provider checkout versus run/item ownership keys. {c('engine-workspaces',1)} | Workspace-level exclusion not located |
| U04 | Full reproducibility of a resumed run after template/config/plugin/model changes | Workflow pinning but live separately loaded assets/sessions. {c('store-content',2)}, {c('engine-execution',1)} | Full invocation snapshot not located |
| U05 | Request settlement parity for daemon-driven answers/resumes | ProgramService owns request projection; ControlModel invokes Orchestrator. {c('engine-program',1)}, {c('daemon-controls',1)} | Requires dedicated lifecycle trace/testing |
| U06 | Strong filesystem sandboxing, transport authentication, remote exposure and secret redaction | Path checks, executable trust, raw config and no dispatcher identity. {c('system',6)}, {c('agents-session',3)}, {c('daemon-config',1)} | These guarantees are not established |
| U07 | Ready-to-use T3 transport and durable provider-session restore | Throwing placeholder RPC; session interface has no load. {c('integration-t3code',3)}, {c('agents-session',4)} | T3 partially implemented; session continuation in memory only |
| U08 | Workflow hot reload / editing and generic migration / retention | Viewer/read RPC, bootstrap registries, store ports, deployment epoch. {c('app-config-workflow',3)}, {c('delivery',3)}, {c('store',1)} | No general mechanism traced |
| U09 | Correctness of “conservative” malformed-sidecar fallback with deny rules | Sidecar reader warns/ignores malformed overlay; default workspace rules can allow. {c('agents-permissions',3)} | Incidental security/correctness question for separate review |
| U10 | Dependency re-evaluation after a persisted satisfied status | Early return precedes live target state. {c('core-planning',4)} | Implemented behavior; intended reopening semantics unresolved |
| U11 | Scale, long-history performance, crash durability and external interoperability | Filesystem scans/caches, locks, wire/ACP/JEV/SSH integrations | Unverified without separately authorized execution |
| U12 | CI health, platform packaging/signing, visual accessibility and runtime coverage | Config and test sources only. {c('delivery',1)}, {c('design',3)} | All outcomes unverified |

Explicitly not found as general facilities in inspected source/manifests: multi-tenant user authorization, SQL migrations, arbitrary plugin isolation, a global autonomous scheduler service, a global host resource allocator, metrics/tracing export, store archival/GC and complete model-cost/ETA accounting. This is a scoped absence finding, not a claim that no external deployment wrapper could supply these facilities.

The file-level census is broad; semantically traced ownership families and their concrete evidence are in [coverage](coverage.md). Test sources were selectively read and broadly cataloged. Binary artifacts and every individual test branch were not audited. No existing documentation was used to fill these gaps.
''')
# Complete file ownership ledger; mapping does not imply line audit.
rows=list(csv.DictReader((OUT/'baseline/source-census.tsv').open(),delimiter='\t'))
# Preserve census column names irrespective of its discovery script.
print('Census columns:',list(rows[0]))
lines=['# Source ownership map','','Every census file is mapped below. Architecture review traces major responsibilities; inclusion here means **mapped**, not that each line was individually audited. Evidence links in specifications identify the semantically traced sources. Generated files, tests and configuration retain distinct census categories.','','| File | Category | Ownership view | Lines |','| --- | --- | --- | --- |']
for row in rows:
    path=row['path']; owner=row.get('owner',''); parts=path.split('/'); key=parts[1] if parts[0]=='packages' else ('tool-'+parts[1].replace('eslint-config','eslint').replace('font-build','fonts') if path.startswith(('tools/eslint-config/','tools/font-build/')) else ('workflow-assets' if parts[0] in ('workflows','templates','examples') else 'delivery'))
    if key not in views:key='delivery'
    lines.append(f'| [{path}](../../{path}) | {row.get("category","")} | [{key}](../architecture/{key}.md) | {row.get("lines",row.get("line_count",""))} |')
put('source-map.md','\n'.join(lines))
# Literal test declarations are safe source evidence; not evaluated.
lines=['# Test source catalog','','Static extraction of literal describe/test/it labels. Labels declare intent only; no test file was imported, collected by a runner or executed. Dynamic/generated cases may not appear in this extraction. Test fixtures are separately in the source census.','','| Source | Selected literal declarations |','| --- | --- |']
tracked=subprocess.check_output(['git','ls-files'],cwd=ROOT,text=True).splitlines()
for path in tracked:
    if not re.search(r'(\.(?:test|spec)\.(?:tsx?|[cm]?js)$|/test_[^/]+\.py$)',path):continue
    txt=(ROOT/path).read_text(); matches=re.findall(r'\b(?:test|it|describe)(?:\.(?:skip|only))?\(\s*[\'"`]([^\'"`\n]+)',txt)
    if path.endswith('.py'):matches=re.findall(r'^\s*def (test_\w+)',txt,re.M)
    shown='; '.join(matches[:12]).replace('|','\\|') or 'Nonliteral or helper-driven declarations; inspect source.'
    lines.append(f'| [{path}](../../{path}) | {shown}'+(f' (+{len(matches)-12} more literal declarations)' if len(matches)>12 else '')+' |')
put('test-catalog.md','\n'.join(lines))
