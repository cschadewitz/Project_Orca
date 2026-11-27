/**
 * Agent questions (#1133, #1169): an ACP `elicitation/create` form, as ORCA shows it to a
 * person and as it checks the answer.
 *
 * An agent asks a question with a JSON Schema form (Claude's `AskUserQuestion`, Codex's
 * `request_user_input`, an MCP server's elicitation). ORCA keeps a closed subset of that
 * schema: single choice, multiple choice, text, number and yes/no fields. A form outside the
 * subset is declined rather than shown in part, and so is a form that asks for a secret or
 * has no fields at all: a form without fields is a confirmation, the shape an approval takes,
 * and an agent question is never permission authority.
 *
 * The answer to such a question is one string, like every human input's: the JSON of an
 * `ElicitationAnswer`. `parseElicitationAnswer` is the one check of it, used where the answer
 * is accepted and again before it is handed to the agent.
 *
 * Node-free: the renderer builds its form card from `ElicitationFormSchema`.
 */
import { z } from "zod";
import { OrcaError } from "../errors.js";

/** Bounds on what ORCA shows and accepts; a form beyond them is declined. */
export const ELICITATION_LIMITS = {
  fields: 20,
  options: 50,
  /** Characters in a title, description, option label or message. */
  label: 2000,
  message: 8000,
  /** Characters in one text answer. */
  text: 4000,
  /** Characters in the whole encoded answer. */
  answer: 65536,
} as const;

const label = z.string().max(ELICITATION_LIMITS.label);

export const ElicitationOptionSchema = z.strictObject({
  /** What the agent is answered with. */
  value: z.string().max(ELICITATION_LIMITS.label),
  /** What a person reads. */
  label,
  description: label.optional(),
});
export type ElicitationOption = z.infer<typeof ElicitationOptionSchema>;

const fieldBase = {
  /** The property name in the agent's schema, and the key of the answer's content. */
  key: z.string().min(1).max(200),
  title: label.optional(),
  description: label.optional(),
  required: z.boolean(),
};

export const ElicitationFieldSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...fieldBase,
    kind: z.literal("choice"),
    options: z.array(ElicitationOptionSchema).min(1).max(ELICITATION_LIMITS.options),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal("multi"),
    options: z.array(ElicitationOptionSchema).min(1).max(ELICITATION_LIMITS.options),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    default: z.array(z.string()).optional(),
  }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal("text"),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal("number"),
    integer: z.boolean(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal("boolean"),
    default: z.boolean().optional(),
  }),
]);
export type ElicitationField = z.infer<typeof ElicitationFieldSchema>;

export const ElicitationFormSchema = z
  .strictObject({
    message: z.string().max(ELICITATION_LIMITS.message),
    fields: z.array(ElicitationFieldSchema).min(1).max(ELICITATION_LIMITS.fields),
  })
  .refine((form) => new Set(form.fields.map((f) => f.key)).size === form.fields.length, {
    message: "field keys must be unique",
  });
export type ElicitationForm = z.infer<typeof ElicitationFormSchema>;

export type ElicitationValue = string | number | boolean | string[];
export type ElicitationAnswer = { action: "accept"; content: Record<string, ElicitationValue> } | { action: "decline" };

/** The answer that declines a form: the agent is told the person would not answer. */
export const ELICITATION_DECLINE = JSON.stringify({ action: "decline" });

/** The one string an `ElicitationAnswer` is recorded and delivered as. */
export function encodeElicitationAnswer(answer: ElicitationAnswer): string {
  return JSON.stringify(answer.action === "decline" ? { action: "decline" } : answer);
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The form ORCA shows for an agent's `requestedSchema`, or why it declines it. Fields keep the
 * schema's property order. Nothing outside the subset is dropped silently: an unknown field
 * type refuses the whole form, because a form answered without one of its fields is not the
 * answer the agent asked for.
 */
export function elicitationForm(
  message: string,
  requestedSchema: unknown,
): { form: ElicitationForm } | { refused: string } {
  if (!isRecord(requestedSchema)) return { refused: "the form has no schema" };
  if (requestedSchema.type !== undefined && requestedSchema.type !== "object")
    return { refused: "the form is not an object schema" };
  const properties = requestedSchema.properties;
  if (!isRecord(properties) || Object.keys(properties).length === 0)
    return { refused: "the form has no fields: a confirmation is not a question ORCA answers" };
  const required = new Set(
    Array.isArray(requestedSchema.required) ? requestedSchema.required.filter((k) => typeof k === "string") : [],
  );
  const fields: ElicitationField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const field = elicitationField(key, raw, required.has(key));
    if ("refused" in field) return field;
    fields.push(field.field);
  }
  const parsed = ElicitationFormSchema.safeParse({ message, fields });
  if (!parsed.success) return { refused: `the form is beyond what ORCA shows (${parsed.error.issues[0]?.message})` };
  return { form: parsed.data };
}

function elicitationField(
  key: string,
  raw: unknown,
  required: boolean,
): { field: ElicitationField } | { refused: string } {
  if (!isRecord(raw)) return { refused: `field '${key}' has no schema` };
  // A secret is never collected through a question: the answer is recorded in the run's log.
  const meta = isRecord(raw._meta) ? raw._meta : {};
  const codex = isRecord(meta.codex) ? meta.codex : {};
  if (raw.writeOnly === true || codex.isSecret === true || raw.format === "password")
    return { refused: `field '${key}' asks for a secret, which ORCA does not collect through a question` };
  const base = {
    key,
    required,
    ...(text(raw.title) !== undefined ? { title: text(raw.title)! } : {}),
    ...(text(raw.description) !== undefined ? { description: text(raw.description)! } : {}),
  };
  switch (raw.type) {
    case "string": {
      const options = choices(raw);
      if (options === null) return { refused: `field '${key}' has options ORCA cannot read` };
      if (options)
        return {
          field: {
            ...base,
            kind: "choice",
            options,
            ...(text(raw.default) !== undefined ? { default: text(raw.default)! } : {}),
          },
        };
      const format = text(raw.format);
      return {
        field: {
          ...base,
          kind: "text",
          ...(count(raw.minLength) !== undefined ? { minLength: count(raw.minLength)! } : {}),
          ...(count(raw.maxLength) !== undefined ? { maxLength: count(raw.maxLength)! } : {}),
          ...(format === "email" || format === "uri" || format === "date" || format === "date-time" ? { format } : {}),
          ...(text(raw.default) !== undefined ? { default: text(raw.default)! } : {}),
        },
      };
    }
    case "number":
    case "integer":
      return {
        field: {
          ...base,
          kind: "number",
          integer: raw.type === "integer",
          ...(finite(raw.minimum) !== undefined ? { minimum: finite(raw.minimum)! } : {}),
          ...(finite(raw.maximum) !== undefined ? { maximum: finite(raw.maximum)! } : {}),
          ...(finite(raw.default) !== undefined ? { default: finite(raw.default)! } : {}),
        },
      };
    case "boolean":
      return {
        field: { ...base, kind: "boolean", ...(typeof raw.default === "boolean" ? { default: raw.default } : {}) },
      };
    case "array": {
      const options = isRecord(raw.items) ? choices(raw.items) : undefined;
      if (!options) return { refused: `field '${key}' is a list without options, which ORCA cannot show` };
      const defaults = Array.isArray(raw.default) ? raw.default.filter((d) => typeof d === "string") : undefined;
      return {
        field: {
          ...base,
          kind: "multi",
          options,
          ...(count(raw.minItems) !== undefined ? { minItems: count(raw.minItems)! } : {}),
          ...(count(raw.maxItems) !== undefined ? { maxItems: count(raw.maxItems)! } : {}),
          ...(defaults ? { default: defaults } : {}),
        },
      };
    }
    default:
      return { refused: `field '${key}' has a type ORCA cannot show` };
  }
}

/**
 * The options of a choice schema: titled `oneOf`/`anyOf` consts, or `enum` with optional
 * `enumNames`. Undefined when the schema offers none, null when it offers some ORCA cannot read.
 */
function choices(raw: Json): ElicitationOption[] | null | undefined {
  const titled = Array.isArray(raw.oneOf) ? raw.oneOf : Array.isArray(raw.anyOf) ? raw.anyOf : undefined;
  if (titled) {
    const out: ElicitationOption[] = [];
    for (const o of titled) {
      if (!isRecord(o) || typeof o.const !== "string") return null;
      out.push({
        value: o.const,
        label: text(o.title) ?? o.const,
        ...(text(o.description) !== undefined ? { description: text(o.description)! } : {}),
      });
    }
    return out;
  }
  if (Array.isArray(raw.enum)) {
    if (!raw.enum.every((v) => typeof v === "string")) return null;
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
    return raw.enum.map((value, i) => ({ value, label: text(names[i]) ?? value }));
  }
  return undefined;
}

function refuse(reason: string): never {
  throw new OrcaError("RUN_STATE", `the answer does not fit the question: ${reason}`, { reason });
}

/**
 * Read an answer to `form`, refusing anything the form did not ask for: an unknown field, a
 * value outside a field's options or bounds, a missing required field. Text is kept exactly
 * as typed; an empty text field is left out.
 */
export function parseElicitationAnswer(form: ElicitationForm, answer: string): ElicitationAnswer {
  if (answer.length > ELICITATION_LIMITS.answer) refuse("it is too long");
  let raw: unknown;
  try {
    raw = JSON.parse(answer);
  } catch {
    refuse("it is not a form answer");
  }
  if (!isRecord(raw)) refuse("it is not a form answer");
  if (raw.action === "decline") {
    if (Object.keys(raw).length !== 1) refuse("a decline carries nothing else");
    return { action: "decline" };
  }
  if (raw.action !== "accept") refuse("its action is neither accept nor decline");
  if (Object.keys(raw).some((k) => k !== "action" && k !== "content")) refuse("it carries more than its content");
  const content = raw.content ?? {};
  if (!isRecord(content)) refuse("its content is not a set of fields");
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(content)) if (!byKey.has(key)) refuse(`the form has no field '${key}'`);
  const out: Record<string, ElicitationValue> = {};
  for (const field of form.fields) {
    const value = content[field.key];
    if (value === undefined || (field.kind === "text" && value === "")) {
      if (field.required) refuse(`'${field.key}' is required`);
      continue;
    }
    out[field.key] = fieldValue(field, value);
  }
  return { action: "accept", content: out };
}

function fieldValue(field: ElicitationField, value: unknown): ElicitationValue {
  const name = `'${field.key}'`;
  switch (field.kind) {
    case "choice":
      if (typeof value !== "string" || !field.options.some((o) => o.value === value))
        refuse(`${name} is not one of its options`);
      return value;
    case "multi": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
        refuse(`${name} is not a list of options`);
      const picks = value;
      if (new Set(picks).size !== picks.length) refuse(`${name} repeats an option`);
      if (!picks.every((v) => field.options.some((o) => o.value === v)))
        refuse(`${name} has a value that is not an option`);
      if (field.minItems !== undefined && picks.length < field.minItems)
        refuse(`${name} needs ${field.minItems} or more`);
      if (field.maxItems !== undefined && picks.length > field.maxItems)
        refuse(`${name} takes ${field.maxItems} at most`);
      if (field.required && picks.length === 0) refuse(`${name} is required`);
      return picks;
    }
    case "text": {
      if (typeof value !== "string") refuse(`${name} is not text`);
      const s = value;
      if (s.length > ELICITATION_LIMITS.text) refuse(`${name} is too long`);
      if (field.maxLength !== undefined && s.length > field.maxLength)
        refuse(`${name} is longer than ${field.maxLength}`);
      if (field.minLength !== undefined && s.length < field.minLength)
        refuse(`${name} is shorter than ${field.minLength}`);
      return s;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${name} is not a number`);
      const n = value;
      if (field.integer && !Number.isInteger(n)) refuse(`${name} is not a whole number`);
      if (field.minimum !== undefined && n < field.minimum) refuse(`${name} is below ${field.minimum}`);
      if (field.maximum !== undefined && n > field.maximum) refuse(`${name} is above ${field.maximum}`);
      return n;
    }
    case "boolean":
      if (typeof value !== "boolean") refuse(`${name} is not yes or no`);
      return value;
  }
}

/** The form an agent question carries in its `human.requested` context, when it is one. */
export function elicitationOf(context: Record<string, unknown> | undefined): ElicitationForm | undefined {
  const parsed = ElicitationFormSchema.safeParse(context?.elicitation);
  return parsed.success ? parsed.data : undefined;
}
