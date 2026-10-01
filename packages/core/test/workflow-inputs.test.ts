/**
 * #330: typed launch inputs - the declaration's load-time rules and the pure validator that
 * admission and preflight share.
 */
import { describe, expect, it } from "vitest";
import {
  parseWorkflow,
  redactWorkflowInputSchema,
  sensitiveInputNames,
  validateWorkflowInputs,
  type WorkflowDefinition,
} from "@orca/core";
import * as schemas from "@orca/core/schemas";

const GRAPH = `
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges:
  - { from: s, to: e }
`;

function wf(extra: string): WorkflowDefinition {
  return parseWorkflow(`id: typed\nname: typed\n${extra}\n${GRAPH}`);
}

/** The `issues` a definition that fails the schema reports. */
function loadIssues(extra: string): { path: string; message: string }[] {
  try {
    wf(extra);
  } catch (e) {
    expect(e).toMatchObject({ code: "WORKFLOW_INVALID" });
    return (e as { details: { issues: { path: string; message: string }[] } }).details.issues;
  }
  throw new Error("expected the definition to be refused");
}

const TYPED = wf(`
vars:
  mode: fast
inputSchema:
  fields:
    title: { type: string, required: true, minLength: 3, maxLength: 20, pattern: "^[A-Z]" }
    count: { type: integer, default: 2, minimum: 1, maximum: 5 }
    ratio: { type: number, minimum: 0, maximum: 1 }
    dryRun: { type: boolean, default: false }
    mode: { type: string, enum: [fast, slow] }
    tags: { type: array, items: { type: string }, minItems: 1, maxItems: 3 }
    repo:
      type: object
      additionalProperties: false
      properties:
        url: { type: string, required: true }
        branches: { type: array, items: { type: string } }
    note: { type: string, nullable: true }
`);

describe("legacy input descriptions (#330)", () => {
  it("still load as documentation and check nothing", () => {
    const def = wf(`inputs:\n  title: What to build\nvars:\n  count: 1`);
    expect(def.inputs).toEqual({ title: "What to build" });
    expect(def.inputSchema).toBeUndefined();
    const result = validateWorkflowInputs(def, { count: "anything", extra: true });
    expect(result.validation).toEqual({ ok: true, errors: [], warnings: [] });
    // Exactly the merge runs have always started with.
    expect(result.vars).toEqual({ count: "anything", extra: true });
  });

  it("keeps descriptions and a declaration side by side", () => {
    const def = wf(`inputs:\n  title: What to build\ninputSchema:\n  fields:\n    title: { type: string }`);
    expect(def.inputs).toEqual({ title: "What to build" });
    expect(def.inputSchema?.fields.title).toEqual({ type: "string" });
  });

  it("reaches the browser-safe schemas subpath", () => {
    expect(schemas.validateWorkflowInputs).toBe(validateWorkflowInputs);
    expect(typeof schemas.WorkflowInputSchemaSchema.parse).toBe("function");
  });
});

describe("declarations are checked at load time", () => {
  it.each([
    ["an unknown type", `x: { type: date }`, "fields.x.type"],
    ["an unknown key (a typo)", `x: { type: string, requried: true }`, "fields.x"],
    ["a constraint for another type", `x: { type: number, pattern: "a" }`, "fields.x.pattern"],
    ["an enum on a structured type", `x: { type: object, enum: [a] }`, "fields.x.enum"],
    ["an enum value of the wrong type", `x: { type: integer, enum: [1, 1.5] }`, "fields.x.enum.1"],
    ["contradictory bounds", `x: { type: number, minimum: 5, maximum: 1 }`, "fields.x.minimum"],
    ["an invalid pattern", `x: { type: string, pattern: "(" }`, "fields.x.pattern"],
    ["a default its declaration refuses", `x: { type: integer, default: "3" }`, "fields.x.default"],
    ["a default outside its bounds", `x: { type: integer, default: 9, maximum: 5 }`, "fields.x.default"],
    [
      "a nested default",
      `x: { type: object, properties: { y: { type: string, default: a } } }`,
      "fields.x.properties.y.default",
    ],
  ])("refuses %s", (_name, field, path) => {
    const issues = loadIssues(`inputSchema:\n  fields:\n    ${field}`);
    expect(issues.map((i) => i.path)).toContain(`inputSchema.${path}`);
  });

  it("refuses an unknown unknown-key policy", () => {
    expect(loadIssues(`inputSchema:\n  unknown: ignore\n  fields: {}`).map((i) => i.path)).toContain(
      "inputSchema.unknown",
    );
  });

  it("never quotes a sensitive default it refuses", () => {
    const issues = loadIssues(
      `inputSchema:\n  fields:\n    token: { type: string, sensitive: true, minLength: 40, default: hunter2 }`,
    );
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });
});

describe("validateWorkflowInputs", () => {
  const good = { title: "Add login", repo: { url: "git@x" } };

  it("resolves defaults < workflow vars < supplied vars", () => {
    const def = wf(`
vars: { count: 3, dryRun: true }
inputSchema:
  fields:
    count: { type: integer, default: 1 }
    dryRun: { type: boolean, default: false }
    level: { type: string, default: low }`);
    expect(validateWorkflowInputs(def, { count: 4 }).vars).toEqual({ count: 4, dryRun: true, level: "low" });
    expect(validateWorkflowInputs(def).vars).toEqual({ count: 3, dryRun: true, level: "low" });
  });

  it("treats an explicit undefined as absent rather than clearing a default", () => {
    expect(validateWorkflowInputs(TYPED, { ...good, count: undefined }).vars.count).toBe(2);
  });

  it("is deterministic and mutates no source", () => {
    const supplied = { ...good, tags: ["a"] };
    const before = structuredClone({ supplied, vars: TYPED.vars, schema: TYPED.inputSchema });
    const a = validateWorkflowInputs(TYPED, supplied);
    const b = validateWorkflowInputs(TYPED, supplied);
    expect(a).toEqual(b);
    expect(a.validation.ok).toBe(true);
    expect(a.vars).toEqual({ ...good, tags: ["a"], count: 2, dryRun: false, mode: "fast" });
    expect({ supplied, vars: TYPED.vars, schema: TYPED.inputSchema }).toEqual(before);
    // A default is copied, not shared with the definition.
    const def = wf(`inputSchema:\n  fields:\n    list: { type: array, default: [a] }`);
    (validateWorkflowInputs(def).vars.list as string[]).push("b");
    expect(def.inputSchema?.fields.list?.default).toEqual(["a"]);
  });

  it("reports every failure with a field path, and returns no vars", () => {
    const result = validateWorkflowInputs(TYPED, {
      title: "no",
      count: 9,
      ratio: -0.5,
      mode: "medium",
      tags: [],
      repo: { branches: ["main", 7], extra: 1 },
      note: null,
      dryRun: null,
    });
    expect(result.vars).toEqual({});
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors).toEqual([
      { path: "vars.title", message: "must be at least 3 characters" },
      { path: "vars.title", message: "must match /^[A-Z]/" },
      { path: "vars.count", message: "must be at most 5" },
      { path: "vars.ratio", message: "must be at least 0" },
      { path: "vars.dryRun", message: "must not be null" },
      { path: "vars.mode", message: "must be one of: fast, slow" },
      { path: "vars.tags", message: "must have at least 1 items" },
      { path: "vars.repo.url", message: "is required" },
      { path: "vars.repo.branches[1]", message: "expected string, got number" },
      { path: "vars.repo.extra", message: "is not a declared property" },
    ]);
  });

  it("requires a required input that nothing supplies", () => {
    expect(validateWorkflowInputs(TYPED, { repo: { url: "u" } }).validation.errors).toEqual([
      { path: "vars.title", message: "is required" },
    ]);
  });

  it.each([
    ["a numeric string for an integer", { count: "3" }, "vars.count", "expected integer, got string"],
    ["a fraction for an integer", { count: 2.5 }, "vars.count", "expected integer, got a fraction"],
    ["a boolean string", { dryRun: "true" }, "vars.dryRun", "expected boolean, got string"],
    ["a number for a string", { title: 12345 }, "vars.title", "expected string, got number"],
    ["an array for an object", { repo: [] }, "vars.repo", "expected object, got array"],
    ["an object for an array", { tags: {} }, "vars.tags", "expected array, got object"],
    [
      "a non-finite number",
      { ratio: Number.POSITIVE_INFINITY },
      "vars.ratio",
      "expected number, got non-finite number",
    ],
  ])("does not coerce %s", (_name, vars, path, message) => {
    expect(validateWorkflowInputs(TYPED, { ...good, ...vars }).validation.errors).toEqual([{ path, message }]);
  });

  it("accepts null only where declared nullable", () => {
    expect(validateWorkflowInputs(TYPED, { ...good, note: null }).validation.ok).toBe(true);
    expect(validateWorkflowInputs(TYPED, { ...good, title: null }).validation.errors).toEqual([
      { path: "vars.title", message: "must not be null" },
    ]);
  });

  describe("unknown vars", () => {
    const declared = (policy?: string) =>
      wf(
        `vars: { internal: 1 }\ninputSchema:\n${policy ? `  unknown: ${policy}\n` : ""}  fields:\n    a: { type: string }`,
      );

    it("pass through silently by default", () => {
      const result = validateWorkflowInputs(declared(), { a: "x", inherited: true });
      expect(result.validation).toEqual({ ok: true, errors: [], warnings: [] });
      expect(result.vars).toEqual({ a: "x", internal: 1, inherited: true });
    });

    it("pass through with a warning under `warn`", () => {
      const result = validateWorkflowInputs(declared("warn"), { a: "x", inherited: true });
      expect(result.validation).toEqual({
        ok: true,
        errors: [],
        warnings: [{ path: "vars.inherited", message: "is not a declared input; it is passed through" }],
      });
      expect(result.vars.inherited).toBe(true);
    });

    it("are refused under `reject`, but the workflow's own vars are not unknown", () => {
      expect(validateWorkflowInputs(declared("reject"), { a: "x", internal: 2 }).validation.ok).toBe(true);
      expect(validateWorkflowInputs(declared("reject"), { a: "x", inherited: true }).validation.errors).toEqual([
        { path: "vars.inherited", message: "is not a declared input" },
      ]);
    });
  });

  describe("sensitive inputs", () => {
    const def = wf(`
vars: { apiKey: sk-default-secret }
inputSchema:
  fields:
    apiKey: { type: string, sensitive: true, pattern: "^sk-", enum: [sk-default-secret, sk-other-secret] }
    auth:
      type: object
      sensitive: true
      properties:
        token: { type: string, enum: [tok-secret] }
    open: { type: string, enum: [visible], default: visible }`);

    it("never echo values, patterns or allowed values in diagnostics", () => {
      const errors = validateWorkflowInputs(def, { apiKey: "pk-leaked-value", auth: { token: "tok-leaked" } })
        .validation.errors;
      expect(errors).toEqual([
        { path: "vars.apiKey", message: "does not match the declared pattern" },
        { path: "vars.apiKey", message: "is not one of the declared values" },
        { path: "vars.auth.token", message: "is not one of the declared values" },
      ]);
      expect(JSON.stringify(errors)).not.toMatch(/secret|leaked|\^sk-/);
    });

    it("are redacted from discovery at every depth", () => {
      const redacted = redactWorkflowInputSchema(def.inputSchema!);
      expect(redacted.fields.apiKey).toEqual({ type: "string", sensitive: true, pattern: "^sk-" });
      expect(redacted.fields.auth?.properties?.token).toEqual({ type: "string" });
      expect(redacted.fields.open).toEqual({ type: "string", enum: ["visible"], default: "visible" });
      expect(JSON.stringify(redacted)).not.toContain("secret");
      expect(sensitiveInputNames(def.inputSchema)).toEqual(["apiKey", "auth"]);
    });
  });
});
