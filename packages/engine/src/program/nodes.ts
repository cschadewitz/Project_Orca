/** Field schema shared by materialize-work-items validation and execution. */
import { z } from "zod";

export const MaterializeWorkItemsNodeSchema = z.object({
  type: z.literal("custom:materialize-work-items"),
  artifact: z.string().min(1).default("decomposition"),
});
