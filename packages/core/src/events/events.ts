/**
 * The event log is ORCA's source of truth. Every state change in a run is an
 * appended, immutable event; run state is a projection (reduce.ts). This makes
 * runs resumable after a crash, auditable ("which artifact did the reviewer
 * actually see?"), and streamable to UIs or upstream ACP clients.
 */
import { z } from "zod";
import { ArtifactSchema } from "../model/artifact.js";
import { ErrorInfoSchema, RunOutcomeSchema, StepResultSchema, WorkspaceSchema } from "../model/run.js";

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

/** Compact, storage-friendly form of an ACP session update. */
export const AgentUpdateSummarySchema = z.object({
  kind: z.string(), // ACP sessionUpdate discriminator
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  toolKind: z.string().optional(),
  status: z.string().optional(),
  locations: z.array(z.string()).optional(),
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
  base("step.waiting", z.object({ stepRunId: z.string(), on: z.string(), detail: z.string().optional() })),
  base("step.completed", z.object({ stepRunId: z.string(), result: StepResultSchema })),
  base("step.failed", z.object({ stepRunId: z.string(), error: ErrorInfoSchema, willRetry: z.boolean() })),
  base("step.cancelled", z.object({ stepRunId: z.string() })),
  base("step.skipped", z.object({ stepRunId: z.string(), reason: z.string() })),

  base(
    "agent.session.opened",
    z.object({ stepRunId: z.string(), sessionId: z.string(), agentId: z.string(), hostId: z.string(), cwd: z.string() }),
  ),
  base(
    "agent.turn.started",
    z.object({ stepRunId: z.string(), sessionId: z.string(), promptHash: z.string(), promptPreview: z.string(), followUp: z.number().int().nonnegative() }),
  ),
  base("agent.update", z.object({ stepRunId: z.string(), sessionId: z.string(), update: AgentUpdateSummarySchema })),
  base(
    "agent.permission",
    z.object({ stepRunId: z.string(), sessionId: z.string(), toolCallId: z.string().optional(), title: z.string(), decision: z.string() }),
  ),
  base("agent.turn.completed", z.object({ stepRunId: z.string(), sessionId: z.string(), stopReason: z.string(), durationMs: z.number() })),
  base("agent.session.closed", z.object({ stepRunId: z.string(), sessionId: z.string(), error: ErrorInfoSchema.optional() })),

  base("artifact.recorded", z.object({ stepRunId: z.string(), artifact: ArtifactSchema })),
  base("artifact.rejected", z.object({ stepRunId: z.string(), kind: z.string(), path: z.string(), reason: z.string() })),

  base("decision.resolved", z.object({ stepRunId: z.string(), choice: z.string(), source: z.string(), raw: z.unknown().optional() })),
  base("loop.iteration", z.object({ stepRunId: z.string(), iteration: z.number().int().nonnegative(), childRunId: z.string().optional(), item: z.unknown().optional() })),
  base("child.spawned", z.object({ stepRunId: z.string(), childRunId: z.string(), branch: z.string().optional() })),
  base("child.finished", z.object({ stepRunId: z.string(), childRunId: z.string(), status: z.string(), outcome: RunOutcomeSchema.optional() })),

  base(
    "human.requested",
    z.object({
      stepRunId: z.string(),
      requestId: z.string(),
      kind: z.enum(["decision", "permission", "question"]),
      question: z.string(),
      options: z.array(z.string()).default([]),
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
