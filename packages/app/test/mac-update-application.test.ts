/** Execute actual Mac preload/IPC over a real candidate session; production remains unavailable. */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { fenceBoot, fenceDirectory, fenceHash } from "@orca/protocol/first-run-fence";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { IpcMain, BrowserWindow } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import type { OrcaBridge } from "../src/bridge.js";
import { MacCandidateSession } from "../src/main/mac-update-candidates.js";
import { MacUpdateApplication, installMacUpdateIPC } from "../src/main/mac-update-application.js";
import { macUpdateRehearsal } from "./mac-update-rehearsal-fixture.js";
import { ClosedUpdateWindow, enterUpdateWriter, provisionUpdateWindow } from "@orca/protocol/update-window";

const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8").replace(
    'import electron = require("electron");',
    'const electron = require("electron");',
  ),
);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
type FixtureLayout = {
  root: string;
  control: string;
  data: string[];
  rehearsal: Awaited<ReturnType<typeof macUpdateRehearsal>>;
};
async function admitFixture(closed: boolean, beforeProvision?: (layout: FixtureLayout) => Promise<void>) {
  // As in the fixed-path recovery fixture, only initial provisioning may select
  // another disposable identity. Approval, stop, defer and assertions never retry.
  for (let attempt = 0; ; attempt++) {
    const f = await macUpdateRehearsal();
    let root: string | undefined;
    let window: ClosedUpdateWindow | undefined;
    let disposed = false;
    const close = async () => {
      if (disposed) return;
      disposed = true;
      try {
        await window?.detach();
      } finally {
        try {
          await f.close();
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    };
    // Own cleanup before mkdtemp/mkdir/provisioning can fail, including final refusal.
    closers.push(close);
    try {
      root = await mkdtemp(join(closed ? process.cwd() : tmpdir(), "orca-mac-app-"));
      const data = join(root, "data");
      if (closed) {
        const control = join(root, "control");
        await mkdir(data, { mode: 0o700 });
        await mkdir(control, { mode: 0o700 });
        const layout = { root, control, data: [data], rehearsal: f };
        await beforeProvision?.(layout);
        try {
          await provisionUpdateWindow(control, layout.data);
        } catch (error) {
          // Provisioning has awaited every partial listener's closure. Dispose the
          // rehearsal and root before resampling, and never retry cleanup failures.
          await close();
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 4) throw error;
          continue;
        }
        window = new ClosedUpdateWindow(control);
      }
      return { f, root, data, window };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
async function fixture(
  enabled = true,
  closed = false,
  activationAllowed = true,
  beforeProvision?: (layout: FixtureLayout) => Promise<void>,
) {
  const { f, root, data, window } = await admitFixture(closed, beforeProvision);
  const session = new MacCandidateSession(
    {
      root,
      limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 10_000 },
      fetch: f.downloadFetch,
      trust: { catalog: f.catalog, inspect: f.inspect },
    },
    {
      // Synthetic drain owner exercises IPC projection; production construction stays unavailable.
      drainAdmission: async (expected, token) => ({
        outcome: "ready",
        lease: { target: expected, token, observe: async () => "held", release: async () => "released" },
      }),
      prepareDrafts: async () => ({ outcome: "blocked", blocker: "candidate" }),
      prepareAdmission: async () => ({ outcome: "unknown" }),
      checkPrepared: async () => "unknown",
    },
  );
  closers.push(async () => {
    await session.settled();
  });
  const resolveWindow = vi.fn(() => window);
  const application = new MacUpdateApplication(
    enabled ? session : undefined,
    closed ? resolveWindow : undefined,
    () => activationAllowed,
  );
  const ipc = new EventEmitter();
  const renderer = new EventEmitter();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  let epoch = f.target.epoch;
  let held = false;
  let owned = true;
  const frame = {};
  let senderFrame = frame;
  const sender = {
    mainFrame: frame,
    send: (channel: string, value: unknown) => renderer.emit(channel, { privateNativeEvent: true }, value),
  };
  installMacUpdateIPC(application, {
    ipc: Object.assign(ipc, {
      handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(name, handler),
    }) as unknown as IpcMain,
    windows: () => (owned ? [{ isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow] : []),
    epoch: () => epoch,
    held: () => held,
  });
  let bridge!: OrcaBridge;
  const invoke = vi.fn(async (channel: string, params: unknown, targetEpoch: number) =>
    handlers.get(channel)!({ sender, senderFrame }, params, targetEpoch),
  );
  runInNewContext(source, {
    exports: {},
    process: { platform: "darwin" },
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name: string, value: OrcaBridge) => {
          bridge = value;
        },
      },
      ipcRenderer: Object.assign(renderer, {
        send: vi.fn(),
        invoke,
        sendSync: (channel: string) => {
          if (channel === "orca:daemon.read") return { epoch };
          const event = { sender, senderFrame, returnValue: undefined };
          ipc.emit(channel, event);
          return event.returnValue;
        },
      }),
    }),
  });
  const offer = async () => {
    const result = await session.offer(
      { ...f.binding.candidate, source: f.binding.source, manifestBytes: f.bytes },
      f.target,
      new AbortController().signal,
    );
    if (result.outcome !== "available") throw new Error("Fixture offer failed");
    return { action: "approve" as const, offerId: result.offerId, manifestSha256: f.binding.candidate.manifestSha256 };
  };
  return {
    f,
    session,
    application,
    window,
    resolveWindow,
    data,
    bridge,
    invoke,
    offer,
    held: (value: boolean) => {
      held = value;
    },
    owned: (value: boolean) => {
      owned = value;
    },
    frame: (valid: boolean) => {
      senderFrame = valid ? frame : {};
    },
    epoch: (value: number) => {
      epoch = value;
    },
  };
}

// Real owned listeners exercise the kernel fence; this mirrors its identity mapping.
function fixtureSlots(root: string) {
  const start =
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, fenceDirectory(root)])).slice(0, 8),
      16,
    ) %
      5000) *
      8;
  return Array.from({ length: 8 }, (_, slot) => start + slot);
}
async function occupy(port: number) {
  const server = createServer();
  const close = async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { server, close };
}
async function expectAbandoned(layout: FixtureLayout) {
  await expect(lstat(layout.root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(layout.rehearsal.downloadEntries()).rejects.toMatchObject({ code: "ENOENT" });
  await expect(layout.rehearsal.call("hello")).rejects.toThrow();
}
// These control cases need the Linux fixture volume, as in fixed-path recovery.
const fixtureIt = it.skipIf(process.platform !== "linux");
fixtureIt(
  "admits a fresh application fixture after real initial contention and releases partial listeners",
  async () => {
    const abandoned: FixtureLayout[] = [];
    let blocker: Awaited<ReturnType<typeof occupy>> | undefined;
    let slots: number[] = [];
    const h = await fixture(true, true, true, async (layout) => {
      if (blocker) {
        await expectAbandoned(abandoned[0]!);
        return;
      }
      abandoned.push(layout);
      slots = fixtureSlots(layout.data[0]!);
      // The last slot forces provisioning to acquire and then release the first seven.
      blocker = await occupy(slots[7]!);
    });
    await expectAbandoned(abandoned[0]!);
    expect(blocker!.server.listening).toBe(true);
    expect(h.window!.snapshot.phase).toBe("open");
    const writer = await enterUpdateWriter(h.data);
    expect(writer?.check()).toBe(true);
    await writer?.close();
    await blocker!.close();
    for (const port of slots) expect((await occupy(port)).server.listening).toBe(true);
  },
);
fixtureIt("bounds initial application fixture admission and cleans exhausted roots and rehearsals", async () => {
  const attempted: FixtureLayout[] = [];
  const slots = new Set<number>();
  const blockers = new Map<number, Awaited<ReturnType<typeof occupy>>>();
  const originalFetch = globalThis.fetch;
  await expect(
    fixture(true, true, true, async (layout) => {
      if (attempted.length) await expectAbandoned(attempted.at(-1)!);
      attempted.push(layout);
      const range = fixtureSlots(layout.data[0]!);
      for (const port of range) slots.add(port);
      const port = range[7]!;
      if (!blockers.has(port)) blockers.set(port, await occupy(port));
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(attempted).toHaveLength(5);
  expect(new Set(attempted.map(({ root }) => root)).size).toBe(5);
  expect(new Set(attempted.map(({ rehearsal }) => rehearsal)).size).toBe(5);
  expect(globalThis.fetch).toBe(originalFetch);
  for (const layout of attempted) await expectAbandoned(layout);
  for (const { server } of blockers.values()) expect(server.listening).toBe(true);
  for (const blocker of blockers.values()) await blocker.close();
  for (const port of slots) expect((await occupy(port)).server.listening).toBe(true);
});
fixtureIt("refuses non-contention provisioning failure without resampling and cleans rehearsal ownership", async () => {
  const attempted: FixtureLayout[] = [];
  const originalFetch = globalThis.fetch;
  await expect(
    fixture(true, true, true, async (layout) => {
      attempted.push(layout);
      layout.data.push(layout.data[0]!); // Real duplicate-root enrollment refusal.
    }),
  ).rejects.toThrow("Protected update window unavailable");
  expect(attempted).toHaveLength(1);
  await expectAbandoned(attempted[0]!);
  expect(globalThis.fetch).toBe(originalFetch);
});
fixtureIt("does not retry a setup hook EADDRINUSE outside initial provisioning", async () => {
  const attempted: FixtureLayout[] = [];
  const failure = Object.assign(new Error("Setup hook failure"), { code: "EADDRINUSE" });
  const originalFetch = globalThis.fetch;
  await expect(
    fixture(true, true, true, async (layout) => {
      attempted.push(layout);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(attempted).toHaveLength(1);
  await expectAbandoned(attempted[0]!);
  expect(globalThis.fetch).toBe(originalFetch);
});

// Approval downloads the candidate, which requires POSIX private modes. Windows must refuse
// it, so the cases that approve a download skip Windows.
it.skipIf(process.platform === "win32")(
  "exact approval durably closes admission; defer settles preparation before reopening",
  async () => {
    const h = await fixture(true, true);
    const command = await h.offer();
    expect(await h.bridge.macUpdates!.act({ ...command, offerId: "stale" })).toMatchObject({ ok: false });
    expect(h.window!.snapshot.phase).toBe("open");
    expect(await h.bridge.macUpdates!.act(command)).toMatchObject({ ok: true, result: { phase: "waiting" } });
    const attempt = h.window!.snapshot.attempt;
    await expect(enterUpdateWriter(h.data)).rejects.toThrow();
    expect(await h.bridge.macUpdates!.act(command)).toMatchObject({ ok: true });
    expect(h.window!.snapshot.attempt).toBe(attempt);
    expect(await h.bridge.macUpdates!.act({ ...command, action: "defer" })).toMatchObject({ ok: true });
    expect(h.window!.snapshot.phase).toBe("open");
    const lease = await enterUpdateWriter(h.data);
    expect(lease?.check()).toBe(true);
    await lease?.close();
    expect(await h.bridge.macUpdates!.act(command)).toMatchObject({ ok: false });
    expect(h.window!.snapshot.phase).toBe("open");
    expect(h.resolveWindow).toHaveBeenCalledTimes(1);
  },
);

it("the production activation hold keeps a constructed session unavailable and leaves admission open", async () => {
  const h = await fixture(true, true, false);
  const command = await h.offer();
  expect(h.bridge.macUpdates!.read()).toEqual({ phase: "unavailable" });
  expect(await h.bridge.macUpdates!.act(command)).toMatchObject({ ok: false });
  expect(h.window!.snapshot.phase).toBe("open");
  expect(h.resolveWindow).not.toHaveBeenCalled();
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.f.runtimeEvents).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "defer cannot reopen a window once native daemon shutdown has begun",
  async () => {
    const h = await fixture(true, true);
    const command = await h.offer();
    await h.bridge.macUpdates!.act(command);
    h.window!.beginStop();
    expect(await h.bridge.macUpdates!.act({ ...command, action: "defer" })).toMatchObject({ ok: false });
    expect(h.window!.snapshot.phase).toBe("stopping");
    expect(h.session.state.phase).toBe("waiting");
    await expect(enterUpdateWriter(h.data)).rejects.toThrow();
  },
);

it("actual production-default IPC/preload is unavailable, with no candidate or native operation", async () => {
  const h = await fixture(false);
  expect(h.bridge.macUpdates!.read()).toEqual({ phase: "unavailable" });
  expect(
    await h.bridge.macUpdates!.act({ action: "approve", offerId: "invented", manifestSha256: "a".repeat(64) }),
  ).toMatchObject({ ok: false });
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.f.runtimeEvents).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "routes exact approval/defer and intermediate snapshots through actual sandboxed preload without native capability",
  async () => {
    const h = await fixture();
    const changed = vi.fn();
    const unsubscribe = h.bridge.macUpdates!.subscribe(changed);
    const command = await h.offer();
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "available", offerId: command.offerId, manifestSha256: command.manifestSha256 }),
    );
    const available = h.bridge.macUpdates!.read();
    expect(Object.keys(available).sort()).toEqual([
      "channel",
      "compatibilityPlanId",
      "manifestSha256",
      "offerId",
      "phase",
      "recoveryPlanId",
      "version",
    ]);
    expect(await h.bridge.macUpdates!.act(command)).toMatchObject({
      ok: true,
      result: { phase: "waiting", blocker: "candidate" },
    });
    expect(changed.mock.calls.map(([state]) => state.phase)).toEqual([
      "available",
      "preparing",
      "downloading",
      "preparing",
      "waiting",
    ]);
    expect(h.invoke).toHaveBeenCalledWith("orca:macUpdate.act", command, h.f.target.epoch);
    expect(h.f.inspect).toHaveBeenCalledOnce();
    h.held(true);
    expect(await h.bridge.macUpdates!.act({ ...command, action: "defer" })).toMatchObject({
      ok: true,
      result: { phase: "deferred" },
    });
    await h.session.settled();
    unsubscribe();
    const count = changed.mock.calls.length;
    await h.offer();
    expect(changed).toHaveBeenCalledTimes(count);
    expect(h.f.stop).not.toHaveBeenCalled();
    expect(h.f.activate).not.toHaveBeenCalled();
  },
);

it.each(["offer", "digest", "extra", "iframe", "external", "stale-epoch", "new-target", "held"])(
  "refuses %s without download/admission or native touch",
  async (fault) => {
    const h = await fixture();
    const command = await h.offer();
    let input: unknown = command;
    if (fault === "offer") input = { ...command, offerId: "other" };
    if (fault === "digest") input = { ...command, manifestSha256: "a".repeat(64) };
    if (fault === "extra") input = { ...command, url: "https://wrong.invalid/zip" };
    if (fault === "iframe") h.frame(false);
    if (fault === "external") h.owned(false);
    if (fault === "stale-epoch" || fault === "new-target") h.epoch(h.f.target.epoch + 1);
    if (fault === "new-target") h.bridge.daemonConnection!.activate(h.f.target.epoch + 1);
    if (fault === "held") h.held(true);
    expect(await h.bridge.macUpdates!.act(input as typeof command)).toMatchObject({ ok: false });
    expect(h.session.state.phase).toBe("available");
    expect(h.f.downloadFetch).not.toHaveBeenCalled();
    expect(h.f.runtimeEvents).toEqual([]);
    if (fault === "iframe" || fault === "external")
      expect(h.bridge.macUpdates!.read()).toEqual({ phase: "unavailable" });
  },
);

it("isolates throwing observers while preserving an exact trusted offer and owner state", async () => {
  const h = await fixture();
  h.application.subscribe(() => {
    throw new Error("Disposed observer");
  });
  const command = await h.offer();
  expect(h.application.state).toMatchObject({ phase: "available", manifestSha256: command.manifestSha256 });
  expect(await h.bridge.macUpdates!.act({ ...command, action: "defer" })).toMatchObject({
    ok: true,
    result: { phase: "deferred" },
  });
});

it("normalizes IPC transport rejection without exposing exception text", async () => {
  const h = await fixture();
  const command = await h.offer();
  h.invoke.mockRejectedValueOnce(new Error("Secret native URL"));
  expect(await h.bridge.macUpdates!.act(command)).toEqual({
    ok: false,
    error: { code: "UPDATE", message: "Update request is unavailable" },
  });
});
