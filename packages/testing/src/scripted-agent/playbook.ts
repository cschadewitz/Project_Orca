/**
 * Playbook for the scripted agent: what to write for each artifact kind it is
 * asked to deliver. Entries are consumed in order per kind across prompts (the
 * last one repeats), which lets a test model "reviewer asks for changes, then
 * approves" without any LLM.
 */
import { SessionConfigOptionSchema } from "@orca/core";
import { z } from "zod";

export const PlaybookEntrySchema = z.object({
  /** Front-matter data; merged into the artifact's YAML header. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Markdown body. Supports {kind}, {path}, {n} (1-based occurrence) and {prompt} placeholders. */
  body: z.string().optional(),
  /** Full raw content (overrides data/body). */
  content: z.string().optional(),
  /** Do not write the file (simulates a missing deliverable). */
  skip: z.boolean().default(false),
  /** Text the agent "says" before writing. */
  say: z.string().optional(),
  /** Ask the client for permission before writing (exercises the permission path). */
  askPermission: z.boolean().default(false),
  /** Stable source path to ask about independently of the attempt-specific report path. */
  permissionPath: z.string().optional(),
  /** Return this stop reason instead of end_turn. */
  stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  /** Never finish the turn and ignore `session/cancel` (simulates a wedged agent). */
  hang: z.boolean().default(false),
});
export type PlaybookEntry = z.infer<typeof PlaybookEntrySchema>;

export const PlaybookSchema = z.object({
  kinds: z.record(z.string(), z.array(PlaybookEntrySchema)).default({}),
  default: PlaybookEntrySchema.default({ skip: false, askPermission: false, hang: false }),
  /** Text emitted at the start of every turn. */
  greeting: z.string().default("Scripted agent: reading deliverables."),
  /** Sleep between updates to mimic streaming. */
  delayMs: z.number().int().nonnegative().default(0),
  /**
   * Session config options advertised in `session/new` (a model list, a mode, …). Each session
   * gets its own copy; `session/set_config_option` updates that copy's `currentValue`.
   */
  configOptions: z.array(SessionConfigOptionSchema).optional(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
/** What callers write (defaults optional). */
export type PlaybookInput = z.input<typeof PlaybookSchema>;

export function parsePlaybook(raw: unknown): Playbook {
  return PlaybookSchema.parse(raw ?? {});
}
