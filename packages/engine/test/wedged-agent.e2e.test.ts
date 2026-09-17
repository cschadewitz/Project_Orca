/**
 * A wedged agent (never ends its turn, ignores `session/cancel`) must not hang
 * the run: the turn timeout and `orchestrator.cancel()` both end in the agent
 * process being killed once `cancelGraceMs` elapses (regression for issue #11).
 */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkflow, WorkflowRegistry } from "@orca/core";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workflows = new WorkflowRegistry().register(
  parseWorkflow(`
id: wedge
name: wedged agent
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: scripted
    prompt: "Do the work."
    completion: { maxFollowUps: 0, maxAttempts: 1 }
    produces: [{ kind: plan, path: .orca/plan.md }]
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`),
);

const playbook = { kinds: { plan: [{ hang: true }] } };

describe("wedged agent (e2e with scripted ACP agent)", () => {
  it("turn timeout fails the step with AGENT_TRANSPORT instead of hanging", async () => {
    const h = await harness(playbook, { workflows }, { turnTimeoutMs: 300, cancelGraceMs: 300 });
    dirs.push(h.dir);
    const started = Date.now();
    const state = await h.orchestrator.startAndRun({ workflowId: "wedge" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(state.run.status).toBe("failed");
    const work = state.stepOrder.map((id) => state.steps[id]!).find((s) => s.nodeId === "work")!;
    expect(work.status).toBe("failed");
    expect(work.error?.code).toBe("AGENT_TRANSPORT");
    expect(work.error?.message).toMatch(/turn timed out after 300ms/);
    const types = (await h.orchestrator.events(state.run.id)).map((e) => e.type);
    expect(types).toContain("agent.session.closed");
  }, 30_000);

  it("orchestrator.cancel() returns and the run ends even though the agent ignores the cancel", async () => {
    const h = await harness(playbook, { workflows }, { cancelGraceMs: 300 });
    dirs.push(h.dir);
    const runId = await h.orchestrator.startRun({ workflowId: "wedge" });
    const done = h.orchestrator.run(runId);
    // Wait until the agent has received the prompt (it logs it before hanging).
    const deadline = Date.now() + 20_000;
    while ((await h.prompts()).length === 0) {
      if (Date.now() > deadline) throw new Error("agent never received the prompt");
      await new Promise((r) => setTimeout(r, 25));
    }
    const started = Date.now();
    await h.orchestrator.cancel(runId, "operator");
    const state = await done;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.run.status).toBe("cancelled");
    const work = state.stepOrder.map((id) => state.steps[id]!).find((s) => s.nodeId === "work")!;
    expect(work.status).toBe("cancelled");
  }, 60_000);
});
