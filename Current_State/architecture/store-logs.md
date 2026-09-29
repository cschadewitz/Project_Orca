# Run logs and planning journal

Owner: `packages/store`. Granularity: component.

Scope and boundaries: event-store, jsonl-event-store, jsonl-log, plan journal.

[SVG](../diagrams/svg/store-logs.svg) · [Editable JSON](../diagrams/source/store-logs.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | JsonlLogDir serializes same-key writes, takes a filesystem lock, derives the next sequence and appends. It detects a non-newline tail before subsequent writes. | E1: [`private async appendLocked`](../../packages/store/src/jsonl-log.ts#L108) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/jsonl-log.ts#L108)) |
| Implemented | JsonlEventStore supports typed filtering and forward/backward range scans; each run has its own sequence domain. | E2: [`override async readRange`](../../packages/store/src/jsonl-event-store.ts#L57) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/jsonl-event-store.ts#L57)) |
| Implemented | PlanJournal append notifies listeners attached to that journal object; it does not watch writes made by another process. | E3: [`abstract class BasePlanJournal`](../../packages/store/src/plan-store.ts#L38) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/plan-store.ts#L38)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Run/plan event producer | JsonlLogDir + withFileLock | call: append sequenced record | Claim E1 above |
| E2 | JsonlLogDir + withFileLock | runs/<id>.jsonl / plans/<id>.jsonl | data: persist JSONL | Claim E1 above |
| E3 | Run/plan event producer | Same-process listeners | message: publish after append | Claim E3 above |
| E4 | Range / replay reader | runs/<id>.jsonl / plans/<id>.jsonl | data: scan by cursor and event type | Claim E2 above |

## Limits

Ordering is per log, not global. Invalid JSON and valid JSON with invalid schemas have different handling; power-loss durability is not established by source inspection.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
