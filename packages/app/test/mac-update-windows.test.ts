/** Execute the actual sandboxed preload against the main window boundary (no native acceptance claim). */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMain } from "electron";
import { expect, it, vi } from "vitest";
import type { OrcaBridge } from "../src/bridge.js";
import { MacUpdateWindows } from "../src/main/mac-update-windows.js";
import { NonceDraftGuard } from "../src/main/update-ipc.js";

const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8").replace(
    'import electron = require("electron");',
    'const electron = require("electron");',
  ),
);
function rig() {
  const ipc = new EventEmitter();
  const all: BrowserWindow[] = [];
  const created = vi.fn();
  const boundary = new MacUpdateWindows({
    windows: () => all,
    ipc: ipc as unknown as IpcMain,
    createDeferred: created,
  });
  const guard = new NonceDraftGuard(boundary);
  function window(id: number) {
    const events = new EventEmitter();
    const renderer = new EventEmitter();
    let enabled = true;
    let destroyed = false;
    let loading = false;
    let auto = true;
    let frozen = false;
    let dirty = false;
    const sent: { nonce: string; generation: number; phase: string }[] = [];
    const frame = { processId: id, routingId: 1 };
    let bridge!: OrcaBridge;
    const contents = Object.assign(events, {
      id,
      mainFrame: frame,
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => loading,
      setWindowOpenHandler: vi.fn(),
      send: (channel: string, message: { nonce: string; generation: number; phase: string }) => {
        sent.push(message);
        if (auto) renderer.emit(channel, {}, message);
      },
    });
    const native = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => destroyed,
      isEnabled: () => enabled,
      setEnabled: (value: boolean) => {
        enabled = value;
      },
    });
    all.push(native as unknown as BrowserWindow);
    boundary.track(native as unknown as BrowserWindow);
    const rendererSend = vi.fn((channel: string, value: unknown) => {
      ipc.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, value);
    });
    runInNewContext(source, {
      exports: {},
      process: { platform: "darwin" },
      require: () => ({
        ipcRenderer: Object.assign(renderer, {
          sendSync: () => ({ epoch: 1 }),
          send: rendererSend,
          invoke: async () => ({ ok: true, result: {} }),
        }),
        contextBridge: {
          exposeInMainWorld: (_name: string, value: OrcaBridge) => {
            bridge = value;
          },
        },
      }),
    });
    const changes: boolean[] = [];
    const listener = (locked: boolean) => {
      // Main must close native interaction before the renderer is asked about drafts.
      if (locked) expect(enabled).toBe(false);
      frozen = locked;
      changes.push(locked);
      return !locked || !dirty;
    };
    const unsubscribe = bridge.updates.prepare(listener);
    return {
      contents,
      native,
      renderer,
      rendererSend,
      sent,
      changes,
      bridge,
      unsubscribe,
      freeze: () => frozen,
      enabled: () => enabled,
      auto: (value: boolean) => {
        auto = value;
      },
      dirty: () => {
        dirty = true;
      },
      loading: (value: boolean) => {
        loading = value;
      },
      destroyed: () => {
        destroyed = true;
        native.emit("closed");
      },
      forward: () => renderer.emit("orca:macUpdate.prepare", {}, sent.at(-1)),
    };
  }
  return { ipc, all, boundary, guard, created, window };
}
it("uses actual preload ownership for native freeze, scoped ACKs and stale/legacy unlock rejection", async () => {
  const r = rig();
  const a = r.window(1);
  const b = r.window(2);
  const prepared = await r.guard.prepare();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  expect(r.guard.valid()).toBe(true);
  expect(a.freeze()).toBe(true);
  expect(b.freeze()).toBe(true);
  expect(a.enabled()).toBe(false);
  expect(b.enabled()).toBe(false);
  a.renderer.emit("orca:update.prepare", {}, null);
  a.renderer.emit("orca:update.prepare", {}, "legacy");
  a.renderer.emit("orca:macUpdate.prepare", {}, { ...a.sent[0], phase: "release", nonce: "stale" });
  a.renderer.emit("orca:macUpdate.prepare", {}, { ...a.sent[0], phase: "release", generation: 100 });
  expect(a.freeze()).toBe(true);
  expect(a.changes).toEqual([true]);
  expect(r.boundary.beginLegacy()).toBeUndefined();
  expect(await prepared.lease.release()).toBe("released");
  expect(a.freeze()).toBe(false);
  expect(b.freeze()).toBe(false);
  expect(a.enabled()).toBe(true);
  expect(b.enabled()).toBe(true);
  expect(r.ipc.listenerCount("orca:macUpdate.prepared")).toBe(0);
  a.unsubscribe();
  b.unsubscribe();
});
it("requires the captured WebContents and main frame, ignoring child/foreign/legacy acknowledgements", async () => {
  const r = rig();
  const a = r.window(1);
  a.auto(false);
  const pending = r.guard.prepare();
  const message = a.sent[0]!;
  const ready = { ...message, ready: true };
  r.ipc.emit("orca:macUpdate.prepared", { sender: a.contents, senderFrame: {} }, ready);
  r.ipc.emit("orca:macUpdate.prepared", { sender: { ...a.contents }, senderFrame: a.contents.mainFrame }, ready);
  r.ipc.emit("orca:update.prepared", { sender: a.contents, senderFrame: a.contents.mainFrame }, ready);
  expect(r.guard.valid()).toBe(false);
  a.forward();
  const prepared = await pending;
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  a.auto(true);
  expect(await prepared.lease.release()).toBe("released");
});
it.each(["document", "crash", "closed", "unexpected-window"] as const)(
  "invalidates %s and retains the native boundary",
  async (kind) => {
    const r = rig();
    const a = r.window(1);
    const prepared = await r.guard.prepare();
    if (prepared.outcome !== "ready") throw new Error("Expected ready");
    if (kind === "document") a.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (kind === "crash") a.contents.emit("render-process-gone", {}, {});
    if (kind === "closed") a.destroyed();
    if (kind === "unexpected-window") {
      const b = r.window(2);
      expect(b.enabled()).toBe(false);
    }
    expect(r.guard.valid()).toBe(false);
    expect(await prepared.lease.release()).toBe("unknown");
    expect(r.boundary.active).toBe(true);
    expect(a.enabled()).toBe(false);
  },
);
it("defers repeated window creation and releases it only after both renderer and native cleanup", async () => {
  const r = rig();
  const a = r.window(1);
  const prepared = await r.guard.prepare();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  expect(r.boundary.requestCreation()).toBe(false);
  expect(r.boundary.requestCreation()).toBe(false);
  expect(r.created).not.toHaveBeenCalled();
  expect(await prepared.lease.release()).toBe("released");
  expect(a.enabled()).toBe(true);
  expect(r.guard.valid()).toBe(false);
  expect(r.created).toHaveBeenCalledOnce();
});
it("arbitrates legacy leases and preserves a prior disabled window state", async () => {
  const r = rig();
  const a = r.window(1);
  const first = r.boundary.beginLegacy()!;
  expect(r.boundary.acquire()).toBeUndefined();
  first();
  const second = r.boundary.beginLegacy()!;
  first();
  expect(r.boundary.acquire()).toBeUndefined();
  second();
  a.native.setEnabled(false);
  const prepared = await r.guard.prepare();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  expect(await prepared.lease.release()).toBe("released");
  expect(a.enabled()).toBe(false);
});
it("restores native interaction after a known draft refusal without dropping drafts", async () => {
  const r = rig();
  const a = r.window(1);
  a.dirty();
  expect(await r.guard.prepare()).toEqual({ outcome: "blocked", blocker: "drafts" });
  expect(a.freeze()).toBe(false);
  expect(a.enabled()).toBe(true);
});
it("keeps ownership across renderer listener replacement", async () => {
  const r = rig();
  const a = r.window(1);
  const prepared = await r.guard.prepare();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  a.unsubscribe();
  const listener = vi.fn(() => true);
  const unsubscribe = a.bridge.updates.prepare(listener);
  expect(listener).toHaveBeenCalledWith(true);
  a.renderer.emit("orca:update.prepare", {}, null);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(await prepared.lease.release()).toBe("released");
  expect(listener).toHaveBeenLastCalledWith(false);
  unsubscribe();
});

it("ignores an old lease release while its replacement owns the freeze", async () => {
  const r = rig();
  const a = r.window(1);
  const first = await r.guard.prepare();
  if (first.outcome !== "ready") throw new Error("Expected ready");
  const old = { ...a.sent[0]!, phase: "release" };
  expect(await first.lease.release()).toBe("released");
  const second = await r.guard.prepare();
  if (second.outcome !== "ready") throw new Error("Expected ready");
  a.renderer.emit("orca:macUpdate.prepare", {}, old);
  expect(a.freeze()).toBe(true);
  expect(a.enabled()).toBe(false);
  expect(await first.lease.release()).toBe("unknown");
  expect(await second.lease.release()).toBe("released");
});
it("rejects unavailable documents and blocks input/navigation and window.open while held", async () => {
  const r = rig();
  const a = r.window(1);
  a.loading(true);
  expect(await r.guard.prepare()).toMatchObject({ outcome: "blocked", blocker: "window-unavailable" });
  expect(a.enabled()).toBe(true);
  a.loading(false);
  const prepared = await r.guard.prepare();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  for (const event of ["before-input-event", "before-mouse-event", "will-frame-navigate"]) {
    const preventDefault = vi.fn();
    a.contents.emit(event, { isMainFrame: true, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  const opening = a.contents.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string };
  expect(opening()).toEqual({ action: "deny" });
  expect(await prepared.lease.release()).toBe("released");
  expect(opening()).toEqual({ action: "allow" });
});
