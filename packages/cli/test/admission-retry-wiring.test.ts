/** Real generation/orchestrator and HTTP/WS wiring; enabled only with the exact integration patch. */
import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import {
  ControlModel,
  CredentialStore,
  OwnershipStore,
  ReadModel,
  orchestratorResolver,
  startDaemon,
  daemonExecutionRuntime,
} from "@orca/daemon";
import { OperatorDiscoverySchema, RunsAdmitResultSchema, type ResponseMessage } from "@orca/protocol";
import { AdmissionIntents, AdmissionIntentController } from "../../app/src/main/admission-intents.js";
import { AdmissionRetryModel, neverAttached } from "../../daemon/src/admission-retry.js";
import { RequestSubmissionModel } from "../../daemon/src/request-submission.js";
import type { ExecutionResumeAuthority } from "@orca/engine";
import type { DirectAdmissionService } from "../../engine/src/direct-admission.js";
import type { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import type { RequestSubmissionService } from "../../engine/src/program/request-submission.js";
import { bootstrap } from "../src/bootstrap.js";
it.skipIf(process.env.ORCA_RETRY_INTEGRATION !== "1")(
  "HTTP/WS and legacy start share one real admission, ownership and current authorization",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-retry-wiring-"));
    let close: (() => Promise<void>) | undefined;
    let socket: WebSocket | undefined;
    let runtime: ReturnType<typeof daemonExecutionRuntime> | undefined;
    try {
      await writeFile(
        join(dir, "program.yaml"),
        "id: program\nname: Program\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
      );
      const app = (await bootstrap({
        configDir: dir,
        config: parseOrcaConfig({ program: { itemWorkflow: "program" }, workflows: ["*.yaml"], templates: [] }),
        logger: silentLogger,
      })) as Awaited<ReturnType<typeof bootstrap>> & {
        retryClaims: RegisteredRetryClaims;
        directAdmissions: DirectAdmissionService;
      };
      const credentials = new CredentialStore();
      const owner = await credentials.issue({ principal: "alice", preset: "owner" });
      const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
      const ownership = new OwnershipStore();
      const reads = new ReadModel({ orchestrator: app.orchestrator });
      const workspaceId = "00000000-0000-4000-8000-000000000001";
      const execution = daemonExecutionRuntime({
        instanceId: "admission-retry-test",
        workspaceId,
        orchestrator: app.orchestrator,
        credentials,
        ownership,
      });
      runtime = execution;
      app.orchestrator.liveInput = execution;
      app.orchestrator.admissionExecution = { authorize: (policy) => execution.authorizeAdmissionExecution(policy) };
      const completions = new Map<string, { done: Promise<void>; begin: (task: Promise<void>) => void }>();
      const completionFor = (runId: string) => {
        const existing = completions.get(runId);
        if (existing) return existing;
        let begin!: (task: Promise<void>) => void;
        const done = new Promise<void>((resolve) => {
          begin = resolve;
        });
        void done.catch(() => {});
        const completion = { done, begin };
        completions.set(runId, completion);
        return completion;
      };
      const execute = vi.fn((runId: string, authority?: ExecutionResumeAuthority) => {
        const task = (async () => {
          const state = await execution.withResumeAuthority(runId, authority, () => app.orchestrator.run(runId));
          await app.program.settle(state);
        })();
        completionFor(runId).begin(task);
        return task;
      });
      const executionFailed = vi.fn();
      const requestService = app.program.submissions as RequestSubmissionService;
      const admissionRetries = new AdmissionRetryModel({
        claims: app.retryClaims,
        direct: app.directAdmissions,
        requests: requestService,
        orchestrator: app.orchestrator,
        execute,
        checkResumeAuthority: (runId, authority) => execution.checkResumeAuthority(runId, authority),
        executionFailed,
      });
      const options = {
        orcaVersion: "test",
        workspaceId,
        operatorSources: { events: app.orchestrator.stores.events },
        capabilities: [] as [],
        reads,
        control: new ControlModel({ orchestrator: app.orchestrator, reads }),
        source: app.orchestrator,
        admissionRetries,
        requestSubmissions: new RequestSubmissionModel({
          service: requestService,
          shouldDispatch: (runId) => neverAttached(app.orchestrator, runId),
          execute,
          checkResumeAuthority: (runId, authority) => execution.checkResumeAuthority(runId, authority),
          executionFailed,
        }),
        submissionWorkspaceId: workspaceId,
        auth: { mode: "token" as const, credentials, ownership, resolver: orchestratorResolver(app.orchestrator) },
      };
      const daemon = await startDaemon(options);
      close = daemon.close;
      const http = async (method: string, params: unknown, token = owner.token): Promise<ResponseMessage> =>
        (await (
          await fetch(`${daemon.url}/rpc`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ kind: "request", id: 1, method, params }),
          })
        ).json()) as ResponseMessage;
      expect(await http("runs.admit", { invalid: true }, viewer.token)).toMatchObject({
        ok: false,
        error: { code: "AUTH_FORBIDDEN" },
      });
      socket = new WebSocket(daemon.socketUrl!, ["orca.v1", `orca.bearer.${owner.token}`]);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
      });
      const command = { workflowId: "program", idempotencyKey: "direct-intent" };
      const expectedScope = { principalId: "alice", workspaceId: options.submissionWorkspaceId };
      expect(
        await http("runs.admit", { ...command, expectedScope: { ...expectedScope, principalId: "bob" } }),
      ).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
      expect(await app.orchestrator.listRuns()).toHaveLength(0);
      const first = await http("runs.admit", { ...command, expectedScope });
      expect(first).toMatchObject({ ok: true, result: { state: "accepted" } });
      if (!first.ok) throw new Error("not admitted");
      const receipt = first.result as { runId: string; operationId: string };
      expect(ownership.owner(receipt.runId)).toBe("alice");
      await completionFor(receipt.runId).done;
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await app.orchestrator.getState(receipt.runId)).run.status).toBe("completed");
      const second = await new Promise<ResponseMessage>((resolve) => {
        socket!.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as ResponseMessage;
          if (frame.id === 2) resolve(frame);
        });
        socket!.send(JSON.stringify({ kind: "request", id: 2, method: "runs.admit", params: command }));
      });
      expect(second).toMatchObject({ ok: true, result: first.result });
      expect(await http("admissions.get", { operationId: receipt.operationId })).toMatchObject({
        ok: true,
        result: { state: "resolved", result: { runId: receipt.runId } },
      });
      expect(await http("runs.start", command)).toMatchObject({ ok: true, result: { runId: receipt.runId } });
      expect(
        (await app.orchestrator.events(receipt.runId)).filter((event) => event.type === "run.started"),
      ).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await app.orchestrator.listRuns()).toHaveLength(1);
      expect(await app.orchestrator.stores.requests.list()).toHaveLength(0);
      const request = { title: "request", body: "body", idempotencyKey: "request-intent" };
      const one = await http("requests.submit", request);
      expect(one).toMatchObject({ ok: true, result: { state: "accepted" } });
      if (!one.ok) throw new Error("Request not admitted");
      const requestReceipt = one.result as { runId: string };
      await completionFor(requestReceipt.runId).done;
      expect((await app.orchestrator.getState(requestReceipt.runId)).run.status).toBe("completed");
      const two = await http("requests.submit", request);
      expect(two).toEqual(one);
      expect(await app.orchestrator.stores.requests.list()).toHaveLength(1);
      expect(await http("runs.admit", { ...command, vars: { changed: true } })).toMatchObject({
        ok: false,
        error: { code: "RETRY_CONFLICT" },
      });
      // Real discovery is the app's scope handshake. Mock encryption here proves
      // routing/restart control only; OS-keychain acceptance is a separate Electron gate.
      const discover = async (token = owner.token) => {
        const response = await http("operator.discover", {}, token);
        if (!response.ok) throw new Error("discovery refused");
        return OperatorDiscoverySchema.parse(response.result);
      };
      const found = await discover();
      expect(found.operations).toContain("runs.admit");
      expect(found.operations).toContain("operator.admitRun");
      const viewerOperations = (await discover(viewer.token)).operations;
      expect(viewerOperations).not.toContain("runs.admit");
      expect(viewerOperations).not.toContain("operator.admitRun");
      const encryption = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "test-only-mock",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      };
      const controller = () =>
        new AdmissionIntentController(new AdmissionIntents(join(dir, "test-intents.enc"), encryption), async () => {
          const current = await discover();
          if (!current.operations.includes("runs.admit")) throw new Error("admission unavailable");
          return {
            scope: { target: daemon.url, principalId: current.principalId, workspaceId: current.target.workspaceId },
            assertCurrent: () => {},
            admit: async (params) => {
              const response = await http("runs.admit", params);
              if (!response.ok) throw new Error(response.error.message);
              return RunsAdmitResultSchema.parse(response.result);
            },
          };
        });
      const palette = await controller().start("program");
      expect(await controller().start("program")).toEqual(palette);
      expect(await controller().list()).toHaveLength(1);
      await completionFor(palette.runId).done;
      expect((await app.orchestrator.getState(palette.runId)).run.status).toBe("completed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(execute.mock.results.map((result) => result.value));
      expect(executionFailed).not.toHaveBeenCalled();
      await credentials.revoke(owner.credential.id);
      expect(await http("admissions.get", { operationId: receipt.operationId })).toMatchObject({
        ok: false,
        error: { code: "AUTH_INVALID" },
      });
    } finally {
      socket?.close();
      await close?.();
      runtime?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
