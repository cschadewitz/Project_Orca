/**
 * Read-only recovery assessment for one run (#357, phase 1): gathers the facts
 * `assessRecovery` needs from the stores and changes nothing. It takes no lease, appends no
 * event and starts nothing, so it is safe to call while another process drives the run.
 */
import { assessRecovery, OrcaError, reduceRun, type RecoveryAssessment } from "@orca/core";
import { lapsed, type Stores } from "@orca/store";
import { INLINE_SEP, runLeaseResource } from "./orchestrator.js";

export interface RecoveryPreviewOptions {
  /** The principal asking; compared with the run's recorded creator for history-based recovery. */
  principalId?: string | undefined;
  /** The version a new run of this workflow would use now, when known. */
  currentWorkflowVersion?: string | undefined;
  /** The configuration generation a new run would be admitted on now, when known. */
  currentConfigGeneration?: string | undefined;
  now?: number;
}

export async function previewRecovery(
  stores: Stores,
  runId: string,
  options: RecoveryPreviewOptions = {},
): Promise<RecoveryAssessment> {
  const events = await stores.events.read(runId);
  const first = events[0];
  if (!first) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
  if (first.type !== "run.created") throw new OrcaError("RUN_STATE", `run ${runId} has no run.created event`);
  const state = reduceRun(events);
  const created = first.payload;

  const rootId = state.run.workflowId.split(INLINE_SEP)[0]!;
  const workflowStored = created.workflowStored === true;
  const workflowReadable = workflowStored
    ? await stores.workflows.get(rootId, state.run.workflowVersion).then(
        (definition) => definition !== undefined,
        () => false,
      )
    : true;
  const executionInputsAvailable = created.executionInputsStored
    ? await stores.execution.getInputs(runId).then(
        (inputs) => inputs !== undefined,
        () => false,
      )
    : true;
  const lease = await stores.leases.get(runLeaseResource(runId));
  const leased = lease !== undefined && !lapsed(lease, options.now);

  // Resume re-drives the topmost paused ancestor, as the orchestrator does.
  let resumeTargetRunId = runId;
  for (let parentId = state.run.parentRunId; parentId;) {
    const parentEvents = await stores.events.read(parentId);
    if (!parentEvents.length) break;
    const parent = reduceRun(parentEvents);
    if (parent.run.status !== "paused") break;
    resumeTargetRunId = parentId;
    parentId = parent.run.parentRunId;
  }

  // An artifact counts only when its record and its bytes read back (the file backend also
  // checks the bytes against their hash). Checked once per id.
  const artifactIds = new Set(Object.values(state.steps).flatMap((step) => step.result?.artifactIds ?? []));
  const present = new Set<string>();
  for (const id of artifactIds) {
    try {
      if ((await stores.artifacts.get(id)) === undefined) continue;
      await stores.artifacts.bytes(id);
      present.add(id);
    } catch {
      // Missing or invalid: reported as missing, never thrown.
    }
  }

  return assessRecovery({
    state,
    creatorPrincipalId: created.actor?.principalId,
    principalId: options.principalId,
    workflowStored,
    workflowReadable,
    executionInputsAvailable,
    leased,
    resumeTargetRunId,
    artifactPresent: (id) => present.has(id),
    currentWorkflowVersion: options.currentWorkflowVersion,
    currentConfigGeneration: options.currentConfigGeneration,
  });
}
