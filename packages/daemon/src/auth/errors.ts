/**
 * The refusals, in one place so every path that refuses says the same thing.
 *
 * Messages are generic on purpose. A missing credential is `AUTH_REQUIRED`; a malformed,
 * unknown, wrong, expired or revoked one is the same `AUTH_INVALID` with the same message and
 * no details, whichever it was - the reason is the audit log's (audit.ts), never the
 * caller's. A verified caller asking for an operation it was not granted is `AUTH_FORBIDDEN`.
 *
 * A *resource* the caller may not see is not `AUTH_FORBIDDEN`: that would confirm it exists.
 * It is the same not-found the method gives for an id that names nothing, built here so the
 * two cannot drift - the guard throws these for both cases rather than letting the
 * underlying model answer one and the guard answer the other.
 */
import { OrcaError } from "@orca/core";
import { ProtocolFault, protocolError, type ProtocolError } from "@orca/protocol";

export const AUTH_REQUIRED_MESSAGE = "authentication required";
export const AUTH_INVALID_MESSAGE = "invalid credentials";
export const AUTH_FORBIDDEN_MESSAGE = "not permitted";

export const authRequired = (): ProtocolFault => new ProtocolFault("AUTH_REQUIRED", AUTH_REQUIRED_MESSAGE);
export const authInvalid = (): ProtocolFault => new ProtocolFault("AUTH_INVALID", AUTH_INVALID_MESSAGE);
export const authForbidden = (): ProtocolFault => new ProtocolFault("AUTH_FORBIDDEN", AUTH_FORBIDDEN_MESSAGE);

export type AuthFailureCode = "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_FORBIDDEN";
const MESSAGES: Record<AuthFailureCode, string> = {
  AUTH_REQUIRED: AUTH_REQUIRED_MESSAGE,
  AUTH_INVALID: AUTH_INVALID_MESSAGE,
  AUTH_FORBIDDEN: AUTH_FORBIDDEN_MESSAGE,
};
export function authError(code: AuthFailureCode): ProtocolError {
  return protocolError(code, MESSAGES[code]);
}

// ----------------------------------------------------------- the not-founds

/** What `runs.events` (and the engine's `getState`) say for a run with no log. */
export function runNotFound(runId: string): OrcaError {
  return new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`, { runId });
}

/**
 * What the registry says for an id it has not got - minus `known`, the list of every
 * registered id, which is exactly what a workflow allowlist exists to hide.
 */
export function workflowNotFound(workflowId: string): OrcaError {
  return new OrcaError("WORKFLOW_NOT_FOUND", `workflow '${workflowId}' not registered`);
}

/** What `artifacts.get` says for an address that names nothing - the same address, the same details. */
export function artifactNotFound(params: {
  artifactId?: string | undefined;
  runId?: string | undefined;
  name?: string | undefined;
  version?: number | undefined;
}): OrcaError {
  const address =
    params.artifactId !== undefined
      ? params.artifactId
      : `${params.name}${params.version === undefined ? "" : `@v${params.version}`} in run ${params.runId}`;
  return new OrcaError("ARTIFACT_MISSING", `artifact ${address} not found`, {
    ...(params.artifactId === undefined
      ? {
          runId: params.runId,
          name: params.name,
          ...(params.version === undefined ? {} : { version: params.version }),
        }
      : { artifactId: params.artifactId }),
  });
}

/** What `inputs.answer` says for a request id it cannot find (control.ts `findInput`). */
export function inputNotFound(requestId: string, runId: string | undefined): OrcaError {
  return new OrcaError("RUN_STATE", `no human input '${requestId}' in this store`, { requestId, runId });
}

/** What `claims.release` says for a work item nobody has claimed (engine `releaseClaim`). */
export function claimNotFound(workItemId: string): OrcaError {
  return new OrcaError("CLAIM_NOT_FOUND", `work item ${workItemId} is not claimed`, { workItemId });
}
