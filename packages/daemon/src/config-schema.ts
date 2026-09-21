/**
 * `OrcaConfigSchema` described as a flat list of fields, so `config.get` can hand the app
 * something to render a form from (#174).
 *
 * It is derived by walking the zod schema at runtime rather than written out by hand, for
 * the obvious reason: a hand-written copy is a second source of truth that goes stale the
 * first time somebody adds a field to `packages/core/src/config.ts` and does not think of
 * this file. The cost is that the walker has to be honest about what it cannot describe - a
 * node it does not recognise is reported with type `unknown`, not guessed at and not
 * dropped, because a form that silently omits a field is worse than one that shows a field
 * it can only edit as text (RULES.md rule 12).
 *
 * **Paths describe the schema, not a document.** An array's element type is written once as
 * `hosts[]` and the form repeats it per element; nothing here knows how many hosts a
 * particular config has.
 *
 * **A union is flattened, and its discriminator becomes an enum.** `workspace` and
 * `humanInput` are discriminated unions, and what a form needs from one is "pick a
 * provider, then fill in that provider's fields". So every branch's fields are emitted at
 * the same path, the literal discriminators are merged into one `enum` of the values, and a
 * field that is not in every branch is `required: false` - because it genuinely is not
 * required, for the branches that lack it.
 *
 * This lives in the daemon rather than in `@orca/protocol` because the protocol package may
 * only reach core through the node-free `@orca/core/schemas` subpath, and `OrcaConfigSchema`
 * is not in that barrel. The protocol owns the *shape* of the description; the daemon is
 * what fills it in.
 */
import { OrcaConfigSchema } from "@orca/core";
import type { ConfigFieldDescription, ConfigFieldType, ConfigSchemaDescription } from "@orca/protocol";
import type { z } from "zod";

/** Enough of a zod v4 node to walk it. `def` is the classic API's view of `_zod.def`. */
interface ZodNode {
  def: {
    type: string;
    shape?: Record<string, ZodNode>;
    element?: ZodNode;
    innerType?: ZodNode;
    valueType?: ZodNode;
    options?: ZodNode[];
    entries?: Record<string, string | number>;
    values?: readonly unknown[];
    defaultValue?: unknown;
  };
  description?: string | undefined;
}

/** The whole config schema, flattened, in declaration order. */
export function describeConfigSchema(): ConfigSchemaDescription {
  const fields = new Map<string, ConfigFieldDescription>();
  walk(OrcaConfigSchema, "", fields, new Set());
  return [...fields.values()];
}

/**
 * Merge a field into the accumulator. Two branches of a union describing the same path are
 * folded rather than duplicated: their enum values are unioned, and the field is required
 * only if both branches require it.
 */
function emit(fields: Map<string, ConfigFieldDescription>, field: ConfigFieldDescription): void {
  const existing = fields.get(field.path);
  if (!existing) return void fields.set(field.path, field);
  const merged: ConfigFieldDescription = {
    ...existing,
    required: existing.required && field.required,
    ...(existing.enum || field.enum ? { enum: [...new Set([...(existing.enum ?? []), ...(field.enum ?? [])])] } : {}),
  };
  fields.set(field.path, merged);
}

/**
 * Peel the wrappers that say "this may be absent" off a node, keeping what they mean.
 *
 * `z.string().default("x")` is a `default` node wrapping a `string`; for a form the string
 * is the type and the default is why it is not required. `optional` and `nullable` say the
 * same thing without a value.
 */
function unwrap(node: ZodNode): { node: ZodNode; required: boolean; hasDefault: boolean; value?: unknown } {
  let current = node;
  let required = true;
  let hasDefault = false;
  let value: unknown;
  // Bounded by the nesting in the schema itself; the guard is against a malformed node
  // pointing at itself rather than against a legitimately deep type.
  for (let depth = 0; depth < 20; depth += 1) {
    const inner = current.def.innerType;
    const kind = current.def.type;
    if ((kind === "default" || kind === "prefault") && inner) {
      required = false;
      hasDefault = true;
      const raw = current.def.defaultValue;
      value = typeof raw === "function" ? (raw as () => unknown)() : raw;
      current = inner;
      continue;
    }
    if ((kind === "optional" || kind === "nullable" || kind === "nullish" || kind === "catch") && inner) {
      required = false;
      current = inner;
      continue;
    }
    break;
  }
  return { node: current, required, hasDefault, ...(hasDefault ? { value } : {}) };
}

/**
 * `required` is always relative to the field's own parent - "if you are writing a host, you
 * must give it an id" - and never compounded with whether the parent itself is required.
 * A form draws a field inside a section it has already decided to show, so compounding
 * would mark every field of an optional section as optional and say nothing useful.
 */
function walk(node: ZodNode, path: string, fields: Map<string, ConfigFieldDescription>, seen: Set<ZodNode>): void {
  const peeled = unwrap(node);
  const inner = peeled.node;
  const isRequired = peeled.required;
  const help = node.description ?? inner.description;
  const base = (type: ConfigFieldType, extra: Partial<ConfigFieldDescription> = {}): ConfigFieldDescription => ({
    path,
    type,
    required: isRequired,
    ...(peeled.hasDefault ? { default: peeled.value } : {}),
    ...(help ? { help } : {}),
    ...extra,
  });
  // A schema that reaches itself would walk forever; the root has no path and is never a
  // field of its own.
  if (seen.has(inner)) return;
  const nested = new Set(seen).add(inner);

  switch (inner.def.type) {
    case "object": {
      if (path !== "") emit(fields, base("object"));
      for (const [key, child] of Object.entries(inner.def.shape ?? {}))
        walk(child, path === "" ? key : `${path}.${key}`, fields, nested);
      return;
    }
    case "array": {
      emit(fields, base("array"));
      if (inner.def.element) walk(inner.def.element, `${path}[]`, fields, nested);
      return;
    }
    case "record": {
      // A record's keys are the document's, not the schema's, so there is no path to
      // describe under it: the form draws key/value pairs.
      emit(fields, base("record"));
      return;
    }
    case "union": {
      // Includes `z.discriminatedUnion`, which zod reports as a plain union with options.
      // Each branch is walked on its own, then merged: a field only one branch has is not
      // required, because choosing the other branch is a legitimate way to leave it out.
      const branches = (inner.def.options ?? []).map((option) => {
        const own = new Map<string, ConfigFieldDescription>();
        walk(option, path, own, nested);
        return own;
      });
      const inEvery = new Map<string, number>();
      for (const branch of branches) for (const key of branch.keys()) inEvery.set(key, (inEvery.get(key) ?? 0) + 1);
      for (const branch of branches)
        for (const field of branch.values())
          emit(fields, inEvery.get(field.path) === branches.length ? field : { ...field, required: false });
      // Every branch of a discriminated union is an object, so the object entry is already
      // emitted above; a union of scalars falls through to `unknown` rather than guessing.
      if (!fields.has(path) && path !== "") emit(fields, base("unknown"));
      return;
    }
    case "enum": {
      emit(fields, base("enum", { enum: Object.values(inner.def.entries ?? {}).map(String) }));
      return;
    }
    case "literal": {
      const values = inner.def.values ?? [];
      // A string literal is a one-value enum, which is exactly what a discriminator is; a
      // numeric or boolean one (`version: 1`) is better described by its type than by a
      // dropdown holding one item.
      if (values.every((v) => typeof v === "string")) emit(fields, base("enum", { enum: values.map(String) }));
      else emit(fields, base(scalarType(typeof values[0])));
      return;
    }
    case "string":
      return void emit(fields, base("string"));
    case "number":
    case "int":
      return void emit(fields, base("number"));
    case "boolean":
      return void emit(fields, base("boolean"));
    default:
      return void emit(fields, base("unknown"));
  }
}

function scalarType(js: string): ConfigFieldType {
  if (js === "string") return "string";
  if (js === "number") return "number";
  if (js === "boolean") return "boolean";
  return "unknown";
}

/**
 * A zod issue path turned into the dotted form a form places an error at:
 * `["hosts", 1, "transport"]` becomes `hosts[1].transport`.
 *
 * It is the same spelling the schema description uses, with the index filled in - which is
 * what lets #175 line an error up with the field it drew. `#174`'s done-when is this
 * function: "a `config.set` with an invalid host transport returns the error at
 * `hosts[1].transport`".
 */
export function dottedPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** Every issue in a failed parse, as `{ path, message }` a form can place. */
export function validationErrors(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: dottedPath(issue.path), message: issue.message }));
}
