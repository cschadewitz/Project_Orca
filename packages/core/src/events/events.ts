/**
 * The event log is ORCA's source of truth. Every state change in a run is an
 * appended, immutable event; run state is a projection (reduce.ts). This makes
 * runs resumable after a crash, auditable ("which artifact did the reviewer
 * actually see?"), and streamable to UIs or upstream ACP clients.
 */
import { z } from "zod";
import { ArtifactSchema } from "../model/artifact.js";
import {
  BranchSkipReasonSchema,
  ErrorInfoSchema,
  GateOptionSchema,
  RunOutcomeSchema,
  RunStatusSchema,
  StepResultSchema,
  WorkspaceSchema,
} from "../model/run.js";

const base = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    id: z.string(),
    /** Per-run monotonic sequence number, assigned by the event store. */
    seq: z.number().int().nonnegative(),
    runId: z.string(),
    at: z.string(),
    type: z.literal(type),
    payload,
  });

/**
 * The most characters of one tool call body - its args, or its result - that go
 * into the event log. A tool that reads a 48,000-character file must not put the
 * file in the log: the log is replayed in full on every read of a run, and it is
 * the same bound #158 puts on a rendered line.
 */
export const TOOL_BODY_MAX_CHARS = 2_000;

/**
 * One side of a tool call as stored: the args the agent sent, or the result it
 * got back, JSON-encoded and capped at `TOOL_BODY_MAX_CHARS`.
 *
 * `length` is the length the body had *before* the cap, so a reader can say
 * "this was 48,000 characters, you are seeing 2,000" without guessing and
 * without the answer drifting if the cap is ever changed. When nothing was
 * dropped, `length === text.length`; `toolBodyTruncated` is that comparison.
 */
export const ToolCallBodySchema = z.object({
  text: z.string(),
  length: z.number().int().nonnegative(),
});
export type ToolCallBody = z.infer<typeof ToolCallBodySchema>;

/** True when `text` is a prefix of a longer body and `length` says how much longer. */
export function toolBodyTruncated(body: ToolCallBody): boolean {
  return body.length > body.text.length;
}

/**
 * Cap a tool call body for the log. Emitters call this; readers never do, so
 * what is on disk is what was decided at write time and replay is deterministic.
 *
 * Nothing to store - absent, null, empty, or a value JSON cannot encode (a
 * cycle, a BigInt) - is `undefined`, which is a tool call row with nothing to
 * expand rather than an empty one.
 */
export function toolCallBody(value: unknown, max: number = TOOL_BODY_MAX_CHARS): ToolCallBody | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return undefined;
      text = encoded;
    } catch {
      return undefined;
    }
  }
  if (!text.length) return undefined;
  return { text: text.length > max ? text.slice(0, max) : text, length: text.length };
}

/** Compact, storage-friendly form of an ACP session update. */
export const AgentUpdateSummarySchema = z.object({
  kind: z.string(), // ACP sessionUpdate discriminator
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  toolKind: z.string().optional(),
  status: z.string().optional(),
  locations: z.array(z.string()).optional(),
  /** What the tool was called with. Absent on updates that are not tool calls, and on logs written before v0.4.0. */
  args: ToolCallBodySchema.optional(),
  /** What the tool came back with. Absent until the call reports a result. */
  result: ToolCallBodySchema.optional(),
  planEntries: z.array(z.object({ content: z.string(), status: z.string(), priority: z.string() })).optional(),
});
export type AgentUpdateSummary = z.infer<typeof AgentUpdateSummarySchema>;

export const OrcaEventSchema = z.discriminatedUnion("type", [
  base(
    "run.created",
    z.object({
      workflowId: z.string(),
      workflowVersion: z.string(),
      requestId: z.string().optional(),
      workItemId: z.string().optional(),
      parentRunId: z.string().optional(),
      parentStepRunId: z.string().optional(),
      workspace: WorkspaceSchema,
      vars: z.record(z.string(), z.unknown()),
    }),
  ),
  base("run.started", z.object({})),
  base("run.paused", z.object({ reason: z.string().optional() })),
  base("run.resumed", z.object({})),
  base("run.completed", z.object({ outcome: RunOutcomeSchema, message: z.string().optional() })),
  base("run.failed", z.object({ error: ErrorInfoSchema })),
  base("run.cancelled", z.object({ reason: z.string().optional() })),
  base("vars.set", z.object({ vars: z.record(z.string(), z.unknown()) })),

  base(
    "step.scheduled",
    z.object({
      stepRunId: z.string(),
      nodeId: z.string(),
      nodeType: z.string(),
      attempt: z.number().int().positive(),
      iteration: z.number().int().nonnegative().optional(),
      /** Edge that led here (for tracing). */
      viaEdge: z.object({ from: z.string(), label: z.string().optional() }).optional(),
    }),
  ),
  base("step.started", z.object({ stepRunId: z.string(), inputArtifactIds: z.array(z.string()).default([]) })),
  /**
   * Artifacts the step actually read, appended as they resolve (a step may resolve inputs more
   * than once). Ids accumulate into `StepRun.inputArtifactIds`; `step.started` cannot carry them
   * because inputs are resolved by the executor, after the step starts.
   */
  base("step.inputs", z.object({ stepRunId: z.string(), artifactIds: z.array(z.string()) })),
  base("step.waiting", z.object({ stepRunId: z.string(), on: z.string(), detail: z.string().optional() })),
  base("step.completed", z.object({ stepRunId: z.string(), result: StepResultSchema })),
  base("step.failed", z.object({ stepRunId: z.string(), error: ErrorInfoSchema, willRetry: z.boolean() })),
  base("step.cancelled", z.object({ stepRunId: z.string() })),
  base("step.skipped", z.object({ stepRunId: z.string(), reason: z.string() })),

  base(
    "agent.session.opened",
    z.object({
      stepRunId: z.string(),
      sessionId: z.string(),
      agentId: z.string(),
      hostId: z.string(),
      cwd: z.string(),
    }),
  ),
  base(
    "agent.turn.started",
    z.object({
      stepRunId: z.string(),
      sessionId: z.string(),
      promptHash: z.string(),
      promptPreview: z.string(),
      followUp: z.number().int().nonnegative(),
    }),
  ),
  base("agent.update", z.object({ stepRunId: z.string(), sessionId: z.string(), update: AgentUpdateSummarySchema })),
  base(
    "agent.permission",
    z.object({
      stepRunId: z.string(),
      sessionId: z.string(),
      toolCallId: z.string().optional(),
      title: z.string(),
      decision: z.string(),
    }),
  ),
  base(
    "agent.turn.completed",
    z.object({ stepRunId: z.string(), sessionId: z.string(), stopReason: z.string(), durationMs: z.number() }),
  ),
  base(
    "agent.session.closed",
    z.object({ stepRunId: z.string(), sessionId: z.string(), error: ErrorInfoSchema.optional() }),
  ),

  base("artifact.recorded", z.object({ stepRunId: z.string(), artifact: ArtifactSchema })),
  base(
    "artifact.rejected",
    z.object({ stepRunId: z.string(), kind: z.string(), path: z.string(), reason: z.string() }),
  ),

  /** Planning signals the artifact carried that the plan refused; the run keeps going without them. */
  base(
    "plan.signals.rejected",
    z.object({ stepRunId: z.string(), artifactId: z.string(), issues: z.array(z.string()) }),
  ),

  base(
    "decision.resolved",
    z.object({ stepRunId: z.string(), choice: z.string(), source: z.string(), raw: z.unknown().optional() }),
  ),
  base(
    "loop.iteration",
    z.object({
      stepRunId: z.string(),
      iteration: z.number().int().nonnegative(),
      childRunId: z.string().optional(),
      item: z.unknown().optional(),
    }),
  ),
  base(
    "child.spawned",
    z.object({
      stepRunId: z.string(),
      childRunId: z.string(),
      branch: z.string().optional(),
      workItemId: z.string().optional(),
      resumed: z.boolean().optional(),
    }),
  ),
  base(
    "child.finished",
    z.object({
      stepRunId: z.string(),
      childRunId: z.string(),
      status: RunStatusSchema,
      outcome: RunOutcomeSchema.optional(),
    }),
  ),
  /** A fan-out branch that never became a child run (unmet dependency, or a sibling settled the join). */
  base(
    "branch.skipped",
    z.object({
      stepRunId: z.string(),
      branch: z.string(),
      reason: BranchSkipReasonSchema,
      workItemId: z.string().optional(),
    }),
  ),

  base(
    "human.requested",
    z.object({
      stepRunId: z.string(),
      requestId: z.string(),
      kind: z.enum(["decision", "permission", "question"]),
      question: z.string(),
      /**
       * `human.answered.answer` carries the chosen option's `id`. A log written before
       * v0.4.0 holds bare strings here and `GateOptionSchema` reads each one as
       * `{ id: s, label: s }`, so those answers still match - see `toGateOption`.
       */
      options: z.array(GateOptionSchema).default([]),
      context: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  base("human.answered", z.object({ stepRunId: z.string(), requestId: z.string(), answer: z.string() })),
]);

export type OrcaEvent = z.infer<typeof OrcaEventSchema>;
export type OrcaEventType = OrcaEvent["type"];
export type OrcaEventOf<T extends OrcaEventType> = Extract<OrcaEvent, { type: T }>;
export type OrcaEventPayload<T extends OrcaEventType> = OrcaEventOf<T>["payload"];

/** An event before the store assigns id/seq/at. */
export type OrcaEventInput = {
  [T in OrcaEventType]: { type: T; runId: string; payload: OrcaEventPayload<T> };
}[OrcaEventType];
