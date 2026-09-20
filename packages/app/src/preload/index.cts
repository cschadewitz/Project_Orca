/**
 * Preload: the narrow bridge between the sandboxed renderer and the main process. The
 * renderer never gets Node or the daemon URL; it gets `window.orca` with one function
 * per IPC channel the main process registers, plus the platform (for the modifier key).
 * The contract is `../bridge.ts`.
 *
 * `.cts`, not `.ts`, and that is load-bearing: a sandboxed preload is evaluated as a plain
 * script, so it must be CommonJS. `packages/app` is `"type": "module"`, so a `.js` emitted
 * here would be ESM and Electron would fail it with "Cannot use import statement outside a
 * module" — `window.orca` never defined, every screen on a bridgeless renderer. The `.cts`
 * extension is the only thing that makes `tsc` write `dist/preload/index.cjs` as CommonJS,
 * and keeping `sandbox: true` is worth more than the module format (#198).
 *
 * The import surface is still just `electron` plus type-only imports — nothing here needs
 * Node, so nothing but this one `require` notices the format. `verbatimModuleSyntax` is on
 * repo-wide and forbids `import … from` in a file that emits CommonJS, so the value import
 * is written in the form the emit actually has; the type imports are erased either way.
 */
// A CommonJS file under `verbatimModuleSyntax` has no other way to spell a value import,
// and emitting CommonJS is the whole point of this file — see the header.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require("electron");
import type { BridgeResult, ConnectionSnapshot, OrcaBridge } from "../bridge.js";
import type { Preferences } from "../preferences/schema.js";
import type { NotificationMessage } from "@orca/protocol";

const { contextBridge, ipcRenderer } = electron;

/**
 * One `invoke` channel per read method; the main process's handler names match one-for-one.
 * The trailing comma in `<T,>` is not a typo: a `.cts` file is parsed with the JSX-adjacent
 * rules that make a bare `<T>` on an arrow ambiguous, and the comma is the disambiguator.
 */
const call = <T,>(channel: string, params?: unknown): Promise<BridgeResult<T>> =>
  ipcRenderer.invoke(channel, params) as Promise<BridgeResult<T>>;

const bridge: OrcaBridge = {
  platform: process.platform,
  hello: () => call("orca:hello"),
  runs: {
    list: (params = {}) => call("orca:runs.list", params),
    get: (params) => call("orca:runs.get", params),
    events: (params) => call("orca:runs.events", params),
  },
  inputs: { list: (params = {}) => call("orca:inputs.list", params) },
  claims: { list: (params = {}) => call("orca:claims.list", params) },
  artifacts: {
    list: (params = {}) => call("orca:artifacts.list", params),
    get: (params) => call("orca:artifacts.get", params),
  },
  agents: { list: (params = {}) => call("orca:agents.list", params) },
  notifications: {
    // The one channel the main process pushes on rather than answers on. Each renderer
    // listener gets its own `ipcRenderer` listener so that unsubscribing one cannot silence
    // another, and so nothing here has to keep a registry across the context bridge.
    subscribe: (listener: (notification: NotificationMessage) => void) => {
      const forward = (_event: unknown, notification: NotificationMessage): void => listener(notification);
      ipcRenderer.on("orca:notification", forward);
      return () => void ipcRenderer.off("orca:notification", forward);
    },
  },
  connection: {
    // Synchronous for the same reason `preferences.read` is: the status bar is drawn on the
    // renderer's first pass, and a promise would paint "reconnecting" for a frame first.
    read: () => ipcRenderer.sendSync("orca:connection.read") as ConnectionSnapshot,
    // A second channel the main process pushes on. One `ipcRenderer` listener per renderer
    // listener, as above, so unsubscribing one cannot silence another.
    subscribe: (listener: (snapshot: ConnectionSnapshot) => void) => {
      const forward = (_event: unknown, snapshot: ConnectionSnapshot): void => listener(snapshot);
      ipcRenderer.on("orca:connection", forward);
      return () => void ipcRenderer.off("orca:connection", forward);
    },
  },
  preferences: {
    read: () => ipcRenderer.sendSync("orca:preferences.read") as Preferences,
    write: (patch) => ipcRenderer.invoke("orca:preferences.write", patch) as Promise<BridgeResult<Preferences>>,
  },
};

contextBridge.exposeInMainWorld("orca", bridge);
