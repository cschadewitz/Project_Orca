/**
 * The `custom:jev-eval` node's fields. The core workflow schema keeps custom nodes loose, so
 * this is where the fields are checked - by the executor's `validate` when the workflows are
 * loaded (#308) and again at the top of `execute`, per docs/EXTENSIBILITY.md - so a bad node
 * fails `orca validate` and bootstrap, and a run that reaches one anyway fails with
 * WORKFLOW_INVALID rather than reaching the provider.
 */
import { ArtifactRefSchema } from "@orca/core";
import { z } from "zod";

/** Question ids and choice option ids: they become JSON keys and `choice == '<id>'` edge tests. */
const IdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "ids are letters, digits, '_' or '-'");

export const JevQuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z.strictObject({ true: z.string().min(1), false: z.string().min(1) }).optional(),
  }),
  z.strictObject({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z
      .record(IdSchema, z.union([z.string().min(1), z.record(z.string(), z.unknown())]))
      .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255, "a choice offers 2..255 options"),
  }),
  z.strictObject({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2).max(10),
  }),
]);

export const JevEvalNodeSchema = z.strictObject({
  type: z.literal("custom:jev-eval"),
  // NodeBase fields, restated because the custom node schema is a loose object.
  name: z.string().optional(),
  description: z.string().optional(),
  maxAttempts: z.number().int().positive().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),

  /** The artifacts to judge - explicit, never "everything the run has". */
  inputs: z.array(ArtifactRefSchema).min(1),
  /** Extra state sections, each a template rendered against the step context (e.g. the acceptance criteria). */
  context: z.record(IdSchema, z.string()).default({}),
  /** Pinned model version (`jev-1.13.0`); falls back to the plugin's. Aliases are refused. */
  model: z.string().min(1).optional(),
  /** What the questions are, as a versioned unit, so an answer can be traced to the rubric that produced it. */
  rubric: z.strictObject({ id: z.string().min(1), version: z.union([z.string().min(1), z.number().int()]) }),
  questions: z
    .record(IdSchema, JevQuestionSchema)
    .refine((q) => Object.keys(q).length >= 1, "ask at least one question"),
  /** Upper bound on the serialised state, in characters. Over it the step fails; nothing is truncated. */
  maxStateChars: z.number().int().positive().default(96_000),
  /** Per-call timeout, cancelled earlier if the run is. */
  timeoutMs: z.number().int().positive().default(60_000),
  /**
   * `fail` (default): a provider error, an invalid response or an over-sized state fails the
   * step like any other. `record`: the step completes with `data.status: "failed"` and an
   * evaluation artifact that says so, so a shadow evaluation never blocks the run it shadows.
   * Neither ever yields an answer that was not returned.
   */
  onError: z.enum(["fail", "record"]).default("fail"),
  /**
   * `true` states that asking the model again is safe: an evaluation changes nothing outside
   * ORCA. Only then may `maxAttempts` repeat an attempt whose request was already sent (a timeout
   * or lost response leaves its outcome unknown). Failures before the request is sent are
   * retried either way (#357).
   */
  repeatable: z.boolean().optional(),
  produces: z
    .strictObject({
      kind: z.string().min(1).default("evaluation"),
      name: z.string().min(1).optional(),
    })
    .default({ kind: "evaluation" }),
});

export type JevEvalNode = z.infer<typeof JevEvalNodeSchema>;
export type JevEvalNodeInput = z.input<typeof JevEvalNodeSchema>;
