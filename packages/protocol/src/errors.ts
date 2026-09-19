/**
 * Errors on the wire. A daemon-side `OrcaError` travels as its `toJSON()` shape with the
 * same stable `code`; the protocol adds the few codes that only make sense between
 * processes (version mismatch, unknown method, bad message).
 */
import { z } from "zod";
import type { OrcaErrorCode } from "@orca/core";

export const PROTOCOL_ERROR_CODES = ["PROTOCOL_VERSION", "PROTOCOL_METHOD", "PROTOCOL_MESSAGE"] as const;
export type ProtocolOnlyErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export type ProtocolErrorCode = OrcaErrorCode | ProtocolOnlyErrorCode;

export const ProtocolErrorSchema = z.object({
  /** An `OrcaErrorCode` or one of `PROTOCOL_ERROR_CODES`; kept as a string so a newer daemon's codes still parse. */
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ProtocolError {
  return details ? { code, message, details } : { code, message };
}
