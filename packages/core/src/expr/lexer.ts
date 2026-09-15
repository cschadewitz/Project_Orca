/** Tokenizer for ORCA's condition/expression language (see README in this folder). */
import { OrcaError } from "../errors.js";

export type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "ident"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "eof"; pos: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ".", ",", "?", ":"];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ kind: "num", value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          j++;
          const e = src[j]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new OrcaError("EXPRESSION_SYNTAX", `unterminated string at ${i}`, { src });
      out.push({ kind: "str", value: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(src.slice(i))!;
      out.push({ kind: "ident", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new OrcaError("EXPRESSION_SYNTAX", `unexpected character '${c}' at ${i}`, { src });
    out.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  out.push({ kind: "eof", pos: i });
  return out;
}
