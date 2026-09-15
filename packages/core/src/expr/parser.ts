/** Recursive-descent parser producing a small AST (ast.ts). */
import { OrcaError } from "../errors.js";
import type { Expr } from "./ast.js";
import { tokenize, type Token } from "./lexer.js";

const WORD_OPS = new Set(["in", "contains", "matches", "and", "or", "not", "startsWith", "endsWith"]);

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly src: string,
  ) {}

  parse(): Expr {
    const e = this.ternary();
    if (this.peek().kind !== "eof") this.fail("unexpected trailing input");
    return e;
  }

  private peek(): Token {
    return this.toks[this.i]!;
  }
  private next(): Token {
    return this.toks[this.i++]!;
  }
  private fail(msg: string): never {
    throw new OrcaError("EXPRESSION_SYNTAX", `${msg} at ${this.peek().pos} in "${this.src}"`);
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return (t.kind === "op" && t.value === v) || (t.kind === "ident" && WORD_OPS.has(t.value) && t.value === v);
  }
  private eatOp(v: string): boolean {
    if (this.isOp(v)) {
      this.next();
      return true;
    }
    return false;
  }
  private expectOp(v: string): void {
    if (!this.eatOp(v)) this.fail(`expected '${v}'`);
  }

  private ternary(): Expr {
    const c = this.or();
    if (this.eatOp("?")) {
      const a = this.ternary();
      this.expectOp(":");
      const b = this.ternary();
      return { t: "cond", c, a, b };
    }
    return c;
  }
  private or(): Expr {
    let l = this.and();
    while (this.isOp("||") || this.isOp("or")) {
      this.next();
      l = { t: "bin", op: "||", l, r: this.and() };
    }
    return l;
  }
  private and(): Expr {
    let l = this.not();
    while (this.isOp("&&") || this.isOp("and")) {
      this.next();
      l = { t: "bin", op: "&&", l, r: this.not() };
    }
    return l;
  }
  private not(): Expr {
    if (this.isOp("!") || this.isOp("not")) {
      this.next();
      return { t: "unary", op: "!", x: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Expr {
    const l = this.add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in", "contains", "matches", "startsWith", "endsWith"]) {
      if (this.isOp(op)) {
        this.next();
        return { t: "bin", op, l, r: this.add() };
      }
    }
    return l;
  }
  private add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { value: string }).value;
      l = { t: "bin", op, l, r: this.mul() };
    }
    return l;
  }
  private mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.next() as { value: string }).value;
      l = { t: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  private unary(): Expr {
    if (this.eatOp("-")) return { t: "unary", op: "-", x: this.unary() };
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eatOp(".")) {
        const t = this.next();
        if (t.kind !== "ident") this.fail("expected property name");
        e = { t: "member", obj: e, prop: t.value };
      } else if (this.eatOp("[")) {
        const idx = this.ternary();
        this.expectOp("]");
        e = { t: "index", obj: e, idx };
      } else if (e.t === "ident" && this.isOp("(")) {
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          do args.push(this.ternary());
          while (this.eatOp(","));
        }
        this.expectOp(")");
        e = { t: "call", fn: e.name, args };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.next();
    switch (t.kind) {
      case "num":
        return { t: "lit", v: t.value };
      case "str":
        return { t: "lit", v: t.value };
      case "ident":
        if (t.value === "true") return { t: "lit", v: true };
        if (t.value === "false") return { t: "lit", v: false };
        if (t.value === "null") return { t: "lit", v: null };
        return { t: "ident", name: t.value };
      case "op":
        if (t.value === "(") {
          const e = this.ternary();
          this.expectOp(")");
          return e;
        }
        if (t.value === "[") {
          const items: Expr[] = [];
          if (!this.isOp("]")) {
            do items.push(this.ternary());
            while (this.eatOp(","));
          }
          this.expectOp("]");
          return { t: "list", items };
        }
        break;
      case "eof":
        break;
    }
    this.i--;
    return this.fail("unexpected token");
  }
}

const cache = new Map<string, Expr>();

export function parseExpression(src: string): Expr {
  const hit = cache.get(src);
  if (hit) return hit;
  const ast = new Parser(tokenize(src), src).parse();
  if (cache.size > 5000) cache.clear();
  cache.set(src, ast);
  return ast;
}
