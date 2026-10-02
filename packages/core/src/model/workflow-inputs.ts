/**
 * Typed workflow launch inputs (#330): the optional `inputSchema` a workflow declares beside
 * its informational `inputs` descriptions.
 *
 * A declaration says what a *launch var* must look like - its type, whether it is required,
 * its default and its constraints. These are the values a run starts with (`run.created`'s
 * `vars`), not an agent node's artifact `inputs` and not the answer to a human-input gate;
 * those are validated where they are produced. `validateWorkflowInputs`
 * (`workflow/inputs.ts`) applies a declaration to a launch.
 *
 * The declaration language is deliberately small and closed: a field the parser does not know
 * is an authoring error rather than a constraint silently ignored, so a typo in `requried`
 * fails at load time instead of admitting a run it was meant to refuse.
 */
import { z } from "zod";
import { checkInputValue } from "../workflow/inputs.js";

export const WORKFLOW_INPUT_TYPES = ["string", "number", "integer", "boolean", "object", "array"] as const;
export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];

/** A value an `enum` may list. Structured values are not enumerable. */
export type WorkflowInputEnumValue = string | number | boolean;

/** One declared input, or one property/item of a structured one. */
export interface WorkflowInputDeclaration {
  type: WorkflowInputType;
  description?: string | undefined;
  /** The resolved value must be present (a workflow `vars` value or a default counts). */
  required?: boolean | undefined;
  /** Applied when neither the workflow's `vars` nor the launch supplies the input. Top level only. */
  default?: unknown;
  /** `null` is accepted as the value. Otherwise `null` is a type error. */
  nullable?: boolean | undefined;
  /**
   * The value (and default) must never reach a diagnostic, a log or discovery metadata.
   * Inherited by every property and item beneath it. Prefer declaring a *reference* to a
   * secret (an environment variable name, a vault path) over passing the secret itself.
   */
  sensitive?: boolean | undefined;
  enum?: WorkflowInputEnumValue[] | undefined;
  /** `string`: length bounds and an unanchored regular expression (`u` flag). */
  minLength?: number | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  /** `number` / `integer`: inclusive bounds. */
  minimum?: number | undefined;
  maximum?: number | undefined;
  /** `array`: the declaration every item must satisfy, and length bounds. */
  items?: WorkflowInputDeclaration | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  /** `object`: declared properties, and whether others are allowed (default true). */
  properties?: Record<string, WorkflowInputDeclaration> | undefined;
  additionalProperties?: boolean | undefined;
}

/**
 * What happens to a launch var that is neither declared nor one of the workflow's own `vars`.
 * `allow` (the default) passes it through silently - a child run inherits every var of its
 * parent, so anything stricter has to be asked for. `warn` passes it through with a warning;
 * `reject` refuses the launch.
 */
export const WorkflowInputUnknownPolicySchema = z.enum(["allow", "warn", "reject"]);
export type WorkflowInputUnknownPolicy = z.infer<typeof WorkflowInputUnknownPolicySchema>;

export interface WorkflowInputSchema {
  /** Declared inputs by var name. */
  fields: Record<string, WorkflowInputDeclaration>;
  unknown?: WorkflowInputUnknownPolicy | undefined;
}

const count = z.number().int().nonnegative();
const EnumValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const DeclarationShape: z.ZodType<WorkflowInputDeclaration> = z.lazy(() =>
  z
    .strictObject({
      type: z.enum(WORKFLOW_INPUT_TYPES),
      description: z.string().optional(),
      required: z.boolean().optional(),
      default: z.unknown().optional(),
      nullable: z.boolean().optional(),
      sensitive: z.boolean().optional(),
      enum: z.array(EnumValueSchema).min(1).optional(),
      minLength: count.optional(),
      maxLength: count.optional(),
      pattern: z.string().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      items: DeclarationShape.optional(),
      minItems: count.optional(),
      maxItems: count.optional(),
      properties: z.record(z.string().min(1), DeclarationShape).optional(),
      additionalProperties: z.boolean().optional(),
    })
    .superRefine((d, ctx) => {
      for (const { path, message } of declarationProblems(d)) ctx.addIssue({ code: "custom", path, message });
    }),
);

/** A single declaration, as it may appear anywhere in a schema. Nested defaults are refused below. */
export const WorkflowInputDeclarationSchema = DeclarationShape;

export const WorkflowInputSchemaSchema: z.ZodType<WorkflowInputSchema> = z
  .strictObject({
    fields: z.record(z.string().min(1), DeclarationShape),
    unknown: WorkflowInputUnknownPolicySchema.optional(),
  })
  .superRefine((s, ctx) => {
    for (const [name, decl] of Object.entries(s.fields)) {
      for (const path of nestedDefaults(decl, []))
        ctx.addIssue({
          code: "custom",
          path: ["fields", name, ...path, "default"],
          message: "defaults are only supported on top-level inputs",
        });
      if (decl.default === undefined) continue;
      // A default that its own declaration would refuse makes every launch that relies on it fail.
      const errors: { path: string; message: string }[] = [];
      checkInputValue(decl, decl.default, `default`, errors, decl.sensitive === true);
      for (const e of errors)
        ctx.addIssue({ code: "custom", path: ["fields", name, "default"], message: `${e.path}: ${e.message}` });
    }
  });

type Problem = { path: (string | number)[]; message: string };

/** Constraints that cannot apply to the declared type, or that contradict each other. */
function declarationProblems(d: WorkflowInputDeclaration): Problem[] {
  const out: Problem[] = [];
  const only = (keys: (keyof WorkflowInputDeclaration)[], types: WorkflowInputType[]) => {
    if (types.includes(d.type)) return;
    for (const k of keys)
      if (d[k] !== undefined) out.push({ path: [k], message: `'${k}' does not apply to type '${d.type}'` });
  };
  only(["minLength", "maxLength", "pattern"], ["string"]);
  only(["minimum", "maximum"], ["number", "integer"]);
  only(["items", "minItems", "maxItems"], ["array"]);
  only(["properties", "additionalProperties"], ["object"]);
  if (d.enum && (d.type === "object" || d.type === "array"))
    out.push({ path: ["enum"], message: `'enum' does not apply to type '${d.type}'` });
  else
    d.enum?.forEach((v, i) => {
      const ok =
        d.type === "string"
          ? typeof v === "string"
          : d.type === "boolean"
            ? typeof v === "boolean"
            : d.type === "integer"
              ? Number.isInteger(v)
              : typeof v === "number";
      if (!ok) out.push({ path: ["enum", i], message: `enum value is not of type '${d.type}'` });
    });
  const order = (lo: keyof WorkflowInputDeclaration, hi: keyof WorkflowInputDeclaration) => {
    const a = d[lo];
    const b = d[hi];
    if (typeof a === "number" && typeof b === "number" && a > b)
      out.push({ path: [lo], message: `'${lo}' is greater than '${hi}'` });
  };
  order("minLength", "maxLength");
  order("minimum", "maximum");
  order("minItems", "maxItems");
  if (d.pattern !== undefined) {
    try {
      new RegExp(d.pattern, "u");
    } catch {
      out.push({ path: ["pattern"], message: "'pattern' is not a valid regular expression" });
    }
  }
  return out;
}

/** Paths (relative to `decl`) of declarations below the top level that set a `default`. */
function nestedDefaults(decl: WorkflowInputDeclaration, at: (string | number)[]): (string | number)[][] {
  const out: (string | number)[][] = [];
  const visit = (d: WorkflowInputDeclaration, path: (string | number)[]) => {
    if (d.default !== undefined) out.push(path);
    nestedDefaults(d, path).forEach((p) => out.push(p));
  };
  if (decl.items) visit(decl.items, [...at, "items"]);
  for (const [k, d] of Object.entries(decl.properties ?? {})) visit(d, [...at, "properties", k]);
  return out;
}

/**
 * The declaration as discovery may show it: a sensitive input keeps its type, description
 * and constraints but loses its `default` and `enum`, which are values, at every depth.
 */
export function redactWorkflowInputSchema(schema: WorkflowInputSchema): WorkflowInputSchema {
  const fields = Object.fromEntries(
    Object.entries(schema.fields).map(([name, decl]) => [name, redactDeclaration(decl, false)]),
  );
  return { ...schema, fields };
}

function redactDeclaration(decl: WorkflowInputDeclaration, inherited: boolean): WorkflowInputDeclaration {
  const sensitive = inherited || decl.sensitive === true;
  const { default: dflt, enum: values, items, properties, ...rest } = decl;
  const out: WorkflowInputDeclaration = { ...rest };
  if (!sensitive && !containsSensitiveInput(decl) && dflt !== undefined) out.default = dflt;
  if (!sensitive && values !== undefined) out.enum = values;
  if (items) out.items = redactDeclaration(items, sensitive);
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([k, d]) => [k, redactDeclaration(d, sensitive)]),
    );
  }
  return out;
}

/** Whether a value contains any sensitive declaration, including object properties and array items. */
function containsSensitiveInput(decl: WorkflowInputDeclaration): boolean {
  return (
    decl.sensitive === true ||
    (decl.items !== undefined && containsSensitiveInput(decl.items)) ||
    Object.values(decl.properties ?? {}).some(containsSensitiveInput)
  );
}

/** Top-level vars containing sensitive declarations; omit the whole value from discovery. */
export function sensitiveInputNames(schema: WorkflowInputSchema | undefined): string[] {
  if (!schema) return [];
  return Object.entries(schema.fields)
    .filter(([, d]) => containsSensitiveInput(d))
    .map(([name]) => name);
}
