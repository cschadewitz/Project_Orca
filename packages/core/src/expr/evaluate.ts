/**
 * Evaluator for the expression language. Sandboxed: no prototype access, no
 * assignment, no user-defined functions; only the whitelisted built-ins below.
 */
import { OrcaError } from "../errors.js";
import type { Expr } from "./ast.js";
import { parseExpression } from "./parser.js";

export type ExprFunction = (...args: unknown[]) => unknown;

export const BUILTIN_FUNCTIONS: Record<string, ExprFunction> = {
  len: (x) => (Array.isArray(x) || typeof x === "string" ? x.length : x && typeof x === "object" ? Object.keys(x).length : 0),
  exists: (x) => x !== undefined && x !== null,
  empty: (x) => x === undefined || x === null || x === "" || (Array.isArray(x) && x.length === 0) || (typeof x === "object" && Object.keys(x as object).length === 0),
  default: (x, d) => (x === undefined || x === null || x === "" ? d : x),
  str: (x) => (x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x)),
  num: (x) => Number(x),
  bool: (x) => truthy(x),
  lower: (s) => String(s ?? "").toLowerCase(),
  upper: (s) => String(s ?? "").toUpperCase(),
  trim: (s) => String(s ?? "").trim(),
  json: (x) => JSON.stringify(x),
  keys: (o) => (o && typeof o === "object" ? Object.keys(o) : []),
  values: (o) => (o && typeof o === "object" ? Object.values(o) : []),
  first: (a) => (Array.isArray(a) ? a[0] : undefined),
  last: (a) => (Array.isArray(a) ? a[a.length - 1] : undefined),
  join: (a, sep) => (Array.isArray(a) ? a.map(String).join(String(sep ?? ",")) : ""),
  count: (a, pred) => {
    if (!Array.isArray(a)) return 0;
    if (pred === undefined) return a.length;
    return a.filter((x) => x === pred).length;
  },
  pluck: (a, key) => (Array.isArray(a) ? a.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[String(key)] : undefined)) : []),
  all: (a) => Array.isArray(a) && a.every(truthy),
  any: (a) => Array.isArray(a) && a.some(truthy),
  min: (...xs) => Math.min(...xs.flat().map(Number)),
  max: (...xs) => Math.max(...xs.flat().map(Number)),
  range: (n) => Array.from({ length: Math.max(0, Number(n)) }, (_, i) => i),
};

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

export interface EvalOptions {
  functions?: Record<string, ExprFunction>;
}

export function evaluateExpression(src: string, context: unknown, options: EvalOptions = {}): unknown {
  return evalAst(parseExpression(src), context, { ...BUILTIN_FUNCTIONS, ...(options.functions ?? {}) });
}

export function evaluateCondition(src: string, context: unknown, options: EvalOptions = {}): boolean {
  return truthy(evaluateExpression(src, context, options));
}

function get(obj: unknown, key: string | number): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof key === "string" && (key === "__proto__" || key === "constructor" || key === "prototype")) return undefined;
  if (obj instanceof Map) return obj.get(key);
  if (typeof obj === "object" || typeof obj === "string") return (obj as Record<string | number, unknown>)[key];
  return undefined;
}

function evalAst(e: Expr, ctx: unknown, fns: Record<string, ExprFunction>): unknown {
  switch (e.t) {
    case "lit":
      return e.v;
    case "ident":
      return get(ctx, e.name);
    case "member":
      return get(evalAst(e.obj, ctx, fns), e.prop);
    case "index": {
      const k = evalAst(e.idx, ctx, fns);
      return get(evalAst(e.obj, ctx, fns), typeof k === "number" ? k : String(k));
    }
    case "list":
      return e.items.map((x) => evalAst(x, ctx, fns));
    case "call": {
      const fn = fns[e.fn];
      if (!fn) throw new OrcaError("EXPRESSION_EVAL", `unknown function ${e.fn}()`);
      return fn(...e.args.map((a) => evalAst(a, ctx, fns)));
    }
    case "unary": {
      const x = evalAst(e.x, ctx, fns);
      return e.op === "!" ? !truthy(x) : -Number(x);
    }
    case "cond":
      return truthy(evalAst(e.c, ctx, fns)) ? evalAst(e.a, ctx, fns) : evalAst(e.b, ctx, fns);
    case "bin": {
      if (e.op === "&&") return truthy(evalAst(e.l, ctx, fns)) ? evalAst(e.r, ctx, fns) : false;
      if (e.op === "||") {
        const l = evalAst(e.l, ctx, fns);
        return truthy(l) ? l : evalAst(e.r, ctx, fns);
      }
      const l = evalAst(e.l, ctx, fns);
      const r = evalAst(e.r, ctx, fns);
      switch (e.op) {
        case "==":
          return looseEq(l, r);
        case "!=":
          return !looseEq(l, r);
        case "<":
          return (l as number) < (r as number);
        case "<=":
          return (l as number) <= (r as number);
        case ">":
          return (l as number) > (r as number);
        case ">=":
          return (l as number) >= (r as number);
        case "+":
          return typeof l === "string" || typeof r === "string" ? String(l ?? "") + String(r ?? "") : Number(l) + Number(r);
        case "-":
          return Number(l) - Number(r);
        case "*":
          return Number(l) * Number(r);
        case "/":
          return Number(l) / Number(r);
        case "%":
          return Number(l) % Number(r);
        case "in":
          return Array.isArray(r) ? r.some((x) => looseEq(x, l)) : typeof r === "string" ? r.includes(String(l)) : r && typeof r === "object" ? String(l) in (r as object) : false;
        case "contains":
          return Array.isArray(l) ? l.some((x) => looseEq(x, r)) : typeof l === "string" ? l.includes(String(r)) : false;
        case "matches":
          return new RegExp(String(r)).test(String(l ?? ""));
        case "startsWith":
          return String(l ?? "").startsWith(String(r));
        case "endsWith":
          return String(l ?? "").endsWith(String(r));
      }
      throw new OrcaError("EXPRESSION_EVAL", `unknown operator ${e.op}`);
    }
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b);
  return false;
}

/** Syntax-check without evaluating. Returns an error message or undefined. */
export function checkExpression(src: string): string | undefined {
  try {
    parseExpression(src);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
