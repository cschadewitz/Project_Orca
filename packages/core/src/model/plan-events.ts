/**
 * The plan journal: an append-only log of every change to a Plan.
 *
 * Runs are event-sourced (events/events.ts). The plan is a *long-lived* graph
 * that outlives any run, so it is stored as documents (fast to query) plus this
 * journal (why is `auth-api` blocked? who accepted risk `token-leak`, and when?).
 * The journal is the audit trail; the documents are the read model.
 */
import { z } from "zod";
import { DecisionSchema, DependencySchema, PlanOriginSchema, PlanSchema, RiskSchema } from "./plan.js";
import { WorkItemSchema } from "./request.js";

const base = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    id: z.string(),
    /** Per-plan monotonic sequence number, assigned by the journal. */
    seq: z.number().int().nonnegative(),
    planId: z.string(),
    at: z.string(),
    type: z.literal(type),
    origin: PlanOriginSchema,
    payload,
  });

const patch = z.record(z.string(), z.unknown());

export const PlanEventSchema = z.discriminatedUnion("type", [
  base("plan.created", z.object({ plan: PlanSchema })),
  base("plan.updated", z.object({ changes: patch })),
  base("request.linked", z.object({ requestId: z.string() })),

  base("work-item.added", z.object({ workItem: WorkItemSchema })),
  base("work-item.updated", z.object({ workItemId: z.string(), changes: patch })),

  base("dependency.added", z.object({ dependency: DependencySchema })),
  base("dependency.resolved", z.object({ dependencyId: z.string(), status: z.enum(["satisfied", "failed", "waived", "open"]), resolution: z.string().optional() })),
  /** An `external` placeholder was bound to a work item registered later. */
  base("dependency.bound", z.object({ dependencyId: z.string(), workItemId: z.string() })),

  base("risk.raised", z.object({ risk: RiskSchema })),
  base("risk.updated", z.object({ riskId: z.string(), changes: patch })),

  /** Front-matter signals an artifact carried that the plan refused (malformed, or rejected on apply). */
  base("signals.rejected", z.object({ artifactId: z.string(), runId: z.string().optional(), issues: z.array(z.string()) })),

  base("decision.opened", z.object({ decision: DecisionSchema })),
  base("decision.updated", z.object({ decisionId: z.string(), changes: patch })),
  base("decision.resolved", z.object({ decisionId: z.string(), chosen: z.string(), decidedBy: z.enum(["matrix", "agent", "human"]), rationale: z.string().optional() })),

  base(
    "schedule.computed",
    z.object({
      runId: z.string().optional(),
      ready: z.array(z.string()),
      waiting: z.array(z.string()),
      held: z.array(z.string()),
      unschedulable: z.array(z.string()),
      criticalPath: z.array(z.string()),
    }),
  ),
  base("dispatch.started", z.object({ workItemId: z.string(), runId: z.string(), reasons: z.array(z.string()) })),
  base("dispatch.finished", z.object({ workItemId: z.string(), runId: z.string(), status: z.string() })),
  base("dispatch.deferred", z.object({ workItemId: z.string(), reason: z.string() })),
]);

export type PlanEvent = z.infer<typeof PlanEventSchema>;
export type PlanEventType = PlanEvent["type"];
export type PlanEventOf<T extends PlanEventType> = Extract<PlanEvent, { type: T }>;
export type PlanEventPayload<T extends PlanEventType> = PlanEventOf<T>["payload"];

/** A journal entry before the store assigns id/seq/at. */
export type PlanEventInput = {
  [T in PlanEventType]: { type: T; planId: string; origin: PlanEventOf<T>["origin"]; payload: PlanEventPayload<T> };
}[PlanEventType];
