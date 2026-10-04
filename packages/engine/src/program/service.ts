/**
 * ProgramService - the public entry point for "give ORCA a big request".
 * Creates the Request record and starts the program workflow, which
 * decomposes it and drives each work item through the SDLC workflow.
 */
import {
  newId,
  RequestSchema,
  SubmissionCommandSchema,
  OrcaError,
  succeeded,
  type Request,
  type RequestSource,
  type RunOverrides,
  type RunState,
  type SubmissionAuthority,
  type SubmissionService,
} from "@orca/core";
import { isTerminal, workflowRevision, type Orchestrator } from "../orchestrator.js";
import { RequestSubmissionService, type RequestSubmissionOptions } from "./request-submission.js";

export interface SubmitRequestInput {
  title: string;
  body: string;
  source?: RequestSource;
  labels?: string[];
  /** Override the configured program workflow. */
  workflowId?: string;
  /** Pin the root program definition selected by a launch preflight. */
  workflowVersion?: string;
  expectedWorkflowRevision?: string;
  expectedConfigGeneration?: string;
  vars?: Record<string, unknown>;
  /**
   * Per-run selection (#186). `overrides.itemWorkflow` wins over the configured
   * `program.itemWorkflow`, which stays the default (as `vars.itemWorkflow`) when it is absent.
   */
  overrides?: RunOverrides;
}

export class ProgramService {
  readonly submissions: RequestSubmissionService | undefined;
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly programWorkflowId = "program",
    /** Seeded as `vars.itemWorkflow`; the program workflow dispatches work items to it. */
    private readonly itemWorkflowId?: string,
    private readonly submission?: Omit<RequestSubmissionOptions, "orchestrator"> & { authority?: SubmissionAuthority },
  ) {
    this.submissions = submission ? new RequestSubmissionService({ ...submission, orchestrator }) : undefined;
  }

  async submit(
    input: SubmitRequestInput,
    retry: import("@orca/core").RetryOptions = {},
  ): Promise<{ request: Request; runId: string; admissionId?: string }> {
    if (this.submissions) {
      if (!this.submission?.authority)
        throw new OrcaError("NOT_SUPPORTED", "Request submission requires explicit authority");
      const result = await this.submissions.submit(input, this.submission.authority, retry);
      if (result.state !== "accepted")
        throw new OrcaError("RUN_STATE", "Request requires reconciliation", { ...result });
      const request = await this.orchestrator.stores.requests.get(result.requestId);
      if (!request) throw new OrcaError("RUN_STATE", "accepted Request is unavailable", { ...result });
      return { request, runId: result.runId, admissionId: result.admissionId };
    }
    if (input.expectedConfigGeneration !== undefined)
      throw new OrcaError("NOT_SUPPORTED", "configuration generation guards require the submission provider");
    // Legacy embedded callers retain the old constructor until their composition root supplies
    // the durable admission store, generation provider and explicit local authority.
    if (!SubmissionCommandSchema.safeParse(input).success)
      throw new OrcaError("WORKFLOW_INPUT_INVALID", "invalid Request submission");
    const now = this.orchestrator.clock.isoNow();
    const request = RequestSchema.parse({
      id: newId("req", this.orchestrator.clock.now()),
      title: input.title,
      body: input.body,
      source: input.source ?? { kind: "manual" },
      labels: input.labels ?? [],
      status: "decomposing",
      createdAt: now,
      updatedAt: now,
    });
    const options = {
      workflowId: input.workflowId ?? this.programWorkflowId,
      ...(input.workflowVersion !== undefined ? { workflowVersion: input.workflowVersion } : {}),
      ...(input.expectedWorkflowRevision !== undefined
        ? { expectedWorkflowRevision: input.expectedWorkflowRevision }
        : {}),
      requestId: request.id,
      vars: { ...(this.itemWorkflowId ? { itemWorkflow: this.itemWorkflowId } : {}), ...(input.vars ?? {}), request },
      ...(input.overrides ? { overrides: input.overrides } : {}),
    };
    // Admission errors must not leave an orphaned Request. Pin the admitted definition for
    // the second check in startRun so a changed workflow cannot slip through between writes.
    const { definition } = await this.orchestrator.validateStartRun(options);
    await this.orchestrator.stores.requests.put(request);
    const runId = await this.orchestrator.startRun({
      ...options,
      workflowVersion: definition.version,
      expectedWorkflowRevision: workflowRevision(definition),
    });
    await this.orchestrator.stores.requests.put({ ...request, programRunId: runId });
    return { request: { ...request, programRunId: runId }, runId };
  }

  async submitAndRun(input: SubmitRequestInput): Promise<{ request: Request; state: RunState }> {
    const admitted = await this.submit(input);
    const { request } = admitted;
    const state = await this.runSubmitted(admitted);
    return { request: (await this.settle(state)) ?? request, state };
  }

  /** Execute an admitted Request only after rechecking current authority at the worker boundary. */
  async runSubmitted(
    admitted: { runId: string; admissionId?: string },
    authority: SubmissionAuthority | undefined = this.submission?.authority,
  ): Promise<RunState> {
    if (!this.submissions) return this.orchestrator.run(admitted.runId);
    if (!authority || !admitted.admissionId)
      throw new OrcaError("NOT_SUPPORTED", "Request execution requires its admission and explicit authority");
    return executeAcceptedSubmission(this.submissions, admitted.admissionId, admitted.runId, authority, (runId) =>
      this.orchestrator.run(runId),
    );
  }

  /** Continue a parked run tree (see Orchestrator.resume) and record the outcome on its Request. */
  async resume(runId: string): Promise<RunState> {
    const state = await this.orchestrator.resume(runId);
    await this.settle(state);
    return state;
  }

  /** Mirror a finished program run onto its Request; paused or live runs leave it untouched. */
  async settle(state: RunState): Promise<Request | undefined> {
    if (!state.run.requestId) return undefined;
    const cur = await this.orchestrator.stores.requests.get(state.run.requestId);
    if (!cur || cur.programRunId !== state.run.id || !isTerminal(state)) return cur;
    const status = succeeded(state) ? "completed" : state.run.status === "cancelled" ? "cancelled" : "failed";
    const updated: Request = { ...cur, status, updatedAt: this.orchestrator.clock.isoNow() };
    await this.orchestrator.stores.requests.put(updated);
    return updated;
  }
}

/** Shared live authority boundary for daemon workers, ProgramService/CLI and configured ACP. */
export async function executeAcceptedSubmission<T>(
  service: SubmissionService,
  admissionId: string,
  runId: string,
  authority: SubmissionAuthority,
  execute: (runId: string) => Promise<T>,
): Promise<T> {
  const current = await service.inspect(admissionId, authority);
  if (current.state !== "accepted" || current.runId !== runId)
    throw new OrcaError("RUN_STATE", "Request admission is not accepted for this run");
  return execute(runId);
}
