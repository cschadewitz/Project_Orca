/**
 * Launch-input validation (#330): a workflow's `inputSchema` applied to the vars a run would
 * start with. Pure and node-free - it is re-exported through `model/workflow.ts`, so it reaches
 * `@orca/core/schemas` and every client, and the engine's admission and a daemon's preflight
 * run exactly this function rather than two copies of it.
 *
 * Resolution is declaration defaults, then the workflow's `vars`, then the supplied launch
 * vars, later sources winning. Nothing is coerced: `"3"` is not a number, `"true"` is not a
 * boolean. No source is mutated. Messages say what is wrong and never what the value was.
 */
import type { WorkflowInputDeclaration } from "../model/workflow-inputs.js";
import type { WorkflowDefinition } from "../model/workflow.js";
import type { ValidationIssue, ValidationResult } from "./validate.js";

export interface WorkflowInputsResult {
  validation: ValidationResult;
  /**
   * The resolved vars a run starts with. Empty when `validation.ok` is false: a caller must
   * check `ok` and never admit a launch on these.
   */
  vars: Record<string, unknown>;
}

/** Validate `suppliedVars` against `definition.inputSchema`, resolving defaults and workflow vars beneath them. */

const SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function validateWorkflowInputs(
  definition: Pick<WorkflowDefinition, "vars" | "inputSchema">,
  suppliedVars: Record<string, unknown> = {},
): WorkflowInputsResult {
  const schema = definition.inputSchema;
  // No declaration: the legacy merge, exactly as runs have always started.
  if (!schema)
    return { validation: { ok: true, errors: [], warnings: [] }, vars: { ...definition.vars, ...suppliedVars } };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const vars = Object.create(null) as Record<string, unknown>;
  for (const [name, decl] of Object.entries(schema.fields))
    if (decl.default !== undefined) vars[name] = structuredClone(decl.default);
  // An explicit `undefined` is absence, not an override of a default.
  for (const source of [definition.vars, suppliedVars])
    for (const [name, value] of Object.entries(source)) if (value !== undefined) vars[name] = value;

  for (const [name, decl] of Object.entries(schema.fields)) {
    const path = `vars.${name}`;
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) {
      if (decl.required) errors.push({ path, message: "is required" });
      continue;
    }
    checkInputValue(decl, value, path, errors, decl.sensitive === true);
  }

  const policy = schema.unknown ?? "allow";
  if (policy !== "allow")
    for (const name of Object.keys(suppliedVars)) {
      if (Object.hasOwn(schema.fields, name) || Object.hasOwn(definition.vars, name)) continue;
      if (suppliedVars[name] === undefined) continue;
      (policy === "reject" ? errors : warnings).push({
        path: `vars.${name}`,
        message: policy === "reject" ? "is not a declared input" : "is not a declared input; it is passed through",
      });
    }

  const validation: ValidationResult = { ok: errors.length === 0, errors, warnings };
  return { validation, vars: validation.ok ? vars : {} };
}

/**
 * Check one value against one declaration, appending an issue per failure to `errors`.
 * `sensitive` is inherited from an enclosing declaration and keeps the declared enum out of
 * the message too, since for a secret-bearing input the allowed values are themselves secret.
 */
export function checkInputValue(
  decl: WorkflowInputDeclaration,
  value: unknown,
  path: string,
  errors: ValidationIssue[],
  sensitive = false,
): void {
  const fail = (message: string, at = path): void => void errors.push({ path: at, message });
  const secret = sensitive || decl.sensitive === true;
  if (value === null) {
    if (!decl.nullable) fail("must not be null");
    return;
  }
  const actual = kindOf(value);
  switch (decl.type) {
    case "string": {
      if (typeof value !== "string") return fail(`expected string, got ${actual}`);
      if (decl.minLength !== undefined && value.length < decl.minLength)
        fail(`must be at least ${decl.minLength} characters`);
      if (decl.maxLength !== undefined && value.length > decl.maxLength)
        fail(`must be at most ${decl.maxLength} characters`);
      if (decl.pattern !== undefined && !new RegExp(decl.pattern, "u").test(value))
        fail(secret ? "does not match the declared pattern" : `must match /${decl.pattern}/`);
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(`expected ${decl.type}, got ${actual}`);
      if (decl.type === "integer" && !Number.isInteger(value)) return fail("expected integer, got a fraction");
      if (decl.minimum !== undefined && value < decl.minimum) fail(`must be at least ${decl.minimum}`);
      if (decl.maximum !== undefined && value > decl.maximum) fail(`must be at most ${decl.maximum}`);
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") return fail(`expected boolean, got ${actual}`);
      break;
    case "secret":
      // The id of a configured secret (#363), never the credential itself.
      if (typeof value !== "string") return fail(`expected the id of a configured secret, got ${actual}`);
      if (!SECRET_ID.test(value)) return fail("is not a secret id (letters, digits, '.', '_' and '-')");
      break;
    case "array": {
      if (!Array.isArray(value)) return fail(`expected array, got ${actual}`);
      if (decl.minItems !== undefined && value.length < decl.minItems)
        fail(`must have at least ${decl.minItems} items`);
      if (decl.maxItems !== undefined && value.length > decl.maxItems) fail(`must have at most ${decl.maxItems} items`);
      if (decl.items) value.forEach((item, i) => checkInputValue(decl.items!, item, `${path}[${i}]`, errors, secret));
      break;
    }
    case "object": {
      if (actual !== "object") return fail(`expected object, got ${actual}`);
      const record = value as Record<string, unknown>;
      const declared = decl.properties ?? {};
      for (const [key, prop] of Object.entries(declared)) {
        const v = Object.hasOwn(record, key) ? record[key] : undefined;
        if (v === undefined) {
          if (prop.required) fail("is required", `${path}.${key}`);
        } else checkInputValue(prop, v, `${path}.${key}`, errors, secret);
      }
      if (decl.additionalProperties === false)
        for (const key of Object.keys(record))
          if (!Object.hasOwn(declared, key)) fail("is not a declared property", secret ? path : `${path}.${key}`);
      break;
    }
  }
  if (decl.enum && !decl.enum.some((e) => e === value))
    fail(secret ? "is not one of the declared values" : `must be one of: ${decl.enum.map(String).join(", ")}`);
}

/** The JSON kind of a value, for a message that names the type and never the value. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null ? "object" : "non-plain object";
  }
  return typeof value;
}
