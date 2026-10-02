/** Execute the actual CommonJS preload against Electron's IPC boundary. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { expect, it, vi } from "vitest";
import type { OrcaBridge } from "../src/bridge.js";

it("strips Electron events from onShow and preserves explicit epoch fencing", async () => {
  const events = new EventEmitter();
  const invoke = vi.fn(async () => ({ ok: true, result: {} }));
  let epoch = 0;
  let bridge!: OrcaBridge;
  const source = readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8");
  // Lower the single CommonJS import assignment; all other imports are type-only.
  // Use Node's stable strip mode (transform mode is no longer in Node 26's API).
  const compiled = stripTypeScriptTypes(
    source.replace('import electron = require("electron");', 'const electron = require("electron");'),
  );
  runInNewContext(compiled, {
    exports: {},
    process: { platform: "darwin" },
    require: () => ({
      ipcRenderer: Object.assign(events, { sendSync: () => ({ epoch }), invoke, send: vi.fn() }),
      contextBridge: {
        exposeInMainWorld: (_name: string, value: OrcaBridge) => {
          bridge = value;
        },
      },
    }),
  });
  const show = vi.fn();
  const unsubscribe = bridge.daemonConnection!.onShow(show);
  events.emit("orca:daemon.show", { sender: "raw Electron event" }, null, 3);
  expect(show).toHaveBeenCalledExactlyOnceWith();
  unsubscribe();
  events.emit("orca:daemon.show", {});
  expect(show).toHaveBeenCalledOnce();
  epoch = 1;
  expect(bridge.daemonConnection!.read().epoch).toBe(1);
  bridge.daemonConnection!.activate(1);
  await bridge.runs.list();
  expect(invoke).toHaveBeenLastCalledWith("orca:runs.list", {}, 1);
  const notification = vi.fn();
  bridge.notifications.subscribe(notification);
  events.emit("orca:notification", {}, { method: "old" }, 0);
  expect(notification).not.toHaveBeenCalled();
  events.emit("orca:notification", {}, { method: "current" }, 1);
  expect(notification).toHaveBeenCalledExactlyOnceWith({ method: "current" });
  // A push informs the boundary, but cannot activate old drafts on the new daemon.
  events.emit("orca:daemon.target", {}, { epoch: 2 });
  await bridge.runs.list();
  expect(invoke).toHaveBeenLastCalledWith("orca:runs.list", {}, 1);
});
