/**
 * The engine's end of the hook telemetry channel (#1000): turning validated spool lines into
 * stored, run- and session-scoped records.
 *
 * The spool (`@orca/agents` `hook-telemetry.ts`) has already dropped every line that is not a
 * valid v1 line. Here, for each one:
 *
 * - **Where it belongs comes from ORCA**: run, session, step, agent, sequence, receipt time
 *   and expiry are stamped from the session the spool belongs to. Nothing in the line can
 *   name another run or session.
 * - **Secret values are redacted** (#336): every text field, and the call's input before and
 *   after it is encoded and cut, goes through the same redaction as the run's log, with the
 *   secret values the run's sessions resolved and its sensitive inputs.
 * - **Everything is bounded** (`TOOL_TELEMETRY_LIMITS`), keeping the length it had.
 * - **It is marked `hook-reported`**: what the hook says it saw and decided.
 *
 * A store write that fails drops the batch; telemetry never fails a step or a session.
 */
import {
  TOOL_TELEMETRY_LIMITS,
  telemetryText,
  toolCallBody,
  type Clock,
  type HookTelemetryLine,
  type Logger,
  type TelemetryText,
  type ToolCallTelemetry,
} from "@orca/core";
import type { HookTelemetrySpool } from "@orca/agents";
import type { ToolTelemetryStore } from "@orca/store";

/** How often a running session's spool is drained. */
export const HOOK_TELEMETRY_DRAIN_MS = 5_000;

/** How often, at most, one store's expired records are removed. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const lastPrune = new WeakMap<ToolTelemetryStore, number>();

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HookTelemetryScope {
  runId: string;
  sessionId: string;
  agentId: string;
  /** The step the session serves now; a per-run session moves from step to step. */
  stepRunId: () => string | undefined;
  /** `agents[].diagnostics.retainDays`. */
  retainDays: number;
}

/** Build the stored records for a batch of lines. Pure apart from `redact`. */
export function toolTelemetryRecords(
  lines: readonly HookTelemetryLine[],
  scope: Omit<HookTelemetryScope, "stepRunId"> & { stepRunId: string | undefined },
  options: { firstSeq: number; now: Date; redact: <T>(value: T) => T },
): ToolCallTelemetry[] {
  const { now, redact } = options;
  const receivedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + scope.retainDays * DAY_MS).toISOString();
  const field = (value: string | undefined, max: number): TelemetryText | undefined =>
    value === undefined ? undefined : telemetryText(redact(value), max);
  return lines.map((line, index) => {
    const seq = options.firstSeq + index;
    // Redact the value, then the encoded and cut text: a value can be split by the cut, or
    // appear only once encoded (an escaped quote, a newline).
    const body = line.input === undefined ? undefined : toolCallBody(redact(line.input), TOOL_TELEMETRY_LIMITS.input);
    const input = body ? { text: redact(body.text), length: body.length } : undefined;
    const record: ToolCallTelemetry = {
      v: 1,
      id: `${scope.sessionId}:${seq}`,
      runId: scope.runId,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      seq,
      source: "hook-reported",
      receivedAt,
      expiresAt,
      reportedAt: line.at,
      tool: telemetryText(redact(line.tool), TOOL_TELEMETRY_LIMITS.tool),
      decision: line.decision,
      latencyMs: line.latencyMs,
    };
    if (scope.stepRunId !== undefined) record.stepRunId = scope.stepRunId;
    const optional = {
      toolUseId: field(line.toolUseId, TOOL_TELEMETRY_LIMITS.toolUseId),
      kind: field(line.kind, TOOL_TELEMETRY_LIMITS.kind),
      title: field(line.title, TOOL_TELEMETRY_LIMITS.title),
      input,
      rule: field(line.rule, TOOL_TELEMETRY_LIMITS.rule),
      hookError: field(line.hookError, TOOL_TELEMETRY_LIMITS.hookError),
    };
    for (const key of Object.keys(optional) as (keyof typeof optional)[])
      if (optional[key] !== undefined) record[key] = optional[key];
    return record;
  });
}

export interface AttachHookTelemetryOptions {
  spool: HookTelemetrySpool;
  store: ToolTelemetryStore;
  scope: HookTelemetryScope;
  /** The run's redaction: its sessions' resolved secret values and its sensitive inputs. */
  redact: <T>(value: T) => T;
  clock: Clock;
  logger: Logger;
  intervalMs?: number | undefined;
}

/**
 * Attach the store as the spool's consumer and drain it every few seconds until the session
 * closes. Returns a stop function; the session's own `finish()` does the last drain.
 */
export function attachHookTelemetry(options: AttachHookTelemetryOptions): () => void {
  const { spool, store, scope, redact, clock, logger } = options;
  let seq = 0;
  spool.attach(async (lines) => {
    const now = new Date(clock.now());
    const records = toolTelemetryRecords(
      lines,
      { ...scope, stepRunId: scope.stepRunId() },
      { firstSeq: seq, now, redact },
    );
    seq += lines.length;
    try {
      await store.append(records);
    } catch (error) {
      logger.warn("tool telemetry could not be stored; the records are dropped", {
        sessionId: scope.sessionId,
        records: records.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const at = now.getTime();
    if (at - (lastPrune.get(store) ?? 0) >= PRUNE_EVERY_MS) {
      lastPrune.set(store, at);
      void store.prune(now).catch((error: unknown) =>
        logger.warn("expired tool telemetry could not be removed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  const timer = setInterval(() => void spool.drain(), options.intervalMs ?? HOOK_TELEMETRY_DRAIN_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
