/**
 * Regression for issue #1: a decision node with `source: { kind: agent }` must resolve the
 * host through the decision's own agent selector. Previously `planDeliverables` fell back to
 * a literal agent id "local", which no config defines, and every such node failed with
 * AGENT_NOT_FOUND before a prompt was ever sent.
 */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "@orca/core";
import { harness, loadShippedWorkflows } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workflow = parseWorkflow(`
id: agent-decision
name: Agent-sourced decision
version: "1"
start: start
nodes:
  start: { type: start }
  ship-it:
    type: decision
    name: "Ask the reviewer whether to ship"
    source:
      kind: agent
      agent: { role: reviewer }
      prompt: "Decide whether we should ship. Answer with one of {{ vars.options }}."
    options: [ship, hold]
  shipped: { type: end, outcome: success }
  held: { type: end, outcome: failure }
edges:
  - { from: start, to: ship-it }
  - { from: ship-it, to: shipped, when: "choice == 'ship'" }
  - { from: ship-it, to: held, when: "choice == 'hold'" }
`);

describe("agent-sourced decision node (e2e with scripted ACP agent)", () => {
  it("resolves the decision's own agent selector and routes on the delivered choice", async () => {
    const h = await harness(
      { kinds: { decision: [{ data: { choice: "ship" }, body: "Looks good." }] } },
      { workflows: (await loadShippedWorkflows()).register(workflow) },
    );
    dirs.push(h.dir);
    const state = await h.orchestrator.startAndRun({ workflowId: "agent-decision" });

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.outcome).toBe("success");
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual(["start", "ship-it", "shipped"]);

    // The decision artifact was planned against the resolved agent's host (absolute path under the workspace).
    const [decision] = Object.values(state.artifacts);
    expect(decision?.kind).toBe("decision");
    expect(decision?.path?.replaceAll("\\", "/")).toBe(
      `${h.dir.replaceAll("\\", "/")}/.orca/runs/${state.run.id}/.orca-attempts/${state.run.id}/${decision?.producedBy.stepRunId}/ship-it-decision.md`,
    );
    expect(decision?.producedBy).toMatchObject({ agentId: "scripted", hostId: "local" });

    const events = await h.orchestrator.events(state.run.id);
    const resolved = events.find((e) => e.type === "decision.resolved");
    expect(resolved?.payload).toMatchObject({ choice: "ship", source: "agent:decision" });
    expect((await h.prompts()).some((p) => p.text.includes("Decide whether we should ship"))).toBe(true);
  }, 60_000);
});
