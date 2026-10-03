# Cal's first implementation job

Experience specification for [#424](https://github.com/cschadewitz/Project_Orca/issues/424),
a preparation slice of [#334](https://github.com/cschadewitz/Project_Orca/issues/334).
Audited on **2026-10-03 UTC**, after fetching and syncing `origin/main` at
**`e94bf699d9f3000de8822ed3434c1dce92b6ce19`**. The issue's requested baseline and
fetched main are identical; no later rebase was needed.

The first track is **intent → preview → direct workflow admission → one agent →
reviewed result**. Direct means Request-free, not workflow-free. The proposed
workflow shape is `start → implement (agent) → end`; this packet contains no workflow
implementation. A durable workflow gate is a separate scenario; an agent's live
permission callback can occur within the one-agent track.

The user should be able to say “Cal, implement this,” know exactly where and with
which instructions the agent will work, authorize that bounded job, follow it by
stable IDs, and review the diff and actual checks. Returning results to the existing
conversation is part of that intent. Publishing a PR is a separate action.

## Review packet

| Document | Purpose |
| --- | --- |
| [Capability map](capability-map.md) | Exact-main evidence, active integration evidence, contracts and proposals |
| [Interaction specification](interaction-spec.md) | Selection, intent, admission, observation, approvals and result states |
| [Static wireframes and transcripts](wireframes-and-transcripts.md) | Annotated happy path, loss of acknowledgment, approval, failure and review fixtures |
| [Acceptance scenarios](acceptance-scenarios.md) | Observable outcomes and limits on what a static review proves |
| [Implementation handoff](implementation-handoff.md) | Remaining decisions, existing owners, evidence and order |

Every fixture value and transcript is synthetic. No tool call, launch, agent run,
PR publication by a job, real Cal connection, packaged app test or physical-machine
acceptance is represented by those fixtures. This documentation PR is separate from
the job-publication example.

## Boundaries

Only `docs/preparation/cal-first-job-experience/` is owned here. The packet preserves
[the operator contract](../../runtime-operator-parallel-contract.md) and the newer
[production preparation at `4937f4c0`](https://github.com/cschadewitz/Project_Orca/blob/4937f4c083c572d07b840258724ef600368a7a5d/docs/mcp-operator-production-contract.md).
Neither a contract nor a feature branch establishes shipped capability.

[#327](https://github.com/cschadewitz/Project_Orca/issues/327) owns the MCP adapter,
projections and operator acceptance; [#355](https://github.com/cschadewitz/Project_Orca/issues/355)
owns template authoring. This packet creates no API, grants, workflow, deployment,
connection provisioner or test harness. Same-agent persistent chat is deferred.

Completed [Mac delivery preparation](../native-mac-delivery/implementation-handoff.md)
(#402) and [packaged testing preparation](../native-mac-testing/implementation-handoff.md)
(#403) remain the inputs for artifact identity and packaged/physical evidence. Their
older statements about pending #397 are historical: its runtime integration is in
this audited main. Their packaging and test proposals do not become executed tests
because the runtime merged. The incremental coding fixture belongs to
[#420](https://github.com/cschadewitz/Project_Orca/issues/420), not this packet.
