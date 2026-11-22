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
/**
 * 1.8 adds maintenance admission and optional hello.processId for local supervisors (#306).
 * It is also the first version to advertise the v0.6.0 additive fields that landed under 1.7
 * (#312): `resultIsPreview` on a plan decision, `workflowPinned` on `runs.get`, `model` on a
 * run step, `pinned` on a workflow view, and the `WORKFLOW_VERSION_NOT_FOUND` answer for a
 * version that is neither on disk nor in the store's workflow-version store. All optional, so
 * a 1.7 client reads a 1.8 daemon as before.
 */
/** 1.9 adds authorized typed-input preflight, pinned launch guards, and authenticated local clients. */
/**
 * 1.10 combines durable Request admission/recovery, configuration generations and apply,
 * daemon workspace/boot identity, and owner-local live input fields and invalidation.
 * Methods and inputs.live remain conditional on wired providers and current authority.
 */
/**
 * 2.0 is the operator-runtime integration boundary. Protocol 1.10 clients validate
 * hello capabilities and event payloads with closed schemas: new operator/admission/
 * revision capabilities and `revision.recorded` are not safely ignorable additions.
 * Upgrade clients and daemons together. Optional feature methods still depend on
 * installed providers and caller authority; the major bump does not require them.
 */
/**
 * 2.1 opens the one-release compatibility window (#880): `hello` carries an optional
 * `fallback`, the previous-major version a client can also speak, and a daemon answers in
 * the highest protocol both sides share. An optional parameter, so a 2.0 daemon ignores it
 * and a 2.0 client never sends it; nothing sent before is sent differently.
 *
 * 2.1 also carries agent session slots (#873), unreleased alongside it: optional
 * `sessionSlots` on `hello` and `agents.list`, and the `agent-slot` value of
 * `step.waiting.on` (a plain string). Optional fields on open objects, so a 2.0 client strips
 * them and a 2.0 daemon never sends them. No capability is minted, because a 2.0 client parses
 * `hello.capabilities` with a closed enum; the fields' presence says whether a daemon has them.
 *
 * 2.1 also carries scoped capabilities (#335), unreleased alongside it: an optional
 * `capabilities` manifest (ids and sources only) on each launch selection in a preflight
 * result and in run provenance, and optional `capabilities` fields in config and workflow
 * documents. Optional fields again, stripped by a 2.0 peer.
 */
/**
 * 2.2 adds the `search` read method (#255): a new name in `READ_METHODS`, answered under
 * `runs.read`. A 2.1 client never calls it; a 2.2 client asks `hello.methods` before it does.
 *
 * 2.2 also carries `hello.deployment` (#879), unreleased alongside it: where a daemon run by
 * the managed server updater finds that updater, so the app can run it over SSH. An optional
 * field on an open object, like #873's in 2.1.
 *
 * 2.3 adds the operations view's reads (#340): optional `outcome`, `workflowId`,
 * `workflowVersion`, `createdFrom`, `createdTo`, `runIds` and `operations` on `runs.list`, optional
 * `operations` on `runs.get`, and the optional `operations` field they fill on
 * `RunSummaryView` (last sequence and activity, step counts, lease owner, and host and usage
 * facets that say `unavailable` rather than zero). Every one is optional and asked for: a
 * 2.2 daemon ignores the unknown params and answers the unfiltered page, so a 2.3 client
 * checks the daemon's version before it trusts a filter it sent.
 */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 2, minor: 3 };

/**
 * The previous major this build still speaks, as its last minor, or `undefined` when there is
 * no window open (#880, docs/UPDATING.md "Protocol compatibility window").
 *
 * The rule, kept in this one constant so the two sides cannot disagree:
 *
 * - When a release bumps `PROTOCOL_VERSION.major` to N, it sets this to the final N-1.x.
 *   For that release a daemon accepts N-1 clients, and the app connects to N-1 daemons
 *   with everything N added switched off by capability and explained.
 * - The next major replaces it with the final N.x, so N-1 leaves: the window is one major
 *   wide and one release long, never more. N-2 is refused with a protocol message.
 * - Whatever the major changed has to stay readable to an N-1 peer: the major that sets
 *   this owns the projection of every message it reshaped (capabilities, methods and
 *   events, not only the version negotiation), and it stays `undefined` until that
 *   projection is verified. The N-1 fixtures in
 *   `packages/protocol/test/protocol-window.test.ts` and `packages/app/test/protocol-window.test.ts` are the check.
 * - Store epochs are not part of it. A store migration still needs the matching daemon.
 *
 * It is `undefined` for 2.x because 2.0 was cut before the window existed: a 1.10 client
 * parses `hello.capabilities` and the event payloads with closed schemas, so it cannot read
 * a 2.x daemon safely (see 2.0 above) and stays refused. 3.0 is the first major that ships
 * with a window, and 2.1 is the first daemon that understands a 3.0 client's `fallback`.
 */
export const PREVIOUS_PROTOCOL: ProtocolVersion | undefined = undefined;

/** The versions one side speaks: its own, and the previous major while a window is open. */
export interface ProtocolWindow {
  readonly current: ProtocolVersion;
  readonly previous?: ProtocolVersion;
}

/** This build's window, as a daemon: what it answers `hello` in. */
export const PROTOCOL_WINDOW: ProtocolWindow = windowOf(PROTOCOL_VERSION, PREVIOUS_PROTOCOL);

/**
 * The oldest daemon this build's clients work with on the current major, which is what they
 * offer in `hello` instead of `PROTOCOL_VERSION`. The minor rule refuses a daemon older in
 * minor than the client's offer, so offering this build's own minor would strand every daemon
 * on an earlier minor of the same major the moment a desktop updates.
 *
 * Raise its minor only when the app starts to depend *unconditionally* on something that
 * minor added. A feature behind a capability or `hello.methods` does not need it: an older
 * daemon simply does not advertise it. 2.1 adds only the daemon's reading of `fallback`,
 * which a client never needs, so a 2.1 app still offers 2.0 and reaches shipped 2.0 daemons.
 */
export const CLIENT_PROTOCOL: ProtocolVersion = { major: 2, minor: 0 };

/** This build's window, as a client: what it offers in `hello` and accepts back. */
export const CLIENT_PROTOCOL_WINDOW: ProtocolWindow = windowOf(CLIENT_PROTOCOL, PREVIOUS_PROTOCOL);

/** A window from a current version and an optional previous one, checked for shape. */
export function windowOf(current: ProtocolVersion, previous?: ProtocolVersion): ProtocolWindow {
  if (!previous) return { current };
  if (previous.major !== current.major - 1)
    throw new Error(
      `a protocol window spans one major: ${formatProtocolVersion(previous)} is not the major before ${formatProtocolVersion(current)}`,
    );
  return { current, previous };
}

/** Which of a window's two versions an exchange uses. */
export type ProtocolRelation = "current" | "previous";

export function formatProtocolVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

/** Whether `client` may talk to `daemon`. */
export function isCompatible(client: ProtocolVersion, daemon: ProtocolVersion): boolean {
  return client.major === daemon.major && daemon.minor >= client.minor;
}

/**
 * The daemon's half of the negotiation: given what a client offered (its own version, then
 * its `fallback` if it sent one), the version the daemon answers in, or `undefined` to
 * refuse. The highest common major wins, so two peers on the same major never fall back.
 */
export function negotiateProtocol(
  offered: readonly ProtocolVersion[],
  window: ProtocolWindow = PROTOCOL_WINDOW,
): { protocol: ProtocolVersion; relation: ProtocolRelation } | undefined {
  const candidates: [ProtocolVersion, ProtocolRelation][] = [[window.current, "current"]];
  if (window.previous) candidates.push([window.previous, "previous"]);
  for (const [daemon, relation] of candidates)
    if (offered.some((client) => isCompatible(client, daemon))) return { protocol: daemon, relation };
  return undefined;
}

/**
 * The client's half: whether a daemon that answered `hello` with `daemon` speaks this
 * client's current protocol, its previous one, or neither.
 */
export function daemonRelation(
  daemon: ProtocolVersion,
  window: ProtocolWindow = CLIENT_PROTOCOL_WINDOW,
): ProtocolRelation | undefined {
  if (isCompatible(window.current, daemon)) return "current";
  if (window.previous && isCompatible(window.previous, daemon)) return "previous";
  return undefined;
}

/** What a client puts in `hello`: its own version, and its fallback while a window is open. */
export function helloOffer(window: ProtocolWindow = CLIENT_PROTOCOL_WINDOW): {
  protocol: ProtocolVersion;
  fallback?: ProtocolVersion;
} {
  return window.previous ? { protocol: window.current, fallback: window.previous } : { protocol: window.current };
}

/** The daemon's refusal sentence: what the client spoke and what this daemon accepts. */
export function describeProtocolRefusal(
  offered: readonly ProtocolVersion[],
  window: ProtocolWindow = PROTOCOL_WINDOW,
): string {
  const client = offered.map(formatProtocolVersion).join(" or ");
  const accepts = window.previous
    ? `${formatProtocolVersion(window.current)} and accepts ${window.previous.major}.x clients up to ${formatProtocolVersion(window.previous)}`
    : formatProtocolVersion(window.current);
  return `client speaks protocol ${client}, daemon speaks ${accepts}`;
}
