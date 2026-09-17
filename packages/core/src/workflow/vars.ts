/**
 * Node `vars` share one convention across every node type that carries them
 * (set, agent, subworkflow): a string value starting with "=" is an expression
 * in ORCA's expression language, anything else is a literal. Keeping the rule
 * in one place stops executors from drifting apart - an unevaluated "=..."
 * silently reaches prompts and artifact paths as literal text.
 */

/** The expression source of a `vars` value, or undefined when the value is a literal. */
export function varExpression(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("=") ? value.slice(1) : undefined;
}

/** Evaluate every "="-prefixed value in `vars`; literals pass through untouched. */
export async function evaluateVars(vars: Record<string, unknown>, evaluate: (expr: string) => Promise<unknown> | unknown): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    const expr = varExpression(v);
    out[k] = expr === undefined ? v : await evaluate(expr);
  }
  return out;
}
