# Claims, leases and filesystem exclusion

Owner: `packages/store`. Granularity: component.

Scope and boundaries: claim-store.ts, lease-store.ts, file-lock.ts.

[SVG](../diagrams/svg/store-ownership.svg) · [Editable JSON](../diagrams/source/store-ownership.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | A work-item claim records parent run and branch ownership and survives ordinary run termination until explicitly released. | E1: [`export interface ClaimStore`](../../packages/store/src/claim-store.ts#L38) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/claim-store.ts#L38)) |
| Implemented | Leases identify a resource, holder, host/pid and heartbeat TTL; withOwnership fences writes and keepLease renews ownership or calls onLost. | E2: [`export function keepLease`](../../packages/store/src/lease-store.ts#L156) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/lease-store.ts#L156)) |
| Implemented | File locks use a directory with a unique owner token; removal is tied to the token, while incomplete/foreign ownership is conservatively retained. | E3: [`export async function withFileLock`](../../packages/store/src/file-lock.ts#L27) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/file-lock.ts#L27)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Dispatcher | Persistent item claim | call: claim work item before launch | Claim E1 above |
| E2 | Run interpreter | Renewable run lease + guarded write | call: acquire / renew / fence writes | Claim E2 above |
| E3 | Persistent item claim | Directory lock + owner token | dependency: serialize claim mutation | Claim E3 above |
| E4 | Renewable run lease + guarded write | Directory lock + owner token | dependency: serialize resource mutation | Claim E3 above |

## Limits

Claims prevent duplicate work-item launch; leases prevent concurrent run interpretation; short file locks serialize individual store operations. None identifies an authorized human caller.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
