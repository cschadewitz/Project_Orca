/**
 * The event log is ORCA's source of truth. Every state change in a run is an
 * appended, immutable event; run state is a projection (reduce.ts). This makes
 * runs resumable after a crash, auditable ("which artifact did the reviewer
 * actually see?"), and streamable to UIs or upstream ACP clients.
 */
import { RunProvenanceSchema } from "../model/run-provenance.js";

import { z } from "zod";
import { ArtifactSchema } from "../model/artifact.js";
import {
  BranchSkipReasonSchema,
  DryRunSchema,
  EffectReviewDecisionSchema,
  ErrorInfoSchema,
  GateOptionSchema,
  HumanInputLiveIdentitySchema,
  RunOutcomeSchema,
  RunCheckpointSchema,
  RunOriginSchema,
  RunOverridesSchema,
  RunStatusSchema,
  StepResultSchema,
  WorkspaceSchema,
} from "../model/run.js";

/** Safe stable correlation for atomic journal publication; never a client retry key. */
export const EventJournalCorrelationSchema = z.strictObject({
  kind: z.enum(["continuation", "revision"]),
  id: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
});
export type EventJournalCorrelation = z.infer<typeof EventJournalCorrelationSchema>;

const base = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    id: z.string(),
    /** Per-run monotonic sequence number, assigned by the event store. */
    seq: z.number().int().nonnegative(),
    runId: z.string(),
    at: z.string(),
    type: z.literal(type),
    payload,
    /** Opaque reference to a private authoritative payload; never a public retrieval capability. */
    executionPayloadRef: z.string().optional(),
    journal: EventJournalCorrelationSchema.optional(),
  });

/** Verified server-side actor; never accepted from workflow vars or caller-supplied RPC fields. */
export const MutationActorSchema = z.object({ principalId: z.string(), credentialId: z.string().optional() });
export type MutationActor = z.infer<typeof MutationActorSchema>;

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
      actor: MutationActorSchema.optional(),
      workflowId: z.string(),
      workflowVersion: z.string(),
      requestId: z.string().optional(),
      /** Server-owned recovery correlation, authenticated in the private creation payload. */
      requestAdmissionId: z.string().optional(),
      directAdmissionId: z.string().optional(),
      workItemId: z.string().optional(),
      parentRunId: z.string().optional(),
      parentStepRunId: z.string().optional(),
      workspace: WorkspaceSchema,
      vars: z.record(z.string(), z.unknown()),
      /** Selection overrides (#186). Absent in logs written before v0.6.0: no overrides. */
      overrides: RunOverridesSchema.optional(),
      provenance: RunProvenanceSchema.optional(),
      /**
       * The definition the run started on is in the workflow-version store under
       * `(workflowId's root, workflowVersion)` (#179), so a resume runs that and never the file
       * on disk. Absent on runs that predate versioning, which run on whatever file is current.
       */
      workflowStored: z.literal(true).optional(),
      /** Exact launch values require the private execution store; missing records fail closed. */
      executionInputsStored: z.literal(true).optional(),
      /** A checkpoint attempt (#357): the source, and the steps, artifacts and vars it reuses. */
      checkpoint: RunCheckpointSchema.optional(),
      /** A delegated run's parent workspace, run and step (#883, `runs.admit` `origin`). */
      origin: RunOriginSchema.optional(),
      /** A dry run (#183): every event of this run is simulated. Children of a dry run carry it too. */
      dryRun: DryRunSchema.optional(),
    }),
  ),
  base("run.started", z.object({})),
  base("run.paused", z.object({ reason: z.string().optional() })),
  base("run.resumed", z.object({})),
  base("run.completed", z.object({ outcome: RunOutcomeSchema, message: z.string().optional() })),
  base("run.failed", z.object({ error: ErrorInfoSchema })),
  base("run.cancelled", z.object({ reason: z.string().optional(), actor: MutationActorSchema.optional() })),
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
  base(
    "step.failed",
    z.object({
      stepRunId: z.string(),
      error: ErrorInfoSchema,
      willRetry: z.boolean(),
      /** The executor stated this attempt did nothing outside ORCA (#357); see `StepRun.noEffect`. */
      effect: z.literal("none").optional(),
    }),
  ),
  base("step.cancelled", z.object({ stepRunId: z.string() })),
  base("step.skipped", z.object({ stepRunId: z.string(), reason: z.string() })),
  /**
   * An operator reviewed a step attempt that started, never reported an outcome and may have
   * acted outside ORCA (#357). Until one is recorded, nothing runs that step again on its own.
   */
  base(
    "step.effect.reviewed",
    z.object({
      stepRunId: z.string(),
      decision: EffectReviewDecisionSchema,
      note: z.string().max(2000).optional(),
      actor: MutationActorSchema.optional(),
    }),
  ),

  base(
    "agent.session.opened",
    z.object({
      /** Conversation context only; loading never restores a pending tool approval. */
      continuity: z
        .object({
          mode: z.enum(["fresh", "loaded"]),
          reason: z.enum(["new", "load-supported", "load-unsupported", "load-failed"]),
        })
        .optional(),
      stepRunId: z.string(),
      sessionId: z.string(),
      agentId: z.string(),
      hostId: z.string(),
      cwd: z.string(),
      /**
       * The model the session runs on (#187): the run's selection as applied, or the agent's own
       * current model when the run selected none. Absent when neither is known, and on logs
       * written before v0.6.0.
       */
      model: z.string().optional(),
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
      /**
       * What decided it (#702): the basis, and for a rule its layer and its index in that
       * layer. Absent on events written before this existed and where the policy was not
       * consulted. It deliberately has no sidecar revision: a digest of the whole permission
       * file in an ordinary event would reach every reader and export of the run log and could
       * correlate a workspace's policy across runs (#702 review). Parsing drops one if a
       * writer sends it, so the public log never keeps it.
       */
      rule: z
        .object({
          basis: z.enum(["protected", "rule", "default", "command-restricted", "unverified-identity"]),
          layer: z.enum(["config", "sidecar", "default"]).optional(),
          index: z.number().int().nonnegative().optional(),
          file: z.number().int().nonnegative().optional(),
          capped: z.boolean().optional(),
        })
        .optional(),
      /** Explicit standing-rule Save acceptance; protected entry is never public or a callback answer. */
      scopedApprovalRef: z.string().optional(),
      entry: z.record(z.string(), z.unknown()).optional(),
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
      /**
       * The agent whose turn this ask is holding open, when one is (#248). A `permission`
       * always has one; a workflow `decision` or `question` has none, and the absence is
       * the answer rather than a gap.
       *
       * It is recorded here as well as derivable from `agent.session.opened` because the
       * `input.opened` notification is a pure function of this one event: a push that had
       * to scan a log to say whose turn is blocked would turn every append into a
       * projection. Only what the moment of asking *knows* is stored - the agent's id and
       * the host it was spawned on. A host's transport is configuration, so it is resolved
       * from the registry on a read and never frozen into the log.
       *
       * An event written before this field existed simply has none; `inputs.list` answers
       * for those logs from the session scan, which is why the read path does not use it.
       */
      agent: z.object({ id: z.string(), hostId: z.string() }).optional(),
      liveDecision: HumanInputLiveIdentitySchema.optional(),
      context: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  // One durable marker records the exact decision and accepted dispatch intent together.
  base(
    "continuation.recorded",
    z.object({
      continuationId: z.string(),
      state: z.enum(["prepared", "accepted", "blocked", "settled"]),
      decision: z
        .object({ requestId: z.string(), stepRunId: z.string(), answer: z.string(), actor: MutationActorSchema })
        .optional(),
      /** Versioned authoritative record is encrypted and omitted from public projections. */
      entry: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  // The single commit marker projects both revision acceptance and its gate answer.
  // entry is authoritative protected material, absent from the public projection.
  base(
    "revision.recorded",
    z.object({
      destinationId: z.string(),
      revisionId: z.string().optional(),
      state: z.enum(["pending", "delivered", "rejected", "superseded"]).optional(),
      decision: z
        .object({ requestId: z.string(), stepRunId: z.string(), answer: z.string(), actor: MutationActorSchema })
        .optional(),
      entry: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  base(
    "human.answered",
    z.object({
      actor: MutationActorSchema.optional(),
      stepRunId: z.string(),
      requestId: z.string(),
      answer: z.string(),
      /**
       * The free-text note the person wrote beside the answer (#238). The run does not
       * branch on it - `answer` is the whole of the decision - but it is the record of
       * *why* that decision was taken, and until now it reached the operator's log and not
       * the run's, which made it something a client had to be told not to display.
       *
       * Absent on every answer recorded before this release, and on every answer given
       * without one; a reader must not turn that into an empty string on screen.
       */
      note: z.string().optional(),
    }),
  ),
]);

export type OrcaEvent = z.infer<typeof OrcaEventSchema>;
export type OrcaEventType = OrcaEvent["type"];
export type OrcaEventOf<T extends OrcaEventType> = Extract<OrcaEvent, { type: T }>;
export type OrcaEventPayload<T extends OrcaEventType> = OrcaEventOf<T>["payload"];

/** An event before the store assigns id/seq/at. */
export type OrcaEventInput = {
  [T in OrcaEventType]: {
    type: T;
    runId: string;
    payload: OrcaEventPayload<T>;
    executionPayloadRef?: string | undefined;
    journal?: EventJournalCorrelation | undefined;
  };
}[OrcaEventType];
