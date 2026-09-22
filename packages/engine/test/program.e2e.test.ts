/** The level above: request -> decomposition -> parallel SDLC runs with dependencies -> summary. */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "@orca/core";
import { ProgramService, projectWorkItems } from "@orca/engine";
import { harness, loadShippedWorkflows } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const good = {
  spec: [
    {
      data: { status: "ready", risk: "low" },
      body: "# Spec\n\nLong enough body to satisfy the design validation rule of eighty characters minimum.",
    },
  ],
  implementation: [{ data: { status: "done", branch: "b" } }],
  "test-report": [{ data: { status: "done", passed: true } }],
  review: [{ data: { status: "done", verdict: "approve" } }],
};

describe("program workflow (e2e)", () => {
  it("decomposes a request and runs the SDLC loop per work item honouring dependencies", async () => {
    const h = await harness({
      kinds: {
        ...good,
        decomposition: [
          {
            data: {
              items: [
                {
                  slug: "db-schema",
                  title: "DB schema",
                  kind: "task",
                  description: "tables",
                  acceptanceCriteria: ["migration applies"],
                  dependsOn: [],
                },
                {
                  slug: "auth-api",
                  title: "Auth API",
                  kind: "feature",
                  description: "login",
                  dependsOn: ["db-schema"],
                },
                { slug: "docs", title: "Docs", kind: "task", description: "write docs", dependsOn: [] },
              ],
              rationale: "vertical slices",
            },
            body: "Breakdown narrative.",
          },
        ],
      },
    });
    dirs.push(h.dir);
    const program = new ProgramService(h.orchestrator);
    const { request, state } = await program.submitAndRun({
      title: "Add authentication",
      body: "Users must be able to log in.",
    });

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.outcome).toBe("success");
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual([
      "start",
      "decompose",
      "register",
      "assess-risks",
      "decide",
      "schedule",
      "plan-gate",
      "dispatch",
      "summarize",
      "done",
    ]);

    const items = await h.orchestrator.stores.workItems.list();
    expect(items.map((w) => [w.slug, w.status]).sort()).toEqual([
      ["auth-api", "done"],
      ["db-schema", "done"],
      ["docs", "done"],
    ]);
    expect((await h.orchestrator.stores.requests.get(request.id))?.status).toBe("completed");

    // Dependency order: auth-api's child run must have been created after db-schema's finished.
    const dispatch = state.steps[state.stepOrder[7]!]!;
    expect(dispatch.childRunIds).toHaveLength(3);
    const children = await Promise.all(dispatch.childRunIds.map((id) => h.orchestrator.getState(id)));
    const bySlug = new Map(children.map((c) => [items.find((w) => w.id === c.run.workItemId)!.slug, c]));
    expect(bySlug.get("auth-api")!.run.createdAt >= bySlug.get("db-schema")!.run.completedAt!).toBe(true);
    for (const c of children) expect(c.run.workspace.cwd).toBe(h.dir);
    expect(bySlug.get("docs")!.run.status).toBe("completed");

    // Each child run produced its own artifacts under its slug and the summary prompt saw dispatch results.
    const artifacts = await h.orchestrator.stores.artifacts.list({ kind: "deploy-report" });
    expect(artifacts).toHaveLength(3);
    for (const artifact of artifacts) {
      const child = children.find((c) => c.run.id === artifact.producedBy.runId)!;
      const item = items.find((item) => item.id === child.run.workItemId)!;
      expect(artifact.path?.replaceAll("\\", "/")).toBe(
        `${h.dir.replaceAll("\\", "/")}/.orca/work/${item.slug}/.orca-attempts/${child.run.id}/${artifact.producedBy.stepRunId}/deploy-report.md`,
      );
    }
    const summaryPrompt = (await h.prompts()).find((p) => p.text.includes("Summarise the program"))!;
    expect(summaryPrompt.text).toContain("`auth-api`: done");
    expect(summaryPrompt.text).toContain("vertical slices");

    // Work-item status is a projection, not a side-write: scribble over the documents the way a
    // crash mid-dispatch would and the program run's own log puts every one of them back.
    for (const w of items) await h.orchestrator.stores.workItems.put({ ...w, status: "in-progress" });
    await projectWorkItems(h.orchestrator.stores, state, "2020-01-01T00:00:00.000Z");
    const rebuilt = await h.orchestrator.stores.workItems.list();
    expect(rebuilt.map((w) => [w.slug, w.status]).sort()).toEqual([
      ["auth-api", "done"],
      ["db-schema", "done"],
      ["docs", "done"],
    ]);
  }, 120_000);

  it("blocks dependants when a prerequisite fails and fails the program", async () => {
    const h = await harness({
      kinds: {
        ...good,
        "test-report": [{ data: { status: "done", passed: false } }], // every build fails its tests
        decomposition: [
          {
            data: {
              items: [
                { slug: "a", title: "A", dependsOn: [] },
                { slug: "b", title: "B", dependsOn: ["a"] },
              ],
            },
          },
        ],
      },
    });
    dirs.push(h.dir);
    const { state } = await new ProgramService(h.orchestrator).submitAndRun({
      title: "x",
      body: "y",
      vars: { maxBuildAttempts: 1 },
    });
    expect(state.run.status).toBe("failed");
    const items = await h.orchestrator.stores.workItems.list();
    expect(Object.fromEntries(items.map((w) => [w.slug, w.status]))).toEqual({ a: "failed", b: "blocked" });
    expect(items.find((w) => w.slug === "b")?.deferredReason).toMatch(/a is failed/);
  }, 120_000);

  it("dispatches work items to the configured itemWorkflow", async () => {
    const workflows = await loadShippedWorkflows();
    workflows.register(
      parseWorkflow(
        [
          "id: my-sdlc",
          'name: "Minimal item workflow"',
          'version: "1"',
          "start: start",
          "nodes:",
          "  start: { type: start }",
          "  done: { type: end, outcome: success }",
          "edges:",
          "  - { from: start, to: done }",
        ].join("\n"),
        "my-sdlc.yaml",
      ),
    );
    const h = await harness(
      {
        kinds: {
          ...good,
          decomposition: [{ data: { items: [{ slug: "only", title: "Only", dependsOn: [] }] } }],
        },
      },
      { workflows },
    );
    dirs.push(h.dir);
    const { state } = await new ProgramService(h.orchestrator, "program", "my-sdlc").submitAndRun({
      title: "x",
      body: "y",
    });

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    const dispatch = state.steps[state.stepOrder.find((id) => state.steps[id]!.nodeId === "dispatch")!]!;
    const children = await Promise.all(dispatch.childRunIds.map((id) => h.orchestrator.getState(id)));
    expect(children.map((c) => c.run.workflowId)).toEqual(["my-sdlc"]);
  }, 120_000);
});
