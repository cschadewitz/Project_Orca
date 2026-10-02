/** Executed with the reserved integration patch applied; no production-generation substitute. */
import { afterEach, expect, it, vi } from "vitest";
import {
  ControlModel,
  CredentialStore,
  OwnershipStore,
  orchestratorResolver,
  ReadModel,
  startDaemon,
} from "@orca/daemon";
import type { ResponseMessage } from "@orca/protocol";
import type { SubmissionResult } from "@orca/core";
import { submissionFixture } from "../../engine/test/request-submission-fixture.js";
import { RequestSubmissionModel } from "../src/request-submission.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
it("wires authenticated HTTP and socket admission, denies before validation, and preserves direct runs", async () => {
  const f = submissionFixture();
  const credentials = new CredentialStore();
  const owner = await credentials.issue({ principal: "owner", preset: "owner" });
  const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
  const ownership = new OwnershipStore();
  const reads = new ReadModel({ orchestrator: f.orc });
  const execute = vi.fn(async () => {});
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.control", "runs.subscribe"],
    reads,
    control: new ControlModel({ orchestrator: f.orc, reads }),
    source: f.orc,
    requestSubmissions: new RequestSubmissionModel({ service: f.service, execute, executionFailed: vi.fn() }),
    submissionWorkspaceId: "workspace-test",
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(f.orc) },
  });
  closers.push(daemon.close);
  const http = async (method: string, params: unknown, token = owner.token): Promise<ResponseMessage> => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as ResponseMessage;
  };
  expect(await http("requests.submit", { nonsense: 1 }, viewer.token)).toMatchObject({
    ok: false,
    error: { code: "AUTH_FORBIDDEN" },
  });
  expect(await f.admissions.records.list()).toEqual([]);
  expect(await http("requests.submit", { title: "Request", body: "", requestId: "forged" })).toMatchObject({
    ok: false,
    error: { code: "PROTOCOL_MESSAGE" },
  });
  expect(await http("runs.start", { workflowId: "program", requestId: "missing" })).toMatchObject({
    ok: false,
    error: { code: "RUN_STATE" },
  });
  expect(await f.orc.listRuns()).toEqual([]);
  const command = { title: "Request", body: "Task" };
  const first = await http("requests.submit", command);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("not accepted");
  const admitted = first.result as SubmissionResult;
  if (admitted.state !== "accepted") throw new Error("not accepted");
  expect(ownership.owner(admitted.runId)).toBe("owner");
  expect(await http("requests.admission", { admissionId: admitted.admissionId })).toMatchObject({
    ok: true,
    result: admitted,
  });
  const socket = new WebSocket(daemon.socketUrl!, ["orca.v1", `orca.bearer.${owner.token}`]);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
  closers.push(async () => {
    socket.close();
  });
  const second = await new Promise<ResponseMessage>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ResponseMessage;
      if (frame.kind === "response" && frame.id === 2) resolve(frame);
    });
    socket.send(JSON.stringify({ kind: "request", id: 2, method: "requests.submit", params: command }));
  });
  expect(second).toMatchObject({ ok: true, result: { state: "accepted" } });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  expect(await http("runs.start", { workflowId: "program" })).toMatchObject({ ok: true });
  expect(await f.stores.requests.list()).toHaveLength(2);
  await credentials.revoke(owner.credential.id);
  expect(await http("requests.reconcile", { admissionId: admitted.admissionId })).toMatchObject({
    ok: false,
    error: { code: "AUTH_INVALID" },
  });
});
