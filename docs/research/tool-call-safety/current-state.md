# Existing system, interception and adapter capabilities

Findings apply to the [recorded baseline](README.md), not every deployed ORCA or
provider version. Line references below refer to that commit. Source and tests take
precedence over historical roadmap claims and over comments that overstate a guarantee.

## What exists and should be reused

| Foundation | Verified behavior and limit | Baseline evidence |
| --- | --- | --- |
| Deterministic implicit permissions | `allow/deny/ask`, first matching kind/title-regex/path/prefix/scope rule. Configuration → workspace sidecar → conditional defaults. Explicit `default`, including `ask`, disables default rules. Default workspace read/search/edit/delete/move and think allow; other requests ask. | [agent model](../../../packages/core/src/model/agent.ts), [evaluator](../../../packages/agents/src/permissions.ts), [ADR 0009](../../adr/0009-permission-grants-in-a-workspace-sidecar.md) |
| Standing rules | Derivation keeps kind; path-derived grants reject outside/root paths and use exact workspace-relative paths. Execute uses an anchored escaped title before path inspection, which is not filesystem confinement. Volatile/unscopable derivations are refused. Serialized sidecar writer and revision-guarded editor exist; no TTL, per-run use count or complete argv/state binding. | `model/agent.ts:452–491`; [permissions writer](../../../packages/agents/src/permissions.ts); [config model](../../../packages/daemon/src/config-model.ts) |
| Live policy | Sidecar reread per ask. Bootstrap resolves current configured agent permission policy even when restoring older execution choices. Saved agent permission changes require restart; sidecar changes are live. | [bootstrap](../../../packages/cli/src/bootstrap.ts) lines 190–206, 350–362; [configuration generations](../../configuration-generations.md) |
| Human permission handling | One request per ask. Default auto input refuses permission asks unless an explicitly configured offered option is selected; pausing input cancels a permission callback rather than persisting it as a reusable gate. | [human-input](../../../packages/engine/src/human-input.ts) lines 51–130; [orchestrator](../../../packages/engine/src/orchestrator.ts) lines 1864–1926 |
| Exact live acceptance | Run/step/input plus daemon/session/turn/invocation identity, one-shot offered choices, current verified responder and execution authority under the owning lease; actor recorded before standing write/delivery. Cancellation/revocation/death expires callbacks. Other processes report owner unavailable. | [live-input](../../../packages/engine/src/live-input.ts), [continuity contract](../../live-input-continuity.md), [execution authority](../../../packages/daemon/src/execution-runtime.ts) |
| Durable workflow decisions | Human/artifact/agent/expression/matrix decisions route the graph. Human gates park and recover from events; their business choices are distinct from live tool callbacks. | [basic executors](../../../packages/engine/src/executors/basic.ts), [human-input](../../../packages/engine/src/human-input.ts), [workflow docs](../../WORKFLOWS.md) |
| Authentication and authority | Per-operation permission inventory, resource ownership/filtering, current credentials/revocation and actor audit. `inputs.answer` differs from `permissions.grant`; run continuation/resume authority differs from answering a gate. | [auth operations](../../../packages/daemon/src/auth/operations.ts), [guard](../../../packages/daemon/src/auth/guard.ts), [live-input authority](../../../packages/daemon/src/live-input-authority.ts), [execution runtime](../../../packages/daemon/src/execution-runtime.ts) |
| Captured execution configuration | Immutable protected generations and workflow versions; provenance records selection sources. Restoration refuses missing/corrupt material; current authority is not frozen. Arbitrary executable plugins have bootstrap-bound recovery limitations. | [generation implementation](../../../packages/engine/src/configuration-generation.ts), [generation contract](../../configuration-generations.md) |
| Recovery and ownership | Fenced execution leases, durable admission/continuation receipts, reconciliation without repeating completed work. Owned direct-child cleanup is bounded; process descendants and remote exit are outside that guarantee. | [lease store](../../../packages/store/src/lease-store.ts), [continuation admission](../../../packages/engine/src/continuation-admission.ts), [cleanup](../../../packages/agents/src/process-cleanup.ts), [architecture](../../ARCHITECTURE.md) |
| Audit and protected data | Protected exact payloads separated from safe public history; actor/target/outcome security audit; compact agent tool summaries. Known-literal redaction is not general taint tracking. | [protected storage](../../protected-execution-storage.md), [audit](../../../packages/daemon/src/auth/audit.ts), [event projection](../../../packages/store/src/protected-event-store.ts), [session summaries](../../../packages/agents/src/session.ts) |

The additive work is a structured action envelope, non-overridable policy ceilings,
explicit interception/effect capabilities, optional model advice, mandatory evidence
before dispatch and bounded permits. Do not duplicate the permission evaluator,
human input queue, authentication service, workflow-version store or recovery ledger.

## Baseline gaps that affect the recommendation

- Permission matching trusts adapter-reported kind/title/locations. It does not
  inspect `rawInput`, argv, environment or network destinations. Exact path and
  prefix rules match **any** reported location; `scope: workspace` requires every
  location and a nonempty list. `pathPrefix` uses string `startsWith`, not a physical
  filesystem boundary. An earlier configured allow can beat a later deny. These
  are compatibility semantics, not proof all effects are permitted.
- [`loadEffectivePermissionPolicy`](../../../packages/agents/src/permissions.ts)
  skips unreadable sidecars when supplied its error callback. Sidecars can contain
  deny/ask rules, so skipping can expose later default allows. Source comments that
  say only grants are lost are too strong; ADR 0009's dated clarification identifies
  this. New enforcing profiles need explicit fail-closed material handling.
- Automatic [`resolvePermission`](../../../packages/agents/src/permissions.ts)
  (lines 121–149) prefers `allow_once` but falls back to provider `allow_always`.
  The live human path filters to one-shot options. A strict reviewed-action profile
  must reject remembered-only automatic choices unless an independent executor can
  enforce the promised bound; do not assume all current approvals are one-shot.
- [`acp-session.ts`](../../../packages/agents/src/acp-session.ts) lines 193–213
  serves client file requests without permission evaluation or a live-turn/session
  check in those handlers. `withinRoots` is lexical, while host I/O follows links.
  Required action checks must run before actual host I/O, with physical confinement
  and correct session attribution; a policy matcher is insufficient.
- [`LocalHost`](../../../packages/agents/src/hosts/local-host.ts) merges ambient
  `process.env` into the agent process. Review of a command title cannot keep those
  credentials private. Policy, daemon store/keys, sockets and runtime credentials
  need exclusion at the execution boundary.
- [`agent.permission`](../../../packages/engine/src/orchestrator.ts) lines 1928–1943
  is a fire-and-forget event append. Tool arguments/results in `agent.update` are
  capped, not a complete action record. Neither is a durable authorization fence.
  Add authoritative evidence using protected storage rather than treating telemetry
  as an execution receipt.

These findings are research inputs, not fixes made by this PR.

## Execution-path capability matrix

The proposed interception location is specific to each path. Baseline capability
does not certify the installed provider's behavior. **Reviewed request** means an
observed decision point; **constrained effects** requires an independent execution
boundary covering filesystem, network, credentials and descendants as promised.

| Path | Existing interception and enforcement | Proposed exact boundary | Required refusal / residual gap |
| --- | --- | --- | --- |
| Local generic ACP permission request | `openAcpSession` handles `session/request_permission` during an active turn; adapter must honor response | Capture before `resolvePermission`; coordinator evaluates and returns only the exact one-time choice | Tools that never ask bypass this seam. Complete-mediation profiles cannot rely on it alone. |
| ACP `session/update` tool notifications | Observations, possibly after execution begins | Use only as coverage/audit telemetry | Never pause or authorize by reading a notification after the effect. |
| ACP client file read/write | ORCA-owned handler → lexical roots → `host.fs` | Check identity/action/policy immediately before brokered file I/O; enforce link/race-safe access at host | Native adapter file access may bypass client methods; remote fs needs a remote boundary. |
| ACP terminal methods | `terminal: false`; no ORCA terminal executor | A future `terminal/create` broker could bind command/argv/env/cwd before process spawn | Not supported now. Terminal support cannot force native adapter commands through the broker. |
| Adapter-internal shell, filesystem or MCP tools | Only callbacks the provider/bridge chooses to forward; ordinary process/service permissions | Provider-specific every-tool hook for review, plus native sandbox/broker and service-side ACLs for effects | An MCP server may execute remotely or hold broader credentials. Its tool title/schema/annotations are untrusted claims. |
| Local `AgentHost.exec` / process spawn | Ordinary local spawn, shell for `exec`, ambient env; no ORCA-created OS sandbox | Runner launcher enforces clean environment, descriptor/mount/network/process limits before starting adapter; broker checks owned commands | Host helper wrapping cannot intercept arbitrary Node/native syscalls by code in the same process. |
| SSH ACP and host I/O | Same callbacks over SSH; remote login shell/agent and shell file operations | A trusted remote runner checks the same action/permit and reports versioned guarantees; remote service enforces target ACLs | Local sandbox does not constrain remote account/processes. Require remote evidence or reject constrained-effects profile before the turn. |
| Custom `AgentSession` / `sessionFactory` | No mandatory review/effect contract in the interface | New explicit capability provider and conformance adapter at factory registration/admission | Unknown by default; factories can bypass `openAcpSession` entirely. |
| In-process plugins/custom node executors | Trusted JavaScript may use fs/net/process directly | Classify as administrator-trusted code, or move to isolated worker with mediated capabilities | No claim the implicit layer confines an in-process hostile plugin. Strict profile rejects unaudited execution paths. |
| ORCA-owned Git/workspace/artifact/integration operations | Service operations outside agent permission callbacks, through host exec/fs or integration code | Separate typed service-operation boundary under the owning principal before provisioning/publishing/I/O | Do not hide service authority in agent approval or recursively model-review internal audit/store writes. Provisioning and publication need their own contracts. |
| CLI/daemon/inbound ACP/inbound MCP | Admission/control authorization protects ORCA operations, not tools of an upstream client | Preserve authenticated shared admission and owner-local answer services; explicit trusted-local authority for in-process/CLI entry points | An upstream ACP choice is not a verified actor. Live upstream choices already use authenticated fallback; no broadening from transport labels. |
| T3 Code scaffold | No permission callbacks in session options; default `full-access`; transport factory throws `NOT_SUPPORTED` | Separate future adapter work, including actual approval bridge and runner contract | Not production enforcement support. Refuse before execution under an enforcing profile. |

Source seams: [ACP session](../../../packages/agents/src/acp-session.ts) lines 79–85,
131–213, 268–287; [local host](../../../packages/agents/src/hosts/local-host.ts);
[SSH host](../../../packages/agents/src/hosts/ssh-host.ts) lines 66–139;
[session interface](../../../packages/agents/src/session.ts) lines 28–47;
[Git worktree provider](../../../packages/engine/src/workspace/git-worktree.ts);
[plugin bootstrap](../../../packages/cli/src/bootstrap.ts) lines 482–493;
[upstream input](../../../packages/integrations/src/acp-facade/upstream-human-input.ts)
lines 55–102; [T3 session](../../../packages/integrations/src/t3code/session.ts);
[integration status](../../INTEGRATIONS.md).

Cancellation currently concerns the owned direct child (the SSH client for remote
sessions). Neither a parent kill nor an expired lease proves grandchildren, remote
jobs or external side effects stopped. A stricter runner must report observed process
tree termination and unknown remote effects separately.

## External primary documentation

Checked 2026-10-04. Protocol guarantees, current upstream source observations and
installed ORCA support are deliberately separate. Pin/test actual binary and bridge
versions before admission; upstream `main` is evidence of an available seam, not
certification of the configured binary.

| Protocol/provider | Primary source and observed contract | Implication for ORCA |
| --- | --- | --- |
| ACP v1 | [Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls): agent executes; updates report progress, permission requests are a separate exchange. [Filesystem](https://agentclientprotocol.com/protocol/v1/file-system) and [terminals](https://agentclientprotocol.com/protocol/v1/terminals) are separately negotiated client capabilities. | ACP does not promise every tool asks permission or every effect uses client services. Inspect supported payloads and exact callback lifetime. |
| Claude Agent SDK / Claude ACP | [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions): auto-approved operations may bypass `canUseTool`; `PreToolUse` is the every-tool hook. Current [ACP bridge source](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts) forwards `canUseTool` requests. | Generic ACP approval has narrower coverage than a managed every-tool hook. Even a hook needs trusted installation and confinement to constrain effects. |
| Claude command policy | [Permissions](https://code.claude.com/docs/en/permissions) documents native rules and their relationship to sandboxing. | Native policy semantics and modes are not ORCA rule semantics; alternate command forms and internal execution need conformance tests. Do not disable provider enforcement to obtain more callbacks. |
| Codex native app-server | [App-server](https://learn.chatgpt.com/docs/app-server) describes separate typed command/file/permission requests with thread/turn/item identity and scoped grants. | A potentially richer future adapter; no native app-server adapter exists in this ORCA baseline. Map native identity and subset grants explicitly, not through a lossy title. |
| Codex ACP | [Bridge source](https://github.com/zed-industries/codex-acp/blob/main/src/thread.rs) maps native approval events to ACP; start events are separate observations. | Pin both provider and bridge. Internal policy can resolve actions without forwarding an ACP ask. Preserve available structured payloads without assuming other adapters supply them. |
| Codex automatic review | [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) describes review at eligible sandbox-boundary requests, not every routine in-sandbox action; sandbox/managed limits remain separate. | Useful precedent for reviewer/enforcer separation and denial-loop protection, not a universal interception feature inherited by ORCA. |
| Gemini CLI | [Policy engine](https://geminicli.com/docs/reference/policy-engine/) has its own rule tiers/modes. Current [ACP session source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpSession.ts) asks only when confirmation is required and its request omits `rawInput`. [Filesystem bridge](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpFileSystemService.ts) has native fallbacks. | Structured command completeness and complete file mediation cannot be assumed. Treat missing required arguments as indeterminate; test exact versions/modes rather than infer coverage from the Gemini name. |
| MCP | [Security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) covers confused-deputy, token audience/passthrough and SSRF concerns. | Tool/service availability and session identity do not confer caller authority. Check remote service permissions and checker egress separately. |

Proposed capability facts should include schema/version, provider/bridge/runner
fingerprints, effective mode, structured-input completeness, permission-only versus
every-tool preflight, brokered fs/exec, effect constraints, descendant/remote handling,
once-only choice support and drift detection. A configured name or self-declared
boolean is insufficient: require conformance evidence from an administrator-trusted
launcher. Bind facts to the session and invalidate on mode/binary/host changes.
Unsupported requirements fail at admission before launching the agent; unexpected
runtime capability loss stops further dispatch. Display partial coverage explicitly.
