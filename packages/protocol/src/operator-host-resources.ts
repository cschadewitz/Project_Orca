/** Closed advisory read; telemetry values and warning policy belong to the shared snapshot. */
import { z } from "zod";
import { OperatorTargetSchema } from "./operator-reads.js";
import { HostResourceSnapshotSchema, resourceWarnings } from "./host-resources.js";

export const OPERATOR_HOST_RESOURCES_METHOD = "operator.hostResources";
export const OperatorHostResourcesParamsSchema = z.strictObject({ target: OperatorTargetSchema });
export const OperatorHostResourcesResultSchema = HostResourceSnapshotSchema.refine(
  (s) =>
    (!("value" in s.workstreams) || s.workstreams.value.scope === "caller-visible") &&
    s.warnings.length === resourceWarnings(s).length &&
    s.warnings.every((warning, i) => {
      const expected = resourceWarnings(s)[i]!;
      return (
        warning.code === expected.code &&
        warning.metric === expected.metric &&
        warning.basis === expected.basis &&
        warning.threshold === expected.threshold &&
        warning.policy === expected.policy
      );
    }),
);
export type OperatorHostResourcesParams = z.infer<typeof OperatorHostResourcesParamsSchema>;
