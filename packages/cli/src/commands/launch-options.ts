/** Launch flags shared by direct workflow and program commands; legacy --var coercion stays unchanged. */
import { OrcaError } from "@orca/core";
import type { CommandContext } from "./index.js";

/**
 * --var keeps its historical JSON-if-possible behavior. --var-json is deliberately strict:
 * a typo must not quietly become a string when the caller asked for a typed value. Explicit
 * JSON flags override legacy flags for the same key, regardless of their position in argv.
 */
export function parseVars(values: string[] = [], jsonValues: string[] = []): Record<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const [flag, items, strict] of [
    ["--var", values, false],
    ["--var-json", jsonValues, true],
  ] as const) {
    for (const value of items) {
      const i = value.indexOf("=");
      if (i < 1) throw new OrcaError("CONFIG_INVALID", `${flag} expects a non-empty key=value`);
      const key = value.slice(0, i);
      const raw = value.slice(i + 1);
      try {
        entries.set(key, JSON.parse(raw));
      } catch {
        // Do not echo values: launch inputs may be sensitive even when parsing fails.
        if (strict) throw new OrcaError("CONFIG_INVALID", "--var-json requires a valid JSON value");
        entries.set(key, raw);
      }
    }
  }
  return Object.fromEntries(entries);
}

/** Both halves of a preflight identity travel to admission without being reinterpreted. */
export function workflowGuards(ctx: Pick<CommandContext, "flags">): {
  workflowVersion?: string;
  expectedWorkflowRevision?: string;
} {
  const workflowVersion = ctx.flags["workflow-version"] as string | undefined;
  const expectedWorkflowRevision = ctx.flags["expected-workflow-revision"] as string | undefined;
  if (workflowVersion !== undefined && !workflowVersion)
    throw new OrcaError("CONFIG_INVALID", "--workflow-version must not be empty");
  if (expectedWorkflowRevision !== undefined && !expectedWorkflowRevision)
    throw new OrcaError("CONFIG_INVALID", "--expected-workflow-revision must not be empty");
  return {
    ...(workflowVersion !== undefined ? { workflowVersion } : {}),
    ...(expectedWorkflowRevision !== undefined ? { expectedWorkflowRevision } : {}),
  };
}
