/** Synthetic window lifecycle and authenticated disposable-daemon guard integration. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, OwnershipStore, startDaemon, createDaemonIdentity, methodsFor } from "@orca/daemon";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { NonceDraftGuard, type DraftWindowBoundary } from "../src/main/update-ipc.js";
import { MacUpdateGuards } from "../src/main/mac-update-guards.js";
import { MacUpdates } from "../src/main/mac-updates.js";

function windows() {
  let barrier = false;
  let intact = true;
  let auto = true;
  let draft = false;
  let receive: Parameters<NonNullable<ReturnType<DraftWindowBoundary["acquire"]>>["listen"]>[0] = () => {};
  const sent: { nonce: string; phase: "prepare" | "release" }[] = [];
  const release = vi.fn(() => {
    barrier = false;
  });
  const boundary: DraftWindowBoundary = {
    acquire: () => {
      if (barrier) return undefined;
      barrier = true;
      intact = true;
      return {
        windows: [
          { id: 1, generation: 3 },
          { id: 2, generation: 7 },
        ],
        check: () => intact,
        release,
        listen: (listener) => {
          receive = listener;
          return () => {
            receive = () => {};
          };
        },
        send: (message) => {
          sent.push(message);
          if (auto)
            for (const [sender, generation] of [
              [1, 3],
              [2, 7],
            ]) {
              receive({
                kind: "ack",
                sender: sender!,
                value: { ...message, generation, ready: message.phase === "release" || !draft },
              });
            }
        },
      };
    },
  };
  return {
    boundary,
    sent,
    release,
    frozen: () => barrier,
    auto: (value: boolean) => {
      auto = value;
    },
    draft: () => {
      draft = true;
    },
    ack: (sender: number, value: unknown) => receive({ kind: "ack", sender, value }),
    changed: () => {
      intact = false;
      receive({ kind: "changed" });
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("nonce draft leases", () => {
  it("owns all captured documents until positive scoped release, rejecting stale releases", async () => {
    const w = windows();
    const guard = new NonceDraftGuard(w.boundary);
    const first = await guard.prepare();
    expect(first.outcome).toBe("ready");
    if (first.outcome !== "ready") throw new Error("Expected ready");
    expect(guard.valid()).toBe(true);
    expect(w.frozen()).toBe(true);
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
    expect(await first.lease.release()).toBe("released");
    const second = await guard.prepare();
    expect(second.outcome).toBe("ready");
    expect(w.sent[0]!.nonce).not.toBe(w.sent.at(-1)!.nonce);
    expect(await first.lease.release()).toBe("unknown");
    expect(w.frozen()).toBe(true);
    if (second.outcome === "ready") await second.lease.release();
  });
  it("ignores foreign, wrong nonce, wrong phase and reloaded-document acknowledgements", async () => {
    vi.useFakeTimers();
    const w = windows();
    w.auto(false);
    const guard = new NonceDraftGuard(w.boundary);
    const prepared = guard.prepare();
    const message = w.sent[0]!;
    w.ack(3, { ...message, generation: 3, ready: true });
    w.ack(1, { ...message, nonce: "foreign", generation: 3, ready: true });
    w.ack(1, { ...message, phase: "release", generation: 3, ready: true });
    w.ack(1, { ...message, generation: 4, ready: true });
    w.ack(2, { ...message, generation: 7, ready: true });
    expect(guard.valid()).toBe(false);
    w.ack(1, { ...message, generation: 3, ready: true });
    const ready = await prepared;
    expect(ready.outcome).toBe("ready");
    if (ready.outcome !== "ready") throw new Error("Expected ready");
    const released = ready.lease.release();
    w.ack(1, { ...message, generation: 3, ready: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await released).toBe("unknown");
    expect(w.release).not.toHaveBeenCalled();
    expect(w.frozen()).toBe(true);
  });
  it.each(["created", "reloaded", "destroyed"])(
    "invalidates %s windows before use and retains unknown boundaries",
    async () => {
      const w = windows();
      const guard = new NonceDraftGuard(w.boundary);
      const ready = await guard.prepare();
      if (ready.outcome !== "ready") throw new Error("Expected ready");
      w.changed();
      expect(guard.valid()).toBe(false);
      expect(await ready.lease.release()).toBe("unknown");
      expect(w.release).not.toHaveBeenCalled();
    },
  );
  it("returns known drafts only after acknowledged unlock", async () => {
    const w = windows();
    w.draft();
    expect(await new NonceDraftGuard(w.boundary).prepare()).toEqual({ outcome: "blocked", blocker: "drafts" });
    expect(w.frozen()).toBe(false);
    expect(w.sent.map((message) => message.phase)).toEqual(["prepare", "release"]);
  });
  it("does not reacquire after uncertain barrier acquisition", async () => {
    const acquire = vi.fn(() => {
      throw new Error("barrier result lost");
    });
    const guard = new NonceDraftGuard({ acquire });
    expect(await guard.prepare()).toEqual({ outcome: "unknown" });
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
    expect(acquire).toHaveBeenCalledOnce();
  });
  it("retains an unacknowledged freeze after renderer timeout", async () => {
    vi.useFakeTimers();
    const w = windows();
    w.auto(false);
    const guard = new NonceDraftGuard(w.boundary);
    const prepared = guard.prepare();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await prepared).toEqual({ outcome: "unknown" });
    expect(w.frozen()).toBe(true);
    expect(await guard.prepare()).toMatchObject({ outcome: "blocked" });
  });
});

async function ownedRig(
  options: { processId?: number; storeDir?: string; invalidToken?: boolean; explicit?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "orca-mac-guards-"));
  const tokenFile = join(root, "owner.token");
  const credentials = new CredentialStore();
  const owner = await credentials.issue({ principal: "synthetic-mac-guard", preset: "owner" });
  await writeFile(tokenFile, options.invalidToken ? "invalid" : owner.token, { mode: 0o600 });
  const identity = createDaemonIdentity("973de3ea-4338-4af5-850b-d44a5f1fb889");
  const requests: string[] = [];
  const methods = methodsFor({
    orcaVersion: "fixture",
    capabilities: [],
    identity,
    processId: options.processId ?? process.pid,
    storeDir: options.storeDir ?? join(root, ".orca"),
  });
  const hello = methods.hello!;
  const daemon = await startDaemon({
    orcaVersion: "fixture",
    capabilities: [],
    identity,
    methods: {
      ...methods,
      hello: {
        ...hello,
        handle: (params, ctx) => {
          requests.push("hello");
          return hello.handle(params, {
            ...ctx,
            processId: options.processId ?? process.pid,
            storeDir: options.storeDir ?? join(root, ".orca"),
          });
        },
      },
    },
    auth: {
      mode: "token",
      credentials,
      ownership: new OwnershipStore(),
      resolver: {
        run: async () => undefined,
        inputRun: async () => undefined,
        artifactRun: async () => undefined,
        claimRun: async () => undefined,
        workflowExists: () => false,
      },
    },
  });
  const stop = vi.fn(async () => {});
  const deps: WorkspaceDeps = {
    findEntry: () => "fixture",
    start: async () => ({ url: daemon.url, pid: process.pid, tokenFile, stop }),
    client: (url) =>
      new DaemonClient(url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({ url, tokenFile, env: {} }),
      }),
    subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultUrl: daemon.url,
    defaultPath: () => root,
    ...(options.explicit ? { explicitUrl: daemon.url } : {}),
  };
  const workspace = new Workspace(deps);
  await workspace.connect();
  workspace.observeHello(workspace.client, {
    identity,
    processId: process.pid,
    protocol: { major: 1, minor: 8 },
    orcaVersion: "fixture",
    capabilities: [],
  });
  const target = { ...identity, epoch: workspace.connectionTarget.epoch };
  return {
    workspace,
    target,
    stop,
    requests,
    identity,
    close: async () => {
      await workspace.close();
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("owned Mac target capture", () => {
  it("verifies authenticated PID/store/instance/epoch and fences local target changes until release", async () => {
    const r = await ownedRig();
    try {
      const captured = await r.workspace.captureMacUpdateTarget(r.target);
      expect(captured?.check()).toBe(true);
      await expect(r.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
      await expect(r.workspace.connect()).rejects.toThrow("busy");
      await expect(r.workspace.open("/other")).rejects.toThrow("progress");
      await expect(r.workspace.prepareUpdate("other")).rejects.toThrow("busy");
      r.workspace.observeHello(r.workspace.client, {
        identity: { ...r.identity, instanceId: createDaemonIdentity(r.identity.workspaceId).instanceId },
        protocol: { major: 1, minor: 8 },
        orcaVersion: "fixture",
        capabilities: [],
      });
      expect(captured?.check()).toBe(false);
      captured?.release();
      const candidate = await r.workspace.prepareConnection("http://localhost:7890");
      await candidate.dispose();
      expect(r.stop).not.toHaveBeenCalled();
    } finally {
      await r.close();
    }
  });
  it.each([{ processId: 1 }, { storeDir: "/wrong/.orca" }, { explicit: true }])(
    "refuses wrong or external targets %j",
    async (options) => {
      const r = await ownedRig(options);
      try {
        expect(await r.workspace.captureMacUpdateTarget(r.target)).toBeUndefined();
        expect(r.stop).not.toHaveBeenCalled();
        if (options.explicit) expect(r.requests).toEqual([]);
      } finally {
        await r.close();
      }
    },
  );
  it.each(["read-only", "parked", "wrong-epoch", "wrong-instance"] as const)(
    "refuses %s before contacting the target",
    async (mode) => {
      const r = await ownedRig();
      try {
        let target = r.target;
        if (mode === "read-only") await r.workspace.open("/read-only-fixture");
        if (mode === "parked") {
          const staged = await r.workspace.prepareConnection("http://localhost:7890");
          staged.activate({
            identity: r.identity,
            protocol: { major: 1, minor: 8 },
            orcaVersion: "fixture",
            capabilities: [],
          });
          await staged.dispose();
        }
        if (mode === "wrong-epoch") target = { ...target, epoch: target.epoch + 1 };
        if (mode === "wrong-instance")
          target = { ...target, instanceId: createDaemonIdentity(r.identity.workspaceId).instanceId };
        expect(await r.workspace.captureMacUpdateTarget(target)).toBeUndefined();
        expect(r.requests).toEqual([]);
      } finally {
        await r.close();
      }
    },
  );

  it("refuses missing authentication without inherited environment credentials", async () => {
    const r = await ownedRig({ invalidToken: true });
    try {
      await expect(r.workspace.captureMacUpdateTarget(r.target)).rejects.toThrow();
      expect(r.requests).toEqual([]);
      const candidate = await r.workspace.prepareConnection("http://localhost:7890");
      await candidate.dispose();
    } finally {
      await r.close();
    }
  });
  it("refuses an already staged connection before hello or maintenance", async () => {
    const r = await ownedRig();
    try {
      const staged = await r.workspace.prepareConnection("http://localhost:7890");
      expect(await r.workspace.captureMacUpdateTarget(r.target)).toBeUndefined();
      expect(r.requests).toEqual([]);
      await staged.dispose();
    } finally {
      await r.close();
    }
  });
  it("coordinator returns to waiting and releases drafts when authoritative attached-execution proof is missing", async () => {
    const r = await ownedRig();
    const w = windows();
    const guards = new MacUpdateGuards(r.workspace, w.boundary);
    const activate = vi.fn(async () => "committed" as const);
    const revalidate = vi.fn(async () => "valid" as const);
    const updater = new MacUpdates({
      download: async () => "verified",
      prepareDrafts: () => guards.prepareDrafts(),
      prepareAdmission: (target, token) => guards.prepareAdmission(target, token),
      revalidate,
      activate,
    });
    try {
      const id = updater.present(
        {
          manifestSha256: "a".repeat(64),
          channel: "fixture",
          compatibilityPlanId: "synthetic",
          recoveryPlanId: "synthetic",
        },
        r.target,
      )!;
      await updater.approve(id);
      expect(updater.state).toMatchObject({ phase: "waiting", blocker: "activity" });
      expect(w.frozen()).toBe(false);
      expect(activate).not.toHaveBeenCalled();
      expect(revalidate).not.toHaveBeenCalled();
      expect(r.stop).not.toHaveBeenCalled();
      expect(r.requests).toEqual(["hello"]);
    } finally {
      await r.close();
    }
  });
});
