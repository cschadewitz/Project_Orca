/**
 * The planning layer end-to-end with the shipped program workflow and the
 * scripted ACP agent: decisions made by matrix before dependants run,
 * stage-level and build-phase dependencies pipelining item runs, risks lifted
 * from artifacts, and a second request that depends on the first one's work
 * (deferred, then picked up by `plan-resume`).
 */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { ProgramService } from "@orca/engine";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const good = {
  spec: [{ data: { status: "ready", risk: "low", risks: [{ key: "flaky-tests", title: "Flaky integration tests", likelihood: 2, impact: 2 }] }, body: "# Spec\n\nLong enough body to satisfy the design validation rule of eighty characters minimum." }],
  implementation: [{ data: { status: "done", branch: "b" } }],
  "test-report": [{ data: { status: "done", passed: true } }],
  review: [{ data: { status: "done", verdict: "approve" } }],
};

describe("planning layer (e2e)", () => {
  it("decides, then dispatches in dependency order with stage-level pipelining and build-phase waits", async () => {
    const h = await harness({
      kinds: {
        ...good,
        decomposition: [
          {
            data: {
              items: [
                { slug: "core", title: "Core", estimate: "M" },
                { slug: "api", title: "API", dependsOn: ["core@spec", "decision:store"], priority: "high" },
                { slug: "ui", title: "UI", dependsOn: ["api#build"] },
              ],
              decisions: [{ key: "store", title: "Session store", question: "Cookie or Redis?", options: [{ key: "cookie", name: "Cookie" }, { key: "redis", name: "Redis" }], blocks: ["api"] }],
              rationale: "three slices",
            },
          },
        ],
        "risk-register": [{ data: { status: "done", risks: [{ key: "ui-regressions", title: "UI regressions", likelihood: 3, impact: 3, affects: ["ui"] }], summary: "one medium risk" } }],
        "decision-matrix": [
          {
            data: {
              key: "store",
              title: "Session store",
              criteria: [{ key: "simple", name: "Simplicity", weight: 3 }, { key: "revoke", name: "Revocation", weight: 1 }],
              options: [
                { key: "cookie", name: "Cookie", scores: { simple: 9, revoke: 3 } },
                { key: "redis", name: "Redis", scores: { simple: 4, revoke: 9 } },
              ],
              rationale: "v1 favours simplicity",
            },
          },
        ],
      },
    });
    dirs.push(h.dir);
    const { request, state } = await new ProgramService(h.orchestrator).submitAndRun({ title: "Sessions", body: "Add sessions." });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual(["start", "decompose", "register", "assess-risks", "decide", "schedule", "plan-gate", "dispatch", "summarize", "done"]);

    const plan = (await h.orchestrator.plan.getPlan("default"))!;
    const snap = await h.orchestrator.plan.snapshot(plan.id);
    const bySlug = Object.fromEntries(snap.items.map((i) => [i.slug, i]));
    expect(Object.fromEntries(snap.items.map((i) => [i.slug, i.status]))).toEqual({ core: "done", api: "done", ui: "done" });

    // Decision: made by the matrix inside the decide loop, before api ran.
    expect(snap.decisions).toEqual([expect.objectContaining({ key: "store", status: "decided", chosen: "cookie", decidedBy: "matrix", rationale: "v1 favours simplicity" })]);
    const decideStep = state.steps[state.stepOrder[4]!]!;
    expect(decideStep.childRunIds).toHaveLength(1);
    const decideRun = await h.orchestrator.getState(decideStep.childRunIds[0]!);
    expect(decideRun.stepOrder.map((id) => decideRun.steps[id]!.nodeId)).toEqual(["start", "matrix", "resolve", "done"]);
    expect(Object.values(decideRun.artifacts)[0]?.path).toBe(`${h.dir}/.orca/program/${request.id}/decisions/store.md`);
    const decidePrompt = (await h.prompts()).find((p) => p.text.includes("You are the **architect**"))!;
    expect(decidePrompt.text).toContain("Work items waiting on this decision: api");

    // Risks: from the register (affects ui) and from every spec (attached to the producing item).
    expect(snap.risks.find((r) => r.key === "ui-regressions")).toMatchObject({ affects: [bySlug.ui!.id], origin: { kind: "artifact" } });
    expect(snap.risks.find((r) => r.key === "flaky-tests")!.affects.sort()).toEqual([bySlug.api!.id, bySlug.core!.id, bySlug.ui!.id].sort());

    // Dispatch order and pipelining: api started after core's spec existed but before core finished.
    const dispatch = state.steps[state.stepOrder[7]!]!;
    const runs = await Promise.all(dispatch.childRunIds.map((id) => h.orchestrator.getState(id)));
    const runOf = (slug: string) => runs.find((r) => r.run.workItemId === bySlug[slug]!.id)!;
    const coreSpec = Object.values(runOf("core").artifacts).find((a) => a.kind === "spec")!;
    expect(runOf("api").run.createdAt >= coreSpec.createdAt).toBe(true);
    expect(runOf("api").run.createdAt < runOf("core").run.completedAt!).toBe(true);
    // ui could only start once api was underway, held its build until api was done, and its build prompt carried api's artifacts.
    expect(runOf("ui").run.createdAt >= runOf("api").run.createdAt).toBe(true);
    const uiAwait = Object.values(runOf("ui").steps).find((s) => s.nodeId === "await-deps")!;
    expect(uiAwait.status).toBe("completed");
    expect(uiAwait.result?.data).toMatchObject({ phase: "build", satisfied: ["api is done"] });
    expect(uiAwait.completedAt! >= runOf("api").run.completedAt!).toBe(true);
    const uiBuild = (await h.prompts()).filter((p) => p.text.includes("You are the **build agent**")).find((p) => p.text.includes("(`ui`)"))!;
    expect(uiBuild.text).toContain("Upstream work this item depends on");
    expect(uiBuild.text).toMatch(/`api` \(done; blocks, required by build\)/);
    expect(uiBuild.text).toContain(`${h.dir}/.orca/work/api/implementation.md`);

    // Schedule artifact + gate + journal.
    expect(Object.values(state.artifacts).some((a) => a.kind === "schedule")).toBe(true);
    expect(state.run.vars.schedule).toMatchObject({ ready: [{ slug: "core" }], waiting: [{ slug: "api" }, { slug: "ui" }], criticalPath: ["core", "api", "ui"] });
    expect(state.run.vars.dispatchOutcome).toBe("complete");
    const journal = await h.orchestrator.plan.journalOf(plan.id);
    const started = journal.filter((e) => e.type === "dispatch.started").map((e) => snap.items.find((i) => i.id === (e.payload as { workItemId: string }).workItemId)!.slug);
    expect(started).toEqual(["core", "api", "ui"]);
    const summaryPrompt = (await h.prompts()).find((p) => p.text.includes("Summarise the program"))!;
    expect(summaryPrompt.text).toContain("Critical path: core -> api -> ui");
  }, 180_000);

  it("defers work that depends on another request, then plan-resume picks it up once that request delivered", async () => {
    const h = await harness({
      kinds: {
        ...good,
        decomposition: [
          { data: { items: [{ slug: "a1", title: "A1" }, { slug: "a2", title: "A2", dependsOn: ["b1"] }], rationale: "A" } },
          { data: { items: [{ slug: "b1", title: "B1" }], rationale: "B" } },
        ],
      },
    });
    dirs.push(h.dir);
    const program = new ProgramService(h.orchestrator);
    const a = await program.submitAndRun({ title: "A", body: "first" });
    expect(a.state.run.status, JSON.stringify(a.state.run.error)).toBe("completed");
    expect(a.state.run.vars.dispatchOutcome).toBe("partial");
    const plan = (await h.orchestrator.plan.getPlan("default"))!;
    let items = Object.fromEntries((await h.orchestrator.plan.snapshot(plan.id)).items.map((i) => [i.slug, i]));
    expect(items.a1!.status).toBe("done");
    expect(items.a2).toMatchObject({ status: "pending", deferredReason: expect.stringMatching(/external 'b1'/) });
    expect((a.state.run.vars.dispatched as { slug: string; status: string }[]).map((d) => `${d.slug}:${d.status}`)).toEqual(["a1:done", "a2:deferred"]);

    const b = await program.submitAndRun({ title: "B", body: "second" });
    expect(b.state.run.status, JSON.stringify(b.state.run.error)).toBe("completed");
    items = Object.fromEntries((await h.orchestrator.plan.snapshot(plan.id)).items.map((i) => [i.slug, i]));
    expect(items.b1!.status).toBe("done");
    expect(items.a2!.status).toBe("pending"); // request-scoped dispatch does not run A's items
    expect(plan.id).toBe((await h.orchestrator.plan.getPlan("default"))!.id);
    expect((await h.orchestrator.plan.getPlan("default"))!.requestIds).toEqual([a.request.id, b.request.id]);

    const resume = await h.orchestrator.startAndRun({ workflowId: "plan-resume", vars: { plan: "default" } });
    expect(resume.run.status, JSON.stringify(resume.run.error)).toBe("completed");
    items = Object.fromEntries((await h.orchestrator.plan.snapshot(plan.id)).items.map((i) => [i.slug, i]));
    expect(items.a2!.status).toBe("done");
    expect(items.a2!.deferredReason).toBeUndefined();
    const journal = await h.orchestrator.plan.journalOf(plan.id);
    expect(journal.map((e) => e.type)).toEqual(expect.arrayContaining(["dispatch.deferred", "dependency.bound", "dependency.resolved", "dispatch.started"]));
    expect((await h.orchestrator.plan.explain(plan.id, "a2"))[0]).toBe("a2: done");
  }, 180_000);
});
