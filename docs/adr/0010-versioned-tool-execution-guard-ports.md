# ADR 0010: Separate versioned action, policy, judge and execution guard ports

- Status: Proposed; inactive preparation for #700 / #699
- Date: 2026-10-26
- Inspected baseline: main `32f92cc16b9faf1748059e930c3f77b3934151ae`

## Context

ORCA already answers ACP permission asks from first-match scoped rules, rereads the
sidecar per ask, protects its own paths and binds live human answers to the original
run/session/turn/invocation under current authority. ACP asks do not mediate native
tools that omit an ask. The existing automatic resolver can select allow_always when
allow_once is unavailable. Owned ACP file callbacks perform host I/O without that
policy evaluator. A review model or prompt cannot close those execution gaps.

[ADR 0009](0009-permission-grants-in-a-workspace-sidecar.md), the existing
[research architecture](../research/tool-call-safety/architecture.md) and
[LiveHumanInput](../../packages/engine/src/live-input.ts) remain foundations.
This decision specializes the research into minimal ports; it does not approve
that entire architecture or change existing support/activation gates.

## Decision proposed

Adopt the [v1 preparation contract](../preparation/tool-execution-guards/README.md)
with a single shared type owner (#700). Keep action/coverage evidence, deterministic
policy verdicts, optional fit judges and one-use enforcement as separately versioned
internal ports. Pure types eventually belong in core; agents capture at the actual
boundary, engine coordinates under the original lease, daemon supplies verified
current authority, store retains protected evidence and protocol exposes safe summaries.
No new policy store, human-input engine, sandbox or recovery ledger is created.

Retain legacy first-match evaluation and option compatibility. Opt-in strict mode
applies captured/current authority ceilings and required coverage/material checks
outside legacy ordering, and never substitutes a remembered grant for a proven
invocation-only choice. A matching approved rule automatically answers the request;
no redundant human confirmation is required. Optional judges assess fit only where
a rule explicitly delegates judgment. They never create authority or weaken ceilings.

Capture exact original/final representations and authoritative complete/absent/unknown
facts before review. Versioned codecs and exact adapter/provider/tool/host coverage
are prerequisites for implementation. Command identity is distinct from guaranteed
effects; OS/host filesystem/network/credential/process boundaries remain necessary.
No path is promoted to verified-per-execution on synthetic or source evidence alone.

A trusted coordinator can issue only an owner-local, one-use permit. The registered
executor rechecks current authority, policy/revocation/lease epochs, lifetime, relevant
state and budgets under its dispatch fence, records authorization and consumes once
before using retained final bytes. A changed action requires reevaluation. External
effects are outside the record transaction; uncertain completion is execution-unknown
and must not be blindly replayed. Reuse existing live acceptance and recovery owners.

## Consequences and alternatives

This lets #701 judges, #702 rules, #703 executor and #704–#706 qualification/acceptance
prepare in parallel against one interface. #702 owns storage/schema/UX migration;
#703 owns capture, permit validation/consumption, actual I/O and uncertain effects.
The [acceptance corpus](../preparation/tool-execution-guards/acceptance.md) defines
expectations for their tests without implementing a competing policy engine.

A universal ACP enforcement claim is rejected: not every execution reaches the client.
Changing all policies to deny-overrides is rejected: it breaks legacy first-match
semantics. Treating judge fit or a public action ID as permission is rejected: neither
is verified delegated authority. Requiring another human confirmation for a matching
rule is rejected: current scoped authority already permits the automatic decision.

This PR contains only types, compile-time consumer fixtures and documents. No production
registration, configuration migration, model egress, new service/key, JEV activation,
hook installation, provider execution, deployment or release is included. #594 remains
unsupported pending its own live/actual-Cal and artifact acceptance; sandbox/privacy
and native host gates are unchanged. Review of the first codec, hook/config protocol,
privacy projection and real dispatch/storage integration remains required before adoption.
