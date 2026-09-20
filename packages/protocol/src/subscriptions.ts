/**
 * `subscribe` / `unsubscribe` and the seven notifications a subscription produces: six about
 * a run, and `agent.changed`, which is a push about the process rather than about a run.
 *
 * Everything else in this package is request/response. This is the other direction: the
 * daemon pushes, so a client renders a transition when it happens instead of asking five
 * lists every second whether anything moved. The envelope already had the `notification`
 * kind (envelope.ts); these are the methods that travel in one.
 *
 * Three shaping decisions worth knowing before reading the schemas:
 *
 * - **Every *run* notification carries `seq`, and `seq` is the cursor.** It is the sequence
 *   number, within `runId`, of the event that caused the notification. A client that keeps
 *   the highest `seq` it has seen can `subscribe({ runId, since: seq })` after a dropped
 *   connection and be sent `seq + 1` onwards, so a blip costs latency and not data. Sequence
 *   numbers are per-run and gap-free (`EventStore`), which is what makes that work.
 *   `agent.changed` is the one method with neither `runId` nor `seq`: it is about the
 *   process, so there is nothing to resume from. A client that folds the cursor tests for a
 *   `seq` instead of assuming one - see the block at the bottom of this file, which is where
 *   that decision was made, unmade and written down.
 * - **The folded shapes are derived from the transition alone.** `run.changed` and
 *   `step.changed` carry a `DisplayStatus`, folded the same way `runs.list` folds it, but
 *   from the event and nothing else - no store read per notification, and no lease check, so
 *   these two never say `stale`. A client that cares about staleness re-reads `runs.list`;
 *   staleness is the absence of events, which no event stream can announce.
 * - **`agent.update` is batched and `event.appended` excludes it.** An agent turn produces
 *   hundreds of updates a second; sending each one as its own frame, and again inside the
 *   raw stream, would make the socket the bottleneck. So the daemon coalesces agent updates
 *   into at most one `agent.update` per 100 ms per step, and `event.appended` - the raw
 *   firehose a timeline tails - skips `agent.update` events because the coalesced
 *   notification already carries them.
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import { AgentUpdateSummarySchema, GateOptionSchema, OrcaEventSchema, RunOutcomeSchema } from "@orca/core/schemas";
import { AgentViewSchema } from "./agents.js";
import { InputKindSchema } from "./inputs.js";
import { DisplayStatusSchema } from "./status.js";
import { ViewErrorSchema } from "./views.js";

export const SUBSCRIBE_METHOD = "subscribe";
export const UNSUBSCRIBE_METHOD = "unsubscribe";

/**
 * The path a daemon upgrades a WebSocket on. Part of the wire contract rather than the
 * daemon's own business: a client has to know where to connect, and `packages/app` may not
 * import `@orca/daemon` (ADR 0008). `/rpc` and `/health` stay ordinary HTTP on the same port.
 */
export const SOCKET_PATH = "/socket";

/** The `http(s)://host:port` a client reads from turned into the socket URL beside it. */
export function socketUrlFor(httpUrl: string): string {
  return `${httpUrl.replace(/^http/, "ws").replace(/\/+$/, "")}${SOCKET_PATH}`;
}

export const NOTIFICATION_METHODS = [
  "run.changed",
  "step.changed",
  "agent.update",
  "input.opened",
  "input.answered",
  "event.appended",
  "agent.changed",
] as const;
export const NotificationMethodSchema = z.enum(NOTIFICATION_METHODS);
export type NotificationMethod = z.infer<typeof NotificationMethodSchema>;

export const RUN_CHANGED = "run.changed";
export const STEP_CHANGED = "step.changed";
export const AGENT_UPDATE = "agent.update";
export const INPUT_OPENED = "input.opened";
export const INPUT_ANSWERED = "input.answered";
export const EVENT_APPENDED = "event.appended";
export const AGENT_CHANGED = "agent.changed";

/**
 * What every *run* notification carries: which subscription asked for it, which run it is
 * about, and where in that run's log it sits. `subscriptionId` is here because one
 * connection may hold several subscriptions - a run detail screen and a global attention
 * count, say - and a client must be able to route a frame without guessing from its
 * contents.
 *
 * `agent.changed` is about no run and has no cursor, so it is the one method in the union
 * that is not built from this - see it at the bottom of this file.
 */
const notification = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    subscriptionId: z.string(),
    runId: z.string(),
    /** The cursor: sequence number, within `runId`, of the event behind this notification. */
    seq: z.number().int().nonnegative(),
    /** The event's own timestamp, not the moment the frame was sent. */
    at: z.string(),
    ...shape,
  });

/**
 * `run.changed` - a run entered a new state. One per `run.*` event, so a list row can be
 * repainted without re-reading the run.
 */
export const RunChangedParamsSchema = notification({
  /**
   * The eight-value status, folded from this transition. Never `stale`: that is a lapsed
   * lease, which is a thing that failed to happen and so has no event.
   */
  status: DisplayStatusSchema,
  outcome: RunOutcomeSchema.optional(),
  /** The event type behind the transition (`run.started`, `run.paused`, ...). */
  event: z.string(),
  /** The reason the engine recorded, on `run.paused` and `run.cancelled`. */
  reason: z.string().optional(),
  /** Present on `run.failed`. */
  error: ViewErrorSchema.optional(),
});
export type RunChangedParams = z.infer<typeof RunChangedParamsSchema>;

/**
 * `step.changed` - one step run entered a new state. `step.scheduled` is the first a client
 * hears of a step, so that one carries enough (`nodeId`, `nodeType`, `attempt`) to draw a
 * new row; the rest only carry what changed.
 */
export const StepChangedParamsSchema = notification({
  stepRunId: z.string(),
  status: DisplayStatusSchema,
  /** The event type behind the transition (`step.started`, `step.waiting`, ...). */
  event: z.string(),
  /** Present on `step.scheduled`, which introduces the step. */
  nodeId: z.string().optional(),
  nodeType: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  iteration: z.number().int().nonnegative().optional(),
  /** What the step is parked on, on `step.waiting`. */
  waitingOn: z.string().optional(),
  /** `step.failed` says whether another attempt follows; a retry is not a red row. */
  willRetry: z.boolean().optional(),
  error: ViewErrorSchema.optional(),
});
export type StepChangedParams = z.infer<typeof StepChangedParamsSchema>;

/**
 * `agent.update` - the coalesced output of one step's agent. `seq` is the last event in the
 * batch and `fromSeq` the first, so a client that appends `updates` in order ends up with
 * exactly the log, and a client resuming from `seq` loses nothing.
 */
export const AgentUpdateParamsSchema = notification({
  stepRunId: z.string(),
  sessionId: z.string(),
  /** Sequence number of the first event in the batch; `seq` is the last. */
  fromSeq: z.number().int().nonnegative(),
  /** The updates this batch coalesced, oldest first. Never empty. */
  updates: z.array(AgentUpdateSummarySchema).min(1),
});
export type AgentUpdateParams = z.infer<typeof AgentUpdateParamsSchema>;

/** `input.opened` - a step is asking a person something; the attention surface's push. */
export const InputOpenedParamsSchema = notification({
  stepRunId: z.string(),
  requestId: z.string(),
  kind: InputKindSchema,
  question: z.string(),
  /**
   * The options offered, whole (protocol 1.4): `{ id, label, consequence?, destructive? }`.
   * Empty means free text. A card drawn from this frame alone has everything it needs to
   * render the gate, which is the point - the previous `string[]` of ids let a client answer
   * a question it could not show. Answer with an option's `id`; see `inputs.ts`.
   */
  options: z.array(GateOptionSchema),
});
export type InputOpenedParams = z.infer<typeof InputOpenedParamsSchema>;

/** `input.answered` - that ask was settled, by this client or another one. */
export const InputAnsweredParamsSchema = notification({
  stepRunId: z.string(),
  requestId: z.string(),
  answer: z.string(),
});
export type InputAnsweredParams = z.infer<typeof InputAnsweredParamsSchema>;

/**
 * `event.appended` - the raw log entry, for a timeline that renders events rather than
 * state. Every event type except `agent.update`, which arrives coalesced as its own
 * notification instead of once per line (see the file header).
 */
export const EventAppendedParamsSchema = notification({
  event: OrcaEventSchema,
});
export type EventAppendedParams = z.infer<typeof EventAppendedParamsSchema>;

/**
 * `agent.changed` - an agent's handshake health moved. It is a member of
 * `NOTIFICATION_METHODS` and of `DaemonNotification`, and it is the only one that carries
 * neither `runId` nor `seq`.
 *
 * **This reverses the decision recorded here in protocol 1.4 (#241).** That version kept
 * `agent.changed` out of the union on the argument that every member of it is a run event
 * with a resume cursor, and that admitting one without a cursor would mean either
 * fabricating a `seq` or teaching every cursor fold to special-case it. The reasoning was
 * sound and the conclusion was wrong, for three reasons that only showed up once a client
 * tried to receive one:
 *
 * - **The exclusion did not remove the special case, it hid it.** The app's fold guarded on
 *   `notification.params.runId === this.opts.params.runId`, which on a store-wide
 *   subscription compares `undefined` with `undefined` and is therefore already true. Had
 *   `agent.changed` reached it, `undefined` would have been folded into the cursor. The fold
 *   had to learn `typeof params.seq === "number"` either way; being in the union is what
 *   makes the type system say so at the one site that matters instead of leaving it to a
 *   client to notice.
 * - **A second parser is a second channel.** `parseAgentChanged` meant every consumer needed
 *   two entry points, two routes and two unsubscribes for one socket. The renderer's
 *   `createNotificationStream` routes by method over one subscription; a push outside the
 *   union could only be reached by a parallel path beside it, which is the duplication the
 *   stream exists to prevent.
 * - **"Not in the union" reads as "not a notification".** `parseNotification` dropped it, so
 *   in practice the frame reached no client at all: the daemon sent something nothing could
 *   receive. A method a client is expected to handle belongs where a client looks for methods.
 *
 * What the old rationale got right survives as a property of this schema rather than as an
 * exclusion: there is still no cursor, still nothing to replay, and still no run. A client
 * reconnecting re-reads `agents.list` - the current answer is one call away - and `since`
 * still refuses to travel without a `runId`.
 *
 * The daemon's half is unchanged: it sends this only to subscriptions that did **not** scope
 * themselves to a run, because an agent is a property of the process and a run screen would
 * only be woken by work it is not showing. It is pushed from a **listener** on the health
 * tracker rather than a poll, and it fires on the two things that change what a card says: a
 * handshake that succeeded and one that failed, whoever caused them. It does **not** fire on
 * `lastSeenAt` moving - that advances with every batch of agent output, and a frame per batch
 * is the firehose the `agent.update` coalescing exists to prevent.
 */
export const AgentChangedParamsSchema = z.object({
  subscriptionId: z.string(),
  /** When the health was recorded, by the daemon's clock. Not a cursor. */
  at: z.string(),
  /** The agent as `agents.list` would now report it. */
  agent: AgentViewSchema,
});
export type AgentChangedParams = z.infer<typeof AgentChangedParamsSchema>;

/** Each notification method's params schema, so a client can validate one it routed by name. */
export const NOTIFICATION_PARAMS = {
  [RUN_CHANGED]: RunChangedParamsSchema,
  [STEP_CHANGED]: StepChangedParamsSchema,
  [AGENT_UPDATE]: AgentUpdateParamsSchema,
  [INPUT_OPENED]: InputOpenedParamsSchema,
  [INPUT_ANSWERED]: InputAnsweredParamsSchema,
  [EVENT_APPENDED]: EventAppendedParamsSchema,
  [AGENT_CHANGED]: AgentChangedParamsSchema,
} as const satisfies Record<NotificationMethod, z.ZodType>;

/** Method name to params type, for a client that switches on the method. */
export interface NotificationParamsByMethod {
  "run.changed": RunChangedParams;
  "step.changed": StepChangedParams;
  "agent.update": AgentUpdateParams;
  "input.opened": InputOpenedParams;
  "input.answered": InputAnsweredParams;
  "event.appended": EventAppendedParams;
  "agent.changed": AgentChangedParams;
}

/** A parsed notification: a discriminated union, so `switch (n.method)` narrows `n.params`. */
export type DaemonNotification = {
  [M in NotificationMethod]: { method: M; params: NotificationParamsByMethod[M] };
}[NotificationMethod];

/**
 * Validate one notification envelope into the union above, or `undefined` when it is not a
 * notification this version knows. Unknown is not an error: a newer daemon may push a method
 * this client has never heard of, and dropping it is the compatible thing to do.
 */
export function parseNotification(message: { method: string; params?: unknown }): DaemonNotification | undefined {
  const method = NotificationMethodSchema.safeParse(message.method);
  if (!method.success) return undefined;
  const params = NOTIFICATION_PARAMS[method.data].safeParse(message.params);
  if (!params.success) return undefined;
  // The table maps each method to exactly its own schema (`satisfies` above pins that), but
  // an indexed lookup keyed by a union widens the result back to the union of all of them.
  return { method: method.data, params: params.data } as DaemonNotification;
}

/**
 * `subscribe` - start a push stream on this connection. HTTP has nowhere to push to, so this
 * method only exists over the WebSocket endpoint; the daemon refuses it on `/rpc`.
 */
export const SubscribeParamsSchema = z
  .object({
    /** Only this run. Absent: every run in the store, children included. */
    runId: z.string().min(1).optional(),
    /** Only these notification methods. Absent or empty: all of them. */
    methods: z.array(NotificationMethodSchema).optional(),
    /**
     * Resume: replay from `since + 1` before the live stream takes over. A sequence number is
     * per-run, so this needs a `runId` - a store-wide subscription has no single cursor.
     */
    since: z.number().int().nonnegative().optional(),
  })
  .refine((p) => p.since === undefined || p.runId !== undefined, {
    message: "'since' needs a 'runId': a cursor is a sequence number within one run",
  });
export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;

export const SubscribeResultSchema = z.object({
  /** Pass to `unsubscribe`; every notification of this stream carries it. */
  subscriptionId: z.string(),
  /** How many notifications the replay sent before the live stream took over. */
  replayed: z.number().int().nonnegative(),
});
export type SubscribeResult = z.infer<typeof SubscribeResultSchema>;

export const UnsubscribeParamsSchema = z.object({ subscriptionId: z.string().min(1) });
export type UnsubscribeParams = z.infer<typeof UnsubscribeParamsSchema>;

export const UnsubscribeResultSchema = z.object({
  /** False when the id was not a live subscription - unsubscribing twice is not an error. */
  stopped: z.boolean(),
});
export type UnsubscribeResult = z.infer<typeof UnsubscribeResultSchema>;
