/**
 * Preload: the narrow bridge between the sandboxed renderer and the main process. The
 * renderer never gets Node or credentials; it gets `window.orca` with one function
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
import type { DaemonTargetSnapshot } from "../daemon-connection.js";
// A CommonJS file under `verbatimModuleSyntax` has no other way to spell a value import,
// and emitting CommonJS is the whole point of this file — see the header.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require("electron");
import type {
  AlertActivation,
  AlertsUpdate,
  BridgeResult,
  ConnectionSnapshot,
  OrcaBridge,
  WorkspaceSnapshot,
} from "../bridge.js";
import type { UpdateSnapshot } from "../update-contract.js";
import type { Preferences } from "../preferences/schema.js";
import type { NotificationMessage } from "@orca/protocol";

const { contextBridge, ipcRenderer } = electron;

/**
 * One `invoke` channel per read method; the main process's handler names match one-for-one.
 * The trailing comma in `<T,>` is not a typo: a `.cts` file is parsed with the JSX-adjacent
 * rules that make a bare `<T>` on an arrow ambiguous, and the comma is the disambiguator.
 */
let targetEpoch = (ipcRenderer.sendSync("orca:daemon.read") as DaemonTargetSnapshot).epoch;

const call = <T,>(channel: string, params?: unknown): Promise<BridgeResult<T>> =>
  ipcRenderer.invoke(channel, params, targetEpoch) as Promise<BridgeResult<T>>;

const bridge: OrcaBridge = {
  platform: process.platform,
  daemonConnection: {
    read: () => ipcRenderer.sendSync("orca:daemon.read") as DaemonTargetSnapshot,
    subscribe: (listener) => {
      const forward = (_event: unknown, target: DaemonTargetSnapshot) => listener(target);
      ipcRenderer.on("orca:daemon.target", forward);
      return () => {
        ipcRenderer.off("orca:daemon.target", forward);
      };
    },
    activate: (epoch) => {
      targetEpoch = epoch;
    },
    show: () => ipcRenderer.send("orca:daemon.show"),
    onShow: (listener) => {
      ipcRenderer.on("orca:daemon.show", listener);
      return () => {
        ipcRenderer.off("orca:daemon.show", listener);
      };
    },
    connect: (url) =>
      ipcRenderer.invoke("orca:daemon.connect", url) as Promise<{ ok: true } | { ok: false; message: string }>,
    cancel: () => ipcRenderer.send("orca:daemon.cancel"),
  },
  updates: {
    read: () => ipcRenderer.sendSync("orca:update.read") as UpdateSnapshot,
    act: (action) => call("orca:update.act", action),
    subscribe: (listener) => {
      const forward = (_event: unknown, state: UpdateSnapshot) => listener(state);
      ipcRenderer.on("orca:update", forward);
      return () => {
        ipcRenderer.off("orca:update", forward);
      };
    },
    prepare: (listener) => {
      const forward = (_event: unknown, nonce: string | null) => {
        const ready = listener(nonce !== null);
        if (nonce) ipcRenderer.send("orca:update.prepared", { nonce, ready });
      };
      ipcRenderer.on("orca:update.prepare", forward);
      return () => {
        ipcRenderer.off("orca:update.prepare", forward);
      };
    },
  },
  hello: () => call("orca:hello"),
  runs: {
    list: (params = {}) => call("orca:runs.list", params),
    get: (params) => call("orca:runs.get", params),
    events: (params) => call("orca:runs.events", params),
    cancel: (params) => call("orca:runs.cancel", params),
    resume: (params) => call("orca:runs.resume", params),
    start: (params) => call("orca:runs.start", params),
  },
  inputs: {
    list: (params = {}) => call("orca:inputs.list", params),
    answer: (params) => call("orca:inputs.answer", params),
  },
  claims: {
    list: (params = {}) => call("orca:claims.list", params),
    release: (params) => call("orca:claims.release", params),
  },
  plan: {
    list: (params = {}) => call("orca:plans.list", params),
    get: (params) => call("orca:plan.get", params),
    items: (params) => call("orca:items.list", params),
    schedule: (params) => call("orca:schedule.get", params),
    explain: (params) => call("orca:schedule.explain", params),
    dependencies: (params) => call("orca:dependencies.list", params),
    risks: (params) => call("orca:risks.list", params),
    decisions: (params) => call("orca:decisions.list", params),
    journal: (params) => call("orca:journal.list", params),
    waive: (params) => call("orca:dependencies.waive", params),
    decide: (params) => call("orca:decisions.decide", params),
    reopen: (params) => call("orca:decisions.reopen", params),
    updateRisk: (params) => call("orca:risks.update", params),
  },
  artifacts: {
    list: (params = {}) => call("orca:artifacts.list", params),
    get: (params) => call("orca:artifacts.get", params),
  },
  workflows: {
    list: (params = {}) => call("orca:workflows.list", params),
    get: (params) => call("orca:workflows.get", params),
  },
  agents: { list: (params = {}) => call("orca:agents.list", params) },
  config: {
    get: (params = {}) => call("orca:config.get", params),
    set: (params) => call("orca:config.set", params),
  },
  notifications: {
    // The one channel the main process pushes on rather than answers on. Each renderer
    // listener gets its own `ipcRenderer` listener so that unsubscribing one cannot silence
    // another, and so nothing here has to keep a registry across the context bridge.
    subscribe: (listener: (notification: NotificationMessage) => void) => {
      const forward = (_event: unknown, notification: NotificationMessage, epoch: number): void => {
        if (epoch === targetEpoch) listener(notification);
      };
      ipcRenderer.on("orca:notification", forward);
      return () => void ipcRenderer.off("orca:notification", forward);
    },
  },
  alerts: {
    // `send`, not `invoke`: the main process has no verdict to give back about what is
    // waiting, and a promise nobody awaits is a promise nobody notices rejecting.
    update: (update: AlertsUpdate) => ipcRenderer.send("orca:alerts.update", update, targetEpoch),
    // A third push channel, one `ipcRenderer` listener per renderer listener as above.
    subscribe: (listener: (activation: AlertActivation) => void) => {
      const forward = (_event: unknown, activation: AlertActivation): void => listener(activation);
      ipcRenderer.on("orca:alerts.activate", forward);
      return () => void ipcRenderer.off("orca:alerts.activate", forward);
    },
  },
  connection: {
    // Synchronous for the same reason `preferences.read` is: the status bar is drawn on the
    // renderer's first pass, and a promise would paint "reconnecting" for a frame first.
    read: () => ipcRenderer.sendSync("orca:connection.read") as ConnectionSnapshot,
    // A second channel the main process pushes on. One `ipcRenderer` listener per renderer
    // listener, as above, so unsubscribing one cannot silence another.
    subscribe: (listener: (snapshot: ConnectionSnapshot) => void) => {
      const forward = (_event: unknown, snapshot: ConnectionSnapshot, epoch: number): void => {
        if (epoch === targetEpoch) listener(snapshot);
      };
      ipcRenderer.on("orca:connection", forward);
      return () => void ipcRenderer.off("orca:connection", forward);
    },
  },
  workspace: {
    // Synchronous, like the two reads above: the file-mode banner names the store on the
    // renderer's first pass, and a promise would paint an unnamed banner for a frame.
    read: () => ipcRenderer.sendSync("orca:workspace.read") as WorkspaceSnapshot,
    subscribe: (listener: (snapshot: WorkspaceSnapshot) => void) => {
      const forward = (_event: unknown, snapshot: WorkspaceSnapshot): void => listener(snapshot);
      ipcRenderer.on("orca:workspace", forward);
      return () => void ipcRenderer.off("orca:workspace", forward);
    },
    open: (params = {}) => call("orca:workspace.open", params),
    connectLive: () => call("orca:workspace.connectLive"),
  },
  deepLink: {
    // Synchronous *and* draining: a link is delivered to one reader once, so the window
    // takes it on its first pass and subscribes for the rest.
    take: () => ipcRenderer.sendSync("orca:deepLink.take") as string | undefined,
    subscribe: (listener: (url: string) => void) => {
      const forward = (_event: unknown, url: string): void => listener(url);
      ipcRenderer.on("orca:deepLink", forward);
      return () => void ipcRenderer.off("orca:deepLink", forward);
    },
  },
  preferences: {
    read: () => ipcRenderer.sendSync("orca:preferences.read") as Preferences,
    write: (patch) => ipcRenderer.invoke("orca:preferences.write", patch) as Promise<BridgeResult<Preferences>>,
  },
};

contextBridge.exposeInMainWorld("orca", bridge);
