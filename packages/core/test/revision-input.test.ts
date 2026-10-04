/** Declaration contract: explicit direct human branches only, never eventual/cross-child destination guesses. */
import { describe, expect, it } from "vitest";
import { WorkflowDefinitionSchema } from "../src/index.js";
import { validateRevisionCapability, RevisionCapabilitySchema } from "../src/model/revision-input.js";
const declaration = {
  actionId: "changes",
  destinationNodeId: "build",
  payload: { kind: "text", maxBytes: 1024 },
  composition: "replace-revision-slot",
};
const graph = (gate: Record<string, unknown> = {}) =>
  WorkflowDefinitionSchema.parse({
    id: "review",
    name: "Review",
    start: "review",
    nodes: {
      review: {
        type: "gate",
        question: "Ready?",
        options: ["changes", "approve"],
        ...gate,
      },
      build: { type: "agent", agent: "builder", prompt: "Build" },
      done: { type: "end" },
    },
    edges: [
      { from: "review", to: "build", when: "choice == 'changes'" },
      { from: "review", to: "done", when: "choice == 'approve'" },
    ],
  });
describe("revision declaration", () => {
  it("accepts an explicit direct branch to an agent", () =>
    expect(validateRevisionCapability(graph(), "review", declaration).ok).toBe(true));
  it.each([
    {
      name: "explicit revision option",
      options: ["approve", "changes"],
      autoOption: "changes",
    },
    { name: "implicit first revision option", options: ["changes", "approve"] },
    {
      name: "object option id rather than label",
      options: [
        { id: "changes", label: "Request changes" },
        { id: "approve", label: "Approve" },
      ],
    },
  ])("rejects automatic selection of the $name", ({ options, ...fixture }) => {
    const { name: _name, ...gate } = fixture;
    for (const autoApproveWhen of ["true", "false", "vars.allowAutoApproval"]) {
      const result = validateRevisionCapability(graph({ options, ...gate, autoApproveWhen }), "review", declaration);
      expect(result).toEqual({
        ok: false,
        errors: [
          {
            path: "nodes.review.revision",
            message: "revision action cannot be selected automatically",
          },
        ],
        warnings: [],
      });
    }
  });
  it.each([
    {
      name: "explicit non-revision override",
      options: ["changes", "approve"],
      autoOption: "approve",
    },
    {
      name: "implicit first non-revision option",
      options: ["approve", "changes"],
    },
  ])("accepts the $name", ({ name: _name, ...gate }) => {
    expect(validateRevisionCapability(graph({ ...gate, autoApproveWhen: "true" }), "review", declaration).ok).toBe(
      true,
    );
  });
  it("allows an inert autoOption when no automatic condition is declared", () => {
    expect(validateRevisionCapability(graph({ autoOption: "changes" }), "review", declaration).ok).toBe(true);
  });
  it("refuses ambiguous branches, unsupported nodes and undeclared actions", () => {
    const g = graph();
    g.edges.push({ from: "review", to: "done" });
    expect(validateRevisionCapability(g, "review", declaration).ok).toBe(false);
    expect(validateRevisionCapability(graph(), "build", declaration).ok).toBe(false);
    expect(
      validateRevisionCapability(graph(), "review", {
        ...declaration,
        actionId: "invented",
      }).ok,
    ).toBe(false);
    expect(
      validateRevisionCapability(graph(), "review", {
        ...declaration,
        destinationNodeId: "child.build",
      }).ok,
    ).toBe(false);
  });
  it("rejects unknown declaration fields and excessive payload limits", () => {
    expect(RevisionCapabilitySchema.safeParse({ ...declaration, append: true }).success).toBe(false);
    expect(
      RevisionCapabilitySchema.safeParse({
        ...declaration,
        payload: { kind: "text", maxBytes: 65537 },
      }).success,
    ).toBe(false);
  });
});
