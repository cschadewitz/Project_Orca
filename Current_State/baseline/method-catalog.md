# Wire method and notification declaration catalog

Declared constants are listed from protocol source. Actual registration depends on supplied models/capabilities: see the [daemon specification](../architecture/daemon.md) and [data contracts](data-contracts.md). A declared notification is not proof of an active producer. No protocol was exercised.

| Method constant / wire name | Declaration | Daemon registration |
| --- | --- | --- |
| `AGENTS_LIST_METHOD` / `agents.list` | [source](../../packages/protocol/src/agents.ts#L25) | [method table](../../packages/daemon/src/methods.ts#L592) |
| `AGENTS_PING_METHOD` / `agents.ping` | [source](../../packages/protocol/src/agents.ts#L26) | [method table](../../packages/daemon/src/methods.ts#L593) |
| `ARTIFACTS_LIST_METHOD` / `artifacts.list` | [source](../../packages/protocol/src/artifacts.ts#L22) | [method table](../../packages/daemon/src/methods.ts#L535) |
| `ARTIFACTS_GET_METHOD` / `artifacts.get` | [source](../../packages/protocol/src/artifacts.ts#L23) | [method table](../../packages/daemon/src/methods.ts#L536) |
| `CLAIMS_LIST_METHOD` / `claims.list` | [source](../../packages/protocol/src/claims.ts#L20) | [method table](../../packages/daemon/src/methods.ts#L534) |
| `CLAIMS_RELEASE_METHOD` / `claims.release` | [source](../../packages/protocol/src/claims.ts#L21) | [method table](../../packages/daemon/src/methods.ts#L580) |
| `CONFIG_GET_METHOD` / `config.get` | [source](../../packages/protocol/src/config.ts#L33) | [method table](../../packages/daemon/src/methods.ts#L547) |
| `CONFIG_SET_METHOD` / `config.set` | [source](../../packages/protocol/src/config.ts#L34) | [method table](../../packages/daemon/src/methods.ts#L548) |
| `INPUTS_ANSWER_METHOD` / `inputs.answer` | [source](../../packages/protocol/src/control.ts#L31) | [method table](../../packages/daemon/src/methods.ts#L576) |
| `RUNS_RESUME_METHOD` / `runs.resume` | [source](../../packages/protocol/src/control.ts#L32) | [method table](../../packages/daemon/src/methods.ts#L577) |
| `RUNS_CANCEL_METHOD` / `runs.cancel` | [source](../../packages/protocol/src/control.ts#L33) | [method table](../../packages/daemon/src/methods.ts#L578) |
| `RUNS_START_METHOD` / `runs.start` | [source](../../packages/protocol/src/control.ts#L34) | [method table](../../packages/daemon/src/methods.ts#L579) |
| `HELLO_METHOD` / `hello` | [source](../../packages/protocol/src/handshake.ts#L36) | [method table](../../packages/daemon/src/methods.ts#L529) |
| `INPUTS_LIST_METHOD` / `inputs.list` | [source](../../packages/protocol/src/inputs.ts#L30) | [method table](../../packages/daemon/src/methods.ts#L533) |
| `DEPENDENCIES_WAIVE_METHOD` / `dependencies.waive` | [source](../../packages/protocol/src/plan-control.ts#L26) | [method table](../../packages/daemon/src/methods.ts#L585) |
| `DECISIONS_DECIDE_METHOD` / `decisions.decide` | [source](../../packages/protocol/src/plan-control.ts#L27) | [method table](../../packages/daemon/src/methods.ts#L586) |
| `DECISIONS_REOPEN_METHOD` / `decisions.reopen` | [source](../../packages/protocol/src/plan-control.ts#L28) | [method table](../../packages/daemon/src/methods.ts#L587) |
| `RISKS_UPDATE_METHOD` / `risks.update` | [source](../../packages/protocol/src/plan-control.ts#L29) | [method table](../../packages/daemon/src/methods.ts#L588) |
| `PLANS_LIST_METHOD` / `plans.list` | [source](../../packages/protocol/src/plan.ts#L46) | [method table](../../packages/daemon/src/methods.ts#L555) |
| `PLAN_GET_METHOD` / `plan.get` | [source](../../packages/protocol/src/plan.ts#L47) | [method table](../../packages/daemon/src/methods.ts#L556) |
| `ITEMS_LIST_METHOD` / `items.list` | [source](../../packages/protocol/src/plan.ts#L48) | [method table](../../packages/daemon/src/methods.ts#L557) |
| `SCHEDULE_GET_METHOD` / `schedule.get` | [source](../../packages/protocol/src/plan.ts#L49) | [method table](../../packages/daemon/src/methods.ts#L558) |
| `SCHEDULE_EXPLAIN_METHOD` / `schedule.explain` | [source](../../packages/protocol/src/plan.ts#L50) | [method table](../../packages/daemon/src/methods.ts#L559) |
| `DEPENDENCIES_LIST_METHOD` / `dependencies.list` | [source](../../packages/protocol/src/plan.ts#L51) | [method table](../../packages/daemon/src/methods.ts#L560) |
| `RISKS_LIST_METHOD` / `risks.list` | [source](../../packages/protocol/src/plan.ts#L52) | [method table](../../packages/daemon/src/methods.ts#L561) |
| `DECISIONS_LIST_METHOD` / `decisions.list` | [source](../../packages/protocol/src/plan.ts#L53) | [method table](../../packages/daemon/src/methods.ts#L562) |
| `JOURNAL_LIST_METHOD` / `journal.list` | [source](../../packages/protocol/src/plan.ts#L54) | [method table](../../packages/daemon/src/methods.ts#L563) |
| `RUNS_LIST_METHOD` / `runs.list` | [source](../../packages/protocol/src/runs.ts#L18) | [method table](../../packages/daemon/src/methods.ts#L530) |
| `RUNS_GET_METHOD` / `runs.get` | [source](../../packages/protocol/src/runs.ts#L19) | [method table](../../packages/daemon/src/methods.ts#L531) |
| `RUNS_EVENTS_METHOD` / `runs.events` | [source](../../packages/protocol/src/runs.ts#L20) | [method table](../../packages/daemon/src/methods.ts#L532) |
| `SUBSCRIBE_METHOD` / `subscribe` | [source](../../packages/protocol/src/subscriptions.ts#L46) | [method table](../../packages/daemon/src/methods.ts#L609) |
| `UNSUBSCRIBE_METHOD` / `unsubscribe` | [source](../../packages/protocol/src/subscriptions.ts#L47) | [method table](../../packages/daemon/src/methods.ts#L610) |
| `WORKFLOWS_LIST_METHOD` / `workflows.list` | [source](../../packages/protocol/src/workflows.ts#L27) | [method table](../../packages/daemon/src/methods.ts#L537) |
| `WORKFLOWS_GET_METHOD` / `workflows.get` | [source](../../packages/protocol/src/workflows.ts#L28) | [method table](../../packages/daemon/src/methods.ts#L538) |
