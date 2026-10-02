/** Server-owned admission correlation in the authenticated creation payload, outside workflow inputs. */
import { z } from "zod";
import { OrcaError, type OrcaEventInput } from "@orca/core";
import type { ExecutionStore } from "@orca/store";

type Created = Extract<OrcaEventInput, { type: "run.created" }>;
export const RequestAdmissionCorrelationSchema = z.object({ requestAdmissionId: z.string().min(1) });

/** Called after normal launch validation and before publishing run.created. */
export async function correlateRequestAdmission(
  input: Created,
  requestAdmissionId: string,
  execution: ExecutionStore,
): Promise<Created & { payload: Created["payload"] & { requestAdmissionId: string } }> {
  if (!requestAdmissionId || !input.payload.requestId || !input.payload.actor || input.payload.parentRunId)
    throw new OrcaError("RUN_STATE", "request admission correlation is unavailable");
  // Even a workflow without sensitive inputs needs an authenticated creation payload.
  // Use the existing execution store/key lifecycle; never add metadata to application vars.
  const inputs = await execution.getInputs(input.runId);
  if (!inputs) {
    if (input.payload.executionInputsStored)
      throw new OrcaError("RUN_STATE", "request admission correlation is unavailable");
    await execution.putInputs({
      runId: input.runId,
      workflowId: input.payload.workflowId,
      workflowVersion: input.payload.workflowVersion,
      vars: input.payload.vars,
      sensitiveNames: [],
      secrets: [],
    });
  }
  return { ...input, payload: { ...input.payload, executionInputsStored: true, requestAdmissionId } };
}
