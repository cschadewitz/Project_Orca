/**
 * Which earlier siblings a child run's artifact visibility includes. A `loop` iteration, and a
 * sequential container's next child for the same work item, read what the earlier ones
 * produced. Fan-out branches (`parallel`) and children bound to different work items do not,
 * even when one starts only after the other has finished: item B's first build must not be
 * handed item A's review as feedback (`workflows/ai-sdlc.yaml`'s optional `review` input).
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  FakeClock,
  parseWorkflow,
  RequestSchema,
  TemplateRegistry,
  WorkflowRegistry,
  WorkItemSchema,
} from "@orca/core";
import { builtinExecutors, completed, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

/** The child workflow: resolve an optional `review` the way the SDLC build step does, then write one. */
const item = `
id: item
name: item
start: m
nodes:
  m: { type: "custom:mark" }
  e: { type: end, outcome: success }
edges: [{ from: m, to: e }]
`;

const parent = (container: string) => `
id: parent
name: parent
vars:
  items:
    - { slug: a, id: wi_a, needs: [] }
    - { slug: b, id: wi_b, needs: [a] }
start: c
nodes:
  c: ${container}
  e: { type: end, outcome: success }
edges: [{ from: c, to: e }]
`;

async function run(container: string) {
  const stores = memoryStores();
  const at = new Date().toISOString();
  await stores.requests.put(
    RequestSchema.parse({ id: "req_1", title: "Request", body: "", createdAt: at, updatedAt: at }),
  );
  for (const slug of ["a", "b"])
    await stores.workItems.put(
      WorkItemSchema.parse({ id: `wi_${slug}`, requestId: "req_1", slug, title: slug, createdAt: at, updatedAt: at }),
    );
  /** Child run id -> the `review` it resolved before writing its own, if any. */
  const resolved = new Map<string, string | undefined>();
  const executors = builtinExecutors();
  executors.register({
    type: "custom:mark",
    execute: async (ctx) => {
      const [prior] = await ctx.resolveInputs([{ name: "review", required: false }]);
      resolved.set(ctx.run.id, prior?.content);
      await ctx.recordArtifact(
        { kind: "review", name: "review", path: "review.md", required: true },
        `review by ${ctx.run.id}`,
      );
      return completed();
    },
  });
  // A plugin container that runs its children one after another, bound to the listed work items.
  executors.register({
    type: "custom:sequence",
    execute: async (ctx) => {
      for (const [i, workItemId] of (ctx.node as unknown as { workItems: string[] }).workItems.entries())
        await ctx.runChild({ workflow: "item" }, { branch: String(i), ...(workItemId ? { workItemId } : {}) });
      return completed();
    },
  });
  const orchestrator = new Orchestrator({
    stores,
    workflows: new WorkflowRegistry().register(parseWorkflow(item)).register(parseWorkflow(parent(container))),
    executors,
    agents: new AgentRegistry(),
    templates: new TemplateRegistry(),
    workspaceProvider: { name: "fake", provision: async () => ({ hostId: "local", cwd: "/tmp" }) },
    clock: new FakeClock(),
  });
  const state = await orchestrator.startAndRun({ workflowId: "parent", requestId: "req_1" });
  expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
  const links = state.steps[state.stepOrder[0]!]!.children;
  expect(links).toHaveLength(2);
  const [first, second] = links;
  // The second child was created only after the first had finished: by timing alone the first
  // is its earlier sibling, so only the container and the work items decide what it sees.
  const order = (await orchestrator.events(state.run.id))
    .filter((e) => e.type === "child.spawned" || e.type === "child.finished")
    .map((e) => `${e.type}:${(e.payload as { childRunId: string }).childRunId}`);
  expect(order).toEqual([
    `child.spawned:${first!.runId}`,
    `child.finished:${first!.runId}`,
    `child.spawned:${second!.runId}`,
    `child.finished:${second!.runId}`,
  ]);
  const review = async (runId: string) =>
    Object.values((await orchestrator.getState(runId)).artifacts).find((a) => a.name === "review")!.version;
  return {
    firstSaw: resolved.get(first!.runId),
    secondSaw: resolved.get(second!.runId),
    firstReview: `review by ${first!.runId}`,
    versions: [await review(first!.runId), await review(second!.runId)],
  };
}

describe("earlier-sibling artifact visibility", () => {
  it.each([
    [
      "parallel branches under a concurrency limit",
      "{ type: parallel, concurrency: 1, branches: { a: { workflow: item }, b: { workflow: item } } }",
    ],
    [
      "a parallel forEach branch that depends on another",
      "{ type: parallel, forEach: { items: vars.items, key: item.slug, dependsOn: item.needs, body: { workflow: item } } }",
    ],
    [
      "a parallel forEach over work items",
      "{ type: parallel, concurrency: 1, forEach: { items: vars.items, key: item.slug, workItemId: item.id, body: { workflow: item } } }",
    ],
    [
      "a sequential container's children for different work items",
      "{ type: custom:sequence, workItems: [wi_a, wi_b] }",
    ],
  ])("keeps %s apart", async (_, container) => {
    const seen = await run(container);
    expect(seen.firstSaw).toBeUndefined();
    expect(seen.secondSaw).toBeUndefined();
    // Nor does versioning count the other child's: each writes its own `review` v1.
    expect(seen.versions).toEqual([1, 1]);
  });

  it.each([
    [
      "loop iterations",
      "{ type: loop, mode: while, condition: 'iteration < 2', maxIterations: 2, body: { workflow: item } }",
    ],
    ["a sequential container's children", "{ type: custom:sequence, workItems: ['', ''] }"],
    ["a sequential container's children for the same work item", "{ type: custom:sequence, workItems: [wi_a, wi_a] }"],
  ])("lets %s see the earlier one", async (_, container) => {
    const seen = await run(container);
    expect(seen.firstSaw).toBeUndefined();
    expect(seen.secondSaw).toBe(seen.firstReview);
    expect(seen.versions).toEqual([1, 2]);
  });
});
