/** CLI retry identity is explicit and copyable across process restarts. */
import { randomUUID } from "node:crypto";
import { OrcaError } from "@orca/core";
import type { RetryOptions } from "../../../core/src/model/admission-retry.js";
export function admissionRetryOptions(key?: string): RetryOptions {
  const idempotencyKey = key ?? randomUUID();
  if (Buffer.byteLength(idempotencyKey) < 1 || Buffer.byteLength(idempotencyKey) > 128)
    throw new OrcaError("WORKFLOW_INPUT_INVALID", "Retry key must contain 1–128 UTF-8 bytes");
  return { idempotencyKey };
}
