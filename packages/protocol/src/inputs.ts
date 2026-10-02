/**
 * `inputs.list` - everything a person is being asked, across every run or within one.
 *
 * This is the attention surface's only read (docs/design/20-attention-and-gates.md). A card
 * has to show the question, where it came from, how long it has waited and the artifacts the
 * decision is about *without* a further call, because the design forbids offering an answer
 * the app could not show the basis for - so each entry carries its artifacts inline.
 *
 * `options` carries the model's `GateOption` whole as of protocol 1.4 - `{ id, label,
 * consequence?, destructive? }`, the shape `HumanInputRequest.options` has had since #220.
 * It used to be `string[]` holding the ids, which let a client answer a gate and not render
 * it: no label to show, no consequence clause, and no `destructive` flag, which is a safety
 * property and not a decoration (docs/design/20-attention-and-gates.md, #161).
 *
 * `id` is still the whole of the answer: `inputs.answer` takes an option id, a label may be
 * reworded between the ask and the answer, and `GateOptionSchema` reads a bare string as an
 * option that is its own id and label, so a log written before #220 still parses.
 *
 * `agent` joined for the same reason as the artifacts (protocol 1.6, #248): a permission ask
 * holds an agent's turn open, the card has to say whose, and "whose" was one `agents.list`
 * away - a further call the design forbids. It is optional because a workflow gate is not an
 * agent's question.
 */
import { z } from "zod";
import { PendingRevisionViewSchema, RevisionBoundaryViewSchema } from "./revision-input.js";
import { LiveInputViewSchema } from "./live-input.js";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import { GateOptionSchema } from "@orca/core/schemas";
import { AgentHostTypeSchema } from "./agents.js";
import { ArtifactViewSchema, WorkItemViewSchema } from "./views.js";

export const INPUTS_LIST_METHOD = "inputs.list";

export const InputKindSchema = z.enum(["decision", "permission", "question"]);
export type InputKind = z.infer<typeof InputKindSchema>;

/**
 * Who is blocked on this question - the agent that asked and the host it runs on (#248).
 *
 * Three fields of `AgentView` and not a fourth: a card says "claude-local on build-01 is
 * waiting", and the rest of the agent's state is what the Agents surface is for. Folding one
 * vocabulary matters more here than saving the bytes, so the names are `AgentView`'s.
 *
 * `hostType` is absent when the host is no longer configured, for the same reason it is
 * optional on `AgentView`: a config edit between the ask and the read leaves the agent
 * without one, and an invented `local` would be worse than none (RULES.md rule 12).
 */
export const InputAgentSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  hostType: AgentHostTypeSchema.optional(),
});
export type InputAgent = z.infer<typeof InputAgentSchema>;

export const OpenInputViewSchema = z.object({
  revision: RevisionBoundaryViewSchema.optional(),
  /** Absent for durable workflow gates; expired permission asks cannot be answered. */
  live: LiveInputViewSchema.optional(),
  id: z.string(),
  /**
   * `permission` is tier 1 (an agent turn is held open), `decision` and `question` are
   * tier 2 gates. The tiers are the design's; the kinds are the engine's.
   */
  kind: InputKindSchema,
  question: z.string(),
  /** The options offered, verbatim. Empty means free text; answer with an option's `id`. */
  options: z.array(GateOptionSchema),
  /** Whatever the asking step attached (tool call, file path, policy). Rendered as-is or not at all. */
  context: z.record(z.string(), z.unknown()),
  runId: z.string(),
  runName: z.string(),
  stepRunId: z.string(),
  nodeId: z.string().optional(),
  /**
   * The agent held open by this ask, when there is one (protocol 1.6, #248). A `permission`
   * always has one - an `ask` reaches a person only through a live agent session - and a
   * `decision` or `question` opened by a workflow gate has none, so its absence is the
   * honest answer and not a field that failed to load.
   */
  agent: InputAgentSchema.optional(),
  workItem: WorkItemViewSchema.optional(),
  requestedAt: z.string(),
  /** How long it has waited, against `asOf` of the result - so a client's own clock never enters into it. */
  waitingMs: z.number().int().nonnegative(),
  /** The artifacts the step had in hand when it asked: what the decision is about. */
  artifacts: z.array(ArtifactViewSchema),
});
export type OpenInputView = z.infer<typeof OpenInputViewSchema>;

export const INPUTS_REVISION_RUN_LIMIT = 20;
export const INPUTS_REVISION_ITEM_LIMIT = 50;
/** Metadata only. Protected correction text still requires inputs.revisionPending. */
export const PendingRevisionSummarySchema = PendingRevisionViewSchema.pick({
  target: true,
  expectedRevision: true,
  state: true,
  unavailableReason: true,
});
export type PendingRevisionSummary = z.infer<typeof PendingRevisionSummarySchema>;
const revisionItems = z.array(PendingRevisionSummarySchema).max(INPUTS_REVISION_ITEM_LIMIT);
/** Current revisions in an explicit run batch, never a complete historical/global index. */
export const PendingRevisionsDiscoverySchema = z.discriminatedUnion("incomplete", [
  z.strictObject({ items: revisionItems, incomplete: z.literal(false) }),
  z.strictObject({
    items: revisionItems,
    incomplete: z.literal(true),
    reason: z.enum(["run-scope-required", "limit", "boundary-unavailable"]),
  }),
]);
export type PendingRevisionsDiscovery = z.infer<typeof PendingRevisionsDiscoverySchema>;

export const InputsListParamsSchema = z.object({
  /** One run and its descendants. Absent: every run in the store. */
  runId: z.string().optional(),
  kind: z.array(InputKindSchema).optional(),
  /** Explicit exact-run batch for current revision metadata. Defaults to [runId], never descendants/global history. */
  revisionRunIds: z
    .array(z.string().min(1).max(1024))
    .min(1)
    .max(INPUTS_REVISION_RUN_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, "revision run IDs must be unique")
    .optional(),
});
export type InputsListParams = z.infer<typeof InputsListParamsSchema>;

export const InputsListResultSchema = z.object({
  /** Longest-waiting first: the order the attention list works through them. */
  inputs: z.array(OpenInputViewSchema),
  /** The title bar's one number - `inputs.length`, sent so a client never recounts it. */
  waiting: z.number().int().nonnegative(),
  /** Separate from unanswered inputs and waiting. Absent when production revision discovery is unavailable. */
  pendingRevisions: PendingRevisionsDiscoverySchema.optional(),
  asOf: z.string(),
});
export type InputsListResult = z.infer<typeof InputsListResultSchema>;
