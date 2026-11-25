# Read projections and derived views

Owner: `packages/daemon`. Granularity: component.

Scope and boundaries: read-model.ts, plan-model.ts, workflow-model.ts and agent-model.ts.

[SVG](../diagrams/svg/daemon-projections.svg) · [Editable JSON](../diagrams/source/daemon-projections.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | ReadModel uses per-pass facts/document caches for run listings/details, inputs, claims, artifacts and workflow views, and derives stale status from leases on reads. | E1: [`export class ReadModel`](../../packages/daemon/src/read-model.ts#L387) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/read-model.ts#L387)) |
| Implemented | PlanModel computes schedule-backed item classifications, reasons, risk/decision views and journal pages; preview matrix results are labeled as previews. | E2: [`export class PlanModel`](../../packages/daemon/src/plan-model.ts#L351) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/plan-model.ts#L351)) |
| Implemented | AgentModel reports configured agents and memory health and can actively ping a configured agent session. | E3: [`async ping(`](../../packages/daemon/src/agent-model.ts#L89) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/agent-model.ts#L89)) |
| Implemented | Artifact reads distinguish text, image and binary views and impose content-size limits. | E4: [`async artifactsGet(`](../../packages/daemon/src/read-model.ts#L582) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/read-model.ts#L582)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Protocol read request | ReadModel / PlanModel pass | call: request filtered/paged projection | Claim E1 above |
| E2 | ReadModel / PlanModel pass | Orchestrator + documents + leases | data: read authoritative inputs | Claim E1 above |
| E3 | ReadModel / PlanModel pass | Core schedule / presentation fold | call: derive classification / status | Claim E2 above |
| E4 | ReadModel / PlanModel pass | Protocol views | data: serialize view with asOf | Claim E1 above |

## Limits

Pagination bounds responses; it does not necessarily bound source traversal. Static read cost follows loops and store implementations, not measured latency.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
