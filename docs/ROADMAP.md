# Roadmap and current capabilities

This page is for anyone deciding what to build next or checking whether ORCA already does
something. It lists what main implements, its known limits, and the open work, with the issue that
owns each item. Issues are the source of truth: re-read one before scheduling work, and follow
[Contributing](../CONTRIBUTING.md) to change it.

Root version **0.8.0-rc.1**, wire protocol **2.12**, store epoch **`operator-journals-v4`**. A
source version is not a deployed build or a native release verdict. Release history is in the
[changelog](../CHANGELOG.md); pending notes are in [`changelog.d/`](../changelog.d/README.md).
Older dated reviews are in the [archive](archive/README.md); this page supersedes their
classifications.

"Implemented" means the source and its tests are on main. A merged PR does not complete every
acceptance criterion on its issue.

## What main implements

| Capability | Read | Known limits |
| --- | --- | --- |
| ACP agents on local and SSH hosts; persisted role, model and per-item workflow; prompt packs | [Integrations](INTEGRATIONS.md), [agent support](agent-support.md) | Each real provider and client pairing needs its own evidence. No automatic `session/load` or ACP terminal support. |
| Six desktop surfaces, five Plan modes, workflow drafts, visual editor, validation panel, dry run (#180–#183) | [Planning](PLANNING.md), [workflow editing](design/70-workflow-editing.md), [workflows](WORKFLOWS.md) | No agent cost, run percentage or ETA, capacity scheduling or automatic Maintain. |
| Authenticated HTTP/WS, per-operation authorization, target identity, draft isolation | [Daemon security](daemon-security.md), [connections](daemon-connection.md) | Remote listeners need explicit credentials and trusted TLS. Loopback is not identity. |
| Typed launch inputs, immutable workflow identities, built-in node validation | [Workflow inputs](workflow-inputs.md), [built-in validation](builtin-node-validation.md) | Changed content under the same version is refused for new launches. |
| Save and apply as separate steps; configuration generations; redacted launch provenance | [Configuration generations](configuration-generations.md) | Roles, defaults and assets reload for new work. Agents, hosts and providers need a restart. |
| Structured config editing, guided Request and direct launch, template and pack authoring | [Request submission](request-submission.md) | Real-agent, signed arm64 and physical first-run acceptance are separate. |
| Shared admission with durable retry receipts | [Request submission](request-submission.md), [admission retry](admission-retry.md) | Acceptance is not execution or delivery. |
| Durable gates; live permission callbacks owned by the original session | [Live input](live-input-continuity.md) | An expired callback is not a durable gate. |
| Protected human revisions and continuation | [Revision input](revision-input.md) | No generic automatic resume. |
| Inbound MCP reads, preflight, mutations and receipts | [MCP operator](mcp-operator.md) | #594 exact-command approval is required before the Mac beta. Scope can leave out Request, plan and config operations. |
| Scoped MCP servers, skills and secret references per agent session (#335–#337) | [Secret use authority](secret-use-authority.md), [workflows](WORKFLOWS.md#secret-references) | Secrets resolve only at the execution boundary. |
| Fenced leases, claims, per-file locks, protected history | [Protected storage](protected-execution-storage.md), [file locks](storage/file-locks.md) | Plan queues are per instance. Multi-record changes are not atomic. |
| Store contracts, optional SQLite metadata, operations dashboard and history, daemon search (#338–#341, #255) | [SQLite metadata](storage/sqlite-metadata.md), [ADR 0011](adr/0011-sqlite-metadata-graph-and-kv-deferred.md), [data model](DATA-MODEL.md) | Graph and key-value stores are deferred. |
| Checkpoint recovery with side-effect review (#357) | [Recovery](recovery.md) | Multi-record recovery needs its own evidence. |
| Opt-in owned root worktrees | [Root isolation](root-worktree-isolation.md) | Built-in local Linux host only. Shared Git metadata is not a sandbox against hostile users. |
| Windows NSIS updates, the Linux `.deb` update notice, held Mac update and recovery | [Updating](UPDATING.md), [Linux install](INSTALL-LINUX.md) | Mac production updates are held until signed N/N+1 acceptance. Maintenance never installs packages over RPC. |
| Advisory daemon-host resources | [Host resources](host-resources.md), [access proposal](host-resource-access-policy.md) | The normal CLI does not mount a collector or grant host telemetry. |
| Several machines: SSH profiles, one-step server setup, watching several daemons, step delegation | [Multi-machine](MULTI-MACHINE.md), [delegation](WORKFLOWS.md#delegating-steps-to-another-daemon) | Text artifacts only; no code sync beyond an allowed `gitRef`. No placement across workers (#343), host registry (#342) or budgets (#346). |
| Maintenance MCP contract | [Maintenance MCP](maintenance-mcp.md) | Refusal-only. No host collector, restart or management authority. |

Other standing limits:

- An agent's own tools can still write ORCA's files when the config directory is its workspace
  ([ADR 0009](adr/0009-permission-grants-in-a-workspace-sidecar.md)).
- Watching for pushes by outside writers is incomplete.
- A realized risk records state; it does not create a follow-up Request.
- No remote workspace synchronization, calendar or capacity planning, or autonomous Maintain.

## Open priorities

These are the owner's priorities, not dates or promises.

| Outcome | Open issues |
| --- | --- |
| Operate ORCA safely through an MCP client | #327 MCP orchestration interface; #392 outbound MCP tunnel; #594 exact-command approval (required before the Mac beta). |
| Pre-Mac preparation | #385 signing and private delivery; #416 and #469 manual and crash-surviving diagnostics (capture stays off by default). |
| Live Apple Silicon acceptance | #602 signed delivery and packaged execution; #603 live upgrades and protected-state restore; #604 diagnostics; #390 invited journeys on a physical Mac. |

Mac acceptance is a native gate: do not erase journals or reset the Keychain to get a pass.
Linux source checks and packaging config cannot prove Gatekeeper, TCC or physical usability. The
Mac bundle identity is `com.schadewitz.orca`; Windows keeps `dev.orca.desktop`.

## Wider backlog

Grouped by primary ship-group label. "Needs" is a hard dependency recorded on the issue.

| Ship group | Issues | Order |
| --- | --- | --- |
| `ship-group:managed-fleet` | #223 host monitor; #103 lock liveness across pid namespaces; #342 managed hosts; #343 capacity and fencing; #344 drain and recovery | #342 needs #223; #343 needs #342; #344 needs #343. |
| `ship-group:usage-routing` | #345 attributable usage; #346 budgets; #347 account routing | #346 needs #345; #347 needs #346. ORCA does not yet collect cost data. |
| `ship-group:github-planning` | #348 tracker contract; #349 GitHub import; #350 conflict-safe outbox | #349 needs #348; #350 needs #349. |
| `ship-group:ado-planning`, `jira-planning`, `linear-planning`, `beads-planning` | #351, #352, #353, #354 | Each needs #350; they can run in parallel. |

## Evidence

Keep source, review and CI evidence apart from the deployed build, transport, scope and native
candidate. A docs-only CI success may skip every runtime job. A failed run stays failed after a
fix is published. See [documentation-only review](DEVELOPMENT.md#documentation-only-review).
