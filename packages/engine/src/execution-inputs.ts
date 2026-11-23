/** Admission sensitivity and public projections; only execution contexts may retain authoritative values. */
import type { Logger, WorkflowDefinition, WorkflowInputDeclaration } from "@orca/core";
import { redactExecutionValue, type ExecutionInputs } from "@orca/store";

function containsSensitive(decl: WorkflowInputDeclaration): boolean {
  return (
    decl.sensitive === true ||
    !!(decl.items && containsSensitive(decl.items)) ||
    Object.values(decl.properties ?? {}).some(containsSensitive)
  );
}

/** Inherited names stay sensitive even when a child accepts them as undeclared vars. */
export function protectExecutionInputs(
  runId: string,
  definition: WorkflowDefinition,
  vars: Record<string, unknown>,
  parent?: ExecutionInputs,
  /** Names the launch asked to protect though the definition does not declare them (#363). */
  alsoSensitive: readonly string[] = [],
): ExecutionInputs | undefined {
  const sensitiveNames = new Set([...(parent?.sensitiveNames ?? []), ...alsoSensitive]);
  for (const [name, declaration] of Object.entries(definition.inputSchema?.fields ?? {}))
    if (containsSensitive(declaration)) sensitiveNames.add(name);
  if (!sensitiveNames.size && !parent?.secrets.length) return undefined;
  const secrets = [...(parent?.secrets ?? [])];
  for (const name of sensitiveNames) {
    if (Object.hasOwn(vars, name)) secrets.push(vars[name]);
    const decl = definition.inputSchema?.fields[name];
    if (decl?.default !== undefined) secrets.push(decl.default);
    if (decl?.enum !== undefined) secrets.push(...decl.enum);
  }
  return structuredClone({
    runId,
    workflowId: definition.id,
    workflowVersion: definition.version,
    vars,
    sensitiveNames: [...sensitiveNames],
    secrets,
  });
}

/** Sanitize at the logger boundary, including child bindings and structured fields. */
export function executionLogger(
  logger: Logger,
  inputs: () => ExecutionInputs | undefined,
  bindings: Record<string, unknown> = {},
): Logger {
  const emit = (
    level: Parameters<Logger["log"]>[0],
    message: string,
    fields: Record<string, unknown> | undefined,
    direct: boolean,
  ): void => {
    const current = inputs();
    const redact = <T>(value: T): T => (current ? redactExecutionValue(value, current.secrets, true) : value);
    const all = { ...bindings, ...(fields ?? {}) };
    const projected = Object.keys(all).length ? redact(all) : undefined;
    if (direct) logger[level](redact(message), projected);
    else logger.log(level, redact(message), projected);
  };
  return {
    log: (level, message, fields) => emit(level, message, fields, false),
    debug: (message, fields) => emit("debug", message, fields, true),
    info: (message, fields) => emit("info", message, fields, true),
    warn: (message, fields) => emit("warn", message, fields, true),
    error: (message, fields) => emit("error", message, fields, true),
    child: (fields) => executionLogger(logger, inputs, { ...bindings, ...fields }),
  };
}
