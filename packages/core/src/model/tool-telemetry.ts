/**
 * Tool-call telemetry from native pre-tool hooks (#1000): what a hook saw and answered for
 * one tool call, kept in ORCA's store for diagnosis when an agent opts in.
 *
 * Two shapes, deliberately apart:
 *
 * - {@link HookTelemetryLineSchema} is what a hook appends to its session's spool. The hook
 *   runs in the agent's process tree, so the agent can write the same file: every line is
 *   untrusted input. It is parsed strictly, and a line that does not parse is dropped.
 * - {@link ToolCallTelemetrySchema} is what ORCA stores. Everything that says *where* the
 *   record belongs (run, session, step, agent, sequence, receipt time, expiry) is stamped by
 *   ORCA and never taken from the line. Everything taken from the line is bounded, redacted of
 *   the session's secret values (#336), and marked `source: "hook-reported"`: it is what the
 *   hook says it saw and decided, not something ORCA observed.
 *
 * Telemetry is diagnostic only. It is never an audit record, never decides anything, and a
 * hook's answer never waits on it.
 */
import { z } from "zod";

/** The spool line format the hook writes. A line with any other `v` is dropped. */
export const HOOK_TELEMETRY_LINE_VERSION = 1;

/** The most bytes one spool line may take, newline included. Longer lines are dropped. */
export const HOOK_TELEMETRY_LINE_LIMIT = 8 * 1024;

/** The answers a hook can give: `block` is the hook's own failure (exit 2), never a rule. */
export const HookTelemetryDecisionSchema = z.enum(["allow", "ask", "deny", "block"]);
export type HookTelemetryDecision = z.infer<typeof HookTelemetryDecisionSchema>;

/** Bounds on what a stored record keeps from a line. Longer text is cut, and says so. */
export const TOOL_TELEMETRY_LIMITS = {
  tool: 200,
  toolUseId: 200,
  kind: 64,
  title: 500,
  rule: 200,
  hookError: 500,
  /** Same bound as a tool call's args in the event log (`TOOL_BODY_MAX_CHARS`). */
  input: 2_000,
} as const;

/** A latency longer than this is not a hook that answered in time; it is a broken line. */
const LATENCY_LIMIT_MS = 24 * 60 * 60 * 1000;

const text = z.string().max(HOOK_TELEMETRY_LINE_LIMIT);

/** One line of a hook's spool, as the hook writes it. Untrusted: see the module comment. */
export const HookTelemetryLineSchema = z.strictObject({
  v: z.literal(HOOK_TELEMETRY_LINE_VERSION),
  /** When the hook saw the call, by the hook's clock. Kept as reported. */
  at: z.string().datetime({ offset: true }),
  /** The agent's tool name (`Bash`, `Edit`, `mcp__server__tool`). */
  tool: text.min(1),
  /** The agent's id for the call, when its hook frame carries one. */
  toolUseId: text.optional(),
  /** ACP-style kind (`read`, `edit`, `execute`, ...) the hook derived for the call. */
  kind: text.optional(),
  /** The title the hook matched rules against. */
  title: text.optional(),
  /** What the call was made with, as the hook saw it. Redacted and cut by ORCA. */
  input: z.unknown().optional(),
  decision: HookTelemetryDecisionSchema,
  /** Which rule decided, as the hook names it. */
  rule: text.optional(),
  latencyMs: z.number().finite().nonnegative().max(LATENCY_LIMIT_MS),
  /** The hook's own failure, when `decision` is `block` because something went wrong. */
  hookError: text.optional(),
});
export type HookTelemetryLine = z.infer<typeof HookTelemetryLineSchema>;

/** A text field as stored: cut to its bound, with the length it had before. */
export const TelemetryTextSchema = z.object({ text: z.string(), length: z.number().int().nonnegative() });
export type TelemetryText = z.infer<typeof TelemetryTextSchema>;

/** One stored tool-call record. */
export const ToolCallTelemetrySchema = z.object({
  v: z.literal(1),
  /** `<sessionId>:<seq>`: unique within the store. */
  id: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  /** The step the session was serving when ORCA ingested the line. */
  stepRunId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  /** ORCA's per-session ingestion order. */
  seq: z.number().int().nonnegative(),
  /** Always `hook-reported`: the content is what the hook says, not what ORCA saw. */
  source: z.literal("hook-reported"),
  /** When ORCA ingested the line, by ORCA's clock. */
  receivedAt: z.string(),
  /** When retention removes the record (`agents[].diagnostics.retainDays` after receipt). */
  expiresAt: z.string(),
  /** The hook's `at`, as reported. */
  reportedAt: z.string(),
  tool: TelemetryTextSchema,
  toolUseId: TelemetryTextSchema.optional(),
  kind: TelemetryTextSchema.optional(),
  title: TelemetryTextSchema.optional(),
  /** JSON-encoded, redacted, cut to `TOOL_TELEMETRY_LIMITS.input`. */
  input: TelemetryTextSchema.optional(),
  decision: HookTelemetryDecisionSchema,
  rule: TelemetryTextSchema.optional(),
  latencyMs: z.number().nonnegative(),
  hookError: TelemetryTextSchema.optional(),
});
export type ToolCallTelemetry = z.infer<typeof ToolCallTelemetrySchema>;

/** `value` cut to `max` characters, with the length it had. */
export function telemetryText(value: string, max: number): TelemetryText {
  return { text: value.length > max ? value.slice(0, max) : value, length: value.length };
}

/** Per-agent diagnostics options (`agents[].diagnostics`). Everything is off unless turned on. */
export const AgentDiagnosticsSchema = z.strictObject({
  /**
   * `keep` stores a record of every tool call the agent's native pre-tool hook decides
   * (#1000). Only calls the hook covers are recorded; it needs `nativeToolHook: experimental`.
   * Default `off`: nothing is recorded.
   */
  toolCalls: z.enum(["off", "keep"]).default("off"),
  /** Days a record is kept after ORCA receives it. */
  retainDays: z.number().int().min(1).max(365).default(30),
});
export type AgentDiagnostics = z.infer<typeof AgentDiagnosticsSchema>;
