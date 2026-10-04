/** Real admission composition for child processes; no Vitest or in-memory stores. */
import { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  parseOrcaConfig,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import { fileStores } from "@orca/store";
import { FileRetryClaimStore } from "../../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../../src/admission-retry.js";
import { ConfigurationGenerations } from "../../src/configuration-generation.js";
import { DirectAdmissionService } from "../../src/direct-admission.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { RequestSubmissionService } from "../../src/program/request-submission.js";
import { FileAdmissionStore } from "../../src/program/submission-store.js";
import { LocalWorkspaceProvider } from "../../src/workspace/provider.js";

export type AdmissionKind = "request" | "direct";
export type Boundary =
  | "claimed"
  | "bound"
  | "material"
  | "request-document"
  | "inputs"
  | "created"
  | "policy"
  | "owner"
  | "linked"
  | "admission-accepted"
  | "receipt"
  | "response";
export const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Retry conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "Retry limit"),
};

export async function processFixture(dir: string, boundary: (name: Boundary) => Promise<void>) {
  const stores = fileStores(dir);
  const admissions = new FileAdmissionStore(dir);
  const store = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults, lockTimeoutMs: 5_000 });
  const claims = new RegisteredRetryClaims(store, faults);
  const workflow = parseWorkflow(`
id: program
name: Program
version: "1"
inputSchema:
  unknown: reject
  fields:
    request: { type: object }
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges: [{ from: s, to: e }]
`);
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(workflow),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  let starts = 0;
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: [workflow], templates: [] }),
    admission: {
      validateStartRun: (options, material) => orc.validateStartRun(options, material),
      startRun: async (options, material) => {
        starts++;
        const runId = await orc.startRun(options, material);
        await boundary("created");
        return runId;
      },
    },
  });
  await generations.initialize(parseOrcaConfig({ agents: [], program: { workflow: "program" } }), "process-fixture");
  orc.generations = generations;

  // Instrument only completed persistence calls. Blocking here with IPC allows SIGKILL
  // before the caller receives its acknowledgement, without running catch/finally.
  const putInputs = stores.execution.putInputs.bind(stores.execution);
  stores.execution.putInputs = async (inputs) => {
    await putInputs(inputs);
    await boundary(inputs.runId.startsWith("run_") ? "inputs" : "material");
  };
  const putGeneration = stores.execution.putGeneration.bind(stores.execution);
  stores.execution.putGeneration = async (id, value) => {
    await putGeneration(id, value);
    if (id.startsWith("direct-material-")) await boundary("material");
    if (id.startsWith("admission-execution-policy:")) await boundary("policy");
  };
  const putRequest = stores.requests.put.bind(stores.requests);
  stores.requests.put = async (request) => {
    await putRequest(request);
    await boundary(request.programRunId ? "linked" : "request-document");
  };
  const putAdmission = admissions.records.put.bind(admissions.records);
  admissions.records.put = async (record) => {
    await putAdmission(record);
    if (record.state === "accepted") await boundary("admission-accepted");
  };
  const write = store.write.bind(store);
  store.write = async (record) => {
    await write(record);
    await boundary(record.phase === "accepted" ? "receipt" : "bound");
  };
  // Authority is a trusted fixture, with durable ownership checked by real replay.
  // This tests service/store admission, not transport authentication or grant enforcement.
  const authority = {
    workspaceId: "process-workspace",
    actor: { principalId: "owner" },
    authorize: async () => {},
    onRunAdmitted: async (runId: string) => {
      const key = `process-owner:${runId}`;
      const existing = await stores.execution.getGeneration(key);
      if (existing === undefined) await stores.execution.putGeneration(key, { principalId: "owner" });
      else if (
        !existing ||
        typeof existing !== "object" ||
        !("principalId" in existing) ||
        existing.principalId !== "owner"
      )
        throw new OrcaError("RUN_STATE", "Ownership unavailable");
      await boundary("owner");
    },
    verifyRunAdmitted: async (runId: string) => {
      const owner = await stores.execution.getGeneration(`process-owner:${runId}`);
      if (!owner || typeof owner !== "object" || !("principalId" in owner) || owner.principalId !== "owner")
        throw new OrcaError("RUN_STATE", "Ownership unavailable");
    },
  };
  const request = new RequestSubmissionService({
    orchestrator: orc,
    admissions,
    retries: claims,
    captureLaunch: generations.captureLaunch,
    restoreLaunch: generations.restoreLaunch,
  });
  const direct = new DirectAdmissionService({
    orchestrator: orc,
    retries: claims,
    captureLaunch: generations.captureLaunch,
    restoreLaunch: generations.restoreDirectLaunch,
  });
  const submit = (kind: AdmissionKind) =>
    kind === "request"
      ? request.submitRetry(
          { title: "Process Request", body: "same intent" },
          { idempotencyKey: "same-key" },
          authority,
        )
      : direct.admitRun({ workflowId: "program" }, { idempotencyKey: "same-key" }, authority);
  return { stores, admissions, store, orc, submit, starts: () => starts };
}
