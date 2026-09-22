/**
 * `workflows.list`, `workflows.get` and the traversal `runs.get` grew (#174), against the
 * *shipped* workflow files rather than a fixture graph.
 *
 * That is the point of this file: the viewer (#177) is specified against `ai-sdlc` and
 * `program`, so a test that invented its own two-node workflow would prove the projection
 * compiles and nothing about the graphs anyone will actually open. The workflows are loaded
 * from `workflows/*.yaml` exactly as `orca serve` loads them, so a change to one of those
 * files that the wire cannot express fails here.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { OrcaError, loadWorkflows, parseWorkflow } from "@orca/core";
import {
  HelloResultSchema,
  PROTOCOL_VERSION,
  READ_METHODS,
  RunsGetResultSchema,
  WorkflowsGetResultSchema,
  WorkflowsListResultSchema,
  type WorkflowView,
} from "@orca/protocol";
import { ReadModel, dispatch, methods, type MethodContext } from "@orca/daemon";
import { fixture, type Fixture } from "./fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The workflow the fixture runs say they were started against. The fixture store is events
 * only — it never had a definition, because the read methods never needed one — and the
 * traversal does: `viaEdge` is the definition's edge, so a run whose workflow the daemon
 * does not have gets no edges, which is one of the cases asserted below.
 */
const SDLC = `
id: sdlc
name: SSO delivery loop
version: "2"
start: start
nodes:
  start: { type: start }
  build: { type: agent, agent: { role: builder }, template: sdlc/build }
  fanout: { type: parallel, branches: { "auth-ui": { workflow: sdlc-item } } }
  done: { type: end }
edges:
  - { from: start, to: build }
  - { from: build, to: fanout }
  - { from: fanout, to: done }
`;

let f: Fixture;
let reads: ReadModel;
let ctx: MethodContext;

beforeAll(async () => {
  f = await fixture();
  for (const def of (await loadWorkflows(["workflows/*.yaml"], REPO_ROOT)).list())
    f.orchestrator.workflows.register(def);
  f.orchestrator.workflows.register(parseWorkflow(SDLC, "sdlc.yaml"));
  reads = new ReadModel({ orchestrator: f.orchestrator });
  ctx = { orcaVersion: "0.2.0-test", capabilities: ["runs.read"], storeDir: "/work/orca/.orca", reads };
});

async function call(method: string, params?: unknown) {
  const res = await dispatch(JSON.stringify({ kind: "request", id: 7, method, params }), methods, ctx);
  return res as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
}

describe("workflows.list", () => {
  it("lists the shipped workflows, by id, with their node and edge counts", async () => {
    const r = WorkflowsListResultSchema.parse((await call("workflows.list")).result);
    expect(r.asOf).toBe(f.asOf);
    expect(r.workflows.map((w) => w.id)).toEqual(["ai-sdlc", "plan-resume", "program", "sdlc"]);
    const sdlc = r.workflows.find((w) => w.id === "ai-sdlc")!;
    expect(sdlc.name).toBe("AI-native SDLC loop");
    expect(sdlc.version).toBe("1");
    expect(sdlc.start).toBe("start");
    expect(sdlc.nodeCount).toBe(18);
    expect(sdlc.edgeCount).toBe(20);
  });

  it("says nothing about where a workflow came from", async () => {
    const r = WorkflowsListResultSchema.parse((await call("workflows.list")).result);
    // A daemon loads every workflow from one glob into one registry and does not keep the
    // path, so "shipped" and "user-defined" is not a distinction it can make. The absence
    // is the contract; see `WorkflowSummaryViewSchema`.
    expect(Object.keys(r.workflows[0]!).sort()).toEqual([
      "description",
      "edgeCount",
      "id",
      "name",
      "nodeCount",
      "start",
      "version",
    ]);
  });
});

describe("workflows.get", () => {
  it("returns ai-sdlc's nodes and edges whole", async () => {
    const r = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "ai-sdlc" })).result);
    const w = r.workflow;
    // #136 adds an explicit delivery verdict and blocked terminal node; both travel to
    // the viewer rather than implying that reaching deploy means delivery succeeded.
    expect(w.nodes).toHaveLength(18);
    expect(w.id).toBe("ai-sdlc");
    expect(w.name).toBe("AI-native SDLC loop");
    expect(w.start).toBe("start");
    expect(w.inputs).toEqual({
      workItem: "The work item (title, description, acceptance criteria) this run implements.",
    });
    expect(w.vars).toMatchObject({ maxBuildAttempts: 3, maxReviewRounds: 2 });
  });

  it("folds each node type to the fields the viewer shows", async () => {
    const r = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "ai-sdlc" })).result);
    const node = (id: string) => r.workflow.nodes.find((n) => n.id === id)!;

    expect(node("plan")).toMatchObject({
      type: "agent",
      name: "Plan: capture intent",
      fields: { role: "planner", template: "sdlc/plan" },
    });
    expect(node("spec-gate").fields).toMatchObject({
      question: expect.stringContaining("Approve the spec"),
      options: [
        { id: "approve", label: "approve" },
        { id: "reject", label: "reject" },
      ],
      autoOption: "approve",
    });
    expect(node("tests-passed").fields).toMatchObject({
      source: { kind: "artifact", artifact: "testReport", field: "passed" },
      defaultOption: "false",
    });
    expect(node("bump-build").fields).toEqual({ vars: { buildAttempt: "=vars.buildAttempt + 1" } });
    expect(node("done").fields).toEqual({ outcome: "success", message: "Work item delivered." });
    expect(node("start").fields).toEqual({});
    // A `custom:` node is a plugin's, so everything but the base fields goes through.
    expect(node("await-deps")).toMatchObject({ type: "custom:plan-await", fields: { phase: "build" } });
    // The definition's whole node never travels: no `meta`, no `type` inside `fields`.
    expect(node("plan").fields).not.toHaveProperty("type");
  });

  it("carries the edges with their conditions and labels, back edges included", async () => {
    const r = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "ai-sdlc" })).result);
    expect(r.workflow.edges).toHaveLength(20);
    expect(r.workflow.edges).toContainEqual({ from: "delivery-status", to: "delivery-blocked" });
    expect(r.workflow.edges).toContainEqual({ from: "start", to: "plan" });
    // The review-to-build loop the viewer draws as a back edge (#177).
    expect(r.workflow.edges).toContainEqual({
      from: "tests-passed",
      to: "bump-build",
      when: "choice == 'false' && vars.buildAttempt < vars.maxBuildAttempts",
      label: "failed, retry",
    });
  });

  it("carries an inline nested graph under its node, and resolves it by its own id", async () => {
    const r = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "program" })).result);
    const decide = r.workflow.nodes.find((n) => n.id === "decide")!;
    expect(decide.type).toBe("loop");
    expect(decide.fields).toMatchObject({ mode: "forEach", items: "vars.openDecisions", maxIterations: 20 });
    // The graph is under the node, not inside `fields`.
    expect(decide.fields).not.toHaveProperty("body");
    const nested = decide.nested![0]!;
    expect(nested.id).toBe("program::decide");
    expect(nested.nodes.map((n) => n.id)).toEqual(["start", "matrix", "resolve", "done"]);

    // And the same graph is fetchable by that id, because it is the id the engine runs it
    // under: a viewer that collapsed the node can expand it with one call.
    const again = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "program::decide" })).result);
    const fetched: WorkflowView = again.workflow;
    expect(fetched.nodes).toEqual(nested.nodes);
    expect(fetched.edges).toEqual(nested.edges);
    // A nested graph is stamped with its parent's version and has no version list of its own.
    expect(fetched.version).toBe("2");
    expect(nested.versions).toBeUndefined();
  });

  it("reports the versions it can see, which is the disk's plus the runs'", async () => {
    // The fixture's runs were created against `sdlc` v2 and v1; the file registered here is
    // v2. The daemon keeps no definition for v1 - it only knows a run recorded it.
    const r = WorkflowsGetResultSchema.parse((await call("workflows.get", { id: "sdlc" })).result);
    expect(r.workflow.versions).toEqual(["1", "2"]);

    expect((await call("workflows.get", { id: "sdlc", version: "2" })).ok).toBe(true);
    const old = await call("workflows.get", { id: "sdlc", version: "1" });
    expect(old.error?.code).toBe("WORKFLOW_NOT_FOUND");
    expect(old.error?.message).toContain("keeps no definition");
  });

  it("answers WORKFLOW_NOT_FOUND for an id it has never heard of", async () => {
    expect((await call("workflows.get", { id: "nope" })).error?.code).toBe("WORKFLOW_NOT_FOUND");
    expect((await call("workflows.get", { id: "ai-sdlc::plan" })).error?.code).toBe("WORKFLOW_NOT_FOUND");
    await expect(reads.workflowsGet({ id: "nope" })).rejects.toThrow(OrcaError);
  });
});

describe("runs.get traversal", () => {
  it("lists the nodes a run took, in order, one entry per attempt", async () => {
    const r = RunsGetResultSchema.parse((await call("runs.get", { runId: "run-parent" })).result);
    expect(r.traversal!.map((t) => [t.nodeId, t.attempt, t.status])).toEqual([
      ["build", 1, "failed"],
      ["build", 2, "succeeded"],
      ["fanout", 1, "running"],
    ]);
    const [first, retry, fan] = r.traversal!;
    expect(first!.stepRunId).toBe("s-build-1");
    expect(first!.startedAt).toBe(r.steps[0]!.startedAt);
    expect(first!.endedAt).toBe(r.steps[0]!.finishedAt);
    // No edge for the first node, and none for a retry: `build` -> `build` is not an edge
    // anyone authored, so the overlay draws nothing rather than inventing one.
    expect(first!.viaEdge).toBeUndefined();
    expect(retry!.viaEdge).toBeUndefined();
    expect(fan!.viaEdge).toEqual({ from: "build", to: "fanout" });
    // A container node links its children, so the canvas can expand the fan-out.
    expect(fan!.childRunIds).toEqual(["run-child-ok", "run-child-gone"]);
    expect(fan!.endedAt).toBeUndefined();
  });

  it("gives a finished run its whole path, with the timestamps the steps carry", async () => {
    const r = RunsGetResultSchema.parse((await call("runs.get", { runId: "run-child-ok" })).result);
    expect(r.traversal).toHaveLength(1);
    const step = r.steps[0]!;
    expect(r.traversal![0]).toMatchObject({
      nodeId: "implement",
      stepRunId: step.id,
      attempt: 1,
      status: "succeeded",
      startedAt: step.startedAt,
      endedAt: step.finishedAt,
    });
    expect(r.traversal![0]!.childRunIds).toBeUndefined();
  });

  it("still lists the nodes when the daemon has no definition for the workflow, without edges", async () => {
    // `run-old` ran `nightly`, which is not registered here.
    const r = RunsGetResultSchema.parse((await call("runs.get", { runId: "run-old" })).result);
    expect(r.traversal).toEqual([]);
    const gate = RunsGetResultSchema.parse((await call("runs.get", { runId: "run-gate" })).result);
    // `sdlc` is registered but has no `write` or `approve` node: an edge that is not in the
    // definition is not named, and the visits are still listed.
    expect(gate.traversal!.map((t) => t.nodeId)).toEqual(["write", "approve"]);
    expect(gate.traversal!.every((t) => t.viaEdge === undefined)).toBe(true);
  });
});

describe("hello", () => {
  it("advertises both workflow methods as reads, so --read-only answers them", async () => {
    const r = HelloResultSchema.parse((await call("hello", { client: "test/1", protocol: PROTOCOL_VERSION })).result);
    // This context has no `control`, which is exactly what `orca serve --read-only` builds.
    expect(r.capabilities).toEqual(["runs.read"]);
    expect(r.methods).toContain("workflows.list");
    expect(r.methods).toContain("workflows.get");
    expect(READ_METHODS).toContain("workflows.list");
    expect(READ_METHODS).toContain("workflows.get");
    expect((await call("workflows.list")).ok).toBe(true);
  });
});
