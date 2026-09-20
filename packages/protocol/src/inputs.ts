/**
 * `inputs.list` - everything a person is being asked, across every run or within one.
 *
 * This is the attention surface's only read (docs/design/20-attention-and-gates.md). A card
 * has to show the question, where it came from, how long it has waited and the artifacts the
 * decision is about *without* a further call, because the design forbids offering an answer
 * the app could not show the basis for - so each entry carries its artifacts inline.
 *
 * One thing the design asks for and this wire does not carry yet: a consequence per option.
 * The *model* has it as of #220 - `HumanInputRequest.options` is now
 * `{ id, label, consequence?, destructive? }` - but `options` here and on
 * `input.opened` are still `string[]`, and the daemon sends the **id** down them, because the
 * id is what `inputs.answer` must receive. So a client can answer correctly and cannot yet
 * render a label, a consequence clause or the destructive flag, and must not invent them.
 *
 * Widening these two to carry the whole `GateOption` (exported from `@orca/core/schemas`) is
 * a one-line swap each and is what #161 needs before the attention surface can be built - it
 * requires both the consequence clause and the destructive flag, and the latter is a safety
 * property, not a decoration.
 */
import { z } from "zod";
import { ArtifactViewSchema, WorkItemViewSchema } from "./views.js";

export const INPUTS_LIST_METHOD = "inputs.list";

export const InputKindSchema = z.enum(["decision", "permission", "question"]);
export type InputKind = z.infer<typeof InputKindSchema>;

export const OpenInputViewSchema = z.object({
  id: z.string(),
  /**
   * `permission` is tier 1 (an agent turn is held open), `decision` and `question` are
   * tier 2 gates. The tiers are the design's; the kinds are the engine's.
   */
  kind: InputKindSchema,
  question: z.string(),
  /** The options offered, verbatim. Empty means free text. */
  options: z.array(z.string()),
  /** Whatever the asking step attached (tool call, file path, policy). Rendered as-is or not at all. */
  context: z.record(z.string(), z.unknown()),
  runId: z.string(),
  runName: z.string(),
  stepRunId: z.string(),
  nodeId: z.string().optional(),
  workItem: WorkItemViewSchema.optional(),
  requestedAt: z.string(),
  /** How long it has waited, against `asOf` of the result - so a client's own clock never enters into it. */
  waitingMs: z.number().int().nonnegative(),
  /** The artifacts the step had in hand when it asked: what the decision is about. */
  artifacts: z.array(ArtifactViewSchema),
});
export type OpenInputView = z.infer<typeof OpenInputViewSchema>;

export const InputsListParamsSchema = z.object({
  /** One run and its descendants. Absent: every run in the store. */
  runId: z.string().optional(),
  kind: z.array(InputKindSchema).optional(),
});
export type InputsListParams = z.infer<typeof InputsListParamsSchema>;

export const InputsListResultSchema = z.object({
  /** Longest-waiting first: the order the attention list works through them. */
  inputs: z.array(OpenInputViewSchema),
  /** The title bar's one number - `inputs.length`, sent so a client never recounts it. */
  waiting: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type InputsListResult = z.infer<typeof InputsListResultSchema>;
