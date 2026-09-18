/** The expression AST shared by the parser and the evaluator - one node kind per `t`. */
export type Expr =
  | { t: "lit"; v: unknown }
  | { t: "ident"; name: string }
  | { t: "member"; obj: Expr; prop: string }
  | { t: "index"; obj: Expr; idx: Expr }
  | { t: "call"; fn: string; args: Expr[] }
  | { t: "unary"; op: "!" | "-"; x: Expr }
  | { t: "bin"; op: string; l: Expr; r: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "list"; items: Expr[] };
