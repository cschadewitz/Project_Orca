/**
 * Issue #24: the `=`-prefixed vars convention lives in one place (evaluateVars)
 * and applies to every vars-bearing node - including agent nodes, which used to
 * pass their vars through to the template unevaluated.
 */
import { rm } from "node:fs/promises";
import { parseWorkflow, WorkflowRegistry } from "@orca/core";
import { afterAll, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workflow = `
id: agent-vars
name: Agent node vars
version: "1"
start: start
nodes:
  start: { type: start }
  seed:
    type: set
    vars:
      n: 3
      label: "=upper('spec')"
  write:
    type: agent
    agent: { role: builder }
    prompt: "DOUBLED={{ vars.doubled }} LABEL={{ vars.label }} LITERAL={{ vars.literal }}"
    vars:
      doubled: "=vars.n * 2"
      literal: "plain text"
    produces:
      - { kind: note, path: ".orca/work/note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: seed }
  - { from: seed, to: write }
  - { from: write, to: done }
`;

describe("vars evaluation", () => {
  it("evaluates `=` vars on agent nodes as well as set nodes", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow, "agent-vars.yaml"));
    const h = await harness({ kinds: { note: [{ data: { status: "done" }, body: "noted" }] } }, { workflows });
    dirs.push(h.dir);
    const state = await h.orchestrator.startAndRun({ workflowId: "agent-vars" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.vars.label).toBe("SPEC");

    const prompt = (await h.prompts()).find((p) => p.text.includes("DOUBLED="));
    expect(prompt).toBeDefined();
    expect(prompt!.text).toContain("DOUBLED=6");
    // Node vars merge over the run's own vars rather than replacing them.
    expect(prompt!.text).toContain("LABEL=SPEC");
    // No "=" prefix, so the value is passed through untouched.
    expect(prompt!.text).toContain("LITERAL=plain text");
  }, 60_000);
});
