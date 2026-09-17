/**
 * The `vars` convention shared by every vars-bearing node (set, agent,
 * subworkflow): a string value starting with "=" is an expression evaluated
 * against the step context, anything else is a literal. Kept in one place so
 * the same map means the same thing whichever node type carries it.
 */
export async function evaluateVars(vars: Record<string, unknown>, evaluate: (expr: string) => Promise<unknown> | unknown): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === "string" && v.startsWith("=") ? await evaluate(v.slice(1)) : v;
  return out;
}
