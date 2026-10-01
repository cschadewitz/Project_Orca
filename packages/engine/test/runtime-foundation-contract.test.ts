/** Existing validation seams and valid omissions the independent #314/#330 branches preserve. */
import { describe, expect, it } from "vitest";
import { parseWorkflow, validateWorkflow } from "@orca/core";
import { builtinExecutors, completed } from "../src/index.js";

describe("runtime foundation validation contracts", () => {
  it("keeps legacy input descriptions, vars and valid builtin omissions", () => {
    const def = parseWorkflow(`
id: compatibility
name: compatibility
inputs:
  count: Number of items
vars:
  count: 2
start: s
nodes:
  s: { type: start }
  wait: { type: "custom:plan-await" }
  matrix: { type: "custom:decision-matrix" }
  e: { type: end }
edges:
  - { from: s, to: wait }
  - { from: wait, to: matrix }
  - { from: matrix, to: e }
`);
    expect(def.inputs).toEqual({ count: "Number of items" });
    expect(def.vars).toEqual({ count: 2 });
    const executors = builtinExecutors();
    expect(validateWorkflow(def, { validateCustomNode: (node) => executors.validateNode(node) })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it("prefixes node-relative nested diagnostics exactly once", () => {
    const executors = builtinExecutors().register({
      type: "custom:contract-fixture",
      validate: () => ({
        errors: [
          { path: "field", message: "Invalid field" },
          { path: ".other", message: "Invalid other field" },
          { path: "[0]", message: "Invalid entry" },
        ],
        warnings: [{ message: "Whole-node warning" }],
      }),
      async execute() {
        return completed();
      },
    });
    const def = parseWorkflow(`
id: nested-contract
name: nested-contract
start: s
nodes:
  s: { type: start }
  group:
    type: parallel
    branches:
      first:
        graph:
          start: s
          nodes:
            s: { type: start }
            check: { type: "custom:contract-fixture" }
          edges:
            - { from: s, to: check }
  e: { type: end }
edges:
  - { from: s, to: group }
  - { from: group, to: e }
`);
    const prefix = "workflow(nested-contract).nodes.group.branches.first.nodes.check";
    expect(validateWorkflow(def, { validateCustomNode: (node) => executors.validateNode(node) })).toEqual({
      ok: false,
      errors: [
        { path: `${prefix}.field`, message: "Invalid field" },
        { path: `${prefix}.other`, message: "Invalid other field" },
        { path: `${prefix}[0]`, message: "Invalid entry" },
      ],
      warnings: [{ path: prefix, message: "Whole-node warning" }],
    });
  });
});
