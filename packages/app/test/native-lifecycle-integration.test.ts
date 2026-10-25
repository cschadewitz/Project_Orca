/** Portable main-owner composition over a real disposable authenticated daemon child.
 * Bootstrap/spawn attachment and window ACKs are fixture seams; no native updater or restore proof.
 */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { startBundledDaemon } from "../src/main/daemon-process.js";
import { Workspace } from "../src/main/workspace.js";
import { MacUpdateGuards } from "../src/main/mac-update-guards.js";
import { callInConnection } from "../src/main/connection-target.js";
import type { DraftWindowBoundary } from "../src/main/update-ipc.js";
import { restartFixture } from "./mac-restart-fixture.js";

const closers: (() => Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});

async function fixture(options: { ignoreOldTerm?: boolean; external?: boolean } = {}) {
  const f = await restartFixture(options);
  closers.push(f.cleanup);
  // Attach the production owner to the independently launched fixture's exact ChildProcess.
  // The fixture supplies bootstrap metadata via IPC rather than the production stdout line.
  const onExit = vi.fn();
  const bundled = await startBundledDaemon({
    entry: f.daemonPath,
    cwd: f.workspace,
    spawn: () => f.old.child.child,
    findPort: async () => Number(new URL(f.old.ready.url).port),
    probe: async () => {
      await f.old.client.hello("lifecycle-fixture", false);
      return true;
    },
    onExit,
  });
  const stop = vi.fn(async () => bundled.stop());
  const start = vi.fn(async () => ({ ...bundled, tokenFile: f.old.ready.tokenFile, stop }));
  const streamClose = vi.fn();
  const workspace = new Workspace({
    findEntry: () => f.daemonPath,
    start,
    client: (url) =>
      new DaemonClient(url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({ url, tokenFile: f.old.ready.tokenFile, env: {} }),
      }),
    subscribe: () => ({ close: streamClose }) as unknown as DaemonSubscription,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultUrl: f.old.ready.url,
    defaultPath: () => f.workspace,
    ...(options.external ? { explicitUrl: f.old.ready.url } : {}),
  });
  await workspace.connect();
  workspace.observeHello(workspace.client, await f.old.client.hello("lifecycle-fixture", false));
  closers.push(() => workspace.close());
  let intact = true;
  let frozen = false;
  const boundary: DraftWindowBoundary = {
    acquire: () => {
      frozen = true;
      let receive: Parameters<NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>["listen"]>[0] = () => {};
      return {
        windows: [{ id: 1, generation: 1 }],
        check: () => intact,
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
  const drafts = await guards.prepareDrafts();
  if (drafts.outcome !== "ready") throw new Error("Expected fixture draft lease");
  const target = {
    workspaceId: f.old.ready.target.workspaceId,
    instanceId: f.old.ready.target.instanceId,
    epoch: workspace.connectionTarget.epoch,
  };
  return {
    ...f,
    workspace,
    guards,
    drafts: drafts.lease,
    target,
    start,
    stop,
    streamClose,
    onExit,
    frozen: () => frozen,
    invalidate: () => {
      intact = false;
    },
  };
}

// Node on Windows cannot deliver the catchable POSIX SIGTERM that these two owned-stop cases
// observe through the restart fixture. The cases that never signal still run there.
it.skipIf(process.platform === "win32")(
  "stops the exact Workspace child cleanly once and keeps calls, reconnect, drafts and restart admission sealed",
  async () => {
    const f = await fixture();
    const admission = await f.guards.prepareAdmission(f.target, randomUUID());
    if (admission.outcome !== "ready") throw new Error("Expected fixture admission");
    const finish = deferred<string>();
    const entered = deferred<void>();
    const late = callInConnection(f.workspace, f.target.epoch, () => {
      entered.resolve();
      return finish.promise;
    });
    const lateResult = expect(late).rejects.toThrow("admission is closed");
    await entered.promise;
    const stopping = admission.lease.stopOwned!(new AbortController().signal, 10_000);
    expect(() => f.workspace.assertEpoch(f.target.epoch)).toThrow("admission is closed");
    finish.resolve("late old reply");
    await lateResult;
    const result = await stopping;
    expect(result).toMatchObject({ outcome: "stopped", receipt: { target: f.old.ready.target } });
    expect(await admission.lease.stopOwned!(new AbortController().signal, 10_000)).toBe(result);
    expect(f.old.child.signals).toEqual(["SIGTERM"]);
    expect(f.old.child.child.exitCode).toBe(0);
    expect(f.old.child.child.signalCode).toBeNull();
    expect(f.onExit).not.toHaveBeenCalled();
    expect(f.streamClose).toHaveBeenCalledOnce();
    expect(await admission.lease.release()).toBe("unknown");
    await expect(f.workspace.connect()).rejects.toThrow("busy");
    await expect(f.workspace.connectLive()).rejects.toThrow("progress");
    await expect(f.workspace.prepareConnection(null)).rejects.toThrow("busy");
    await expect(f.workspace.prepareFirstRunConnection(f.workspace.snapshot.path)).rejects.toThrow("busy");
    // This unrelated Windows token has no reservation and cannot release the Mac lifecycle hold.
    await expect(f.workspace.cancelUpdate("unrelated")).rejects.toThrow(/^Update token is stale$/);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.frozen()).toBe(true);
    await f.workspace.close();
    expect(f.stop).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")(
  "never escalates or repeats an unknown owned stop, including ordinary quit and a late clean close",
  async () => {
    const f = await fixture({ ignoreOldTerm: true });
    const admission = await f.guards.prepareAdmission(f.target, randomUUID());
    if (admission.outcome !== "ready") throw new Error("Expected fixture admission");
    const result = await admission.lease.stopOwned!(new AbortController().signal, 1000);
    expect(result).toEqual({ outcome: "unknown" });
    expect(await admission.lease.stopOwned!(new AbortController().signal, 10_000)).toBe(result);
    expect(f.old.child.signals).toEqual(["SIGTERM"]);
    expect(f.old.child.child.exitCode).toBeNull();
    expect(await admission.lease.release()).toBe("unknown");
    await f.workspace.close();
    expect(f.stop).not.toHaveBeenCalled();
    await f.old.child.cleanup(); // Explicit fixture teardown, never product recovery/retry.
    expect(f.old.child.child.exitCode).toBe(0);
    expect(result).toEqual({ outcome: "unknown" });
    expect(f.frozen()).toBe(true);
  },
);

it.each(["lost", "wrong-instance", "wrong-process", "legacy", "drafts"] as const)(
  "refuses positive stop evidence after a %s fresh proof and never signals or reopens",
  async (mode) => {
    const f = await fixture();
    const actual = globalThis.fetch;
    const proof = vi.fn();
    let stopping = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await actual(input, init);
      const request = JSON.parse(typeof init?.body === "string" ? init.body : "") as { method: string };
      if (!stopping || request.method !== "maintenance.runtime") return response;
      proof();
      expect(init?.signal).toBeDefined();
      if (mode === "lost") throw new Error("Fixture lost acknowledgement");
      if (mode === "drafts") {
        f.invalidate();
        return response;
      }
      const envelope = (await response.json()) as {
        result: { proof: string; target: { instanceId: string; processId: number } };
      };
      if (mode === "wrong-instance") envelope.result.target.instanceId = randomUUID();
      if (mode === "wrong-process") envelope.result.target.processId++;
      if (mode === "legacy") envelope.result.proof = "legacy";
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    const admission = await f.guards.prepareAdmission(f.target, randomUUID());
    if (admission.outcome !== "ready") throw new Error("Expected fixture admission");
    stopping = true;
    const result = await admission.lease.stopOwned!(new AbortController().signal, 10_000);
    expect(result).toEqual({ outcome: "unknown" });
    expect(proof).toHaveBeenCalledOnce();
    expect(f.old.child.signals).toEqual([]);
    expect(await admission.lease.release()).toBe("unknown");
    expect(() => f.workspace.assertEpoch(f.target.epoch)).toThrow("closed");
    expect(f.frozen()).toBe(true);
  },
);

it.each(["external", "wrong-target"] as const)("leaves a %s daemon untouched", async (mode) => {
  const f = await fixture({ external: mode === "external" });
  const target = mode === "wrong-target" ? { ...f.target, instanceId: randomUUID() } : f.target;
  expect(await f.guards.prepareAdmission(target, randomUUID())).toEqual({ outcome: "blocked", blocker: "identity" });
  expect(f.old.child.signals).toEqual([]);
  expect(f.stop).not.toHaveBeenCalled();
  expect(await f.old.client.hello("untouched", false)).toMatchObject({ processId: f.old.ready.target.processId });
});
