/** Authenticated disposable-daemon target identity and update guard integration. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, OwnershipStore, startDaemon, createDaemonIdentity, methodsFor } from "@orca/daemon";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { type DraftWindowBoundary } from "../src/main/update-ipc.js";
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
  it("coordinator refuses missing drain without freezing drafts or invoking prepare-only proof", async () => {
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
      expect(updater.state).toMatchObject({ phase: "failed", blocker: "activity" });
      expect(w.frozen()).toBe(false);
      expect(activate).not.toHaveBeenCalled();
      expect(revalidate).not.toHaveBeenCalled();
      expect(r.stop).not.toHaveBeenCalled();
      expect(r.requests).toEqual([]);
    } finally {
      await r.close();
    }
  });
});
