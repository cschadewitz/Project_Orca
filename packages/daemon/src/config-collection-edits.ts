/** Ordered tuple edits; source splices retain all bytes outside targeted YAML regions. */
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, type Node, type YAMLSeq, type YAMLMap } from "yaml";
import { OrcaError } from "@orca/core";
import { ConfigEditIntentSchema, type ConfigEditIntent } from "@orca/protocol";

type Path = readonly (string | number)[];
const refuse = (): never => {
  throw new OrcaError(
    "CONFIG_INVALID",
    "This structured edit cannot preserve the document safely; retain the draft and use the raw editor.",
  );
};
const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const splice = (text: string, from: number, to: number, next: string) => text.slice(0, from) + next + text.slice(to);
const indentText = (text: string, indent: number) =>
  text
    .split("\n")
    .map((line) => (line ? " ".repeat(indent) + line : line))
    .join("\n");

function safeValue(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (
    depth > 64 ||
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    refuse();
  if (typeof value === "number" && !Number.isFinite(value)) refuse();
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) refuse();
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) refuse();
    safeValue(child, seen, depth + 1);
  }
  seen.delete(value);
}
function range(node: Node): [number, number, number] {
  if (!node.range) return refuse();
  return node.range;
}
function resolve(root: Node | null, path: Path): Node | undefined {
  let node: Node | undefined | null = root;
  for (const key of path) {
    if (!node || isAlias(node)) return refuse();
    if (isMap(node) && typeof key === "string") {
      if (node.items.some((pair) => !isScalar(pair.key) || pair.key.value === "<<")) refuse();
      const pairs = node.items.filter((pair) => isScalar(pair.key) && pair.key.value === key);
      if (pairs.length > 1) refuse();
      node = pairs[0]?.value as Node | undefined;
    } else if (isSeq(node) && typeof key === "number" && key < node.items.length)
      node = node.items[key] as Node | undefined;
    else return refuse();
  }
  if (node && isAlias(node)) refuse();
  return node ?? undefined;
}

function sequenceChunks(
  text: string,
  node: YAMLSeq,
): { starts: number[]; end: number; chunks: string[]; indent: number } {
  const cst = node.srcToken;
  if (cst?.type !== "block-seq" || cst.items.length !== node.items.length || !cst.items.length) return refuse();
  const starts = cst.items.map((item) => {
    const first = item.start[0];
    if (!first) return refuse();
    return lineStart(text, first.offset);
  });
  const end = range(node)[2];
  return { starts, end, chunks: starts.map((start, i) => text.slice(start, starts[i + 1] ?? end)), indent: cst.indent };
}
function editSequence(text: string, node: YAMLSeq, edit: ConfigEditIntent, removeIndex?: number): string {
  const { starts, end, chunks, indent } = sequenceChunks(text, node);
  if (removeIndex !== undefined) {
    if (removeIndex >= chunks.length) return refuse();
    chunks.splice(removeIndex, 1);
  } else if (edit.kind === "insert") {
    if (edit.index > chunks.length) return refuse();
    chunks.splice(edit.index, 0, indentText(stringify([edit.value]), indent));
  } else if (edit.kind === "move") {
    if (edit.from >= chunks.length || edit.to >= chunks.length) return refuse();
    const moved = chunks.splice(edit.from, 1)[0];
    if (moved === undefined) return refuse();
    chunks.splice(edit.to, 0, moved);
  } else return refuse();
  return splice(text, starts[0]!, end, chunks.length ? chunks.join("") : " ".repeat(indent) + "[]\n");
}

function appendMap(text: string, node: YAMLMap, key: string, value: unknown): string {
  const cst = node.srcToken;
  if (cst?.type === "flow-collection") {
    const close = cst.end.find((token) => token.type === "flow-map-end");
    if (!close) return refuse();
    const before = text.slice(range(node)[0], close.offset);
    const separator = !node.items.length || /,\s*$/.test(before) ? "" : ", ";
    return splice(text, close.offset, close.offset, separator + JSON.stringify(key) + ": " + JSON.stringify(value));
  }
  if (cst?.type !== "block-map") return refuse();
  const end = range(node)[1];
  const pair = Object.fromEntries([[key, value]]);
  const added = indentText(stringify(pair), cst.indent);
  return splice(text, end, end, (end > 0 && text[end - 1] !== "\n" ? "\n" : "") + added);
}

function setAt(text: string, root: Node | null, path: Path, value: unknown): string {
  const existing = resolve(root, path);
  if (existing) {
    if (!isScalar(existing)) return refuse();
    const [from, to] = range(existing);
    // JSON scalar spelling is valid YAML and keeps inline/trailing comments outside the range.
    if (value !== null && typeof value === "object") return refuse();
    return splice(text, from, to, JSON.stringify(value));
  }
  const parent = resolve(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent || !isMap(parent) || typeof key !== "string") return refuse();
  return appendMap(text, parent, key, value);
}

function apply(text: string, edit: ConfigEditIntent): string {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) return refuse();
  const root = doc.contents as Node | null;
  if (edit.kind === "set" || edit.kind === "insert") safeValue(edit.value);
  if (!root) {
    if (edit.kind !== "set" && !(edit.kind === "insert" && edit.index === 0)) return refuse();
    const value = edit.kind === "insert" ? [edit.value] : edit.value;
    // Empty-document creation has no existing value/comment region to replace.
    const fresh = parseDocument("{}");
    fresh.setIn(edit.path, value);
    return text + (text && !text.endsWith("\n") ? "\n" : "") + stringify(fresh.toJS());
  }
  if (edit.kind === "set") return setAt(text, root, edit.path, edit.value);
  if (edit.kind === "remove") {
    const parent = resolve(root, edit.path.slice(0, -1));
    const key = edit.path[edit.path.length - 1];
    if (parent && isSeq(parent) && typeof key === "number") return editSequence(text, parent, edit, key);
    if (!parent || !isMap(parent) || typeof key !== "string" || parent.srcToken?.type !== "block-map") return refuse();
    const index = parent.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === key);
    if (index < 0) return text;
    const pair = parent.items[index];
    if (!pair || !isScalar(pair.key)) return refuse();
    const from = lineStart(text, pair.srcToken?.start[0]?.offset ?? range(pair.key)[0]);
    // First keys of a compact sequence map share the '-' line: refuse rather than deleting it.
    if (text.slice(from, range(pair.key)[0]).trim()) return refuse();
    const next = parent.items[index + 1];
    const to =
      next?.srcToken?.start[0]?.offset ??
      (next && isScalar(next.key) ? lineStart(text, range(next.key)[0]) : range(parent)[2]);
    return splice(text, from, to, "");
  }
  const node = resolve(root, edit.path);
  if (!node) {
    if (edit.kind !== "insert" || edit.index !== 0) return refuse();
    return setAt(text, root, edit.path, [edit.value]);
  }
  if (!isSeq(node)) return refuse();
  if (node.items.length === 0 && edit.kind === "insert" && edit.index === 0) {
    const [from, to, end] = range(node);
    if (text.slice(from, to).includes("#")) return refuse();
    const start = lineStart(text, from);
    const indent = /^ */.exec(text.slice(start))?.[0].length ?? 0;
    const prefix = text.slice(start, from).trim();
    if (!prefix.endsWith(":")) return refuse();
    const tail = text.slice(to, end);
    // Keep collection-level inline comments on the header and grow a block sequence
    // so subsequent insert/move edits use the same source-preserving representation.
    return splice(
      text,
      from,
      end,
      (tail.includes("#") ? tail : "\n") + indentText(stringify([edit.value]), indent + 2),
    );
  }
  return editSequence(text, node, edit);
}

export function lowerConfigEdits(text: string, edits: readonly ConfigEditIntent[]): string {
  let candidate = text;
  for (const value of edits) {
    const parsed = ConfigEditIntentSchema.safeParse(value);
    if (!parsed.success) return refuse();
    candidate = apply(candidate, parsed.data);
  }
  if (parseDocument(candidate).errors.length) return refuse();
  return candidate;
}
