/** Authorized HTTP/WS first-start evidence is read-only and distinct from live attachment. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseOrcaConfig, silentLogger } from "@orca/core";
import { publishAdmissionExecutionPolicy, readAdmissionExecutionStatus } from "@orca/engine";
import {
  PROTOCOL_VERSION,
  RunsGetResultSchema,
  type AdmissionExecutionView,
  type ResponseMessage,
} from "@orca/protocol";
import { bootstrap } from "../../cli/src/bootstrap.js";
import { CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { ReadModel } from "../src/read-model.js";
import { startDaemon } from "../src/server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-projection-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "tiny.yaml"),
    "id: tiny\nname: Tiny\nversion: '1'\nstart: s\nnodes: {s: {type: start}, e: {type: end}}\nedges: [{from: s, to: e}]\n",
  );
  const app = await bootstrap({
    configDir: dir,
    config: parseOrcaConfig({ workflows: ["*.yaml"], templates: [] }),
    logger: silentLogger,
  });
  const stores = app.orchestrator.stores;
  const credentials = new CredentialStore({ file: join(dir, "credentials.json") });
  const alice = await credentials.issue({
    principal: "alice",
    permissions: ["runs.read"],
    scope: { runs: "owned", workflows: ["tiny"] },
  });
  const bob = await credentials.issue({
    principal: "bob",
    permissions: ["runs.read"],
    scope: { runs: "owned", workflows: ["tiny"] },
  });
  const noRead = await credentials.issue({
    principal: "alice",
    permissions: ["runs.start"],
    scope: { runs: "owned", workflows: ["tiny"] },
  });
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  const launch = await app.generations.captureLaunch({
    purpose: "workflow",
    workflowId: "tiny",
  });
  const actor = { principalId: "alice", credentialId: alice.credential.id };
  const admissionId = `direct_${randomUUID()}`;
  const runId = await launch.startRun({ actor, admissionRunId: `run_${randomUUID()}`, directAdmissionId: admissionId });
  ownership.record(runId, "alice");
  await ownership.flush(runId);
  await publishAdmissionExecutionPolicy(stores, {
    kind: "direct",
    admissionId,
    runId,
    workspaceId: "workspace",
    actor,
    generationId: launch.generationId,
    workflow: launch.workflow,
  });
  let afterRead: (() => Promise<void>) | undefined;
  const source = vi.fn(async (id: string): Promise<AdmissionExecutionView | undefined> => {
    const status = await readAdmissionExecutionStatus(stores, id);
    await afterRead?.();
    if (status.state === "ordinary") return undefined;
    if (status.state === "ready") return { state: "pending" };
    if (status.state === "started") return { state: "started" };
    if (status.state === "unknown") return { state: "uncertain", reason: "legacy-evidence" };
    return { state: "uncertain", reason: "evidence-unavailable" };
  });
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.subscribe"],
    reads: new ReadModel({ orchestrator: app.orchestrator }),
    source: app.orchestrator,
    admissionExecutionSource: source,
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(app.orchestrator) },
  });
  cleanup.push(() => daemon.close());
  const http = async (token = alice.token): Promise<ResponseMessage> =>
    (
      await fetch(`${daemon.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: "request", id: 1, method: "runs.get", params: { runId } }),
      })
    ).json() as Promise<ResponseMessage>;
  const socket = async () => {
    const ws = new WebSocket(daemon.socketUrl!, ["orca.v1", `orca.bearer.${alice.token}`]);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    });
    cleanup.push(async () => ws.close());
    let id = 0;
    const call = (method: string, params: unknown) =>
      new Promise<ResponseMessage>((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => reject(new Error("socket timeout")), 5000);
        const listener = (event: MessageEvent) => {
          const response = JSON.parse(String(event.data)) as ResponseMessage;
          if (response.kind === "response" && response.id === request) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener);
            resolve(response);
          }
        };
        ws.addEventListener("message", listener);
        ws.send(JSON.stringify({ kind: "request", id: request, method, params }));
      });
    const hello = await call("hello", { client: "admission-projection-test", protocol: PROTOCOL_VERSION });
    expect(hello.ok).toBe(true);
    return () => call("runs.get", { runId });
  };
  return {
    app,
    stores,
    runId,
    alice,
    bob,
    noRead,
    credentials,
    ownership,
    source,
    http,
    socket,
    afterRead: (action: () => Promise<void>) => {
      afterRead = action;
    },
  };
}
function view(response: ResponseMessage) {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  if (!response.ok) throw new Error("read failed");
  return RunsGetResultSchema.parse(response.result);
}

it("reports real protected pending evidence over HTTP and WS without attaching or rewriting", async () => {
  const f = await fixture();
  const before = await f.stores.events.read(f.runId);
  expect(view(await f.http()).admissionExecution).toEqual({ state: "pending" });
  expect(view(await (await f.socket())()).admissionExecution).toEqual({ state: "pending" });
  expect(await f.stores.events.read(f.runId)).toEqual(before);
  expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
});
it("refuses denied resources and grants before reading protected execution evidence", async () => {
  const f = await fixture();
  expect((await f.http(f.bob.token)).ok).toBe(false);
  expect((await f.http(f.noRead.token)).ok).toBe(false);
  expect(f.source).not.toHaveBeenCalled();
});
it.each(["http", "ws"] as const)(
  "rechecks current resource ownership after the protected asynchronous read (%s)",
  async (transport) => {
    const f = await fixture();
    f.afterRead(async () => {
      f.ownership.forget(f.runId, "alice");
      await f.ownership.flush(f.runId);
    });
    const read = transport === "http" ? f.http : await f.socket();
    const response = await read();
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("admissionExecution");
    expect(f.source).toHaveBeenCalledTimes(1);
  },
);
it.each(["http", "ws"] as const)(
  "does not turn a failed journal read into empty or pending success (%s)",
  async (transport) => {
    const f = await fixture();
    const read = transport === "http" ? f.http : await f.socket();
    vi.spyOn(f.stores.execution, "getGeneration").mockRejectedValueOnce(new Error("unavailable"));
    expect(view(await read()).admissionExecution).toEqual({ state: "uncertain", reason: "evidence-unavailable" });
  },
);

it.each(["http", "ws"] as const)(
  "does not return evidence after the original credential is revoked (%s)",
  async (transport) => {
    const f = await fixture();
    const read = transport === "http" ? f.http : await f.socket();
    f.afterRead(async () => {
      await f.credentials.revoke(f.alice.credential.id);
    });
    const response = await read();
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("admissionExecution");
  },
);
