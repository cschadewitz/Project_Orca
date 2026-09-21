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
 *
 * 1.6 adds `agent` to `OpenInputView` and to `input.opened` (#248): which agent's turn a
 * permission ask is holding open, and the host it runs on. An optional field joining two
 * existing views, so a minor by the rule above; nothing sent before is sent differently.
 * It is optional on the wire as well as in the rule - a workflow gate is nobody's agent -
 * so a client reads its absence as "no agent is blocked", never as a field that failed.
 *
 * 1.7 (2026-09-21) is the v0.5.0 wave: the configuration methods, the workflow viewer's wire
 * and the plan methods land together, each an addition by this file's own rule.
 *
 * The workflow viewer's wire (#174, for #177): the two read methods
 * `workflows.list` and `workflows.get` with `WorkflowSummaryView` and `WorkflowView` behind
 * them, an optional `traversal` on `RunsGetResult` - the nodes a run took, in order, with
 * their attempts and the edges between them - and the `workflows.changed` notification.
 * Three additions by this file's own rule: two methods joining `READ_METHODS`, one optional
 * field joining an existing result, one method joining `NOTIFICATION_METHODS`. Nothing sent
 * before is sent differently, and a 1.6 client reading a 1.7 daemon sees a `runs.get` with
 * one more key it ignores.
 *
 * `workflows.changed` is in the list with nothing emitting it, which is stated rather than
 * hidden: there is no workflow reload path in the runtime today (see its schema), so a
 * client may subscribe now and will hear one when v0.6.0's editor can honestly send it.
 *
 * The configuration methods - `config.get` in `READ_METHODS`,
 * `config.set` in `CONTROL_METHODS` - the `config.changed` notification, and the
 * `CONFIG_STALE` control error code (#174, #266). Additions by this file's own rule: two
 * methods, one notification method joining the list clients read by name, and one more code
 * in a list that was always documented as open-ended (`ProtocolErrorSchema.code` is a plain
 * string so a newer daemon's codes still parse). Nothing sent before is sent differently.
 *
 * The one thing worth saying out loud, because it is a capability decision and not a shape:
 * neither method mints a capability. `config.get` is answered under `runs.read` and
 * `config.set` under `runs.control`, so a 1.6 client that hid its write buttons on the
 * absence of `runs.control` goes on hiding exactly the right ones, and a `--read-only`
 * daemon omits `config.set` from `hello.methods` the way it omits the other four.
 *
 * The plan surface (#169): the nine reads `plans.list`, `plan.get`,
 * `items.list`, `schedule.get`, `schedule.explain`, `dependencies.list`, `risks.list`,
 * `decisions.list` and `journal.list`; the writes `dependencies.waive`, `decisions.decide`,
 * `decisions.reopen`, `risks.update` and `claims.release` (#88); and the `plan.changed`
 * notification. Every one of them is new - no message that was sent before is sent
 * differently - so a minor by this file's rule. A 1.6 client's `parseNotification` drops
 * `plan.changed` as a method it has never heard of, which is what it will go on doing, and a
 * 1.6 client reading `hello.methods` simply sees fourteen names it does not call.
 *
 * The plan surface *does* mint capabilities, unlike the configuration methods above:
 * `plan.read` and `plan.write` join `DAEMON_CAPABILITIES` in 1.7. They are not a `runs.read` /
 * `runs.control` restatement - a daemon can serve a store that has no plan in it at all, and
 * then answers the run methods and none of the plan ones - so a client that wants to know
 * whether to draw a plan surface has a question to ask that `runs.read` cannot answer. Both
 * are derived from what the daemon was actually built with rather than asserted, so a
 * capability and the methods behind it cannot disagree. Two new names in an enum a 1.6 client
 * reads by lookup: it finds the two it knows and ignores the rest.
 *
 * `EffectivePermissionRule.source` gains a third value, `default`, for the rules
 * `@orca/agents` appends after both documents (#140). An addition to an enum inside a
 * `config.get` result, not a new field: 1.7 is the first version to carry `config.get` at all,
 * so no client has ever seen this field with only two values in it. It is deliberately not a
 * `ConfigDocument` - there is no file behind it and `config.set` cannot address it - and a
 * client that switches on the source shows it as the floor it is rather than as config
 * somebody wrote.
 */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 1, minor: 7 };

export function formatProtocolVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

/** Whether `client` may talk to `daemon`. */
export function isCompatible(client: ProtocolVersion, daemon: ProtocolVersion): boolean {
  return client.major === daemon.major && daemon.minor >= client.minor;
}
