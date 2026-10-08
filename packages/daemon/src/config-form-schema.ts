/** Authoritative rich form metadata; no renderer schema copy and no plugin execution. */
import { OrcaConfigSchema } from "@orca/core";
import type { ConfigFieldMetadata, ConfigFieldShape, ConfigFormSchema, ConfigFieldType } from "@orca/protocol";
import type { z } from "zod";
import { configFieldVisibility } from "./config-form-visibility.js";

interface Node {
  def: {
    type: string;
    innerType?: Node;
    shape?: Record<string, Node>;
    element?: Node;
    valueType?: Node;
    keyType?: Node;
    options?: Node[];
    discriminator?: string;
    entries?: Record<string, string | number>;
    values?: readonly unknown[];
    defaultValue?: unknown;
    checks?: readonly unknown[];
  };
  description?: string;
}
const unknown = "metadata-unavailable";

/** Only audited core schemas enter this walker; callbacks/plugins are not discovered. */
export function describeConfigFormSchema(): ConfigFormSchema {
  return { version: 1, root: describeFormNode(OrcaConfigSchema) };
}

/** Exported for focused schema input-semantics tests; callers supply trusted Zod nodes. */
export function describeFormNode(schema: z.ZodType, path = ""): ConfigFieldShape {
  return walk(schema, path, new Set());
}

function acceptance(node: Node, value: "absent" | "null", seen = new Set<Node>()): boolean | typeof unknown {
  if (seen.has(node)) return unknown;
  seen = new Set(seen).add(node);
  const { type, innerType, options } = node.def;
  if (type === "optional" && value === "absent") return true;
  if ((type === "default" || type === "prefault") && value === "absent") return true;
  if (type === "nullable" && value === "null") return true;
  if (["optional", "nullable", "default", "prefault"].includes(type) && innerType)
    return acceptance(innerType, value, seen);
  if (type === "union") {
    const values = (options ?? []).map((option) => acceptance(option, value, seen));
    return values.includes(true) ? true : values.includes(unknown) ? unknown : false;
  }
  if (type === "null") return value === "null";
  if (type === "undefined" || type === "void") return value === "absent";
  if (type === "literal") return node.def.values?.includes(value === "null" ? null : undefined) ?? false;
  if (["object", "array", "record", "string", "number", "int", "boolean", "enum", "never"].includes(type)) return false;
  return unknown;
}

function walk(source: Node, path: string, seen: Set<Node>): ConfigFieldShape {
  let node = source;
  let defaultState: ConfigFieldMetadata["default"] = { state: "none" };
  const wrappers = new Set<Node>();
  while (["optional", "nullable", "default", "prefault"].includes(node.def.type) && node.def.innerType) {
    if (wrappers.has(node)) break;
    wrappers.add(node);
    if ((node.def.type === "default" || node.def.type === "prefault") && defaultState.state === "none") {
      // Factory defaults are withheld: reading Zod's getter would execute the factory.
      // Literal defaults have the same getter, so conservatively withhold both until
      // an audited pure value source exists. Presence remains distinct from no default.
      defaultState = { state: "withheld" };
    }
    node = node.def.innerType;
  }
  const meta: ConfigFieldMetadata = {
    acceptsAbsent: acceptance(source, "absent"),
    acceptsNull: acceptance(source, "null"),
    visibility: configFieldVisibility(path),
    default: defaultState,
  };
  const unsupported = (): ConfigFieldShape => ({
    ...meta,
    visibility: "metadata-unavailable",
    kind: "unsupported",
    reason: "opaque",
    ...(["pipe", "catch", "custom"].includes(node.def.type)
      ? { default: { state: "metadata-unavailable" as const } }
      : {}),
  });
  if (seen.has(node) || wrappers.has(node)) return unsupported();
  const nested = new Set(seen).add(node);
  const child = (n: Node, p: string) => walk(n, p, nested);
  switch (node.def.type) {
    case "object":
      return {
        ...meta,
        kind: "object",
        fields: Object.fromEntries(
          Object.entries(node.def.shape ?? {}).map(([key, n]) => [key, child(n, path ? `${path}.${key}` : key)]),
        ),
      };
    case "array":
      return node.def.element ? { ...meta, kind: "array", item: child(node.def.element, `${path}[]`) } : unsupported();
    case "record":
      // Constrained/enum/opaque key schemas cannot be described as arbitrary record keys.
      return node.def.valueType && node.def.keyType?.def.type === "string" && !node.def.keyType.def.checks?.length
        ? { ...meta, kind: "record", value: child(node.def.valueType, `${path}.<key>`) }
        : unsupported();
    case "union": {
      const discriminator = node.def.discriminator;
      if (!discriminator) return unsupported();
      const branches: Record<string, ConfigFieldShape> = Object.create(null) as Record<string, ConfigFieldShape>;
      for (const branch of node.def.options ?? []) {
        const values = branch.def.shape?.[discriminator]?.def.values;
        if (!values || values.length !== 1 || typeof values[0] !== "string") return unsupported();
        Object.defineProperty(branches, values[0], { value: child(branch, path), enumerable: true });
      }
      return { ...meta, kind: "union", discriminator, branches };
    }
    default: {
      const type = scalarType(node);
      if (!type) return unsupported();
      const choices =
        node.def.type === "enum"
          ? Object.values(node.def.entries ?? {}).map(String)
          : node.def.type === "literal" && type === "enum"
            ? node.def.values?.map(String)
            : undefined;
      return {
        ...meta,
        kind: "scalar",
        field: {
          path,
          type,
          required: meta.acceptsAbsent === false,
          ...(meta.visibility === "non-secret" && choices ? { enum: choices } : {}),
          ...(meta.visibility === "non-secret" && (source.description ?? node.description)
            ? { help: source.description ?? node.description }
            : {}),
        },
      };
    }
  }
}

function scalarType(node: Node): ConfigFieldType | undefined {
  if (["string", "number", "boolean", "enum"].includes(node.def.type)) return node.def.type as ConfigFieldType;
  if (node.def.type === "int") return "number";
  if (node.def.type === "literal") {
    const values = node.def.values ?? [];
    if (values.every((v) => typeof v === "string")) return "enum";
    const type = typeof values[0];
    return type === "number" || type === "boolean" ? type : undefined;
  }
  return undefined;
}
