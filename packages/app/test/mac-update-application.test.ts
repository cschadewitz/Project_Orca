/** Execute actual Mac preload/IPC over a real candidate session; production remains unavailable. */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
async function fixture(enabled = true) {
  const f = await macUpdateRehearsal();
  const root = await mkdtemp(join(tmpdir(), "orca-mac-app-"));
  const session = new MacCandidateSession({
    root,
    limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 10_000 },
    fetch: f.downloadFetch,
    trust: { catalog: f.catalog, inspect: f.inspect },
  });
  closers.push(async () => {
    await session.settled();
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  const application = new MacUpdateApplication(enabled ? session : undefined);
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

it("actual production-default IPC/preload is unavailable, with no candidate or native operation", async () => {
  const h = await fixture(false);
  expect(h.bridge.macUpdates!.read()).toEqual({ phase: "unavailable" });
  expect(
    await h.bridge.macUpdates!.act({ action: "approve", offerId: "invented", manifestSha256: "a".repeat(64) }),
  ).toMatchObject({ ok: false });
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.f.runtimeEvents).toEqual([]);
});

it("routes exact approval/defer and intermediate snapshots through actual sandboxed preload without native capability", async () => {
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
});

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
