/** Production bootstrap, models and authenticated disposable daemon; no native updater. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { FileContinuationLocatorStore } from "@orca/store";
import type { ExecutionResumeAuthority } from "@orca/engine";
import { PROTOCOL_VERSION, type ResponseMessage } from "@orca/protocol";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { AdmissionRetryModel, neverAttached } from "../src/admission-retry.js";
import { RequestSubmissionModel } from "../src/request-submission.js";
import { ContinuationAdmissionModel } from "../src/continuation-admission.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import {
  ControlModel,
  CredentialStore,
  OwnershipStore,
  ReadModel,
  createDaemonIdentity,
  orchestratorResolver,
  startDaemon,
} from "../src/index.js";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function runtimeMaintenanceFixture(
  options: {
    omitRequests?: boolean;
    wrongControl?: boolean;
    wrongCredentials?: boolean;
    invalidIdentity?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-runtime-maintenance-"));
  await writeFile(
    join(dir, "flow.yaml"),
    "id: flow\nname: Flow\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
  );
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [], program: { workflow: "flow" } }),
    logger: silentLogger,
  });
  const credentials = new CredentialStore();
  const owner = await credentials.issue({ principal: "runtime-owner", preset: "owner" });
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const ownership = new OwnershipStore();
  const identity = createDaemonIdentity(options.invalidIdentity ? "unversioned-workspace" : randomUUID());
  const target = { ...identity, processId: process.pid };
  const orc = app.orchestrator;
  const runtime = daemonExecutionRuntime({
    ...identity,
    orchestrator: orc,
    credentials: options.wrongCredentials ? new CredentialStore() : credentials,
    ownership,
  });
  orc.liveInput = runtime;
  orc.runtimeActivity = runtime.activity;
  orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
  if (!app.program.submissions || !app.retryClaims || !app.directAdmissions || !app.retryClaimStore)
    throw new Error("Missing production admission services");
  const execute = async (id: string, authority?: ExecutionResumeAuthority) => {
    await runtime.withResumeAuthority(id, authority, () => orc.run(id));
  };
  const requests = new RequestSubmissionModel({
    runtimeActivity: runtime.activity,
    orchestrator: orc,
    service: app.program.submissions,
    shouldDispatch: (id) => neverAttached(orc, id),
    execute: async (id, authority) => {
      await execute(id, authority);
      await app.program.settle(await orc.getState(id));
    },
    executionFailed: () => {},
  });
  const admissions = new AdmissionRetryModel({
    runtimeActivity: runtime.activity,
    orchestrator: orc,
    claims: app.retryClaims,
    direct: app.directAdmissions,
    requests: app.program.submissions,
    execute,
    executionFailed: () => {},
  });
  const locators = new FileContinuationLocatorStore({
    storeDir: join(dir, ".orca"),
    execution: orc.stores.execution,
    retries: app.retryClaimStore,
  });
  const continuations = new ContinuationAdmissionModel({
    runtimeActivity: runtime.activity,
    orchestrator: orc,
    claims: app.retryClaims,
    locators,
    executionRuntime: runtime,
  });
  const reads = new ReadModel({ orchestrator: orc });
  const control = new ControlModel({ orchestrator: orc, reads });
  const daemon = await startDaemon({
    orcaVersion: "fixture",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    ...identity,
    identity,
    storeDir: join(dir, ".orca"),
    source: orc,
    reads,
    control: options.wrongControl ? undefined : control,
    liveInputs: runtime.port,
    runtimeIdle: runtime,
    requestSubmissions: options.omitRequests ? undefined : requests,
    admissionRetries: admissions,
    continuationAdmissions: continuations,
    submissionWorkspaceId: identity.workspaceId,
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(orc) },
  });
  const call = async (method: string, params: unknown = {}, token = owner.token): Promise<ResponseMessage> => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as ResponseMessage;
  };
  return {
    dir,
    app,
    orc,
    credentials,
    owner,
    viewer,
    ownership,
    identity,
    target,
    runtime,
    requests,
    admissions,
    locators,
    continuations,
    daemon,
    call,
    hello: () => call("hello", { client: "runtime-fixture", protocol: PROTOCOL_VERSION }),
    prepare: (token = "update-owner", expected = target) =>
      call("maintenance.runtime", { action: "prepare", token, target: expected }),
    resume: (token = "update-owner") => call("maintenance.runtime", { action: "resume", token, target }),
    close: async () => {
      await daemon.close();
      runtime.close();
      await rm(dir, { recursive: true });
    },
  };
}
