# Builtin custom-node validation

The six builtin plan/program custom nodes validate their fields through the
existing `NodeExecutor.validate` hook. `orca validate` and bootstrap report
malformed explicit values before agent work. Each executor uses the same Zod
parser at the beginning of `execute`, so direct execution also rejects a bad
node with a non-retryable `WORKFLOW_INVALID` outcome before reading artifacts,
consulting the plan, writing stores or launching children.

## Fields and defaults

| Node | Checked fields and omitted defaults |
| --- | --- |
| `custom:plan-register` | `artifact`: nonempty string, `decomposition`; `plan`, `planName`: optional string templates |
| `custom:decision-matrix` | `artifact`: nonempty string, `decisionMatrix` (fallback artifact kind `decision-matrix`); `decision`: optional string template, otherwise the artifact's key |
| `custom:plan-schedule` | `plan`: optional string template; `artifactPath`: string template, `.orca/plans/{{ vars.plan }}/schedule.md`; `record`: boolean, `true`; `policy`: optional policy overrides |
| `custom:plan-dispatch` | `workflow`: optional nonempty string; `concurrency`: optional positive integer; `scope`: `request` (default) or `plan`; `leavesOnly`: boolean, `true`; `failFast`: boolean, `false`; `onWaiting`: `defer` (default) or `wait`; `pollMs`: positive integer, 5000; `waitTimeoutMs`: nonnegative integer, 1800000; `policy`: optional policy overrides |
| `custom:plan-await` | `phase`: nonempty string, `build`; `pollMs`: positive integer, 2000; `timeoutMs`: positive integer, 1800000 |
| `custom:materialize-work-items` | `artifact`: nonempty string, `decomposition` |

An empty schedule `artifactPath` still disables the artifact. Dispatch
`waitTimeoutMs: 0` still means wait indefinitely. Explicit `false` booleans and
zero priority weights remain valid. Explicit `null`, wrong primitive types,
unknown enum values, fractional counts/durations and out-of-range numbers fail;
there is no coercion of strings such as `concurrency: "four"` or `record: "false"`.

Policy overrides reuse the core scheduling constraints: known strategies and
risk appetites, positive integer concurrency, boolean flags, and nonnegative
numeric priority weights. Parsing does not fill omitted policy fields or
weights, so a sparse override cannot replace the plan's settings with defaults.
An omitted dispatch concurrency continues to use the plan's concurrency.

## Compatibility and diagnostics

Validation checks template-bearing fields as strings without evaluating them.
Rendering stays at the existing execution sites (`plan`, `planName`, `decision`
and schedule `artifactPath`). Artifact names and dispatch `workflow` remain
literal strings. Common edge expressions retain the existing workflow validator
and evaluator. An omitted dispatch workflow still resolves from the run's item
workflow override, then `vars.itemWorkflow`; absence of both remains a runtime
error because those values are unavailable during definition validation.

The core schema continues to own common node fields and extension metadata.
The builtin field schemas ignore unrecognized keys and do not mutate the
definition or insert defaults into it. No new warning category is introduced.
Warnings from other custom validators and unregistered custom types remain
non-blocking.

Parser issues use the existing node-relative `{ path, message }` shape, such as
`policy.weights.age`. The workflow validator prefixes them once, including
nested graphs. Direct execution reports these same relative issues in
`error.details.issues`; malformed node fields are not artifact-validation or
plan-lookup errors.

Implementation is in `packages/engine/src/plan/nodes.ts`, its adjacent
`node-validation.ts`, and `packages/engine/src/program/nodes.ts`. Regression
tests are `packages/engine/test/builtin-node-validation*.test.ts`; existing
plan/program execution tests exercise the same parsers.

## Integration

This completes the builtin schema slice of #314 using #308's existing hook.
No registry, bootstrap, protocol, public barrel, constructor, or client wiring
is required. The engine needs the same direct `zod` dependency as the core
package. Typed launch inputs (#330) and daemon authorization (#328) remain
separate work under the runtime foundation integration contract.
