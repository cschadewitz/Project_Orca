/**
 * Regression for issue #4: a missing optional input must not shift `as`
 * aliases onto the wrong artifact when rendering the prompt.
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
id: alias-inputs
name: Optional input aliases
version: "1"
start: start
nodes:
  start: { type: start }
  seed:
    type: agent
    agent: { role: builder }
    prompt: "Write the spec and the review."
    produces:
      - { kind: spec, path: ".orca/work/spec.md" }
      - { kind: review, path: ".orca/work/review.md" }
  consume:
    type: agent
    agent: { role: builder }
    prompt: |
      {{#if inputs.primary}}PRIMARY: {{ inputs.primary.content }}{{/if}}
      {{#if inputs.tests}}TESTS: {{ inputs.tests.content }}{{/if}}
      {{#if inputs.feedback}}FEEDBACK: {{ inputs.feedback.content }}{{/if}}
    inputs:
      - { kind: spec, as: primary }
      - { name: testReport, as: tests, required: false }
      - { kind: review, as: feedback, required: false }
    produces:
      - { kind: note, path: ".orca/work/note.md" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: seed }
  - { from: seed, to: consume }
  - { from: consume, to: done }
`;

describe("optional input aliases", () => {
  it("keeps `as` aliases paired with their refs when an optional input is missing", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow, "alias-inputs.yaml"));
    const h = await harness(
      {
        kinds: {
          spec: [{ data: { status: "ready" }, body: "SPEC-BODY" }],
          review: [{ data: { status: "done" }, body: "REVIEW-BODY" }],
          note: [{ data: { status: "done" }, body: "noted" }],
        },
      },
      { workflows },
    );
    dirs.push(h.dir);
    const state = await h.orchestrator.startAndRun({ workflowId: "alias-inputs" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");

    const prompts = await h.prompts();
    const consume = prompts.find((p) => p.text.includes("PRIMARY:"));
    expect(consume).toBeDefined();
    expect(consume!.text).toContain("PRIMARY:");
    expect(consume!.text).toContain("SPEC-BODY");
    // testReport never existed, so its alias must stay empty ...
    expect(consume!.text).not.toContain("TESTS:");
    // ... and the review must land under its own alias, not the one before it.
    expect(consume!.text).toContain("FEEDBACK:");
    expect(consume!.text).toContain("REVIEW-BODY");

    // Lineage only lists inputs that actually resolved.
    const note = Object.values(state.artifacts).find((a) => a.kind === "note")!;
    const parentKinds = note.parents.map((id) => state.artifacts[id]!.kind).sort();
    expect(parentKinds).toEqual(["review", "spec"]);

    // Issue #15: the step records what it actually read, even though `step.started` is
    // appended before the executor resolves inputs.
    const consumeStep = Object.values(state.steps).find((s) => s.nodeId === "consume")!;
    const inputKinds = consumeStep.inputArtifactIds.map((id) => state.artifacts[id]!.kind).sort();
    expect(inputKinds).toEqual(["review", "spec"]);
    const seedStep = Object.values(state.steps).find((s) => s.nodeId === "seed")!;
    expect(seedStep.inputArtifactIds).toEqual([]);
  }, 60_000);
});
