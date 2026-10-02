/** Safe launch explanation. No executable snapshot, secret values or artifact references. */
import { z } from "zod";
const ChoiceSchema = z.object({ value: z.string(), source: z.string() });
export const RunProvenanceSchema = z.object({
  configGeneration: z.string(),
  workflow: z.object({ id: z.string(), version: z.string(), revision: z.string() }),
  inputs: z.array(
    z.object({ name: z.string(), source: z.enum(["caller", "workflow"]), value: z.literal("[REDACTED]") }),
  ),
  selections: z.array(
    z.object({
      nodeId: z.string(),
      role: z.string().optional(),
      agent: ChoiceSchema,
      host: ChoiceSchema,
      model: ChoiceSchema.optional(),
      template: ChoiceSchema.optional(),
    }),
  ),
  itemWorkflow: ChoiceSchema,
  templatePack: ChoiceSchema.optional(),
});
export type RunProvenance = z.infer<typeof RunProvenanceSchema>;
