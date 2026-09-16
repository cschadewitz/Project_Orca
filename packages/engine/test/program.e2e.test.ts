/** The level above: request -> decomposition -> parallel SDLC runs with dependencies -> summary. */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { ProgramService } from "@orca/engine";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const good = { spec: [{ data: { status: "ready", risk: "low" }, body: "# Spec\n\nLong enough body to satisfy the design validation rule of eighty characters minimum." }], implementation: [{ data: { status: "done", branch: "b" } }], "test-report": [{ data: { status: "done", passed: true } }], review: [{ data: { status: "done", verdict: "approve" } }] };

describe("program workflow (e2e)", () => {
  it("decomposes a request and runs the SDLC loop per work item honouring dependencies", async () => {
    const h = await harness({
      kinds: {
        ...good,
        decomposition: [
          {
            data: {
              items: [
                { slug: "db-schema", title: "DB schema", kind: "task", description: "tables", acceptanceCriteria: ["migration applies"], dependsOn: [] },
                { slug: "auth-api", title: "Auth API", kind: "feature", description: "login", dependsOn: ["db-schema"] },
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
    const { request, state } = await program.submitAndRun({ title: "Add authentication", body: "Users must be able to log in." });

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.outcome).toBe("success");
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual(["start", "decompose", "register", "assess-risks", "decide", "schedule", "plan-gate", "dispatch", "summarize", "done"]);

    const items = await h.orchestrator.stores.workItems.list();
    expect(items.map((w) => [w.slug, w.status]).sort()).toEqual([["auth-api", "done"], ["db-schema", "done"], ["docs", "done"]]);
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
    expect(artifacts.map((a) => a.path).sort()).toEqual(["auth-api", "db-schema", "docs"].map((s) => `${h.dir}/.orca/work/${s}/deploy-report.md`));
    const summaryPrompt = (await h.prompts()).find((p) => p.text.includes("Summarise the program"))!;
    expect(summaryPrompt.text).toContain("`auth-api`: done");
    expect(summaryPrompt.text).toContain("vertical slices");
  }, 120_000);

  it("blocks dependants when a prerequisite fails and fails the program", async () => {
    const h = await harness({
      kinds: {
        ...good,
        "test-report": [{ data: { status: "done", passed: false } }], // every build fails its tests
        decomposition: [{ data: { items: [{ slug: "a", title: "A", dependsOn: [] }, { slug: "b", title: "B", dependsOn: ["a"] }] } }],
      },
    });
    dirs.push(h.dir);
    const { state } = await new ProgramService(h.orchestrator).submitAndRun({ title: "x", body: "y", vars: { maxBuildAttempts: 1 } });
    expect(state.run.status).toBe("failed");
    const items = await h.orchestrator.stores.workItems.list();
    expect(Object.fromEntries(items.map((w) => [w.slug, w.status]))).toEqual({ a: "failed", b: "blocked" });
    expect(items.find((w) => w.slug === "b")?.deferredReason).toMatch(/a is failed/);
  }, 120_000);
});
