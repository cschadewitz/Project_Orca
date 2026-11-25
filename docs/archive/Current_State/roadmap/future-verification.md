# Separate runtime and correctness follow-up

Nothing in this file was executed. This is the bounded handoff for [R16](recommendations.md#r16), not an expansion of this review into a bug hunt. [Baseline uncertainties](../baseline/uncertainties.md) remain the authoritative limits; test declarations show intent only.

## Incidental hypotheses

### H01

**Malformed permission overlay can remove a restriction.** High confidence in the source-level possibility; runtime interaction unverified. [D05](../comparison/differences.md#d05) traces sidecar deny/ask rules, warning-and-skip loading and later default allows. A focused future test should compare a valid restrictive overlay against malformed/unavailable replacement for a matching workspace tool request, including a configured deny and a missing human-input channel. Determine the intended result before changing fallback. Owner: agents/core; R07.

### H02

**All-destructive option sets need verification against the digit-1 rule.** [bindOptions](../../packages/app/renderer/src/attention/card-model.ts#L35) concatenates safe then destructive options and assigns index + 1; with no safe choices, the first option can receive 1. Reachability through gate/permission schemas and rendering is not fully traced here. [D15](../comparison/differences.md#d15) separately establishes the broader documentation mismatch. Future review should establish whether such an option set is accepted and what keyboard/default-focus behavior is intended. Owner: app/protocol; R03/R16.

### H03

**Request settlement may depend on the resume entry point.** [Program service](../architecture/engine-program.md) explicitly settles terminal root Request status; [daemon controls](../architecture/daemon-controls.md) invoke the interpreter. This is an ownership/parity question, not a confirmed stale-status defect. Trace all callbacks and compare CLI, facade and daemon completion for the same parked program Request; only then decide whether a shared projection owner is required. Owner: engine/daemon; R09.

## Architectural verification scenarios

| ID | Boundary and evidence | Future scenario / required evidence | Roadmap relation |
| --- | --- | --- | --- |
| V01 | [Plan operations](../architecture/engine-plan.md), [documents](../architecture/store-documents.md) | Two independent service processes mutate the same semantic plan state; interrupt between document and journal writes. Record ordering, retry, duplication and recovery, without assuming the in-memory queue is cross-process. | R04 |
| V02 | [Run ownership](../architecture/store-ownership.md), [JSONL](../architecture/store-logs.md) | Replace/break a lease during queued and streaming appends; interrupt lock acquisition/commit and restart. Verify fencing and operator recovery for legacy metadata. Never infer safety from a single-process test alone. | R04/R16 |
| V03 | [Workspace provisioning](../architecture/engine-workspaces.md) | Concurrent local-provider runs share cwd/branch; compare git-worktree provider and nested inheritance. Observe dirty-tree handling, refusal/queue behavior and cancellation ownership. | R06 |
| V04 | [Subscriptions](../architecture/daemon-subscriptions.md), [app client](../architecture/app-client.md) | Mutate via an external CLI while connected; drop store-wide connection during run/plan/config/agent changes, including a gap shorter than the visible connection grace period. Check eventual snapshots, ordering and duplicates. | R05/R11 |
| V05 | [Recipe resolution](../addenda/corrections.md#c01-workflow-version-identity-is-conditional), [sessions](../architecture/agents-session.md) | Resume after same-version edits, version bump, template change, model-option change and process restart. Distinguish chosen inputs from nondeterministic provider outputs and run replay from conversation restoration. | R08 |
| V06 | [Updates](../architecture/app-updates.md), [deployment](../architecture/delivery.md) | Test packaged supported platforms: pending drafts, active/parked runs, owned versus external daemon, failed maintenance, failed installer, interrupted activation and incompatible store epoch. Record exact artifact hash/signing state. | R15 |
| V07 | [ACP/SSH](../architecture/agents-session.md), [JEV](../architecture/integration-jev.md), [T3](../architecture/integration-t3code.md) | Exercise only supported external adapters with approved endpoints/data: negotiation, cancellation, disconnection, malformed responses and credential redaction. T3 requires a chosen transport first; no generic “integration passed” claim. | R14/R16 |
| V08 | [Read projections](../architecture/daemon-projections.md), [artifact index](../architecture/store-content.md), [trust](../architecture/daemon-transport.md) | Measure representative store histories and memory/disk growth; separately verify supported bind/caller/config-access policy. Record environment and workload rather than inventing a scaling threshold or assuming loopback is per-user authentication. | R12/R18 |

Every later result should record revision, initial store/workspace state, platform, command or harness, fault timing and observed output. Reuse existing meaningful tests when they cover the boundary; add tests for independently specified invariants rather than mirrors of helper implementations. File actual correctness findings separately with reproduction evidence.
