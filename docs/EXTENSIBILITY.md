# Extensibility

Every extension point is an interface in `@orca/engine` / `@orca/agents` / `@orca/store`,
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
| New node type | `NodeExecutor` → `api.executors.register()` | `engine/executors/types.ts` |
| New artifact kind | just use it in `produces.kind`; register validation in a node or plugin | `core/model/artifact.ts` |
| New prompt templates / partials | `api.templates.registerSource()` or files matched by `templates:` globs | `core/template/registry.ts` |
| New workflows | `api.workflows.register()` or files matched by `workflows:` globs | `core/workflow/load.ts` |
| Agent transport (HTTP ACP, T3 Code, in‑process) | `AgentSession` + `Orchestrator.sessionFactory` | `agents/session.ts` |
| Host type (containers, cloud sandboxes) | `AgentHost` → `api.agents.addHost()` | `agents/host.ts` |
| Where work happens | `WorkspaceProvider` → `api.setWorkspaceProvider()` | `engine/workspace/provider.ts` |
| Human channel (Slack, web UI, upstream ACP) | `HumanInputPort` → `api.setHumanInput()` | `engine/human-input.ts` |
| Persistence (SQLite, Postgres) | `EventStore`, `ArtifactStore`, `DocumentStore` | `store/*.ts` |
| Expression functions | `evaluateExpression(src, ctx, { functions })` | `core/expr/evaluate.ts` |
| Observability | `orchestrator.subscribe()` on the event stream | `store/event-store.ts` |

Conventions that keep extensions reviewable:

- Executors return `completed()` / `failed()` and put anything routable into `result.data`
  (expressions read it as `steps.<node>.result.data.*`) or into vars via `vars.set`.
- Never write to the projection directly; append events through `ctx.emit()`.
- Anything an agent must know goes into the prompt (template) or the deliverables block,
  not into side channels.
- Custom node types are `custom:<kebab-name>`; validation of their fields is the plugin's job
  (use zod and throw `OrcaError("WORKFLOW_INVALID", …)` from a validation hook if needed).
- A `HumanInputPort` receives `query.signal`, which fires when the run is cancelled while the
  question is open. Drop the request and reject with `humanInputCancelled(signal)`; the engine
  stops waiting on `cancel()` regardless, but a cooperative port avoids stranded questions.
