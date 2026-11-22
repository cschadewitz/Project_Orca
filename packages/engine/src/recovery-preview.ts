/**
 * Read-only recovery assessment for one run (#357, phase 1): gathers the facts
 * `assessRecovery` needs from the stores and changes nothing. It takes no lease, appends no
 * event and starts nothing, so it is safe to call while another process drives the run.
 */
import {
  assessRecovery,
  OrcaError,
  reduceRun,
  type OrcaEventPayload,
  type RecoveryAssessment,
  type RecoveryRunFacts,
  type WorkflowDefinition,
} from "@orca/core";
import { lapsed, type Stores } from "@orca/store";
import { INLINE_SEP, inlineWorkflowDefinition, runLeaseResource, workflowRevision } from "./orchestrator.js";

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export interface RecoveryPreviewOptions {
  /** The checkpoint to describe: a step run id, or a node id that names exactly one. */
  checkpoint?: string | undefined;
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
  const self = await runFacts(stores, runId, options.now);
  if (!self) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
  const { facts, created } = self;
  const state = facts.state;

  // Resume re-drives the topmost paused ancestor, as the orchestrator does, and so drives every
  // paused run between it and this one. Each of them is checked like this run.
  const resumeAncestors: RecoveryRunFacts[] = [];
  for (let parentId = state.run.parentRunId; parentId;) {
    const parent = await runFacts(stores, parentId, options.now);
    if (!parent || parent.facts.state.run.status !== "paused") break;
    resumeAncestors.push(parent.facts);
    parentId = parent.facts.state.run.parentRunId;
  }

  // Resume also re-attaches to every unfinished run below the one it drives (this run's own
  // children included, when an ancestor is the one driven); each is checked too.
  const target = resumeAncestors.at(-1) ?? facts;
  const resumeDescendants: RecoveryRunFacts[] = [];
  const seen = new Set([state.run.id, ...resumeAncestors.map((a) => a.state.run.id)]);
  const children = (s: RecoveryRunFacts["state"]) => Object.values(s.steps).flatMap((step) => step.childRunIds);
  const queue = [...children(target.state), ...children(state)];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const child = await runFacts(stores, id, options.now);
    if (!child || TERMINAL.has(child.facts.state.run.status)) continue;
    resumeDescendants.push(child.facts);
    queue.push(...children(child.facts.state));
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
    ...facts,
    creatorPrincipalId: created.actor?.principalId,
    principalId: options.principalId,
    resumeAncestors,
    resumeDescendants,
    artifactPresent: (id) => present.has(id),
    checkpoint: options.checkpoint,
    currentWorkflowVersion: options.currentWorkflowVersion,
    currentConfigGeneration: options.currentConfigGeneration,
  });
}

/** One run's log, pinned definition, launch inputs and lease, read without writing anything. */
async function runFacts(
  stores: Stores,
  runId: string,
  now: number | undefined,
): Promise<{ facts: RecoveryRunFacts; created: OrcaEventPayload<"run.created"> } | undefined> {
  const events = await stores.events.read(runId);
  const first = events[0];
  if (!first) return undefined;
  if (first.type !== "run.created") throw new OrcaError("RUN_STATE", `run ${runId} has no run.created event`);
  const state = reduceRun(events);
  const created = first.payload;
  const rootId = state.run.workflowId.split(INLINE_SEP)[0]!;
  const workflowStored = created.workflowStored === true;
  const root = workflowStored
    ? await stores.workflows.get(rootId, state.run.workflowVersion).catch(() => undefined)
    : undefined;
  // An inline run (`root::node...`) recorded the revision of the definition the interpreter
  // builds from its root, so that is what is compared; a root that no longer holds the inline
  // graph cannot be continued, as the interpreter would refuse it too.
  const definition = root && rootId !== state.run.workflowId ? inlineOrUndefined(root, state.run.workflowId) : root;
  const workflowReadable = !workflowStored || definition !== undefined;
  // The interpreter refuses to continue a run whose stored definition no longer has the revision
  // its provenance recorded, or whose recorded generation is gone (orchestrator loadContext).
  const provenance = state.run.provenance;
  const revision: RecoveryRunFacts["revision"] = !provenance
    ? "not-recorded"
    : !definition
      ? "unknown"
      : workflowRevision(definition) === provenance.workflow.revision
        ? "matches"
        : "mismatch";
  const generation: RecoveryRunFacts["generation"] = !provenance
    ? "not-recorded"
    : await stores.execution.getGeneration(provenance.configGeneration).then(
        (snapshot) => (snapshot === undefined ? "missing" : "present"),
        () => "unreadable",
      );
  const executionInputsAvailable = created.executionInputsStored
    ? await stores.execution.getInputs(runId).then(
        (inputs) => inputs !== undefined,
        () => false,
      )
    : true;
  const lease = await stores.leases.get(runLeaseResource(runId));
  const leased = lease !== undefined && !lapsed(lease, now);
  return {
    facts: { state, workflowStored, workflowReadable, revision, generation, executionInputsAvailable, leased },
    created,
  };
}

function inlineOrUndefined(root: WorkflowDefinition, workflowId: string): WorkflowDefinition | undefined {
  try {
    return inlineWorkflowDefinition(root, workflowId);
  } catch {
    return undefined;
  }
}
