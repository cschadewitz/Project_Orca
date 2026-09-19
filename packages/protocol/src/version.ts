/**
 * Protocol versioning. `major` changes when an existing message changes shape or
 * meaning; `minor` when messages or fields are added. A client and a daemon are
 * compatible when their majors match and the daemon is at least as new as the client
 * (a newer client may ask for a method an older daemon does not have).
 */
import { z } from "zod";

export const ProtocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

/** The version this package speaks. Bump `minor` for additions, `major` for anything else. */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 1 };

export function formatProtocolVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

/** Whether `client` may talk to `daemon`. */
export function isCompatible(client: ProtocolVersion, daemon: ProtocolVersion): boolean {
  return client.major === daemon.major && daemon.minor >= client.minor;
}
