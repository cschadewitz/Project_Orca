/** Ordered draft projection for controls only. Persistence always uses the injected YAML lowering seam. */
import type { DocumentPath, EditIntent, FieldShape } from "./contracts.js";

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const samePath = (a: DocumentPath, b: DocumentPath): boolean =>
  a.length === b.length && a.every((part, i) => part === b[i]);
/** Display projections and parsed metadata are copied on reads; object identity is not a draft change. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return false;
}
export const pathLabel = (path: DocumentPath): string =>
  path.reduce<string>(
    (s, p) =>
      typeof p === "number"
        ? `${s}[${p}]`
        : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(p)
          ? `${s === "" ? "" : `${s}.`}${p}`
          : `${s}[${JSON.stringify(p)}]`,
    "",
  );

export function recordKeyError(key: string, value: unknown): string | undefined {
  if (key === "" || !/^[A-Za-z0-9_-]+$/.test(key) || FORBIDDEN.has(key))
    return "Use a key without dots, brackets, spaces or reserved names.";
  if (isObject(value) && Object.hasOwn(value, key)) return "This key already exists.";
  return undefined;
}

export function atPath(value: unknown, path: DocumentPath): unknown {
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(value)) return undefined;
      value = value[part];
    } else {
      if (!isObject(value) || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
  }
  return value;
}

function checkedPath(path: DocumentPath): void {
  if (path.length === 0 || path.some((p) => (typeof p === "string" ? FORBIDDEN.has(p) : !Number.isInteger(p) || p < 0)))
    throw new Error("Unsupported edit path.");
}
function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  throw new Error("Edit values must be explicit JSON values.");
}

/** Copies untouched extension values for display, never serializes this copy back to disk. */
export function projectEdits(base: unknown, edits: readonly EditIntent[]): unknown {
  const projected = jsonValue(base);
  for (const edit of edits) {
    checkedPath(edit.path);
    if (edit.kind === "insert" || edit.kind === "move") {
      const collection = atPath(projected, edit.path);
      if (!Array.isArray(collection)) throw new Error("Collection is not an array.");
      if (edit.kind === "insert") {
        if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index > collection.length)
          throw new Error("Invalid insertion index.");
        collection.splice(edit.index, 0, jsonValue(edit.value));
      } else {
        if (![edit.from, edit.to].every((i) => Number.isInteger(i) && i >= 0 && i < collection.length))
          throw new Error("Invalid movement index.");
        const [item] = collection.splice(edit.from, 1);
        collection.splice(edit.to, 0, item);
      }
    } else {
      const parent = atPath(projected, edit.path.slice(0, -1));
      const key = edit.path.at(-1)!;
      if (Array.isArray(parent) && typeof key === "number" && key < parent.length) {
        if (edit.kind === "remove") parent.splice(key, 1);
        else parent[key] = jsonValue(edit.value);
      } else if (isObject(parent) && typeof key === "string") {
        if (edit.kind === "remove") delete parent[key];
        else
          Object.defineProperty(parent, key, {
            value: jsonValue(edit.value),
            writable: true,
            enumerable: true,
            configurable: true,
          });
      } else throw new Error("Edit parent is unavailable.");
    }
  }
  return projected;
}

/** Creating containers deliberately leaves child defaults absent; validation supplies required errors. */
export function initialValue(shape: FieldShape): { available: true; value: unknown } | { available: false } {
  if (
    shape.visibility !== "non-secret" ||
    shape.acceptsAbsent === "metadata-unavailable" ||
    shape.acceptsNull === "metadata-unavailable"
  )
    return { available: false };
  if (shape.kind === "object" || shape.kind === "record") return { available: true, value: {} };
  if (shape.kind === "array") return { available: true, value: [] };
  if (shape.kind !== "scalar") return { available: false };
  if (shape.field.type === "string") return { available: true, value: "" };
  if (shape.field.type === "number") return { available: true, value: 0 };
  if (shape.field.type === "boolean") return { available: true, value: false };
  return { available: false };
}

/** Remove only known old-branch fields. Retain common fields and unknown extensions, without parent replacement. */
export function switchVariant(
  shape: Extract<FieldShape, { kind: "union" }>,
  value: unknown,
  path: DocumentPath,
  branch: string,
): readonly EditIntent[] | undefined {
  if (!Object.hasOwn(shape.branches, branch) || recordKeyError(shape.discriminator, {}) !== undefined) return undefined;
  const next = shape.branches[branch];
  const current = isObject(value) ? value[shape.discriminator] : undefined;
  const old =
    typeof current === "string" && Object.hasOwn(shape.branches, current) ? shape.branches[current] : undefined;
  if (
    next?.kind !== "object" ||
    next.visibility !== "non-secret" ||
    next.acceptsAbsent === "metadata-unavailable" ||
    next.acceptsNull === "metadata-unavailable" ||
    (old !== undefined && old.visibility !== "non-secret") ||
    (old !== undefined && (typeof old.acceptsAbsent !== "boolean" || typeof old.acceptsNull !== "boolean")) ||
    (value !== undefined && value !== null && old?.kind !== "object")
  )
    return undefined;
  const edits: EditIntent[] = [];
  if (!isObject(value)) edits.push({ kind: "set", path, value: {} });
  if (old?.kind === "object" && isObject(value)) {
    for (const key of Object.keys(old.fields)) {
      if (key !== shape.discriminator && !Object.hasOwn(next.fields, key) && Object.hasOwn(value, key))
        edits.push({ kind: "remove", path: [...path, key] });
    }
  }
  edits.push({ kind: "set", path: [...path, shape.discriminator], value: branch });
  return edits;
}
