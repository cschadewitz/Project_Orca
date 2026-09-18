/**
 * `completion.mode: artifact-present` against the scripted ACP agent: the turn is cut short
 * once every *required* deliverable exists, and never when nothing is required
 * (regression for issue #10, where `[].every(Boolean)` cancelled the turn after 1.5 s).
 */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkflow, WorkflowRegistry } from "@orca/core";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function workflow(produces: string): WorkflowRegistry {
  const reg = new WorkflowRegistry();
  reg.register(
    parseWorkflow(`
id: present
name: artifact-present
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: scripted
    prompt: "Do the work."
    completion: { mode: artifact-present, maxFollowUps: 0 }
    produces:
${produces}
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`),
  );
  return reg;
}

describe("artifact-present completion (e2e with scripted ACP agent)", () => {
  it("does not cancel the turn when no deliverable is required", async () => {
    // The agent takes longer than one watcher tick (1.5 s) to write its only, optional, deliverable.
    const h = await harness(
      { kinds: { plan: [{ delayMs: 2500, body: "# Plan\n\nWritten after the first watcher tick." }] } },
      { workflows: workflow("      - { kind: plan, path: .orca/plan.md, required: false }") },
    );
    dirs.push(h.dir);
    const state = await h.orchestrator.startAndRun({ workflowId: "present" });

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    const work = state.stepOrder.map((id) => state.steps[id]!).find((s) => s.nodeId === "work")!;
    expect(work.result?.data).toMatchObject({ stopReason: "end_turn" });
    const arts = Object.values(state.artifacts);
    expect(arts.map((a) => a.kind)).toEqual(["plan"]);
    expect(arts[0]?.path).toBe(`${h.dir}/.orca/plan.md`);
  }, 60_000);

  it("cancels the turn once every required deliverable exists, ignoring optional ones", async () => {
    // `plan` is written right away; `notes` would only land after 20 s. The watcher must cancel
    // the turn as soon as `plan` exists rather than wait for the optional `notes`.
    const h = await harness(
      {
        kinds: {
          plan: [{ body: "# Plan\n\nWritten immediately." }],
          notes: [{ delayMs: 20_000, body: "never written" }],
        },
      },
      {
        workflows: workflow(
          "      - { kind: plan, path: .orca/plan.md }\n      - { kind: notes, path: .orca/notes.md, required: false }",
        ),
      },
    );
    dirs.push(h.dir);
    const started = Date.now();
    const state = await h.orchestrator.startAndRun({ workflowId: "present" });
    const elapsed = Date.now() - started;

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(elapsed).toBeLessThan(15_000);
    const work = state.stepOrder.map((id) => state.steps[id]!).find((s) => s.nodeId === "work")!;
    expect(work.result?.data).toMatchObject({ stopReason: "cancelled" });
    expect(Object.values(state.artifacts).map((a) => a.kind)).toEqual(["plan"]);
  }, 60_000);
});
