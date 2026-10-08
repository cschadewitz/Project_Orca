/** Fresh-process synthetic daemon with actual auth, producer fencing and existing shutdown drains. No providers. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { FileContinuationLocatorStore } from "@orca/store";
import type { ExecutionResumeAuthority } from "@orca/engine";
import { bootstrap } from "../../../cli/src/bootstrap.js";
import { AdmissionRetryModel, neverAttached } from "../../../daemon/src/admission-retry.js";
import { RequestSubmissionModel } from "../../../daemon/src/request-submission.js";
import { ContinuationAdmissionModel } from "../../../daemon/src/continuation-admission.js";
import { daemonExecutionRuntime } from "../../../daemon/src/execution-runtime.js";
import {
  ControlModel,
  CredentialStore,
  OwnershipStore,
  ReadModel,
  createDaemonIdentity,
  orchestratorResolver,
  startDaemon,
} from "@orca/daemon";
interface Config {
  workspace: string;
  workspaceId: string;
  version: string;
  token?: string;
  fenceId: string;
  ignoreTerm?: boolean;
}
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Config;
const app = await bootstrap({
  configDir: config.workspace,
  config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [], program: { workflow: "flow" } }),
  logger: silentLogger,
});
const credentials = new CredentialStore();
const owner = await credentials.issue({ principal: "synthetic-restart-owner", preset: "owner" });
const tokenFile = join(config.workspace, `owner-${randomUUID()}.token`);
await writeFile(tokenFile, owner.token, { flag: "wx", mode: 0o600 });
const ownership = new OwnershipStore();
const identity = createDaemonIdentity(config.workspaceId);
const orc = app.orchestrator;
const runtime = daemonExecutionRuntime({ ...identity, orchestrator: orc, credentials, ownership });
orc.liveInput = runtime;
orc.runtimeActivity = runtime.activity;
orc.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
if (!app.program.submissions || !app.retryClaims || !app.directAdmissions || !app.retryClaimStore)
  throw new Error("Missing fixture composition");
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
  storeDir: join(config.workspace, ".orca"),
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
  orcaVersion: config.version,
  capabilities: ["runs.read", "runs.control", "runs.subscribe"],
  identity,
  workspaceId: identity.workspaceId,
  storeDir: join(config.workspace, ".orca"),
  source: orc,
  reads,
  control,
  liveInputs: runtime.port,
  runtimeIdle: runtime,
  requestSubmissions: requests,
  admissionRetries: admissions,
  continuationAdmissions: continuations,
  submissionWorkspaceId: identity.workspaceId,
  auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(orc) },
  ...(config.token ? { maintenanceToken: config.token } : {}),
});
let stopping: Promise<void> | undefined;
const close = () =>
  (stopping ??= (async () => {
    await daemon.close();
    runtime.close();
    process.exitCode = 0;
    process.disconnect?.();
  })());
process.on("SIGTERM", () => {
  process.send?.({ kind: "signal", signal: "SIGTERM" });
  if (!config.ignoreTerm)
    void close().catch(() => {
      process.exit(18);
    });
});
process.on("message", (message: { action?: string }) => {
  if (message.action === "cleanup")
    void close().catch(() => {
      process.exit(18);
    });
  if (message.action === "crash") process.exit(17);
});
process.send?.({
  kind: "ready",
  url: daemon.url,
  tokenFile,
  target: { ...identity, processId: process.pid },
  fenceId: config.fenceId,
  admissionClosedFromBootstrap: !!config.token,
});
