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
} from "@orca/daemon";
import type { ResponseMessage } from "@orca/protocol";
import { AdmissionRetryModel } from "../../daemon/src/admission-retry.js";
import { RequestSubmissionModel } from "../../daemon/src/request-submission.js";
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
    try {
      await writeFile(
        join(dir, "program.yaml"),
        "id: program\nname: Program\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
      );
      const app = (await bootstrap({
        configDir: dir,
        config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [] }),
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
      const execute = vi.fn(() => new Promise<void>(() => {}));
      const requestService = app.program.submissions as RequestSubmissionService;
      const admissionRetries = new AdmissionRetryModel({
        claims: app.retryClaims,
        direct: app.directAdmissions,
        requests: requestService,
        orchestrator: app.orchestrator,
        execute,
        executionFailed: vi.fn(),
      });
      const options = {
        orcaVersion: "test",
        capabilities: [] as [],
        reads,
        control: new ControlModel({ orchestrator: app.orchestrator, reads }),
        source: app.orchestrator,
        admissionRetries,
        requestSubmissions: new RequestSubmissionModel({ service: requestService, execute, executionFailed: vi.fn() }),
        submissionWorkspaceId: "w",
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
      const first = await http("runs.admit", command);
      expect(first).toMatchObject({ ok: true, result: { state: "accepted" } });
      if (!first.ok) throw new Error("not admitted");
      const receipt = first.result as { runId: string; operationId: string };
      expect(ownership.owner(receipt.runId)).toBe("alice");
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
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
      expect(await app.orchestrator.listRuns()).toHaveLength(1);
      expect(await app.orchestrator.stores.requests.list()).toHaveLength(0);
      const request = { title: "request", body: "body", idempotencyKey: "request-intent" };
      const one = await http("requests.submit", request);
      const two = await http("requests.submit", request);
      expect(two).toEqual(one);
      expect(await app.orchestrator.stores.requests.list()).toHaveLength(1);
      expect(await http("runs.admit", { ...command, vars: { changed: true } })).toMatchObject({
        ok: false,
        error: { code: "RETRY_CONFLICT" },
      });
      await credentials.revoke(owner.credential.id);
      expect(await http("admissions.get", { operationId: receipt.operationId })).toMatchObject({
        ok: false,
        error: { code: "AUTH_INVALID" },
      });
    } finally {
      socket?.close();
      await close?.();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
