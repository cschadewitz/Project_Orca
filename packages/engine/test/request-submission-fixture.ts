import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type SubmissionAuthority,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, workflowRevision } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";
import {
  RequestSubmissionService,
  type CaptureLaunch,
  type BoundLaunchOptions,
} from "../src/program/request-submission.js";
import { correlateRequestAdmission } from "../src/program/request-admission-event.js";
import { MemoryAdmissionStore, type AdmissionStore } from "../src/program/submission-store.js";

export function submissionFixture(
  stores: Stores = memoryStores(),
  admissions: AdmissionStore = new MemoryAdmissionStore(),
  options: { strictInputs?: boolean; nativeCorrelation?: boolean; sensitiveInputs?: boolean } = {},
) {
  const definition = parseWorkflow(`
id: program
name: Program
version: "1"
inputSchema:
  unknown: ${options.strictInputs ? "reject" : "allow"}
  fields:
    request: { type: object }
    capturedGeneration: { type: string }
    token: { type: string, sensitive: ${options.sensitiveInputs !== false} }
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges: [{ from: s, to: e }]
`);
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    logger: silentLogger,
  });
  // Faithful provider stand-in for the reserved orchestrator patch: persist metadata
  // immediately before publication, after the real engine's unchanged input validation.
  // Integration tests disable this stand-in and exercise the patched engine itself.
  const correlation = new AsyncLocalStorage<string | undefined>();
  if (!options.nativeCorrelation) {
    const append = orc.stores.events.append.bind(orc.stores.events);
    orc.stores.events.append = async (input) => {
      const id = correlation.getStore();
      return append(
        input.type === "run.created" && id ? await correlateRequestAdmission(input, id, stores.execution) : input,
      );
    };
  }
  let generation = "fixture-generation-1";
  let beforeStart: (() => Promise<void>) | undefined;
  const capture: CaptureLaunch = vi.fn(async (selection) => {
    const captured = generation;
    if (selection.expectedConfigGeneration && selection.expectedConfigGeneration !== captured)
      throw new OrcaError("CONFIG_STALE", "generation changed");
    const workflowId = selection.workflowId ?? "program";
    const validation = await orc.validateStartRun({
      workflowId,
      ...(selection.workflowVersion ? { workflowVersion: selection.workflowVersion } : {}),
      ...(selection.expectedWorkflowRevision ? { expectedWorkflowRevision: selection.expectedWorkflowRevision } : {}),
    });
    const pinned = {
      workflowId,
      workflowVersion: validation.definition.version,
      expectedWorkflowRevision: workflowRevision(validation.definition),
    };
    return {
      requestAdmissionCorrelation: true as const,
      generationId: captured,
      workflow: { id: workflowId, version: pinned.workflowVersion, revision: pinned.expectedWorkflowRevision },
      validateStartRun: async (options: BoundLaunchOptions) => {
        await orc.validateStartRun({ ...options, ...pinned });
      },
      startRun: async (options: BoundLaunchOptions) => {
        await beforeStart?.();
        // Fixture defaults captured by value, even if generation changes during persistence.
        return correlation.run(options.requestAdmissionId, () =>
          orc.startRun({ ...options, ...pinned, vars: { capturedGeneration: captured, ...options.vars } }),
        );
      },
    };
  });
  const owners = new Map<string, string>();
  const authority: SubmissionAuthority = {
    workspaceId: "workspace-test",
    actor: { principalId: "owner", credentialId: "credential-test" },
    authorize: vi.fn(async () => {}),
    onRunAdmitted: vi.fn(async (runId) => {
      owners.set(runId, "owner");
    }),
  };
  const service = new RequestSubmissionService({ orchestrator: orc, admissions, captureLaunch: capture });
  return {
    orc,
    stores,
    admissions,
    capture,
    authority,
    owners,
    service,
    setGeneration: (value: string) => {
      generation = value;
    },
    beforeStart: (action: () => Promise<void>) => {
      beforeStart = action;
    },
  };
}
