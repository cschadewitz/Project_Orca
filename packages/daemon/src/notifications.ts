/**
 * Log event in, notification out. The one place that knows which `OrcaEvent` becomes which
 * of the six push methods in `@orca/protocol`, and it is a pure function of the event, so it
 * can be tested without a socket, a store or a clock.
 *
 * Purity is the point, not a convenience. A notification derived from the event alone costs
 * nothing per event and can never disagree with the log; a notification that read the store
 * to enrich itself would turn one append into a projection, which is exactly the cost the
 * push channel exists to avoid. What that rules out is `stale` - a lapsed lease is the
 * absence of events, so no event stream can announce it, and a client that cares re-reads
 * `runs.list`. `@orca/protocol`'s `subscriptions.ts` says the same thing from the wire side.
 *
 * `agent.update` events are *not* mapped here: they are coalesced over a 100 ms window by
 * `Subscription` (subscriptions.ts) and sent as one notification carrying many updates.
 * `event.appended` skips them for the same reason - the raw firehose would otherwise ship
 * every agent line twice.
 */
import type { OrcaEvent } from "@orca/core";
import {
  EVENT_APPENDED,
  INPUT_ANSWERED,
  INPUT_OPENED,
  RUN_CHANGED,
  STEP_CHANGED,
  displayStatusForRun,
  displayStatusForStep,
  type DaemonNotification,
  type NotificationMethod,
} from "@orca/protocol";

/** The engine run status each `run.*` event puts the run into. */
const RUN_STATUS = {
  "run.created": "created",
  "run.started": "running",
  "run.resumed": "running",
  "run.paused": "paused",
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
} as const;

/** The engine step status each `step.*` event puts the step into. */
const STEP_STATUS = {
  "step.scheduled": "scheduled",
  "step.started": "running",
  "step.waiting": "waiting",
  "step.completed": "completed",
  "step.failed": "failed",
  "step.cancelled": "cancelled",
  "step.skipped": "skipped",
} as const;

/** What every notification carries: where it came from and where in the log it sits. */
function base(event: OrcaEvent, subscriptionId: string) {
  return { subscriptionId, runId: event.runId, seq: event.seq, at: event.at };
}

/**
 * The folded notifications one event produces, in the order they should be sent. Most events
 * produce one (`event.appended`); a `run.*`, `step.*` or `human.*` event produces two, the
 * folded one first so a client that only listens for `step.changed` is never behind a client
 * that also tails the raw log.
 *
 * `agent.update` produces none - see the file header.
 */
export function notificationsFor(event: OrcaEvent, subscriptionId: string): DaemonNotification[] {
  const out: DaemonNotification[] = [];
  const at = base(event, subscriptionId);

  if (event.type in RUN_STATUS) {
    const status = RUN_STATUS[event.type as keyof typeof RUN_STATUS];
    const outcome = event.type === "run.completed" ? event.payload.outcome : undefined;
    const reason = event.type === "run.paused" || event.type === "run.cancelled" ? event.payload.reason : undefined;
    const error = event.type === "run.failed" ? event.payload.error : undefined;
    out.push({
      method: RUN_CHANGED,
      params: {
        ...at,
        status: displayStatusForRun({ status, ...(outcome ? { outcome } : {}) }),
        event: event.type,
        ...(outcome ? { outcome } : {}),
        ...(reason ? { reason } : {}),
        ...(error ? { error: { code: error.code, message: error.message } } : {}),
      },
    });
  } else if (event.type in STEP_STATUS) {
    const status = STEP_STATUS[event.type as keyof typeof STEP_STATUS];
    const waitingOn = event.type === "step.waiting" ? event.payload.on : undefined;
    const error = event.type === "step.failed" ? event.payload.error : undefined;
    // Only `step.scheduled` introduces the step; the rest name a step the client already has.
    const intro =
      event.type === "step.scheduled"
        ? {
            nodeId: event.payload.nodeId,
            nodeType: event.payload.nodeType,
            attempt: event.payload.attempt,
            ...(event.payload.iteration === undefined ? {} : { iteration: event.payload.iteration }),
          }
        : {};
    out.push({
      method: STEP_CHANGED,
      params: {
        ...at,
        stepRunId: (event.payload as { stepRunId: string }).stepRunId,
        status: displayStatusForStep({ status, ...(waitingOn ? { waitingOn } : {}) }),
        event: event.type,
        ...intro,
        ...(waitingOn ? { waitingOn } : {}),
        ...(event.type === "step.failed" ? { willRetry: event.payload.willRetry } : {}),
        ...(error ? { error: { code: error.code, message: error.message } } : {}),
      },
    });
  } else if (event.type === "human.requested") {
    out.push({
      method: INPUT_OPENED,
      params: {
        ...at,
        stepRunId: event.payload.stepRunId,
        requestId: event.payload.requestId,
        kind: event.payload.kind,
        question: event.payload.question,
        // The whole `GateOption` (protocol 1.4). `GateOptionSchema` has already read a
        // pre-#220 log's bare strings as `{ id: s, label: s }` by the time the event gets
        // here, so an old log pushes the same shape as a new one.
        options: event.payload.options,
      },
    });
  } else if (event.type === "human.answered") {
    out.push({
      method: INPUT_ANSWERED,
      params: {
        ...at,
        stepRunId: event.payload.stepRunId,
        requestId: event.payload.requestId,
        answer: event.payload.answer,
      },
    });
  } else if (event.type === "agent.update") {
    // Coalesced by the subscription, and deliberately absent from the raw stream too.
    return out;
  }

  out.push({ method: EVENT_APPENDED, params: { ...at, event } });
  return out;
}

/** Whether a subscription that asked for `methods` wants this one. Empty or absent: all of them. */
export function wants(methods: readonly NotificationMethod[] | undefined, method: NotificationMethod): boolean {
  return !methods?.length || methods.includes(method);
}
