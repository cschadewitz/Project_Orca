# Attention and human controls

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/attention/ and main/alerts.ts.

[SVG](../diagrams/svg/app-attention.svg) · [Editable JSON](../diagrams/source/app-attention.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | useAttention shares open asks, failed/running summaries, incoming changes and derived badge/OS alert inputs. | E1: [`export function useAttention`](../../packages/app/renderer/src/attention/use-attention.ts#L72) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/attention/use-attention.ts#L72)) |
| Implemented | Gate, permission and generic answer cards share a plain model for options/digits; useControls calls input answer or run resume/cancel through the bridge. | E2: [`export function useControls`](../../packages/app/renderer/src/attention/use-controls.ts#L51) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/attention/use-controls.ts#L51)) |
| Implemented | Main alerts implement tier preferences and timed escalation; OS notification activation returns a route target to the renderer. | E3: [`export function createAlerts`](../../packages/app/src/main/alerts.ts#L102) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/alerts.ts#L102)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | inputs.list + run snapshots / pushes | Shared Attention feed | data: merge open and settled asks | Claim E1 above |
| E2 | Shared Attention feed | Gate / permission / answer cards | data: render question/options | Claim E2 above |
| E3 | Gate / permission / answer cards | Protocol control handlers | call: answer/resume/cancel | Claim E2 above |
| E4 | Shared Attention feed | OS alerts and badge | message: publish preference-controlled alerts | Claim E3 above |

## Limits

Standing-grant UI promises follow daemon returned persistence details. A gate and an ACP permission ask have different parking/lifetime behavior.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
