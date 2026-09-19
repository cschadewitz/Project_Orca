/**
 * Preload: the narrow bridge between the sandboxed renderer and the main process. The
 * renderer never gets Node or the daemon URL; it gets `window.orca` with one function
 * per IPC channel the main process registers.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface OrcaBridge {
  hello: () => Promise<unknown>;
}

const bridge: OrcaBridge = {
  hello: () => ipcRenderer.invoke("orca:hello"),
};

contextBridge.exposeInMainWorld("orca", bridge);
