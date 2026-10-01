# Plan UI and decision surfaces

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/plan/.

[SVG](../diagrams/svg/app-plan.svg) · [Editable JSON](../diagrams/source/app-plan.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | usePlan reads plans, header, filtered/paged items and journal. plan.changed increments area revisions and rereads affected views. | E1: [`export function usePlan`](../../packages/app/renderer/src/plan/use-plan.ts#L114) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/plan/use-plan.ts#L114)) |
| Implemented | PlanSurface composes schedule, dependencies, risks and decisions with inspectors; each mode has separate plain models and feeds. | E2: [`export function PlanSurface`](../../packages/app/renderer/src/plan/plan-surface.tsx#L117) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/plan/plan-surface.tsx#L117)) |
| Implemented | Decision UI submits chosen options/rationale and supports reopening through plan bridge methods. | E3: [`window.orca.plan.decide`](../../packages/app/renderer/src/plan/decision-mode.tsx#L224) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/plan/decision-mode.tsx#L224)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | plan.changed invalidations | Plan feed + area revisions | message: invalidate affected projections | Claim E1 above |
| E2 | Plan feed + area revisions | Plan read/write bridge | call: reread current span / journal | Claim E1 above |
| E3 | Plan feed + area revisions | Schedule / dependency / risk / decision modes | data: supply derived daemon views | Claim E2 above |
| E4 | Schedule / dependency / risk / decision modes | Journal + dock inspector | call: select object / explain reasons | Claim E2 above |
| E5 | Schedule / dependency / risk / decision modes | Plan read/write bridge | call: waive, decide, reopen, update risk | Claim E3 above |

## Limits

Plan notifications are invalidations rather than full row patches. See uncertainties for reconnection parity with run feeds.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
