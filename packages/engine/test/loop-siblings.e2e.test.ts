/**
 * Regression for issue #32: each `loop` iteration is a child run, so iteration N could not
 * read what iteration N-1 produced - a review-then-fix loop handed the builder nothing.
 * Artifact visibility now includes earlier, already-finished siblings.
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
id: fix-loop
name: Review then fix
version: "1"
start: s
nodes:
  s: { type: start }
  fix:
    type: loop
    mode: while
    condition: "iteration < 2"
    maxIterations: 2
    body:
      graph:
        start: bs
        nodes:
          bs: { type: start }
          build:
            type: agent
            agent: scripted
            prompt: |
              Iteration {{ iteration }}.
              {{#if inputs.feedback}}FEEDBACK: {{ inputs.feedback.content }}{{/if}}
            inputs:
              - { kind: review, as: feedback, required: false }
            produces:
              - { kind: code, path: ".orca/work/code.md" }
          review:
            type: agent
            agent: scripted
            prompt: "Review iteration {{ iteration }}."
            produces:
              - { kind: review, path: ".orca/work/review.md" }
          be: { type: end, outcome: success }
        edges:
          - { from: bs, to: build }
          - { from: build, to: review }
          - { from: review, to: be }
  e: { type: end, outcome: success }
edges: [{ from: s, to: fix }, { from: fix, to: e }]
`;

describe("loop iterations see earlier siblings", () => {
  it("hands iteration 1's review to iteration 2's builder", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow, "fix-loop.yaml"));
    const h = await harness(
      { kinds: { code: [{ body: "CODE-{n}" }], review: [{ body: "REVIEW-{n}" }] } },
      { workflows },
    );
    dirs.push(h.dir);

    const state = await h.orchestrator.startAndRun({ workflowId: "fix-loop" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");

    const builds = (await h.prompts()).filter((p) => p.text.includes("Iteration "));
    expect(builds).toHaveLength(2);
    // Nothing precedes the first iteration, so its optional input stays unresolved ...
    expect(builds[0]!.text).not.toContain("FEEDBACK:");
    // ... while the second one is handed the sibling iteration's review.
    expect(builds[1]!.text).toContain("FEEDBACK:");
    expect(builds[1]!.text).toContain("REVIEW-1");

    // The sibling is visible for versioning too: the second review supersedes the first.
    const loopStep = state.steps[state.stepOrder[1]!]!;
    expect(loopStep.childRunIds).toHaveLength(2);
    const second = await h.orchestrator.getState(loopStep.childRunIds[1]!);
    const review = Object.values(second.artifacts).find((a) => a.kind === "review")!;
    expect(review.version).toBe(2);
    // The builder's read is recorded as lineage on what it produced.
    const first = await h.orchestrator.getState(loopStep.childRunIds[0]!);
    const firstReview = Object.values(first.artifacts).find((a) => a.kind === "review")!;
    const code = Object.values(second.artifacts).find((a) => a.kind === "code")!;
    expect(code.parents).toContain(firstReview.id);
  }, 60_000);
});
