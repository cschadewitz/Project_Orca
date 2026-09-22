/**
 * Regression for issue #14: agent-node `vars` must honour the documented "="
 * expression prefix, in the prompt and in deliverable paths, just like `set`
 * and `subworkflow` vars do.
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
name: Agent vars expressions
version: "1"
vars: { workItem: { slug: "login-form" } }
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "Work on {{ vars.slug }} (literal {{ vars.label }}, upper {{ vars.shout }})."
    vars:
      slug: "=vars.workItem.slug"
      label: "plain-text"
      shout: "=upper(vars.workItem.slug)"
    produces:
      - { kind: note, path: ".orca/{{ vars.slug }}/note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: done }
`;

describe("agent node vars", () => {
  it("evaluates '='-prefixed vars before rendering the prompt and deliverable paths", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow, "agent-vars.yaml"));
    const h = await harness({ kinds: { note: [{ data: { status: "done" }, body: "noted" }] } }, { workflows });
    dirs.push(h.dir);

    const state = await h.orchestrator.startAndRun({ workflowId: "agent-vars" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");

    const prompt = (await h.prompts()).find((p) => p.text.includes("Work on"))!;
    expect(prompt.text).toContain("Work on login-form (literal plain-text, upper LOGIN-FORM).");
    expect(prompt.text).not.toContain("=vars.workItem.slug");

    const note = Object.values(state.artifacts).find((a) => a.kind === "note")!;
    expect(note.path?.replaceAll("\\", "/")).toContain(
      `.orca/login-form/.orca-attempts/${state.run.id}/${note.producedBy.stepRunId}/note.md`,
    );
  });
});
