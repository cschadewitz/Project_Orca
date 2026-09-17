export type { Expr } from "./ast.js";
export { parseExpression } from "./parser.js";
export { evaluateExpression, evaluateCondition, checkExpression, truthy, BUILTIN_FUNCTIONS, type ExprFunction, type EvalOptions } from "./evaluate.js";
