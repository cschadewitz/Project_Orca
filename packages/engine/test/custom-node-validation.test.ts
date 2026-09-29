/**
 * Two load-time checks the engine contributes to `validateWorkflow`:
 *
 * - #308: a registered executor's `validate(node)` is what `NodeExecutorRegistry.validateNode`
 *   hands the validator for a `custom:*` node, and a type nobody registered is a warning
 *   that says the fields went unchecked rather than an error.
 * - #309: `validateArtifact` reads `requiredFields` and `fieldValues` as dotted paths into
 *   the artifact's data, the same path a decision's `field` reads with.
 */
import { describe, expect, it } from "vitest";
import { parseWorkflow, validateWorkflow, type ArtifactSpec } from "@orca/core";
import { builtinExecutors, completed, validateArtifact } from "../src/index.js";

describe("NodeExecutorRegistry.validateNode", () => {
  it("asks the node's executor, warns about a type nobody registered, and has no opinion on a builtin", () => {
    const executors = builtinExecutors().register({
      type: "custom:strict",
      validate: (node) => ("field" in node ? {} : { errors: [{ path: "field", message: "Required" }] }),
      async execute() {
        return completed();
      },
    });
    const def = parseWorkflow(`
id: checked
name: checked
start: s
nodes:
  s: { type: start }
  ok: { type: "custom:strict", field: 1 }
  bad: { type: "custom:strict" }
  nobody: { type: "custom:nobody" }
  wait: { type: "custom:plan-await", phase: build }
  e: { type: end }
edges:
  - { from: s, to: ok }
  - { from: ok, to: bad }
  - { from: bad, to: nobody }
  - { from: nobody, to: wait }
  - { from: wait, to: e }
`);
    const r = validateWorkflow(def, { validateCustomNode: (n) => executors.validateNode(n) });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ path: "workflow(checked).nodes.bad.field", message: "Required" }]);
    expect(r.warnings).toEqual([
      {
        path: "workflow(checked).nodes.nobody",
        message: "no executor is registered for 'custom:nobody'; its fields were not checked",
      },
    ]);
  });
});

describe("validateArtifact", () => {
  const spec: ArtifactSpec = {
    kind: "evaluation",
    path: "evaluation.md",
    required: true,
    validate: {
      requiredFields: ["status", "answers.conflict.choice"],
      fieldValues: { status: ["ok"], "answers.conflict.choice": ["consistent", "contradiction"] },
    },
  };

  it("reads a dotted field as a path into the data and a plain key as the top-level field (#309)", () => {
    const ok = { status: "ok", answers: { conflict: { choice: "consistent" } } };
    expect(validateArtifact(spec, ok, "")).toBeUndefined();

    expect(validateArtifact(spec, { status: "ok", answers: { conflict: {} } }, "")).toBe(
      "front matter field 'answers.conflict.choice' is missing",
    );
    expect(validateArtifact(spec, { status: "ok", answers: "none" }, "")).toBe(
      "front matter field 'answers.conflict.choice' is missing",
    );
    expect(validateArtifact(spec, { status: "ok", answers: { conflict: { choice: "maybe" } } }, "")).toBe(
      "front matter field 'answers.conflict.choice' must be one of consistent, contradiction (got 'maybe')",
    );
    expect(validateArtifact(spec, { ...ok, status: "failed" }, "")).toBe(
      "front matter field 'status' must be one of ok (got 'failed')",
    );
  });
});
