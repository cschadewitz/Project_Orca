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
  await bridge.guidedLaunch!.recover({ id: "opaque-main-handle", action: "inspect" });
  expect(invoke).toHaveBeenLastCalledWith(
    "orca:guidedLaunch.recover",
    { id: "opaque-main-handle", action: "inspect" },
    1,
  );
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
  await bridge.guidedLaunch!.snapshot();
  expect(invoke).toHaveBeenLastCalledWith("orca:guidedLaunch.snapshot", undefined, 1);
  await bridge.firstRun!.status();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.status", undefined, 1);
  await bridge.firstRun!.choose();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.choose", undefined, 1);
  await bridge.firstRun!.prepare("opaque-review");
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.prepare", "opaque-review", 1);
  await bridge.firstRun!.connect();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.connect", undefined, 1);
  await bridge.firstRun!.prepareRecovery!();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.prepareRecovery", undefined, 1);
  await bridge.firstRun!.reconcileRecovery!("opaque-recovery-review");
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.reconcileRecovery", "opaque-recovery-review", 1);
  await bridge.firstRun!.endPreviousSession!("opaque-previous-attempt");
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.endPreviousSession", "opaque-previous-attempt", 1);
  await bridge.firstRun!.reviewConfiguration!();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.reviewConfiguration", undefined, 1);
  await bridge.firstRun!.cancelConfigurationReview!();
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.cancelConfigurationReview", undefined, 1);
  await bridge.firstRun!.bindConfiguration!("opaque-config-review");
  expect(invoke).toHaveBeenLastCalledWith("orca:workspace.firstRun.bindConfiguration", "opaque-config-review", 1);
  await bridge.templates!.call("templates.get", {});
  expect(invoke).toHaveBeenLastCalledWith("orca:templates", { method: "templates.get", params: {} }, 1);
  const params = {
    target: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
    },
    handle: "33333333-3333-4333-8333-333333333333",
  };
  expect(Object.keys(bridge.scopedPermissions!)).toEqual(["call"]);
  // A target notification above did not activate epoch 2. Opaque review commands
  // retain the same explicit target fence as every other authenticated RPC.
  await bridge.scopedPermissions!.call("scopedPermissions.inspect", params);
  expect(invoke).toHaveBeenLastCalledWith("orca:scopedPermissions", { method: "scopedPermissions.inspect", params }, 1);
  await bridge.daemonConnection!.connect(null);
  expect(invoke).toHaveBeenLastCalledWith("orca:daemon.connect", null, 1);
  bridge.daemonConnection!.activate(2);
  await bridge.scopedPermissions!.call("scopedPermissions.cancel", params);
  expect(invoke).toHaveBeenLastCalledWith("orca:scopedPermissions", { method: "scopedPermissions.cancel", params }, 2);
  // The Machines surface (#882): watching is a main-process choice, never a write to a daemon,
  // and a pushed snapshot reaches the listener without Electron's event.
  await bridge.daemonConnection!.fleet!.watch("build-box", true);
  expect(invoke).toHaveBeenLastCalledWith("orca:fleet.watch", "build-box", true);
  const machines = vi.fn();
  const stop = bridge.daemonConnection!.fleet!.subscribe(machines);
  events.emit("orca:fleet", { sender: "raw Electron event" }, { machines: [] }, 2);
  expect(machines).toHaveBeenCalledExactlyOnceWith({ machines: [] });
  stop();
  events.emit("orca:fleet", {}, { machines: [] }, 2);
  expect(machines).toHaveBeenCalledOnce();
});
