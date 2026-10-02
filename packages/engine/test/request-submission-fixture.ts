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
import { MemoryAdmissionStore, type AdmissionStore } from "../src/program/submission-store.js";

export function submissionFixture(
  stores: Stores = memoryStores(),
  admissions: AdmissionStore = new MemoryAdmissionStore(),
) {
  const definition = parseWorkflow(`
id: program
name: Program
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true }
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
      generationId: captured,
      workflow: { id: workflowId, version: pinned.workflowVersion, revision: pinned.expectedWorkflowRevision },
      validateStartRun: async (options: BoundLaunchOptions) => {
        await orc.validateStartRun({ ...options, ...pinned });
      },
      startRun: async (options: BoundLaunchOptions) => {
        await beforeStart?.();
        // Fixture defaults captured by value, even if generation changes during persistence.
        return orc.startRun({ ...options, ...pinned, vars: { capturedGeneration: captured, ...options.vars } });
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
