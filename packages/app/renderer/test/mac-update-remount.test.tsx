// @vitest-environment happy-dom
/** Actual React component, sandboxed preload and Electron window-boundary regression. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { BrowserWindow, IpcMain } from "electron";
import type { OrcaBridge } from "../../src/bridge.js";
import { MacUpdateWindows } from "../../src/main/mac-update-windows.js";
import { NonceDraftGuard } from "../../src/main/update-ipc.js";
import { UpdateControl } from "../src/chrome/update-control.js";
import { harness, installBridge } from "./harness.js";

const source = stripTypeScriptTypes(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/preload/index.cts"), "utf8").replace(
    'import electron = require("electron");',
    'const electron = require("electron");',
  ),
);
afterEach(cleanup);
function runtime() {
  const ipc = new EventEmitter();
  const renderer = new EventEmitter();
  let enabled = true;
  let bridge!: OrcaBridge;
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { processId: 1, routingId: 1 },
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    setWindowOpenHandler: () => {},
    send: (channel: string, value: unknown) => renderer.emit(channel, {}, value),
  });
  const native = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isEnabled: () => enabled,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  }) as unknown as BrowserWindow;
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
        sendSync: (channel: string) =>
          channel === "orca:daemon.read" ? { epoch: 1 } : { phase: "unavailable", current: "fixture" },
        send: (channel: string, value: unknown) =>
          ipc.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, value),
        invoke: async () => ({ ok: true, result: {} }),
      }),
    }),
  });
  const boundary = new MacUpdateWindows({
    windows: () => [native],
    ipc: ipc as unknown as IpcMain,
    createDeferred: () => {},
  });
  const guard = new NonceDraftGuard(boundary);
  return { bridge, boundary, guard, enabled: () => enabled };
}
it.each([false, true])(
  "restores original inert=%s after UpdateControl remounts during an owned lease",
  async (priorInert) => {
    const fake = installBridge({ platform: "darwin" });
    const r = runtime();
    fake.bridge.updates = r.bridge.updates;
    const h = harness("darwin");
    const view = (key: number) => (
      <h.Providers>
        <div className="orca-window">
          <UpdateControl key={key} />
        </div>
      </h.Providers>
    );
    const mounted = render(view(0));
    const root = document.querySelector<HTMLElement>(".orca-window")!;
    root.inert = priorInert;
    try {
      if (!priorInert) {
        const prepared = await r.guard.prepare();
        if (prepared.outcome !== "ready") throw new Error("Expected ready");
        expect(root.inert).toBe(true);
        expect(r.enabled()).toBe(false);
        act(() => mounted.rerender(view(1)));
        expect(document.querySelector(".orca-window")).toBe(root);
        expect(root.inert).toBe(true);
        expect(r.guard.valid()).toBe(true);
        expect(await prepared.lease.release()).toBe("released");
        expect(r.boundary.active).toBe(false);
        expect(r.enabled()).toBe(true);
        expect(root.inert).toBe(false);
        // The completed restoration must not leak into the next owner.
        root.inert = true;
        expect(await r.guard.prepare()).toEqual({ outcome: "blocked", blocker: "drafts" });
        expect(root.inert).toBe(true);
      } else {
        // Remount before the refused prepare's cleanup continuation runs.
        const preparing = r.guard.prepare();
        act(() => mounted.rerender(view(1)));
        expect(await preparing).toEqual({ outcome: "blocked", blocker: "drafts" });
        expect(r.boundary.active).toBe(false);
        expect(r.enabled()).toBe(true);
        expect(root.inert).toBe(true);
      }
    } finally {
      mounted.unmount();
      h.dispose();
    }
  },
);
