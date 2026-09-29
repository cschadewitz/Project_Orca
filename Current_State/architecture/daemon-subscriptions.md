# Notifications and replay

Owner: `packages/daemon`. Granularity: component.

Scope and boundaries: notifications.ts and subscriptions.ts.

[SVG](../diagrams/svg/daemon-subscriptions.svg) · [Editable JSON](../diagrams/source/daemon-subscriptions.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Subscription attaches a listener before reading a run replay, buffers events, then drops overlap by sequence before live delivery. | E1: [`async start():`](../../packages/daemon/src/subscriptions.ts#L166) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/subscriptions.ts#L166)) |
| Implemented | Agent output is coalesced per step; terminal run delivery flushes held batches. | E2: [`private batch(`](../../packages/daemon/src/subscriptions.ts#L278) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/subscriptions.ts#L278)) |
| Implemented | Agent/config/plan notifications attach only for store-wide subscriptions; since is a run cursor and does not replay those channels. | E3: [`if (runId === undefined && this.opts.plans)`](../../packages/daemon/src/subscriptions.ts#L212) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/subscriptions.ts#L212)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | EventStore / PlanJournal / model listeners | Subscription buffer + batcher | message: same-process events and revisions | Claim E1 above |
| E2 | Run-specific eventsRange replay | Subscription buffer + batcher | data: catch up after run cursor | Claim E1 above |
| E3 | Subscription buffer + batcher | WebSocket notification | message: emit typed notifications | Claim E2 above |
| E4 | WebSocket notification | App subscription parser | message: parse, dispatch to UI feed | Claim E3 above |

## Limits

Store-wide reconnect cannot use a single run seq. Agent health has no durable replay; plan seq belongs to the plan journal, not a run log.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
