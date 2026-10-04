/** Real daemon adapters all reach the same first-attachment barrier. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { ControlModel } from "../src/control.js";
import { ReadModel } from "../src/read-model.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { AdmissionRetryModel, directAdmissionAuthority, type AdmissionAuthorities } from "../src/admission-retry.js";
import { Authorizer, CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-routes-"));
  close.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "workflow.yaml"),
    "id: workflow\nname: Workflow\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
  );
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [] }),
    logger: silentLogger,
  });
  const credentials = new CredentialStore();
  const issued = await credentials.issue({
    principal: "alice",
    permissions: ["runs.start"],
    scope: { workflows: ["workflow"], runs: "owned" },
  });
  const actor = { principalId: "alice", credentialId: issued.credential.id };
  const ownership = new OwnershipStore();
  const runtime = daemonExecutionRuntime({
    instanceId: "fixture",
    workspaceId: "workspace",
    orchestrator: app.orchestrator,
    credentials,
    ownership,
  });
  close.push(() => runtime.close());
  app.orchestrator.liveInput = runtime;
  app.orchestrator.admissionExecution = { authorize: (policy) => runtime.authorizeAdmissionExecution(policy) };
  const authority = directAdmissionAuthority({
    workspaceId: "workspace",
    actor,
    authorizer: new Authorizer({ ownership, resolver: orchestratorResolver(app.orchestrator) }),
    principal: async () => {
      const current = credentials.current(issued.credential.id);
      if (!current.ok) throw new Error("credential revoked");
      return current.principal;
    },
  });
  let observeExecution!: (completion: Promise<void>) => void;
  const executionComplete = new Promise<void>((resolve) => {
    observeExecution = resolve;
  });
  void executionComplete.catch(() => {});
  const execute = vi.fn((runId: string) => {
    const task = app.orchestrator.run(runId).then(() => {});
    observeExecution(task);
    return task;
  });
  const failed = vi.fn();
  const model = new AdmissionRetryModel({
    claims: app.retryClaims!,
    direct: app.directAdmissions!,
    requests: app.program.submissions!,
    orchestrator: app.orchestrator,
    execute,
    executionFailed: failed,
  });
  const control = new ControlModel({
    orchestrator: app.orchestrator,
    reads: new ReadModel({ orchestrator: app.orchestrator }),
  });
  const authorities: AdmissionAuthorities = {
    principalId: actor.principalId,
    workspaceId: "workspace",
    check: () => authority.authorize({ workflowId: "workflow" }),
    direct: async () => authority,
    request: async () => {
      throw new Error("not a Request");
    },
  };
  const admit = () =>
    app.directAdmissions!.admitRun({ workflowId: "workflow" }, { idempotencyKey: "intent" }, authority);
  return {
    ...app,
    credentials,
    issued,
    ownership,
    actor,
    authority,
    model,
    execute,
    executionComplete,
    failed,
    control,
    authorities,
    admit,
  };
}
it.each([false, true])(
  "ControlModel.settleAdmitted uses current first-start authority (revoked=%s)",
  async (revoked) => {
    const f = await fixture();
    const receipt = await f.admit();
    if (receipt.state !== "resolved" || receipt.result.state !== "accepted") throw new Error("not admitted");
    const runId = receipt.result.runId;
    if (revoked) {
      await f.credentials.revoke(f.issued.credential.id);
      await expect(f.control.settleAdmitted(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
      expect((await f.orchestrator.events(runId)).map((event) => event.type)).toEqual(["run.created"]);
    } else {
      await f.control.settleAdmitted(runId);
      expect((await f.orchestrator.getState(runId)).run.status).toBe("completed");
      expect((await f.orchestrator.events(runId)).filter((event) => event.type === "run.started")).toHaveLength(1);
    }
  },
);
it.each(["admit", "reconcile"] as const)("%s dispatch executes a real admitted run exactly once", async (route) => {
  const f = await fixture();
  const receipt =
    route === "admit"
      ? await f.model.admit({ workflowId: "workflow" }, { idempotencyKey: "intent" }, f.authority)
      : await (async () => {
          const accepted = await f.admit();
          if (accepted.state !== "resolved" || accepted.result.state !== "accepted") throw new Error("not admitted");
          await f.model.reconcile(accepted.operationId, f.authorities);
          return accepted.result;
        })();
  if (receipt.state !== "accepted") throw new Error("not accepted");
  await f.executionComplete;
  expect((await f.orchestrator.getState(receipt.runId)).run.status).toBe("completed");
  await f.model.admit({ workflowId: "workflow" }, { idempotencyKey: "intent" }, f.authority);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.failed).not.toHaveBeenCalled();
  expect((await f.orchestrator.events(receipt.runId)).filter((event) => event.type === "run.started")).toHaveLength(1);
});
it("a legacy admitted root without policy stays refused rather than receiving new authority", async () => {
  const f = await fixture();
  const runId = await f.orchestrator.startRun({
    workflowId: "workflow",
    actor: f.actor,
    directAdmissionId: "legacy-admission",
  });
  f.ownership.record(runId, f.actor.principalId);
  await f.ownership.flush(runId);
  await expect(f.control.settleAdmitted(runId)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect((await f.orchestrator.events(runId)).map((event) => event.type)).toEqual(["run.created"]);
  expect(await f.orchestrator.stores.execution.getGeneration(`admission-execution-policy:${runId}`)).toBeUndefined();
});
