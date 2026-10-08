/** Concrete authenticated runtime leases over a disposable daemon and synthetic window ACKs. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { runtimeMaintenanceFixture, barrier } from "../../daemon/test/runtime-maintenance-fixture.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { Workspace } from "../src/main/workspace.js";
import { MacUpdateGuards } from "../src/main/mac-update-guards.js";
import type { DraftWindowBoundary } from "../src/main/update-ipc.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await runtimeMaintenanceFixture();
  closers.push(f.close);
  const tokenDir = await mkdtemp(join(tmpdir(), "orca-runtime-owner-token-"));
  closers.push(() => rm(tokenDir, { recursive: true }));
  const tokenFile = join(tokenDir, "owner.token");
  await writeFile(tokenFile, f.owner.token, { mode: 0o600 });
  const stop = vi.fn(async () => {});
  const workspace = new Workspace({
    findEntry: () => "fixture",
    start: async () => ({ url: f.daemon.url, pid: process.pid, tokenFile, stop }),
    client: (url) =>
      new DaemonClient(url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({ url, tokenFile, env: {} }),
      }),
    subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultUrl: f.daemon.url,
    defaultPath: () => f.dir,
  });
  await workspace.connect();
  workspace.observeHello(workspace.client, {
    identity: f.identity,
    processId: process.pid,
    protocol: PROTOCOL_VERSION,
    orcaVersion: "fixture",
    capabilities: [],
  });
  closers.push(() => workspace.close());
  let frozen = false;
  const boundary: DraftWindowBoundary = {
    acquire: () => {
      frozen = true;
      let receive: Parameters<NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>["listen"]>[0] = () => {};
      return {
        windows: [{ id: 1, generation: 1 }],
        check: () => frozen,
        release: () => {
          frozen = false;
        },
        listen: (listener) => {
          receive = listener;
          return () => {};
        },
        send: (message) => receive({ kind: "ack", sender: 1, value: { ...message, generation: 1, ready: true } }),
      };
    },
  };
  const guards = new MacUpdateGuards(workspace, boundary);
  const draft = await guards.prepareDrafts();
  if (draft.outcome !== "ready") throw new Error("Expected ready drafts");
  return {
    ...f,
    workspace,
    guards,
    stop,
    draft: draft.lease,
    frozen: () => frozen,
    target: { ...f.identity, epoch: workspace.connectionTarget.epoch },
  };
}
it("acquires a proof-bound local/daemon lease and resumes exactly once before releasing local ownership", async () => {
  const f = await fixture();
  const admission = await f.guards.prepareAdmission(f.target, "update-owner");
  expect(admission.outcome).toBe("ready");
  if (admission.outcome !== "ready") throw new Error("Expected ready admission");
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  const release = admission.lease.release();
  expect(await admission.lease.release()).toBe("unknown");
  expect(await release).toBe("released");
  const staged = await f.workspace.prepareConnection("http://localhost:7890");
  await staged.dispose();
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
  expect(await f.draft.release()).toBe("released");
  expect(f.frozen()).toBe(false);
  expect(f.stop).not.toHaveBeenCalled();
});
it("returns known active work without holding daemon admission or the local target reservation", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("dispatch");
  try {
    expect(await f.guards.prepareAdmission(f.target, "update-owner")).toEqual({
      outcome: "blocked",
      blocker: "activity",
    });
  } finally {
    finish();
  }
  const staged = await f.workspace.prepareConnection("http://localhost:7890");
  await staged.dispose();
  expect(await f.draft.release()).toBe("released");
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it.each(["lost", "pid", "instance", "proof"] as const)(
  "retains remote and local ownership after an uncertain %s prepare response",
  async (mode) => {
    const f = await fixture();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await original(...args);
      const input = JSON.parse(typeof args[1]?.body === "string" ? args[1].body : "") as {
        method: string;
        params: { action?: string };
      };
      if (input.method !== "maintenance.runtime" || input.params.action !== "prepare") return response;
      const envelope = (await response.json()) as {
        result: { target: { processId: number; instanceId: string }; proof: string };
      };
      if (mode === "lost") throw new Error("prepare response lost after acquisition");
      if (mode === "pid") envelope.result.target.processId++;
      if (mode === "instance") envelope.result.target.instanceId = "00000000-0000-4000-8000-000000000001";
      if (mode === "proof") envelope.result.proof = "legacy";
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    expect(await f.guards.prepareAdmission(f.target, "update-owner")).toEqual({ outcome: "unknown" });
    vi.restoreAllMocks();
    expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
    await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
    expect(f.frozen()).toBe(true);
    expect(f.stop).not.toHaveBeenCalled();
  },
);
it("retains the local target after a lost resume acknowledgement and never retries an uncertain release", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  const received = barrier(),
    finish = barrier();
  const resume = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await original(...args);
    const input = JSON.parse(typeof args[1]?.body === "string" ? args[1].body : "") as {
      method: string;
      params: { action?: string };
    };
    if (input.method === "maintenance.runtime" && input.params.action === "resume") {
      resume();
      received.release();
      await finish.promise;
      throw new Error("resume response lost");
    }
    return response;
  });
  const admission = await f.guards.prepareAdmission(f.target, "update-owner");
  if (admission.outcome !== "ready") throw new Error("Expected ready admission");
  const release = admission.lease.release();
  await received.promise;
  expect(await admission.lease.release()).toBe("unknown");
  finish.release();
  expect(await release).toBe("unknown");
  expect(resume).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
  await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  expect(f.frozen()).toBe(true);
});
