# Extensibility

Every extension point is an interface in `@orca/engine` / `@orca/agents` / `@orca/store` /
`@orca/core`,
and most can be reached from a **plugin**: an ES module whose default export is an
`OrcaPlugin` (`packages/engine/src/plugin.ts`), listed under `plugins:` in `orca.config.yaml`.

```ts
// plugins/jira.ts
import { definePlugin, completed } from "@orca/engine";
export default definePlugin({
  name: "jira",
  register(api) {
    api.executors.register({
      type: "custom:jira-transition",
      async execute(ctx) {
        const node = ctx.node as unknown as { issue: string; to: string };
        await transition(await ctx.render(node.issue), node.to);
        return completed({ data: { transitioned: node.to } });
      },
    });
    api.templates.registerSource("---\nid: jira/comment\n---\nSummarise {{ artifacts.review.content }}");
  },
});
```

| Extension | Interface | Where |
| --- | --- | --- |
| New node type | `NodeExecutor` → `api.executors.register()`; an optional `validate(node)` runs at load time | `engine/executors/types.ts` |
| New artifact kind | just use it in `produces.kind`; register validation in a node or plugin | `core/model/artifact.ts` |
| New prompt templates / partials | `api.templates.registerSource()` or files matched by `templates:` globs | `core/template/registry.ts` |
| New workflows | `api.workflows.register()` or files matched by `workflows:` globs | `core/workflow/load.ts` |
| Agent transport (HTTP ACP, T3 Code, in‑process) | `AgentSession` + `Orchestrator.sessionFactory` (a constructor option, not reachable from `PluginApi`) | `agents/session.ts`, `engine/orchestrator.ts` |
| Host type (containers, cloud sandboxes) | `AgentHost` → `api.agents.addHost()` | `agents/host.ts` |
| Where work happens | `WorkspaceProvider` → `api.setWorkspaceProvider()` | `engine/workspace/provider.ts` |
| Human channel (Slack, web UI, upstream ACP) | `HumanInputPort` → `api.setHumanInput()` | `engine/human-input.ts` |
| Persistence (SQLite, Postgres) | `EventStore`, `ArtifactStore`, `DocumentStore`, `ClaimStore` | `store/*.ts` |
| Expression functions | `evaluateExpression(src, ctx, { functions })` — library API only; the engine does not yet let a plugin extend the built‑ins used by `when:` and templates | `core/expr/evaluate.ts` |
| Planning signals from custom artifacts | `SignalExtractor` → `api.plan.addSignalExtractor()` | `core/plan/signals.ts` |
| Scheduling behaviour | `policy.weights` / `strategy`, or rank from `computeSchedule().priorities` | `core/plan/schedule.ts` |
| Plan persistence | `PlanStores` (four `DocumentStore`s + `PlanJournal`) | `store/plan-store.ts` |
| Plan mutations from nodes / UIs | `PlanService` via `ctx.plan` or `api.plan` | `engine/plan/service.ts` |
| Observability | `orchestrator.subscribe()` on the event stream | `store/event-store.ts` |

Conventions that keep extensions reviewable:

- Executors return `completed()` / `failed()` and put anything routable into `result.data`
  (expressions read it as `steps.<node>.result.data.*`) or into vars via `vars.set`.
- Never write to the projection directly; append events through `ctx.emit()`.
- Anything an agent must know goes into the prompt (template) or the deliverables block,
  not into side channels.
- Nothing in the interpreter is keyed on node type: a custom node gets retries by setting
  `maxAttempts:` on the node (its executor must return `failed(..., retryable = true)`), and
  ends the run by returning `completed({ outcome, message })` — no `end` node needed after it.
- Custom node types are `custom:<kebab-name>`; validation of their fields is the plugin's job,
  and it has two moments. Give the executor a `validate(node)` returning
  `{ errors?, warnings? }` of `{ path?, message }` (paths relative to the node: `rubric`,
  `.questions.conflict`): `validateWorkflow` calls it for every `custom:*` node whose executor
  is registered, so `orca validate` and bootstrap reject a malformed node up front, the way
  they reject a missing template (#308). Then parse `ctx.node` again at the top of `execute`
  and return `failed("WORKFLOW_INVALID", …, retryable = false)`, because a node can reach an
  executor without having been validated by it (a workflow registered by another plugin, an
  embedder that skips validation). The engine calls `NodeExecutorRegistry.validateNode` for
  the hook; a type nobody registered is reported as a warning, not an error.
  `packages/integrations/src/jev/` (`custom:jev-eval`, `docs/INTEGRATIONS.md`) is a worked
  plugin of this shape: one zod parse shared by `validate` and `execute`, `ctx.resolveInputs`
  for explicit inputs, an injectable provider port so the tests script the remote,
  `ctx.recordArtifact` for the durable record, and the routable part in `result.data`.
- A `HumanInputPort` receives `query.signal`, which fires when the run is cancelled while the
  question is open. Drop the request and reject with `humanInputCancelled(signal)`; the engine
  stops waiting on `cancel()` regardless, but a cooperative port avoids stranded questions.
