/**
 * Preload: the narrow bridge between the sandboxed renderer and the main process. The
 * renderer never gets Node or the daemon URL; it gets `window.orca` with one function
 * per IPC channel the main process registers. The contract is `../bridge.ts`.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { BridgeResult, OrcaBridge } from "../bridge.js";
import type { HelloResult } from "@orca/protocol";

const bridge: OrcaBridge = {
  hello: () => ipcRenderer.invoke("orca:hello") as Promise<BridgeResult<HelloResult>>,
};

contextBridge.exposeInMainWorld("orca", bridge);
