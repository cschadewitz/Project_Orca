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

/**
 * The version this package speaks. Bump `minor` for additions, `major` for anything else.
 *
 * 1.4 adds the control methods (`inputs.answer`, `runs.resume`, `runs.cancel`, `runs.start`),
 * the agent methods (`agents.list`, `agents.ping`) and the `agent.changed` notification, and
 * widens `options` on `OpenInputView` and `input.opened` from `string[]` to `GateOption[]`.
 *
 * That widening is a *shape* change to an existing field, which this file's own rule calls a
 * major. It is a minor anyway, on one condition that holds today and is worth writing down:
 * every shipped client of `options` is built from this same commit (ADR 0008 - the app and
 * the daemon ship together), so no build in existence reads those two fields as strings. The
 * next widening of a field somebody outside this repository already parses is a major.
 *
 * 1.5 moves `agent.changed` into `NOTIFICATION_METHODS` and `DaemonNotification` (#241), and
 * adds `hostType` to `AgentView`. Both are additions by this file's own rule: a method joins
 * a list clients read by name, and an optional field joins a view. Nothing that was sent
 * before is sent differently - a 1.4 client's `parseNotification` dropped `agent.changed` as
 * a method it had never heard of, which is what it will go on doing.
 */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 5 };

export function formatProtocolVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

/** Whether `client` may talk to `daemon`. */
export function isCompatible(client: ProtocolVersion, daemon: ProtocolVersion): boolean {
  return client.major === daemon.major && daemon.minor >= client.minor;
}
