# Agent context recovery investigation for #357

30 October 2026. ORCA baseline `a4e0fd44e2a112129034e2f4c9b33a7c95c6db99`.
Source investigation, proposed lifecycle contract and bounded adapter groundwork.
The adapter's required-load option is implemented locally; the lifecycle is not wired.

This advances [#357](https://github.com/cschadewitz/Project_Orca/issues/357), specifically its
[durability requirement and Approved — Continue decision](https://github.com/cschadewitz/Project_Orca/issues/357#issuecomment-6514920391).
It creates no competing recovery issue or dependency graph. #237 owns the shipped live
callback foundation; #702/#703 own scoped and one-use authority; #374 is related provenance
work; #344 owns host reassignment. This packet does not claim their acceptance.

## Finding and evidence boundary

Conversation recovery is feasible in the inspected Claude, Codex, Gemini, Pi and OpenCode
source paths, conditional on the expected provider storage, identity and configuration
still being available. None has installed-provider recovery acceptance in this investigation.
Copilot adds documented persistent history and an advertised load capability, with a
closed native implementation and unverified ACP recovery behavior. These are named
provider research lanes, not a certified provider/tool/version support matrix: ORCA accepts
configured ACP commands rather than owning a fixed provider distribution.

Context means the provider's persisted conversation/compaction state sufficient for a
new turn. It does not mean a running process, the model's hidden state, every streamed
token, a pending JSON-RPC request, a terminal, or proof of an external effect. A successful
load response and the same session ID establish neither completeness nor authority.
Restoring context does not resurrect an expired permission callback. Provider context
can outlive a turn; its original execution permission must not.

Pins below reuse existing [#704/#705 research](../provider-enforcement-704-705/README.md),
[#506/#594 Codex evidence](../acp-command-conformance/source-map.md),
[#709 Copilot preparation](../copilot-cli-acp-709/README.md) and
[#710 OpenCode preparation](../opencode-acp-710/README.md). They are not claims about latest
releases or installed executable correspondence. [Source inventory](source-inventory.json)
records the exact resources reread for this investigation and Git blob identities where
the read tool returned them. No provider was installed, authenticated or launched.

## What the ORCA source baseline preserves

- [The adapter](../../../packages/agents/src/acp-session.ts) exposes both the ORCA session
  ID and the provider's `acpSessionId`, accepts explicit `resumeSessionId`, checks negotiated
  `loadSession`, sends `session/load` on a newly spawned connection, and reports continuity.
  Unsupported, rejected **and timed-out** loads currently fall back to `session/new`.
  The catch erases the specific load error. This is existing behavior, not safe durable
  Continue behavior. A timed-out provider load may still finish later; the strict path must
  retire that connection rather than race it with a fresh session.
- [The orchestrator](../../../packages/engine/src/orchestrator.ts) supplies no resume ID
  at session creation. Its `agent.session.opened` event records `session.id` (ORCA's ID),
  agent, host, cwd, model and continuity, **not the native ACP recovery ID**. The grep of
  engine/store/core/daemon source found no persistence of `acpSessionId`. Existing pooled
  sessions can serve multiple live turns, but pool reuse is not a restart recovery index.
- Permission invocation IDs are newly minted per ask and turn; prompt completion,
  cancellation, timeout and transport/process death abort the old invocation. This is
  intentional. An old tool-call ID and an old human answer cannot be retargeted.
- The adapter receives history replay during the load handshake before a caller can
  subscribe to the returned session's updates. It does not buffer that replay for later
  subscribers. The engine's bounded update summaries are not a complete native transcript
  backup. UI replay and restored model context are separate observations.

## Provider inventory

The restart column describes a source-supported route, **not observed restart acceptance**.
Every route needs the same authorized storage namespace on the same host/profile and the
right workspace association; a remotely launched provider owns its remote storage.

| Provider / exact research pin | After a turn / new connection | Process or daemon restart route | Limits and missing context behavior |
| --- | --- | --- | --- |
| Claude Agent ACP **0.95.0**, `ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350`; SDK **0.3.309**, native candidate **2.1.309** | Advertises load; load reads transcript and starts/reuses a query with SDK `resume: sessionId`, then replays history. ACP/native ID is shared. | Local JSONL transcript under `claudeConfigDir()/projects/<project>/<sessionId>.jsonl`; search spans project directories. A fresh bridge can call the same load route if the native SDK can resume it. | Native implementation is closed; artifact correspondence and crash-tail durability are unverified. Transcript-read errors are logged and can yield an empty snapshot; this is not proof the model lost context or that it recovered it. A separate live-query recreation path starts fresh under the same ID for a never-persisted session. Do not infer history from ID equality. |
| Codex ACP **2.2.2**, `202e66e63343ec4f5a5e35ab590251d813d129ca`; native dependency floor **0.160.1**, `d27764b82f7118f674371e6d6e76271d9d606edb` | ACP load calls native `thread/resume`; native thread ID is the ACP session ID. Replays durable item pages (or legacy history) and restores reported model/settings. | Rollout JSONL under the configured Codex home, plus native state/index machinery. New app-server can resume a materialized thread. The bridge also has app-server restart/lazy-resume machinery. | A never-prompted thread may have no rollout. Fallback to `thread/read` uses live app-server memory only; after its death, the recovery owner maps missing rollout to `UnpersistedSessionLostError`. Active-writer conflicts refuse. Stream replay failure closes the partially opened session. No automatic rerun/effect guarantee. |
| Gemini CLI **0.65.0**, `6006c14a4decfe4b891c6263ad6ad5992e404b5b` | Native ACP advertises load. SessionSelector resolves saved conversation; `resumeChat` gets converted history plus the original conversation/file path; a new Session/config is created. | Project-keyed runtime temp directory, `chats/session-*` with extensions `.json` and `.jsonl`. Normally the `.gemini` runtime root; macOS Seatbelt uses `.cache/.gemini`; container sandbox runtime may be ephemeral. Persistent volume/profile identity matters. | Missing or wholly unreadable records can fail selection; duplicate IDs choose the most recently updated record. `allowEmpty: true` permits a startup-only session, so successful load need not imply nonempty conversation. UI history streaming is asynchronous and errors are logged after returning. Recording errors/cleanup and missing last writes need acceptance tests. |
| Pi native **1.4.0**, `4a080252f06caf63a525d7873c5d94d3c23887e0`; community pi-acp **0.0.34**, `b0581c9c1d675e634234674484247008b03d69b4` | Load closes the old Pi subprocess, finds an ID-to-file mapping or scans native sessions, spawns RPC Pi with `--session <file>`, obtains configuration/messages and replays them. | Native JSONL, normally `~/.pi/agent/sessions/...`, with native settings/agent-dir overrides; bridge mapping in `~/.pi/pi-acp/session-map.json`. Mapping can be rebuilt by scanning session headers. | Unknown ID rejects. Malformed map is treated as empty and native discovery may recover it. **Stale mapping to a missing/empty file is hazardous:** the inspected native `SessionManager` initializes a fresh session for such an explicit path; the bridge restore path does not compare its requested ID with native `get_state.sessionId`. Launcher version is externally selected, so this is a pin-specific source risk, not an installed defect claim. |
| OpenCode **1.19.4**, `148842ef7cb1bc34192b3fff57d0f9721ab9c801` | Load retrieves backing session and messages through the SDK, restores model/variant/mode into the ACP connection's session map, registers MCP and replays messages. Native ID is retained. | Native database is the durable backing store; ACP map itself is in memory. Database path derives from `Global.Path.data`, channel and `OPENCODE_DB`; `:memory:` is explicitly possible and not restart durable. | Missing backing session/messages fails the request. Current config is resnapshotted; unavailable former model/mode can fall back to current defaults. Runtime permission caches/background jobs are separate. SQLite WAL with `synchronous=NORMAL` is not a promise of power-loss durability. |
| Copilot CLI **1.0.103**; reused documentation pin `github/docs@943e6d816a55df71c974921348c177f344377c8d` | Existing #709 registry probe advertises `loadSession`; documentation discusses created/loaded/resumed sessions. Actual ACP load is not exercised. | Documented `$COPILOT_HOME/session-state/<id>/events.jsonl` and workspace artifacts; `session-store.db` indexes cross-session data. CLI `--resume`/`--continue` is documented. | **Documented/advertised only.** Cannot attribute native CLI resume semantics or exact context fidelity to ACP without an installed test. Changing config home hides existing sessions. Remote sync, local removal and retention are separate; no sync/reindex action is authorized here. |

The historical installed-profile report for Codex was **0.159.1 / bridge 2.1.1**, not the
newer research pair. Rereading bridge `68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`
confirmed the same resume/materialized-history/live-memory fallback distinction. Its
installed binary, native patch level, selected home and enabled recovery configuration
still need verification. Do not promote the newer source pin to installed support.
T3 Code is existing transport groundwork, not another supported ACP recovery route.

### Source anchors supporting the table

- Claude: [load/replay](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/src/acp-agent.ts#L3033-L3167),
  [same-ID fresh recreation case](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/src/acp-agent.ts#L4124-L4155),
  [transcript lookup/errors](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/src/resumed-session.ts#L49-L130).
- Codex: [native resume/materialization and load](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CodexAcpClient.ts#L619-L762),
  [replay failure](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CodexAcpServer.ts#L1144-L1197),
  [unpersisted-loss classification](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/app-server-recovery/AppServerRecovery.ts#L674-L684),
  [native recorder](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/rollout/src/recorder.rs),
  [older bridge comparison](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexAcpClient.ts#L544-L680).
- Gemini: [load and asynchronous replay](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSessionManager.ts#L204-L312),
  [selection](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/utils/sessionUtils.ts#L513-L598),
  [runtime storage](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/config/storage.ts#L89-L108),
  [recording and startup cleanup](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/services/chatRecordingService.ts).
- Pi: [restore mapping/process](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/agent.ts#L159-L230),
  [load/replay](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/agent.ts#L938-L1014),
  [map](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/session-store.ts),
  [native missing/empty path](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1029-L1054),
  [native persistence](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1172-L1188).
- OpenCode: [ACP load/resume](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/acp/service.ts#L211-L333),
  [model/mode fallback](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/acp/service.ts#L1089-L1145),
  [database options](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/core/src/database/database.ts),
  [data root](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/core/src/global.ts).
- Copilot: [ACP launcher/session behavior](https://github.com/github/docs/blob/943e6d816a55df71c974921348c177f344377c8d/content/copilot/reference/copilot-cli-reference/acp-server.md#L37-L55),
  [local history](https://github.com/github/docs/blob/943e6d816a55df71c974921348c177f344377c8d/content/copilot/reference/copilot-cli-reference/cli-config-dir-reference.md#L329-L343),
  [existing advertised capability evidence](../copilot-cli-acp-709/source-pins.json).

Compaction is normal provider state evolution, not evidence of unrecoverable context.
Pi builds model context from its active branch, summary and retained entries, rather
than every raw historical message. Claude replay also handles retained summaries; Codex
records compaction items. Recovery should identify the expected checkpoint/branch and
compaction boundary, and state whether the latest durable context was recovered. No
source read here proves full token-for-token recovery at a crash boundary, nor does a
raw transcript guarantee reconstruction of native context. Shells, subagents, extension
state, pending MCP work and external mutations require separate reconciliation.

## Smallest safe Continue contract proposed for #357

The local implementation described below supplies the opt-in required-load boundary
in item 4. The remaining lifecycle, storage and native-verification work stays proposed.

1. **Persist a non-executing intent and recovery reference before yielding to a person.**
   Use protected run-owned storage and existing fencing. Bind schema version, intent ID,
   run/step/attempt, principal/workspace, host/storage-profile identity, provider/adapter
   artifact identity, native session ID, exact reviewed scope and effective configuration.
   Add a private checkpoint/branch/last-durable-turn reference and integrity/version facts
   when the provider can supply them. The reference is not a bearer credential or callback.
   Store no execution permit, descriptor, secret environment value or raw private context
   in public projections. Persist the native ID privately; an ORCA session ID alone cannot
   find provider history. Reuse existing ports rather than creating another ownership system.
2. **Retire the originating invocation and preserve the human decision separately.**
   Late approval produces Approved — Continue. It neither prompts a provider nor resolves
   the dead callback. Cancellation tombstones both pending and approved intents. A single
   explicit Continue uses authenticated compare-and-swap to claim one eligible new attempt;
   its state/provenance must be distinct from the historical invocation and completed work.
   Unrelated run/sibling failures must be checked before claiming eligibility.
3. **Check authority and uncertainty before starting recovery.**
   Recheck current principal, workspace/revision/resources, policy, credential availability,
   revocation, lease/fence and cancellation. Reconcile any effect whose old acknowledgement
   was lost; never silently retry it. Restoring a provider can start native processes,
   extensions, auto-memory or MCP servers, so do not call it a side-effect-free probe.
   Use the currently authorized launcher/resource ceilings and supported enforcement tuple.
   The persisted intent itself remains non-executing.
4. **Require recovery explicitly on the existing adapter path.**
   The implemented adapter addition is an opt-in `requireContextRecovery` alongside the existing
   `resumeSessionId`, used only by this new lifecycle. Missing capability, load error or
   timeout stops that attempt, closes the connection and preserves the original reference;
   it never calls `session/new`. Preserve a sanitized actionable failure classification
   (unsupported, missing, corrupt, wrong identity/profile, incompatible version, busy writer,
   timeout or unavailable). Existing generic fresh-session callers need no behavior change.
   `loaded` means RPC success today; verified expected-context identity/availability must be
   a separate private recovery result. A generic load response alone cannot establish it.

   The adapter now distinguishes missing ID, unsupported load, failed load and load timeout.
   Provider-specific missing/corrupt/unauthorized/incompatible classifications remain future
   verification work; a rejected provider load is deliberately only `load-failed` today.
5. **Validate recovered identity and context before a prompt.**
   Verify the exact provider checkpoint/session and branch, durable boundary, configuration
   compatibility and current workspace; refuse missing or silently replaced context. Pi's
   native session ID must match the expected one, with a present valid session file and
   expected durable marker; do not trust the adapter's echoed ACP ID. Treat same-ID empty
   recovery and model/mode substitutions explicitly. Checkpoint evidence may need a small
   provider-specific verification seam; unknown verification is not success. Recheck current
   ownership/authority after awaited recovery and before starting the fresh turn.
6. **Authorize the actual new invocation, narrowly and once.**
   Start a distinct turn only after explicit Continue. Its permission challenge supplies
   a newly observed session/turn/invocation identity. Compare the canonical current action
   with the approved intent and supported offered one-use effect, then bind fresh short
   execution authority under #702/#703. A prompt saying "continue" or a matching tool-call
   ID is insufficient. Changed or unverifiable scope requires new review. Native remembered
   approvals are not restored ORCA permission; supported enforcement must still mediate
   the actual dispatch. Consume one-use authority before effects. Uncertain dispatch remains
   consumed and requires reconciliation rather than automatic replay.
7. **Keep failed recovery actionable and history intact.**
   Report why and what can be recovered: provider/profile unavailable, missing storage,
   invalid/corrupt context, incompatible checkpoint, or durable-tail gap. Keep the original
   reference and reviewed scope; a separately reviewed new-session/reconstruction option
   must state its loss and repeated work. Do not claim terminal history resumed, rewrite old
   events, or let a context failure erase the approval/attempt record.

## Decisions and acceptance still needed

- **Durability target and ownership:** protect/retain provider-native state with a verifiable
  private reference first; decide separately whether ORCA also needs encrypted snapshots or
  export/import for each provider. Same-host process recovery is smaller than backup or
  host-loss recovery. Define tolerated crash-tail loss and how a partial durable checkpoint
  is shown; no provider source establishes universal zero-loss/power-loss guarantees.
- **Fallback:** default to stopping Continue when required context is unavailable. Decide
  the explicit operator workflow for a reconstructed or blank-session attempt and its scope
  review. Compacted-but-valid context is not automatically a fallback case.
- **Retention:** unanswered-intent retention and private context disposal remain undecided.
  Do not silently change TTLs, equate recoverability with indefinite retention, or advertise
  unsupported provider GC protection. Retention expiry/deletion must produce a precise,
  auditable reason and chosen recovery option rather than pretending load succeeded.
- **Provider acceptance:** on the exact authorized binary/profile/host, seed a unique private
  marker, obtain the native ID, end/cancel/timeout/disconnect, restart provider and daemon
  separately, load without a prompt, verify expected context, then Continue with new IDs.
  Cover missing/empty/corrupt storage, wrong principal/profile/cwd, version/config/model
  change, compaction, double Continue/concurrent owners, cancellation/revocation during
  recovery, and interrupted dispatch/lost acknowledgement. Verify no shell/MCP/subagent
  effect is repeated. Do not print markers, context or credentials into public evidence.

This investigation needs no new product approval to keep source/contract work moving.
Enabling execution requires reviewed lifecycle wiring and the corresponding provider
acceptance evidence. These are implementation/verification gaps, not denied actions.
It does not establish private-release readiness.

## Focused local validation

[context-recovery-357.test.ts](../../../packages/agents/test/context-recovery-357.test.ts)
uses real ACP framing with synthetic in-memory peers and a retained fixture history map.
It checks four retirement paths (ordinary turn end, cancel, timeout and disconnect),
successful required load on a replacement connection with no `session/new`, new ORCA
session/turn/invocation IDs despite reused provider/tool/callback IDs, and an old answer
that cannot finish the replacement turn. It also checks unsupported, rejected and timed-out
loads honestly report the **existing** fresh fallback, without automatically prompting.
Six additional cases verify required-load rejection for absent/empty/whitespace IDs before
spawning, and unsupported/rejected/timed-out loads without a fresh session or prompt.
Load errors carry stable reason tags without provider error text, native IDs or stderr;
failure tests observe owned-process cleanup. All 13 cases are provider-free.
No fixture counter or retained map is provider persistence, real effects, durable late
intent storage, permission reauthorization or installed-provider acceptance.

Validation commands and results are recorded in [validation.md](validation.md).

## Implemented adapter groundwork and limits

`OpenSessionOptions.requireContextRecovery` is optional and uses the existing
`resumeSessionId`, capability negotiation, load call and bounded cleanup. A caller that
opts in receives either a successful protocol load or an error before any `session/new`
or `session/prompt`. No approval input, durable state, default session selection or
provider verification port is added. This slice selects no crash-tail-loss budget,
degraded-context fallback or retention duration.

| Boundary | Error code | `details.contextRecoveryReason` |
| --- | --- | --- |
| Missing, empty or whitespace-only native ID | `CONFIG_INVALID` | `missing-session-id` |
| Agent does not advertise load | `NOT_SUPPORTED` | `load-unsupported` |
| Provider load rejects or its response cannot be applied | `AGENT_PROTOCOL` | `load-failed` |
| Client's load deadline elapses | `AGENT_TRANSPORT` | `load-timeout` |

The load-failure error excludes raw provider errors, stderr and native context/ID material;
it does not persist the raw error as a cause. Existing initialize/spawn/cleanup failures
retain their separate diagnostics. Cleanup failure still rejects, preserving the primary
failure and recording cleanup status through the existing mechanism. Closing this direct
child is not proof that descendants, remote operations or other provider clients stopped.
Provider loading can still perform setup, MCP or client-filesystem work under the existing
adapter permissions; this option is not an effect-free context probe or an execution guard.
Successful `loaded` continuity is deliberately unchanged: native history identity,
nonempty/complete context and uncertain effects still need provider-specific verification
before a durable Continue can execute. No installed-provider acceptance is implied.
