/**
 * Program-level custom nodes: the "level above" the SDLC loop.
 *
 *  custom:materialize-work-items  - turn a `decomposition` artifact into
 *                                   WorkItem records and publish them as vars.
 *
 * Dispatching them is *not* a custom node: the program workflow fans out over
 * `vars.leafWorkItems` with a plain `parallel` node whose `forEach` carries the
 * item key, its `dependsOn` and its `workItemId`. One fan-out engine, one join,
 * and the work-item status falls out of the child-run events the container
 * already records (see work-items.ts).
 *
 * This node is a `custom:*` node on purpose: it shows how a plugin extends the
 * node vocabulary without touching the core schema.
 *
 * It is the *request-scoped* original. The plan-aware successors
 * (`custom:plan-register`, `custom:plan-dispatch`, ...) in `../plan/executors.ts`
 * track dependencies, risks and decisions across requests; the shipped
 * `workflows/program.yaml` uses those.
 */
import { DecompositionSchema, newId, parseDependencyRef, type CustomNode, type WorkItem } from "@orca/core";
import { completed, failed, type NodeExecutor, type StepOutcome } from "../executors/types.js";

export interface MaterializeWorkItemsNode extends CustomNode {
  type: "custom:materialize-work-items";
  /** Name/kind of the decomposition artifact (default "decomposition"). */
  artifact?: string;
}

export const materializeWorkItemsExecutor: NodeExecutor<MaterializeWorkItemsNode> = {
  type: "custom:materialize-work-items",
  async execute(ctx): Promise<StepOutcome> {
    const name = ctx.node.artifact ?? "decomposition";
    const [art] = await ctx.resolveInputs([{ name, required: false }]);
    const source = art ?? (await ctx.resolveInputs([{ kind: name, required: true }]))[0]!;
    const parsed = DecompositionSchema.safeParse(source.data);
    if (!parsed.success) return failed("ARTIFACT_INVALID", `decomposition artifact is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {}, false);
    const request = await ctx.run.request();
    const requestId = request?.id ?? ctx.run.id;
    const now = ctx.clock.isoNow();
    const bySlug = new Map<string, WorkItem>();
    for (const item of parsed.data.items) {
      const wi: WorkItem = {
        id: newId("wi", ctx.clock.now()),
        requestId,
        slug: item.slug,
        title: item.title,
        description: item.description,
        kind: item.kind,
        acceptanceCriteria: item.acceptanceCriteria,
        dependsOn: item.dependsOn,
        priority: item.priority,
        produced: {},
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(item.workflow ? { workflowId: item.workflow } : {}),
        ...(item.repo ? { repo: item.repo } : {}),
        ...(item.estimate ? { estimate: item.estimate } : {}),
      };
      bySlug.set(item.slug, wi);
    }
    for (const item of parsed.data.items) {
      if (item.parent) {
        const parent = bySlug.get(item.parent);
        if (parent) bySlug.get(item.slug)!.parentId = parent.id;
      }
      for (const dep of item.dependsOn) {
        const key = parseDependencyRef(dep).key;
        if (!bySlug.has(key)) return failed("ARTIFACT_INVALID", `work item '${item.slug}' depends on unknown '${key}'`, {}, false);
      }
    }
    await ctx.stores.workItems.putMany([...bySlug.values()]);
    if (request) await ctx.stores.requests.put({ ...request, status: "in-progress", updatedAt: now });
    const workItems = [...bySlug.values()];
    // Only leaves are dispatched: an epic/feature is done when its children are. Published as a
    // var so the fan-out stays plain YAML (`forEach.items: vars.leafWorkItems`).
    const parents = new Set(workItems.map((w) => w.parentId).filter(Boolean));
    const leafWorkItems = workItems.filter((w) => !parents.has(w.id));
    await ctx.emit({ type: "vars.set", payload: { vars: { workItems, leafWorkItems } } });
    return completed({ data: { count: workItems.length, leaves: leafWorkItems.length, slugs: workItems.map((w) => w.slug) } });
  },
};
