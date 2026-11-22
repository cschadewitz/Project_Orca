/** Safe launch explanation. No executable snapshot, secret values or artifact references. */
import { z } from "zod";
import { RedactedCapabilityManifestSchema } from "./capabilities.js";
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
      template: ChoiceSchema.extend({
        /** Digest of the captured parsed instruction asset; optional for historical records. */
        revision: z.string().optional(),
        partials: z.array(z.object({ id: z.string(), revision: z.string() })).optional(),
      }).optional(),
      /**
       * The step's resolved MCP servers and skills (#335): ids, the scope each came from and a
       * skill's version and content digest. Never a definition, argument or environment value.
       * Absent on records from before #335.
       */
      capabilities: RedactedCapabilityManifestSchema.optional(),
    }),
  ),
  templatePack: ChoiceSchema.optional(),
  /** Effective dispatch default; individual node pins may select another workflow. */
  itemWorkflow: ChoiceSchema.optional(),
});
export type RunProvenance = z.infer<typeof RunProvenanceSchema>;
