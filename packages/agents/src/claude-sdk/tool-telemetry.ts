/**
 * Tool-call telemetry from the Claude Agent SDK route's in-process `PreToolUse` hook (#1123),
 * handed to the engine the way a native hook's spool is (#1000): the same v1 lines, fitted to
 * the same line limit and checked against the same schema, the same per-session line limit, and
 * the same `attach` / `drain` / `finish` the engine already reads a spool through.
 *
 * The hook runs in the daemon, so there is no file and nothing the agent could write to: a line
 * is kept in memory until the next drain. As with a spool, lines drained before a consumer is
 * attached are dropped, a consumer's failure drops that drain's lines, and `record` never throws,
 * so recording can never change an answer.
 */
import { HookTelemetryLineSchema, type HookTelemetryLine } from "@orca/core";
import {
  HOOK_TELEMETRY_SESSION_LINES,
  fitHookTelemetryLine,
  type HookTelemetryConsumer,
  type HookTelemetryDrainReport,
  type HookTelemetrySource,
} from "../hook-telemetry.js";

export interface InProcessHookTelemetry extends HookTelemetrySource {
  /** The hook's side: one line per decided call. Never throws; ignored once finished. */
  record(line: HookTelemetryLine): void;
}

export function inProcessHookTelemetry(): InProcessHookTelemetry {
  let consumer: HookTelemetryConsumer | undefined;
  let pending: HookTelemetryLine[] = [];
  let rejected = 0;
  let dropped = 0;
  let kept = 0;
  let ended = false;
  let finished: Promise<HookTelemetryDrainReport> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const once = async (): Promise<HookTelemetryDrainReport> => {
    const out: HookTelemetryDrainReport = { accepted: 0, rejected, dropped };
    rejected = dropped = 0;
    const lines = pending;
    pending = [];
    if (!lines.length) return out;
    if (!consumer) return { ...out, dropped: out.dropped + lines.length };
    try {
      await consumer(lines);
      return { ...out, accepted: lines.length };
    } catch {
      return { ...out, dropped: out.dropped + lines.length };
    }
  };
  const serialized = () => {
    const next = queue.then(once, () => ({ accepted: 0, rejected: 0, dropped: 0 }));
    queue = next;
    return next;
  };

  return {
    record(line) {
      if (ended) return;
      try {
        const fitted = fitHookTelemetryLine(line);
        const parsed = fitted === undefined ? undefined : HookTelemetryLineSchema.safeParse(fitted);
        if (!parsed?.success) rejected++;
        else if (kept >= HOOK_TELEMETRY_SESSION_LINES) dropped++;
        else {
          kept++;
          pending.push(parsed.data);
        }
      } catch {
        rejected++;
      }
    },
    attach(next) {
      consumer = next;
    },
    drain() {
      return finished ?? serialized();
    },
    finish() {
      ended = true;
      return (finished ??= serialized());
    },
  };
}
