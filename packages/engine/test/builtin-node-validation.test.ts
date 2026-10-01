/** Builtin field failures agree at load time and runtime, before any context services are used. */
import { describe, expect, it } from "vitest";
import { parseWorkflow, validateWorkflow, type NodeDef } from "@orca/core";
import { builtinExecutors, completed, type StepContext } from "../src/index.js";

const executors = builtinExecutors();
const types = [
  "plan-register",
  "decision-matrix",
  "plan-schedule",
  "plan-dispatch",
  "plan-await",
  "materialize-work-items",
];

function definition(node: Record<string, unknown>) {
  return parseWorkflow(
    JSON.stringify({
      id: "builtin",
      name: "Builtin",
      start: "s",
      nodes: { s: { type: "start" }, check: node, e: { type: "end" } },
      edges: [
        { from: "s", to: "check" },
        { from: "check", to: "e" },
      ],
    }),
  );
}

const invalid: [string, string, unknown][] = [
  ["plan-register", "artifact", 12],
  ["plan-register", "plan", false],
  ["plan-register", "planName", []],
  ["decision-matrix", "artifact", false],
  ["decision-matrix", "decision", {}],
  ["plan-schedule", "plan", 12],
  ["plan-schedule", "artifactPath", false],
  ["plan-schedule", "record", "false"],
  ["plan-schedule", "policy", []],
  ["plan-dispatch", "workflow", 12],
  ["plan-dispatch", "workflow", ""],
  ["plan-dispatch", "concurrency", "four"],
  ["plan-dispatch", "concurrency", 0],
  ["plan-dispatch", "concurrency", 1.5],
  ["plan-dispatch", "scope", "all"],
  ["plan-dispatch", "leavesOnly", "false"],
  ["plan-dispatch", "failFast", 1],
  ["plan-dispatch", "onWaiting", "forever"],
  ["plan-dispatch", "pollMs", 0],
  ["plan-dispatch", "pollMs", "100"],
  ["plan-dispatch", "waitTimeoutMs", -1],
  ["plan-dispatch", "waitTimeoutMs", 0.5],
  ["plan-dispatch", "policy", "fifo"],
  ["plan-await", "phase", 1],
  ["plan-await", "phase", ""],
  ["plan-await", "pollMs", -1],
  ["plan-await", "timeoutMs", 0],
  ["plan-await", "timeoutMs", "200"],
  ["materialize-work-items", "artifact", []],
  ["materialize-work-items", "artifact", ""],
];

describe("builtin custom-node validation", () => {
  it.each(types)("accepts omitted defaults for %s without mutating the definition", (type) => {
    const def = definition({ type: `custom:${type}`, meta: { owner: "test" }, extra: "extension" });
    const before = structuredClone(def);
    expect(validateWorkflow(def, { validateCustomNode: (node) => executors.validateNode(node) })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(def).toEqual(before);
  });

  it.each(invalid)("rejects %s.%s = %j before using runtime services", async (type, field, value) => {
    const def = definition({ type: `custom:${type}`, [field]: value });
    const node = def.nodes.check!;
    const validation = validateWorkflow(def, { validateCustomNode: (n) => executors.validateNode(n) });
    expect(validation.ok).toBe(false);
    const issues = executors.validateNode(node)!.errors!;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.path === field)).toBe(true);
    expect(validation.errors).toEqual(
      issues.map((issue) => ({
        path: `workflow(builtin).nodes.check.${issue.path}`,
        message: issue.message,
      })),
    );
    // Intentionally no services: parsing must finish before artifact, store, plan or agent access.
    expect(await executors.get(node.type)!.execute({ node, nodeId: "check" } as StepContext)).toMatchObject({
      kind: "failed",
      retryable: false,
      error: { code: "WORKFLOW_INVALID", details: { issues } },
    });
  });

  it.each(types)("does not treat explicit null as an omission for %s", (type) => {
    const field =
      type === "plan-await"
        ? "phase"
        : type === "plan-dispatch"
          ? "scope"
          : type === "plan-schedule"
            ? "record"
            : "artifact";
    const node = definition({ type: `custom:${type}`, [field]: null }).nodes.check!;
    expect(executors.validateNode(node)?.errors).toEqual([{ path: field, message: expect.any(String) }]);
  });

  it.each(["plan-schedule", "plan-dispatch"])("checks nested %s policy fields", (type) => {
    const badPolicy = {
      strategy: "fast",
      concurrency: "two",
      riskAppetite: "none",
      holdAboveAppetite: "yes",
      mitigateFirst: 1,
      orderSoftDependencies: null,
      weights: { criticalPath: -1, dependents: "two", risk: false, mitigation: -2, priority: null, age: -1 },
    };
    const node = definition({ type: `custom:${type}`, policy: badPolicy }).nodes.check!;
    expect(executors.validateNode(node)?.errors?.map((i) => i.path)).toEqual([
      "policy.strategy",
      "policy.weights.criticalPath",
      "policy.weights.dependents",
      "policy.weights.risk",
      "policy.weights.mitigation",
      "policy.weights.priority",
      "policy.weights.age",
      "policy.concurrency",
      "policy.riskAppetite",
      "policy.holdAboveAppetite",
      "policy.mitigateFirst",
      "policy.orderSoftDependencies",
    ]);
  });

  it("prefixes builtin failures in nested graphs once and leaves warnings non-blocking", () => {
    const registry = builtinExecutors().register({
      type: "custom:warning",
      validate: () => ({ warnings: [{ path: "hint", message: "Advisory" }] }),
      async execute() {
        return completed();
      },
    });
    const graph = definition({ type: "custom:plan-dispatch", policy: { weights: { age: -1 } } });
    const def = definition({ type: "parallel", branches: { first: { graph } } });
    const validate = () => validateWorkflow(def, { validateCustomNode: (node) => registry.validateNode(node) });
    expect(validate().errors).toEqual([
      {
        path: "workflow(builtin).nodes.check.branches.first.nodes.check.policy.weights.age",
        message: expect.any(String),
      },
    ]);
    const nested = def.nodes.check;
    if (nested?.type !== "parallel") throw new Error("expected parallel");
    const branch = nested.branches!.first!;
    if (!("graph" in branch)) throw new Error("expected graph");
    branch.graph.nodes.check = { type: "custom:warning" };
    expect(validate()).toEqual({
      ok: true,
      errors: [],
      warnings: [
        {
          path: "workflow(builtin).nodes.check.branches.first.nodes.check.hint",
          message: "Advisory",
        },
      ],
    });
  });

  it.each([
    { type: "custom:plan-register", plan: "{{ vars.plan }}", planName: "Plan {{ vars.title }}" },
    { type: "custom:decision-matrix", decision: "{{ vars.decision.key }}" },
    { type: "custom:plan-schedule", plan: "{{ vars.plan }}", artifactPath: "{{ vars.path }}/schedule.md" },
    { type: "custom:plan-schedule", artifactPath: "", record: false, policy: {} },
    { type: "custom:plan-dispatch", waitTimeoutMs: 0, leavesOnly: false, failFast: false },
    { type: "custom:plan-await", phase: "custom-phase" },
  ])("preserves supported strings and sentinel values: %j", (node) => {
    const def = definition(node);
    def.edges[0]!.when = "vars.enabled == true";
    expect(validateWorkflow(def, { validateCustomNode: (n) => executors.validateNode(n) }).ok).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite numbers: %s",
    (concurrency) => {
      const node: NodeDef = { type: "custom:plan-dispatch", concurrency };
      expect(executors.validateNode(node)?.errors?.[0]?.path).toBe("concurrency");
    },
  );
});
