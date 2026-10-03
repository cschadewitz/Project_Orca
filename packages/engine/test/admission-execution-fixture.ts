/** Real protected stores/generations; shared by unit and independent-process fence tests. */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, RequestSchema, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { memoryStores, type Stores } from "@orca/store";
import {
  builtinExecutors,
  completed,
  ConfigurationGenerations,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  publishAdmissionExecutionPolicy,
  type AdmissionExecutionBinding,
  type AdmissionExecutionPolicy,
} from "../src/index.js";

export const actor = { principalId: "admission-owner", credentialId: "admission-credential" };
export async function admissionRuntime(
  stores: Stores = memoryStores(),
  options: {
    workflowVersion?: string;
    effect?: () => Promise<void>;
    authorize?: (policy: Readonly<AdmissionExecutionPolicy>) => Promise<void>;
  } = {},
) {
  const definition = parseWorkflow(`
id: admission-fence
name: Admission fence
version: '${options.workflowVersion ?? "1"}'
start: s
nodes:
  s: {type: start}
  effect: {type: 'custom:effect'}
  gate: {type: gate, question: Continue?, options: [go]}
  done: {type: end}
edges:
  - {from: s, to: effect}
  - {from: effect, to: gate}
  - {from: gate, to: done}
`);
  let effects = 0;
  const executors = builtinExecutors().register({
    type: "custom:effect",
    execute: async () => {
      effects++;
      await options.effect?.();
      return completed();
    },
  });
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    executors,
    humanInput: new PausingHumanInput(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    admissionExecution: { authorize: options.authorize ?? (async () => {}) },
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: [definition], templates: [] }),
    admission: orc,
    validateCustomNode: (node) => executors.validateNode(node),
  });
  await generations.initialize(parseOrcaConfig({ program: { workflow: definition.id } }), "fixture-revision");
  orc.generations = generations;
  const admit = async (kind: "direct" | "request" = "direct", publish = true, workflowVersion?: string) => {
    const runId = `run_${randomUUID()}`;
    const admissionId = `admission_${randomUUID()}`;
    const requestId = kind === "request" ? `request_${randomUUID()}` : undefined;
    if (requestId)
      await stores.requests.put(
        RequestSchema.parse({
          id: requestId,
          title: "Task",
          body: "Task",
          source: { kind: "manual" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    const launch = await generations.captureLaunch({
      purpose: "workflow",
      workflowId: definition.id,
      ...(workflowVersion ? { workflowVersion } : {}),
    });
    await launch.startRun({
      actor,
      admissionRunId: runId,
      ...(kind === "request"
        ? { requestAdmissionId: admissionId, requestId: requestId! }
        : { directAdmissionId: admissionId }),
    });
    const binding: AdmissionExecutionBinding = {
      kind,
      admissionId,
      runId,
      workspaceId: "admission-workspace",
      actor,
      generationId: launch.generationId,
      workflow: { ...launch.workflow },
      ...(requestId ? { requestId } : {}),
    };
    if (publish) await publishAdmissionExecutionPolicy(orc.stores, binding);
    return binding;
  };
  return { orc, stores: orc.stores, generations, admit, effects: () => effects };
}
