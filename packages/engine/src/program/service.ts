/**
 * ProgramService - the public entry point for "give ORCA a big request".
 * Creates the Request record and starts the program workflow, which
 * decomposes it and drives each work item through the SDLC workflow.
 */
import {
  newId,
  RequestSchema,
  succeeded,
  type Request,
  type RequestSource,
  type RunOverrides,
  type RunState,
} from "@orca/core";
import { isTerminal, workflowRevision, type Orchestrator } from "../orchestrator.js";

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
  vars?: Record<string, unknown>;
  /**
   * Per-run selection (#186). `overrides.itemWorkflow` wins over the configured
   * `program.itemWorkflow`, which stays the default (as `vars.itemWorkflow`) when it is absent.
   */
  overrides?: RunOverrides;
}

export class ProgramService {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly programWorkflowId = "program",
    /** Seeded as `vars.itemWorkflow`; the program workflow dispatches work items to it. */
    private readonly itemWorkflowId?: string,
  ) {}

  async submit(input: SubmitRequestInput): Promise<{ request: Request; runId: string }> {
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
      vars: { request, ...(this.itemWorkflowId ? { itemWorkflow: this.itemWorkflowId } : {}), ...(input.vars ?? {}) },
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
    const { request, runId } = await this.submit(input);
    const state = await this.orchestrator.run(runId);
    return { request: (await this.settle(state)) ?? request, state };
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
