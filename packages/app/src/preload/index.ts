/**
 * Preload: the narrow bridge between the sandboxed renderer and the main process. The
 * renderer never gets Node or the daemon URL; it gets `window.orca` with one function
 * per IPC channel the main process registers, plus the platform (for the modifier key).
 * The contract is `../bridge.ts`.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { BridgeResult, OrcaBridge } from "../bridge.js";
import type { Preferences } from "../preferences/schema.js";
import type { HelloResult } from "@orca/protocol";

const bridge: OrcaBridge = {
  platform: process.platform,
  hello: () => ipcRenderer.invoke("orca:hello") as Promise<BridgeResult<HelloResult>>,
  preferences: {
    read: () => ipcRenderer.sendSync("orca:preferences.read") as Preferences,
    write: (patch) => ipcRenderer.invoke("orca:preferences.write", patch) as Promise<BridgeResult<Preferences>>,
  },
};

contextBridge.exposeInMainWorld("orca", bridge);
