/** Explicit corrective input. Notes and tool permissions are deliberately absent from this contract. */
import { z } from "zod";
import type { MutationActor } from "../events/events.js";
import { WorkflowInputSchemaSchema } from "./workflow-inputs.js";
import type { WorkflowGraph } from "./workflow.js";
import type { ValidationResult } from "../workflow/validate.js";

export const RevisionCapabilitySchema = z.strictObject({
  actionId: z.string().min(1),
  destinationNodeId: z.string().min(1),
  payload: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("text"),
      maxBytes: z.number().int().positive().max(65536),
    }),
    z.strictObject({
      kind: z.literal("values"),
      inputSchema: WorkflowInputSchemaSchema,
      maxBytes: z.number().int().positive().max(65536),
    }),
  ]),
  composition: z.literal("replace-revision-slot"),
});
export type RevisionCapability = z.infer<typeof RevisionCapabilitySchema>;
export interface RevisionTarget {
  runId: string;
  stepRunId: string;
  requestId: string;
  destinationId: string;
  expectedRevision: string;
}
export type RevisionPayload = { kind: "text"; text: string } | { kind: "values"; values: Record<string, unknown> };
export interface RevisionCommand {
  target: RevisionTarget;
  payload: RevisionPayload;
  actionId: string;
  supersedesRevisionId?: string;
}
export type RevisionState = "pending" | "delivered" | "rejected" | "superseded";
export interface RevisionReceipt {
  revisionId: string;
  target: RevisionTarget;
  state: RevisionState;
  attemptId: string;
  currentRevisionId: string;
  expectedRevision: string;
}
export interface PendingRevisionTarget {
  runId: string;
  revisionId: string;
  destinationId: string;
  attemptId: string;
}
export interface PendingRevisionView {
  target: PendingRevisionTarget;
  expectedRevision: string;
  state: RevisionState;
  payload?: RevisionPayload;
  /** Current allowlisted destination, visible only with protected content grants. */
  boundary?: RevisionBoundaryView;
  replacementAllowed: boolean;
  unavailableReason?: "delivered" | "target-changed" | "cancelled" | "delivery-uncertain";
}
export interface ReplacePendingRevisionCommand {
  target: PendingRevisionTarget;
  expectedRevision: string;
  payload: RevisionPayload;
}
export interface RevisionBoundaryView {
  target: RevisionTarget;
  capability: RevisionCapability;
  destinationDescription: string;
}
export interface RevisionProvenance {
  actor: MutationActor;
  workspaceId: string;
  operationId: string;
  source: "human-revision";
  recordedAt: string;
}

/** Conservative v1 routing: all outgoing conditions must be simple, distinct choice comparisons. */
export function validateRevisionCapability(
  graph: WorkflowGraph,
  nodeId: string,
  declaration: unknown,
): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const fail = (message: string) => errors.push({ path: `nodes.${nodeId}.revision`, message });
  const parsed = RevisionCapabilitySchema.safeParse(declaration);
  if (!parsed.success) fail("invalid revision declaration");
  else {
    const capability = parsed.data;
    const node = graph.nodes[nodeId];
    if (!node || !(node.type === "gate" || (node.type === "decision" && node.source.kind === "human")))
      fail("revision requires a durable human gate or decision");
    else if (!node.options.some((option) => option.id === capability.actionId))
      fail("revision action must be an existing option");
    // Match gateExecutor's nullish fallback exactly; no automatic route can
    // collect the explicit correction required by the revision action.
    if (
      node?.type === "gate" &&
      node.autoApproveWhen !== undefined &&
      (node.autoOption ?? node.options[0]?.id) === capability.actionId
    )
      fail("revision action cannot be selected automatically");
    if (graph.nodes[capability.destinationNodeId]?.type !== "agent")
      fail("revision destination must be an agent in the same graph");
    const choices = new Map<string, string>();
    for (const edge of graph.edges.filter((edge) => edge.from === nodeId)) {
      const match = /^\s*choice\s*==\s*(['"])([A-Za-z0-9_-]+)\1\s*$/.exec(edge.when ?? "");
      if (!match || choices.has(match[2]!)) fail("revision branches must be unique direct choice comparisons");
      else choices.set(match[2]!, edge.to);
    }
    if (choices.get(capability.actionId) !== capability.destinationNodeId)
      fail("revision action must directly select its declared destination");
  }
  return { ok: errors.length === 0, errors, warnings: [] };
}
