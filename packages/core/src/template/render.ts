/**
 * Prompt template renderer.
 *
 * Templates are markdown with a handful of directives. Interpolations use the
 * expression language so that the same syntax works in `when:` conditions and
 * in prompts:
 *
 *   {{ workItem.title }}
 *   {{#if artifacts.review}} ... {{else}} ... {{/if}}
 *   {{#each workItem.acceptanceCriteria as criterion}} - {{ criterion }} {{/each}}
 *   {{#each items as item, i}} ... {{/each}}
 *   {{> partial-id }}
 *   {{!-- comment --}}
 *
 * Values render as-is (markdown is the output). Objects/arrays render as YAML.
 */
import { stringify as stringifyYaml } from "yaml";
import { OrcaError } from "../errors.js";
import { checkExpression, evaluateExpression, truthy, type EvalOptions } from "../expr/index.js";

export interface RenderOptions extends EvalOptions {
  /** Resolve `{{> name}}` partials. */
  partials?: (name: string) => string | undefined;
  /** Guard against runaway recursion in partials. */
  maxDepth?: number;
  /** Optional authoring bounds; ordinary runtime rendering retains its existing behavior. */
  maxOutputLength?: number;
  maxOperations?: number;
}

type Node =
  | { t: "text"; s: string }
  | { t: "expr"; src: string }
  | { t: "partial"; name: string }
  | { t: "if"; cond: string; then: Node[]; else: Node[] }
  | { t: "each"; src: string; itemVar: string; indexVar?: string; body: Node[] };

/**
 * Find tags left to right in linear time. Same matches as the old
 * `/\{\{(!--[\s\S]*?--|[^}]*)\}\}/g`: a `{{!-- … --}}` comment closes at the first
 * `--}}`, a comment that never closes is read as a plain tag, and a plain tag
 * `{{ … }}` has no `}` inside it. The regex backtracked quadratically on input
 * such as many unclosed `{{!--`, and the parser runs on text clients send.
 */
export function* scanTags(src: string): Generator<{ index: number; end: number; inner: string }> {
  // Cached "next occurrence at or after" lookups keep each search linear overall.
  const next = (needle: string) => {
    let at = -2; // not searched yet
    return (from: number): number => {
      // Callers only move forward, so a cached hit at or after `from` is still the first one.
      if (at === -1 || at >= from) return at;
      at = src.indexOf(needle, from);
      return at;
    };
  };
  const nextOpen = next("{{");
  const nextComment = next("{{!--");
  const nextCommentClose = next("--}}");
  const nextBrace = next("}");
  let i = nextOpen(0);
  while (i !== -1) {
    if (src.startsWith("{{!--", i)) {
      const close = nextCommentClose(i + 5);
      if (close !== -1) {
        yield { index: i, end: close + 4, inner: src.slice(i + 2, close + 2) };
        i = nextOpen(close + 4);
        continue;
      }
    }
    const brace = nextBrace(i + 2);
    if (brace === -1) return; // no `}` left, so neither a plain tag nor a comment can close
    if (src[brace + 1] === "}") {
      yield { index: i, end: brace + 2, inner: src.slice(i + 2, brace) };
      i = nextOpen(brace + 2);
      continue;
    }
    // A plain tag starting before `brace` would stop at the same `}` and fail too,
    // but a comment starting before it can still close later.
    const comment = nextComment(i + 1);
    i = comment !== -1 && comment < brace ? comment : nextOpen(brace + 1);
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
const SPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * Parse `#each <src> as <item>[, <index>]` without regex backtracking. Returns
 * what `/^#each\s+(.+?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?$/`
 * captured, which was cubic in a run of spaces inside the tag.
 */
export function parseEachTag(tag: string): { src: string; itemVar: string; indexVar?: string } | undefined {
  if (!tag.startsWith("#each")) return undefined;
  const identBefore = (end: number): number => {
    let start = end;
    while (start > 0 && IDENT_PART.test(tag[start - 1]!)) start--;
    return start < end && IDENT_START.test(tag[start]!) ? start : -1;
  };
  const spaceBefore = (end: number): number => {
    let start = end;
    while (start > 0 && SPACE.test(tag[start - 1]!)) start--;
    return start;
  };
  // `as <ws>+` ends at `at`; the source is what lies between `#each <ws>+` and `<ws>+ as`.
  const sourceBefore = (at: number): string | undefined => {
    const beforeAs = spaceBefore(at);
    if (beforeAs === at || beforeAs < 2 || tag.slice(beforeAs - 2, beforeAs) !== "as") return undefined;
    const region = tag.slice(5, beforeAs - 2);
    let lead = 0;
    while (lead < region.length && SPACE.test(region[lead]!)) lead++;
    let trail = 0;
    while (trail < region.length - lead && SPACE.test(region[region.length - 1 - trail]!)) trail++;
    let src: string;
    if (lead === region.length) {
      // All whitespace: the greedy leading `\s+` gives back characters until `.+?` can take
      // one that is not a line break, with at least one left for the trailing `\s+`.
      for (let at = region.length - 2; at >= 1; at--) if (!LINE_BREAK.test(region[at]!)) return region[at];
      return undefined;
    } else {
      if (lead === 0 || trail === 0) return undefined;
      src = region.slice(lead, region.length - trail);
    }
    return LINE_BREAK.test(src) ? undefined : src;
  };
  const last = identBefore(tag.length);
  if (last === -1) return undefined;
  // `<item>, <index>` starts earlier than `<item>` alone, and the lazy source preferred it.
  const afterFirst = spaceBefore(last);
  if (afterFirst > 0 && tag[afterFirst - 1] === ",") {
    const first = identBefore(spaceBefore(afterFirst - 1));
    if (first !== -1) {
      const src = sourceBefore(first);
      return src === undefined
        ? undefined
        : { src, itemVar: tag.slice(first, spaceBefore(afterFirst - 1)), indexVar: tag.slice(last) };
    }
    return undefined;
  }
  const src = sourceBefore(last);
  return src === undefined ? undefined : { src, itemVar: tag.slice(last) };
}

function parseTemplate(src: string): Node[] {
  type Frame = {
    nodes: Node[];
    open?:
      | { kind: "if"; cond: string; then: Node[]; inElse: boolean }
      | { kind: "each"; src: string; itemVar: string; indexVar?: string };
  };
  const root: Frame = { nodes: [] };
  const stack: Frame[] = [root];
  let last = 0;
  for (const m of scanTags(src)) {
    const top = stack[stack.length - 1]!;
    const text = src.slice(last, m.index);
    if (text) top.nodes.push({ t: "text", s: text });
    last = m.end;
    const tag = m.inner.trim();
    if (tag.startsWith("!--") || tag.startsWith("!")) continue;
    if (tag.startsWith("#if ")) {
      stack.push({ nodes: [], open: { kind: "if", cond: tag.slice(4).trim(), then: [], inElse: false } });
    } else if (tag === "else") {
      const o = top.open;
      if (!o || o.kind !== "if" || o.inElse) throw new OrcaError("TEMPLATE_RENDER", "unexpected {{else}}");
      o.then = top.nodes;
      top.nodes = [];
      o.inElse = true;
    } else if (tag === "/if") {
      const f = stack.pop();
      if (!f?.open || f.open.kind !== "if") throw new OrcaError("TEMPLATE_RENDER", "unexpected {{/if}}");
      const node: Node = f.open.inElse
        ? { t: "if", cond: f.open.cond, then: f.open.then, else: f.nodes }
        : { t: "if", cond: f.open.cond, then: f.nodes, else: [] };
      stack[stack.length - 1]!.nodes.push(node);
    } else if (tag.startsWith("#each ")) {
      const each = parseEachTag(tag);
      if (!each) throw new OrcaError("TEMPLATE_RENDER", `malformed each: {{${tag}}}`);
      stack.push({ nodes: [], open: { kind: "each", ...each } });
    } else if (tag === "/each") {
      const f = stack.pop();
      if (!f?.open || f.open.kind !== "each") throw new OrcaError("TEMPLATE_RENDER", "unexpected {{/each}}");
      const o = f.open;
      stack[stack.length - 1]!.nodes.push({
        t: "each",
        src: o.src,
        itemVar: o.itemVar,
        ...(o.indexVar ? { indexVar: o.indexVar } : {}),
        body: f.nodes,
      });
    } else if (tag.startsWith(">")) {
      top.nodes.push({ t: "partial", name: tag.slice(1).trim() });
    } else {
      top.nodes.push({ t: "expr", src: tag });
    }
  }
  const tail = src.slice(last);
  if (tail) stack[stack.length - 1]!.nodes.push({ t: "text", s: tail });
  if (stack.length !== 1)
    throw new OrcaError("TEMPLATE_RENDER", `unclosed {{#${stack[stack.length - 1]!.open?.kind}}} block`);
  return root.nodes;
}

export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return stringifyYaml(v).trimEnd();
}

function renderNodes(
  nodes: Node[],
  ctx: Record<string, unknown>,
  opts: RenderOptions,
  depth: number,
  budget: { remaining: number },
): string {
  let out = "";
  const consume = () => {
    if (--budget.remaining < 0) throw new OrcaError("TEMPLATE_RENDER", "preview operation bound exceeded");
  };
  const append = (value: string) => {
    if (opts.maxOutputLength !== undefined && out.length + value.length > opts.maxOutputLength)
      throw new OrcaError("TEMPLATE_RENDER", "preview output bound exceeded");
    out += value;
  };
  for (const n of nodes) {
    consume();
    switch (n.t) {
      case "text":
        append(n.s);
        break;
      case "expr":
        append(formatValue(evaluateExpression(n.src, ctx, opts)));
        break;
      case "if":
        append(renderNodes(truthy(evaluateExpression(n.cond, ctx, opts)) ? n.then : n.else, ctx, opts, depth, budget));
        break;
      case "each": {
        const items = evaluateExpression(n.src, ctx, opts);
        const arr = Array.isArray(items) ? items : items && typeof items === "object" ? Object.entries(items) : [];
        arr.forEach((item, i) => {
          consume();
          const scope: Record<string, unknown> = { ...ctx, [n.itemVar]: item };
          if (n.indexVar) scope[n.indexVar] = i;
          append(renderNodes(n.body, scope, opts, depth, budget));
        });
        break;
      }
      case "partial": {
        if (depth > (opts.maxDepth ?? 8))
          throw new OrcaError("TEMPLATE_RENDER", `partial nesting too deep at ${n.name}`);
        const body = opts.partials?.(n.name);
        if (body === undefined) throw new OrcaError("TEMPLATE_NOT_FOUND", `partial '${n.name}' not found`);
        append(renderNodes(parseTemplate(body), ctx, opts, depth + 1, budget));
        break;
      }
    }
  }
  return out;
}

export function renderTemplate(body: string, context: Record<string, unknown>, options: RenderOptions = {}): string {
  return renderNodes(parseTemplate(body), context, options, 0, { remaining: options.maxOperations ?? Infinity });
}

/** Parse-only check used by workflow validation. */
export function checkTemplate(body: string): string | undefined {
  try {
    parseTemplate(body);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Parse every branch for authoring diagnostics and exact-ID partial references without rendering. */
export function templateReferences(body: string): string[] {
  const partials = new Set<string>();
  function walk(nodes: Node[]): void {
    for (const node of nodes) {
      if (node.t === "partial") partials.add(node.name);
      const expression = node.t === "expr" || node.t === "each" ? node.src : node.t === "if" ? node.cond : undefined;
      if (expression !== undefined && checkExpression(expression))
        throw new OrcaError("TEMPLATE_RENDER", "invalid template expression");
      if (node.t === "if") {
        walk(node.then);
        walk(node.else);
      }
      if (node.t === "each") walk(node.body);
    }
  }
  walk(parseTemplate(body));
  return [...partials];
}
