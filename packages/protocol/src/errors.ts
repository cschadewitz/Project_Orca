/**
 * Errors on the wire. A daemon-side `OrcaError` travels as its `toJSON()` shape with the
 * same stable `code`; the protocol adds the few codes that only make sense between
 * processes (version mismatch, unknown method, bad message).
 */
import { z } from "zod";
import type { OrcaErrorCode } from "@orca/core";

export const PROTOCOL_ERROR_CODES = ["PROTOCOL_VERSION", "PROTOCOL_METHOD", "PROTOCOL_MESSAGE"] as const;

/**
 * The refusals the control methods have and the engine has not. Each one is a client
 * mistake the daemon can name precisely, and naming it precisely is the point: the app has
 * to tell "somebody else answered this gate a second before you did" from "that option does
 * not exist" from "another process is driving this run", and the engine says `RUN_STATE` to
 * all three because a CLI reads the message and a screen cannot.
 *
 * They live here rather than in `core`'s `OrcaErrorCode` because they are only ever raised
 * between processes. A code a client branches on is the wire's business.
 */
export const CONTROL_ERROR_CODES = [
  /** The request was already answered - by another client, or by this one twice. */
  "INPUT_ANSWERED",
  /** The run is not parked on anything: it is running, or it has already finished. */
  "RUN_NOT_WAITING",
  /** Not an option this request offers. `details.options` is the list that is. */
  "INPUT_OPTION_UNKNOWN",
  /**
   * Another *live* process holds the run's single-writer lease. `details` carries that
   * holder's `pid`, `host`, `holder` and `renewedAt`: "do it over there" is only actionable
   * if the client can say where there is.
   */
  "RUN_LEASED_ELSEWHERE",
] as const;

export type ProtocolOnlyErrorCode = (typeof PROTOCOL_ERROR_CODES)[number] | (typeof CONTROL_ERROR_CODES)[number];
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

/**
 * A failure raised by a method with one of the protocol-only codes.
 *
 * `OrcaError` cannot carry them: its `code` is an `OrcaErrorCode`, and `describeError` -
 * which is what turns a thrown thing into the error half of a response envelope - only ever
 * produces one of those. So a control method that wants to say `INPUT_ANSWERED` rather than
 * `RUN_STATE` throws this, and `dispatch` asks it for its own shape first.
 */
export class ProtocolFault extends Error {
  override readonly name = "ProtocolFault";
  constructor(
    readonly code: ProtocolOnlyErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON(): ProtocolError {
    return protocolError(this.code, this.message, this.details);
  }
}

export function isProtocolFault(e: unknown): e is ProtocolFault {
  return e instanceof ProtocolFault;
}
