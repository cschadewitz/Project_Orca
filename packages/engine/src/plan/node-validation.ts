/** Shared schema parsing for builtin nodes at load time and before execution side effects. */
import type { NodeIssue } from "@orca/core";
import type { z } from "zod";
import { failed, type StepContext } from "../executors/types.js";

export function parseNode<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { node: T; issues?: undefined } | { node?: undefined; issues: NodeIssue[] } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  return { node: parsed.data };
}

export function validateNode<T>(schema: z.ZodType<T>, raw: unknown) {
  const { issues } = parseNode(schema, raw);
  return issues ? { errors: issues } : {};
}

export function invalidNode(ctx: StepContext, issues: NodeIssue[]) {
  return failed(
    "WORKFLOW_INVALID",
    `${ctx.node.type} '${ctx.nodeId}': ${issues.map((issue) => `${issue.path || "node"}: ${issue.message}`).join("; ")}`,
    { issues },
    false,
  );
}
