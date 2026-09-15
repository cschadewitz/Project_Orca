/**
 * ProgramService - the public entry point for "give ORCA a big request".
 * Creates the Request record and starts the program workflow, which
 * decomposes it and drives each work item through the SDLC workflow.
 */
import { newId, RequestSchema, type Request, type RequestSource, type RunState } from "@orca/core";
import type { Orchestrator } from "../orchestrator.js";

export interface SubmitRequestInput {
  title: string;
  body: string;
  source?: RequestSource;
  labels?: string[];
  /** Override the configured program workflow. */
  workflowId?: string;
  vars?: Record<string, unknown>;
}

export class ProgramService {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly programWorkflowId = "program",
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
    await this.orchestrator.stores.requests.put(request);
    const runId = await this.orchestrator.startRun({ workflowId: input.workflowId ?? this.programWorkflowId, requestId: request.id, vars: { request, ...(input.vars ?? {}) } });
    await this.orchestrator.stores.requests.put({ ...request, programRunId: runId });
    return { request: { ...request, programRunId: runId }, runId };
  }

  async submitAndRun(input: SubmitRequestInput): Promise<{ request: Request; state: RunState }> {
    const { request, runId } = await this.submit(input);
    const state = await this.orchestrator.run(runId);
    const status = state.run.status === "completed" ? "completed" : state.run.status === "cancelled" ? "cancelled" : "failed";
    const cur = (await this.orchestrator.stores.requests.get(request.id)) ?? request;
    await this.orchestrator.stores.requests.put({ ...cur, status, updatedAt: this.orchestrator.clock.isoNow() });
    return { request: cur, state };
  }
}
