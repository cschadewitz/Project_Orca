/**
 * Electron main process. Owns the daemon connection, the preferences file, the application
 * menu and the window; the renderer only sees what the preload bridge exposes.
 *
 * Which daemon, in order: `ORCA_DAEMON_URL`, then the saved endpoint, then the daemon inside a
 * packaged app over a verified first-run selection or explicit ORCA_WORKSPACE. Without an
 * explicit target or verified selection the app opens disconnected for setup. This file
 * owns the composition; `daemon-process.ts` is Electron-
 * free so that it can be tested as a plain module. **Which store that daemon serves is
 * `./workspace.ts`'s**, because it can change while the app is running (#164), and every
 * bridge call waits on the switch rather than on a promise that resolved once at startup.
 *
 * The other thing that arrives from outside is an `orca://` URL (#165). The three ways an
 * operating system delivers one — a cold start's `argv`, `open-url`, `second-instance` —
 * are folded into `./deep-link.ts` here and resolved by one route table in the renderer.
 *
 * The window loads the built renderer from `dist/renderer` unless `ORCA_RENDERER_URL` is
 * set, which is what `pnpm --filter @orca/app dev` does to point it at the Vite dev
 * server for hot reload (scripts/dev.js).
 */
import { callScopedPermission } from "../client/scoped-permission-client.js";
import type { ScopedPermissionMethod } from "@orca/protocol";
import { z } from "zod";
import { createDiagnosticsInitializer } from "./diagnostics/initialize.js";
import { createManagedMacReplacementStartup } from "./mac-managed-replacement-startup.js";
import { MacAppWriterBarrier } from "./mac-app-writer-barrier.js";
import { diagnosticsAddonPath } from "./diagnostics/native-addon.js";
import type { OwnedDiagnosticObservation } from "./diagnostics/source-producers.js";
import { FirstRunSetup } from "./first-run/setup.js";
import { installFirstRunIPC, startFirstRunWorkspace } from "./first-run/ipc.js";
import { FirstRunRefusal } from "./first-run/refusal.js";
import type { DiagnosticsResult } from "../diagnostics-contract.js";
import { AdmissionIntents, AdmissionIntentController, protectedStorageBridgeError } from "./admission-intents.js";
import { RecoveryIntentController, RecoveryIntents, recoveryTarget } from "./recovery-intents.js";
import { GuidedLaunchAdapter } from "./guided-launch-adapter.js";
import type { LaunchReview, PreflightParams } from "../configuration-launch-contract.js";
import { RunsAdmitResultSchema, ServerPathSchema } from "@orca/protocol";
import { ConnectionTarget, ConnectionRefusal, connectionFailure, callInConnection } from "./connection-target.js";
import { RemoteProfiles } from "./remote-profiles.js";
import { ServerUpdater } from "./server-update.js";
import { isUpdateAction, prepareDrafts } from "./update-ipc.js";
import { Updates, type UpdateGuards } from "./updates.js";
import { AutoUpdates, idleThreshold } from "./auto-updates.js";
import { MacUpdateWindows } from "./mac-update-windows.js";
import { MacUpdateGuards } from "./mac-update-guards.js";
import { installMacUpdateIPC } from "./mac-update-application.js";
import { createManagedMacUpdateApplication } from "./mac-managed-update-application.js";
import { createManagedMacNativeProviders } from "./mac-native-providers.js";
import { updateDriver } from "./update-driver.js";
import { isDebInstall, LinuxReleaseWatch } from "./linux-release-notice.js";
import { executableMatchesPackage, LinuxPackageRestart, readInstalledDebVersion } from "./linux-package-restart.js";
import { basename, dirname, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { windowIcon } from "./window-icon.js";
import { revealWhenReady } from "./window-reveal.js";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  powerMonitor,
  autoUpdater,
  systemPreferences,
  clipboard,
  net,
  shell,
} from "electron";
import { rawTokens, type ThemeId } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import type { AlertItem, AlertsUpdate, BridgeResult, ConnectionSnapshot, WorkspaceSnapshot } from "../bridge.js";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import { callTemplate } from "../client/template-client.js";
import type { TemplateMethod } from "../template-bridge.js";
import type { WorkflowDraftMethodName } from "../workflow-draft-bridge.js";
import { callWorkflowDraft } from "../client/workflow-draft-client.js";
import { daemonEndpoint, type DaemonConnectionRequest, type ProfileResult } from "../daemon-connection.js";
import { isLoopbackDaemon, LocalDaemonToken } from "../client/auth.js";
import { PreferencesFile } from "../preferences/preferences-file.js";
import type { Preferences, ThemePreference } from "../preferences/schema.js";
import { appMenuTemplate } from "./app-menu.js";
import { hasTitleBarOverlay, titleBarOverlay, windowChrome } from "./window-chrome.js";
import { createAlerts, type AlertTier } from "./alerts.js";
import { ConnectionMachine } from "./connection-state.js";
import { DeepLinkQueue, ORCA_SCHEME, protocolClientArgs, urlFromArgv } from "./deep-link.js";
import { findBundledDaemon, startBundledDaemon } from "./daemon-process.js";
import { StoreSwitchRestart, takeStoreSwitchRequest, writeStoreSwitchRequest } from "./store-switch.js";
import { storeRoot, Workspace } from "./workspace.js";
import { Fleet, alertScope, labelAlerts, type FleetTarget, type FocusedMachine } from "./fleet.js";
import { MAX_WATCHED_PROFILES } from "../preferences/schema.js";

// Mount synchronously before producers. Selected workspace/configuration roots are
// enrolled before their first producer; replacement activation remains held below.
// The updater only ever replaces a packaged app, and only a packaged app carries the
// native storage addon this gate needs, so unpackaged Electron (development, the app
// smoke tests) never mounts it and starts like Linux and Windows do.
const appWriterRoot = app.getPath("userData");
const appWriters = new MacAppWriterBarrier();
const macReplacement =
  process.platform === "darwin" && app.isPackaged
    ? createManagedMacReplacementStartup({
        control: join(dirname(appWriterRoot), basename(appWriterRoot) + "-native-replacement"),
        appRoot: appWriterRoot,
        safeStorage,
      })
    : undefined;
const ordinaryStartupAllowed = () =>
  appWriters.admitting && (!macReplacement || macReplacement.bootstrap.ordinaryAllowed);
function assertOrdinaryStartup(): void {
  if (!ordinaryStartupAllowed()) throw new Error("Native replacement recovery keeps protected startup closed");
}

// Existing run completion and observation remain available during the reserved drain.
// New admissions and app/configuration mutations still require the open window.
const drainCompletionChannels = new Set([
  "orca:hello",
  "orca:runs.list",
  "orca:runs.get",
  "orca:runs.events",
  "orca:inputs.list",
  "orca:claims.list",
  "orca:artifacts.list",
  "orca:artifacts.get",
  "orca:search",
  "orca:agents.list",
  "orca:workflows.list",
  "orca:workflows.get",
  "orca:config.get",
  "orca:plans.list",
  "orca:plan.get",
  "orca:items.list",
  "orca:schedule.get",
  "orca:schedule.explain",
  "orca:dependencies.list",
  "orca:risks.list",
  "orca:decisions.list",
  "orca:journal.list",
  "orca:inputs.revise",
  "orca:inputs.revisionPending",
  "orca:inputs.replaceRevision",
  "orca:inputs.answer",
  "orca:runs.cancel",
  "orca:runs.resume",
  // Recovery reads and side-effect reviews finish existing work; starting an attempt does not.
  "orca:runs.recovery",
  "orca:runs.reviewEffect",
]);
function assertDispatchAllowed(channel: string): void {
  if (
    ordinaryStartupAllowed() ||
    (appWriters.admitting &&
      workspace.macUpdateReserved &&
      macReplacement?.bootstrap.existingWorkAllowed &&
      drainCompletionChannels.has(channel))
  )
    return;
  assertOrdinaryStartup();
}

/** Bind to MacClosedWindowCommit only with the real native session/root inventory.
 * The barrier seals synchronously; outstanding storage work retains kernel ownership. */
export async function pauseMacUpdateAppWriters(signal: AbortSignal): Promise<boolean> {
  if (!macReplacement || signal.aborted) return false;
  stopDiagnosticObservations();
  const paused = await appWriters.pause(
    () => diagnosticsInitializer.close(),
    () => macReplacement.releasePausedAppWriter(),
  );
  return paused && !signal.aborted;
}

/** The recovery shell's one action, offered only when the update-protection records are lost
 * or unreadable and record no attempt; docs/implementation/mac-closed-window-fixed-path.md. */
async function offerUpdateProtectionReset(startup: NonNullable<typeof macReplacement>): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Update protection needs a reset",
    message: "ORCA's update-protection records are missing or damaged",
    detail:
      "This happens when ORCA's data folder is restored or moved without the recovery folder kept " +
      "beside it, or when that folder is removed. No update is recorded as in progress. Resetting " +
      "replaces the records and restarts ORCA; workspaces, settings and keychain items are kept.",
    buttons: ["Keep", "Reset and restart"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  if (await startup.reset()) {
    app.relaunch();
    app.quit();
    return;
  }
  dialog.showErrorBox(
    "Update protection could not be reset",
    "Protected startup remains closed. Quit any other ORCA process, then open ORCA again.",
  );
}

const preferences = new PreferencesFile(join(app.getPath("userData"), "preferences.json"));
/** Saved SSH profiles, their pinned host keys and sealed credentials (#874). Main only. */
const remoteProfiles = new RemoteProfiles({
  dir: join(app.getPath("userData"), "remote-daemons"),
  cipher: safeStorage,
  // Phase and refusal code only: ssh's own output never reaches the console or the renderer.
  onTunnelState: (id, state) => {
    if (state.phase === "reconnecting" || state.phase === "failed")
      console.error(`ssh tunnel for profile ${id}: ${state.phase} (${state.refusal})`);
  },
});

/** The dev server's URL when `scripts/dev.js` started one; undefined in a packaged app. */
const rendererUrl = process.env.ORCA_RENDERER_URL;

// Capture and native recovery remain unavailable until independent/native review.
// This controller is separate from admission intents, daemon hello and execution keys.
const diagnosticsInitializer = createDiagnosticsInitializer({
  root: join(app.getPath("userData"), "diagnostics"),
  safeStorage,
  chooseDestination: async () => {
    const result = await dialog.showSaveDialog({
      title: "Save diagnostic preview",
      defaultPath: "orca-diagnostics.json",
      filters: [{ name: "Diagnostic JSON", extensions: ["json"] }],
    });
    return result.canceled ? undefined : result.filePath;
  },
});
const diagnostics = diagnosticsInitializer.controller;
let diagnosticsStopping = false;
let powerObservationMounted = false;
function observeDiagnostic(...fact: OwnedDiagnosticObservation): void {
  if (!diagnosticsStopping && appWriters.admitting && (!macReplacement || macReplacement.bootstrap.existingWorkAllowed))
    diagnosticsInitializer.observer(...fact);
}
const observeSuspend = () => observeDiagnostic("lifecycle", "sleep_observed");
const observeResume = () => observeDiagnostic("lifecycle", "wake_observed");
function stopDiagnosticObservations(): void {
  if (diagnosticsStopping) return;
  observeDiagnostic("lifecycle", "app_stopping");
  diagnosticsStopping = true;
  if (powerObservationMounted) {
    powerMonitor.removeListener("suspend", observeSuspend);
    powerMonitor.removeListener("resume", observeResume);
    powerObservationMounted = false;
  }
}
diagnostics.subscribe((status) => {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send("orca:diagnostics.changed", status);
});
const diagnosticWindowGenerations = new Map<number, number>();
let diagnosticConsentGeneration = 0;
const diagnosticHandle = (
  method: string,
  schema: z.ZodType,
  run: (params: unknown) => unknown,
  disposalOnly = false,
): void => {
  ipcMain.handle(`orca:diagnostics.${method}`, async (event, params: unknown, epoch: number): Promise<unknown> => {
    try {
      assertOrdinaryStartup();
      const win = BrowserWindow.fromWebContents(event.sender);
      const generation = diagnosticWindowGenerations.get(event.sender.id) ?? 0;
      const consentGeneration = diagnosticConsentGeneration;
      const frame = event.senderFrame;
      const currentSender = () =>
        win &&
        !win.isDestroyed() &&
        BrowserWindow.getAllWindows().length === 1 &&
        event.senderFrame === event.sender.mainFrame &&
        frame === event.sender.mainFrame &&
        generation === (diagnosticWindowGenerations.get(event.sender.id) ?? 0);
      if (!currentSender()) return { ok: false, code: "stale_export" } satisfies DiagnosticsResult<never>;
      if (
        !win ||
        win.isDestroyed() ||
        event.senderFrame !== event.sender.mainFrame ||
        (!disposalOnly && epoch !== workspace.connectionTarget.epoch)
      )
        return { ok: false, code: "stale_export" } satisfies DiagnosticsResult<never>;
      const parsed = schema.safeParse(params);
      if (!parsed.success) return { ok: false, code: "refused" } satisfies DiagnosticsResult<never>;
      // Exact-handle disposal grants no capture, content, picker or Save authority.
      // A workspace switch may revoke its old target epoch before export cancellation;
      // cancel the frozen report from this same verified document without initialization.
      if (disposalOnly) return await appWriters.run(() => run(parsed.data));
      // Opt-out revokes in the controller before any initialization wait. Its
      // current sender, target and strict consent parameters were verified above.
      if (method === "setEnabled" && (parsed.data as { enabled: boolean }).enabled === false) {
        diagnosticConsentGeneration++;
        return await appWriters.run(() => run(parsed.data));
      }
      return await appWriters.run(async () => {
        await diagnosticsInitializer.initialize();
        if (
          !currentSender() ||
          epoch !== workspace.connectionTarget.epoch ||
          (method === "setEnabled" && consentGeneration !== diagnosticConsentGeneration)
        )
          return { ok: false, code: "stale_export" } satisfies DiagnosticsResult<never>;
        return await run(parsed.data);
      });
    } catch {
      return { ok: false, code: "unavailable" } satisfies DiagnosticsResult<never>;
    }
  });
};
const noDiagnosticParams = z.undefined();
const opaqueDiagnosticHandle = z.string().uuid();
diagnosticHandle("status", noDiagnosticParams, () => ({ ok: true, value: diagnostics.status() }));
diagnosticHandle("setEnabled", z.object({ enabled: z.boolean(), scopeVersion: z.literal(1) }).strict(), (params) => {
  const choice = params as { enabled: boolean; scopeVersion: number };
  return diagnostics.setEnabled(choice.enabled, choice.scopeVersion);
});
diagnosticHandle("setMinutes", z.object({ minutes: z.number().int().min(1).max(15) }).strict(), (params) =>
  diagnostics.setMinutes((params as { minutes: number }).minutes),
);
diagnosticHandle("prepareExport", z.object({ source: z.enum(["current", "previous"]) }).strict(), (params) =>
  diagnostics.prepareExport((params as { source: "current" | "previous" }).source),
);
diagnosticHandle(
  "cancelExport",
  z.object({ handle: opaqueDiagnosticHandle }).strict(),
  (params) => diagnostics.cancelExport((params as { handle: string }).handle),
  true,
);
diagnosticHandle("chooseDestination", z.object({ handle: opaqueDiagnosticHandle }).strict(), (params) =>
  diagnostics.chooseDestination((params as { handle: string }).handle),
);
diagnosticHandle(
  "save",
  z.object({ handle: opaqueDiagnosticHandle, destinationToken: opaqueDiagnosticHandle }).strict(),
  (params) => {
    const choice = params as { handle: string; destinationToken: string };
    return diagnostics.save(choice.handle, choice.destinationToken);
  },
);
diagnosticHandle("discardPrevious", noDiagnosticParams, () => diagnostics.discardPrevious());
diagnosticHandle("retryCleanup", noDiagnosticParams, () => diagnostics.retryCleanup());
diagnosticHandle("acknowledgeUnknown", z.object({ operationHandle: opaqueDiagnosticHandle }).strict(), (params) =>
  diagnostics.acknowledgeUnknown((params as { operationHandle: string }).operationHandle),
);

/* ---------- one app, one window onto a store ---------- */

/**
 * A second launch is not a second app. Without the lock, following an `orca://` link on
 * Windows or Linux starts another process with another window onto the same store — two
 * copies of one run tree, and the link opening in the one nobody was looking at. With it,
 * the second process exits and hands its command line to this one as `second-instance`
 * (#165); macOS never starts a second process and sends `open-url` instead.
 */
const primary = app.requestSingleInstanceLock();

const deepLinks = new DeepLinkQueue();

/** The URL this process was started for, on the platforms that put it in the command line. */
deepLinks.offer(urlFromArgv(process.argv));

/* ---------- the daemon ---------- */

/**
 * Every bridge call answers rather than rejects: a rejection over the context bridge reaches
 * the renderer as a stringified `Error` with the main process's stack, which no screen can
 * render. See `../bridge.ts`.
 *
 * `workspace.ready()` is what the old `daemonReady` promise was, awaited on every call
 * rather than only on the first ones: the app can be re-pointed at another store while it
 * runs, so "which daemon" has a new answer each time rather than a settled one.
 */
function handle<P, R>(channel: string, run: (params: P) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, params: P, epoch: number): Promise<BridgeResult<R>> => {
    try {
      assertDispatchAllowed(channel);
      if (macUpdateWindows.active) throw new Error("Update window preparation is in progress");
      if (!channel.startsWith("orca:workspace.")) {
        return {
          ok: true,
          result: await appWriters.run(() =>
            callInConnection(workspace, epoch, () => {
              assertDispatchAllowed(channel);
              if (macUpdateWindows.active) throw new Error("Update window preparation is in progress");
              return run(params);
            }),
          ),
        };
      }
      workspace.assertEpoch(epoch);
      await workspace.ready();
      workspace.assertEpoch(epoch);
      assertDispatchAllowed(channel);
      if (macUpdateWindows.active) throw new Error("Update window preparation is in progress");
      return { ok: true, result: await appWriters.run(() => run(params)) };
    } catch (e) {
      if (e instanceof DaemonClientError) return { ok: false, error: e.error };
      const storage = protectedStorageBridgeError(e);
      if (storage) return { ok: false, error: storage };
      return { ok: false, error: { code: "AGENT_TRANSPORT", message: e instanceof Error ? e.message : String(e) } };
    }
  });
}

/** The client of the moment, read at call time and never captured. */
const client = (): DaemonClient => workspace.client;

// Consume only the verified projection of operator.discover; no peer-feature source import.
const intentDiscovery = z.object({
  principalId: z.string().min(1),
  authentication: z.literal("credential"),
  target: z.object({ workspaceId: z.uuid(), instanceId: z.uuid() }),
  operations: z.array(z.string()),
});
const intentJournal = new AdmissionIntents(join(app.getPath("userData"), "admission-intents.enc"), safeStorage);
const intents = new AdmissionIntentController(intentJournal, async () => {
  const captured = client();
  const target = workspace.connectionTarget;
  const found = await captured.call("operator.discover", {}, intentDiscovery);
  workspace.assertEpoch(target.epoch);
  if (
    !found.operations.includes("runs.admit") ||
    !target.identity ||
    found.target.workspaceId !== target.identity.workspaceId ||
    found.target.instanceId !== target.identity.instanceId
  )
    throw new Error(
      "The authenticated daemon target changed or retry admission is unavailable. Refresh before retrying.",
    );
  return {
    scope: {
      target: target.source === "bundled" ? `bundled:${workspace.snapshot.path}` : daemonEndpoint(target.url),
      principalId: found.principalId,
      workspaceId: found.target.workspaceId,
    },
    assertCurrent: () => workspace.assertEpoch(target.epoch),
    admit: (params) => captured.call("runs.admit", params, RunsAdmitResultSchema),
  };
});
const guided = new GuidedLaunchAdapter(intentJournal, () => {
  const target = workspace.connectionTarget;
  return {
    client: client(),
    target,
    workspace: workspace.snapshot,
    assertCurrent: () => workspace.assertEpoch(target.epoch),
  };
});
handle("orca:guidedLaunch.snapshot", () => guided.snapshot());
handle("orca:guidedLaunch.preflight", (params: PreflightParams) => guided.preflight(params));
handle("orca:guidedLaunch.submit", (review: LaunchReview) => guided.controller.submit(review));
handle("orca:guidedLaunch.retained", () => guided.controller.retained());
handle("orca:guidedLaunch.load", (id: string) => guided.load(id));
handle("orca:guidedLaunch.resolve", (review: LaunchReview) => guided.resolve(review));
handle("orca:guidedLaunch.recover", (params: { id: string; action: "inspect" | "reconcile" }) => {
  if (params.action !== "inspect" && params.action !== "reconcile")
    throw new Error("Choose an explicit recovery action.");
  return guided.controller.recover(params.id, params.action);
});
handle("orca:guidedLaunch.abandon", (id: string) =>
  guided.controller.abandon(id, async () => {
    const result = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Keep retained intent", "Abandon intent"],
      defaultId: 0,
      cancelId: 0,
      message: "Abandon this launch intent?",
      detail:
        "The original work may already exist or still be running. This does not cancel it. A new launch creates separate work with a new key.",
    });
    return result.response === 1;
  }),
);
// Checkpoint attempts (#357): the same verified scope as run intents, bound to the captured
// connection, with `runs.recover` required in the principal's operations.
const recoveryIntents = new RecoveryIntentController(
  new RecoveryIntents(join(app.getPath("userData"), "recovery-intents.enc"), safeStorage),
  async () => {
    const captured = client();
    const target = workspace.connectionTarget;
    const endpoint = workspace.profileEndpoint;
    const found = await captured.call("operator.discover", {}, intentDiscovery);
    workspace.assertEpoch(target.epoch);
    if (
      !found.operations.includes("runs.recover") ||
      !target.identity ||
      found.target.workspaceId !== target.identity.workspaceId ||
      found.target.instanceId !== target.identity.instanceId
    )
      throw new Error("The authenticated daemon target changed or recovery is unavailable. Refresh before retrying.");
    return {
      scope: {
        target: recoveryTarget(target, workspace.snapshot.path, endpoint),
        principalId: found.principalId,
        workspaceId: found.target.workspaceId,
      },
      assertCurrent: () => workspace.assertEpoch(target.epoch),
      recover: (params) => captured.runsRecover(params),
      reconcile: (params) => captured.runsRecoverReconcile(params),
    };
  },
  async (state) => {
    const result = await dialog.showMessageBox(
      state === "resolved"
        ? {
            type: "question",
            buttons: ["Keep it", "Start a separate attempt"],
            defaultId: 0,
            cancelId: 0,
            message: "Start a separate checkpoint attempt?",
            detail:
              "The attempt this recovery started stays as it is. ORCA forgets the link to it here, and the next start creates a separate attempt with a new key.",
          }
        : {
            type: "warning",
            buttons: ["Keep recovery", "Abandon recovery"],
            defaultId: 0,
            cancelId: 0,
            message: "Abandon this checkpoint recovery?",
            detail:
              "An attempt may already exist or be running. This does not cancel it. The next start creates a separate attempt with a new key.",
          },
    );
    return result.response === 1;
  },
);
handle("orca:recoveryIntents.list", (params: { runId: string }) => recoveryIntents.list(params.runId));
handle("orca:recoveryIntents.start", (params: { runId: string; checkpoint: string }) =>
  recoveryIntents.start(params.runId, params.checkpoint),
);
handle("orca:recoveryIntents.finish", (params: { id: string }) => recoveryIntents.finish(params.id));
handle("orca:recoveryIntents.dismiss", (params: { id: string }) => recoveryIntents.dismiss(params.id));
handle("orca:admissionIntents.start", (workflowId: string) => intents.start(workflowId));
handle("orca:admissionIntents.list", () => intents.list());
handle("orca:admissionIntents.abandon", (id: string) =>
  intents.abandon(id, async () => {
    const result = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Keep retained intent", "Abandon intent"],
      defaultId: 0,
      cancelId: 0,
      message: "Abandon this run intent?",
      detail:
        "The original run may already exist or still be running. This does not cancel it. The next start creates a separate run with a new key.",
    });
    return result.response === 1;
  }),
);

handle("orca:hello", () => client().hello(`orca-app/${app.getVersion()}`));
handle("orca:runs.list", (params: Parameters<DaemonClient["runsList"]>[0]) => client().runsList(params));
handle("orca:runs.get", (params: Parameters<DaemonClient["runsGet"]>[0]) => client().runsGet(params));
handle("orca:runs.events", (params: Parameters<DaemonClient["runsEvents"]>[0]) => client().runsEvents(params));
handle("orca:inputs.list", (params: Parameters<DaemonClient["inputsList"]>[0]) => client().inputsList(params));
handle("orca:claims.list", (params: Parameters<DaemonClient["claimsList"]>[0]) => client().claimsList(params));
handle("orca:artifacts.list", (params: Parameters<DaemonClient["artifactsList"]>[0]) => client().artifactsList(params));
handle("orca:artifacts.get", (params: Parameters<DaemonClient["artifactsGet"]>[0]) => client().artifactsGet(params));
// `search` (#255): a read, bounded by the daemon; the palette asks `hello.methods` first.
handle("orca:search", (params: Parameters<DaemonClient["search"]>[0]) => client().search(params));
handle("orca:agents.list", (params: Parameters<DaemonClient["agentsList"]>[0]) => client().agentsList(params));
// The workflow viewer's two reads (#174, for #177). Reads like the ones above: a
// `--read-only` daemon answers both, because a workflow is a file and not a run.
handle("orca:workflows.list", (params: Parameters<DaemonClient["workflowsList"]>[0]) => client().workflowsList(params));
handle("orca:workflows.get", (params: Parameters<DaemonClient["workflowsGet"]>[0]) => client().workflowsGet(params));
handle("orca:scopedPermissions", (command: { method: ScopedPermissionMethod; params: unknown }) =>
  callScopedPermission(client(), command.method, command.params),
);
handle("orca:templates", (command: { method: TemplateMethod; params: unknown }) =>
  callTemplate(client(), command.method, command.params),
);
// Workflow drafts (#180): one channel for the closed method family, validated in the client.
handle("orca:workflowDrafts", (command: { method: WorkflowDraftMethodName; params: unknown }) =>
  callWorkflowDraft(client(), command.method, command.params),
);
handle("orca:config.get", (params: Parameters<DaemonClient["configGet"]>[0]) => client().configGet(params));
handle("orca:config.apply", (params: Parameters<DaemonClient["configApply"]>[0]) => client().configApply(params));
handle("orca:workflows.validateInputs", (params: Parameters<DaemonClient["workflowsValidateInputs"]>[0]) =>
  client().workflowsValidateInputs(params),
);
handle("orca:operator.preflight", (params: Parameters<DaemonClient["operatorPreflight"]>[0]) =>
  client().operatorPreflight(params),
);

// The plan reads (#169). Same channel shape as the run reads; the daemon omits all nine when
// it serves no plan, so a surface checks `hello.methods` rather than calling and failing.
handle("orca:plans.list", (params: Parameters<DaemonClient["plansList"]>[0]) => client().plansList(params));
handle("orca:plan.get", (params: Parameters<DaemonClient["planGet"]>[0]) => client().planGet(params));
handle("orca:items.list", (params: Parameters<DaemonClient["itemsList"]>[0]) => client().itemsList(params));
handle("orca:schedule.get", (params: Parameters<DaemonClient["scheduleGet"]>[0]) => client().scheduleGet(params));
handle("orca:schedule.explain", (params: Parameters<DaemonClient["scheduleExplain"]>[0]) =>
  client().scheduleExplain(params),
);
handle("orca:dependencies.list", (params: Parameters<DaemonClient["dependenciesList"]>[0]) =>
  client().dependenciesList(params),
);
handle("orca:risks.list", (params: Parameters<DaemonClient["risksList"]>[0]) => client().risksList(params));
handle("orca:decisions.list", (params: Parameters<DaemonClient["decisionsList"]>[0]) => client().decisionsList(params));
handle("orca:journal.list", (params: Parameters<DaemonClient["journalList"]>[0]) => client().journalList(params));

// The four that write a run (#160, #161, #178). They reach the daemon the same way the
// reads do; what makes them different is on the other two sides - the daemon refuses them
// without the run's lease, and the renderer asks `useWritability()` before offering the
// control at all. `runs.start` needs no lease: there is no run to hold one yet.
handle("orca:inputs.revise", (params: Parameters<DaemonClient["inputsRevise"]>[0]) => client().inputsRevise(params));
handle("orca:inputs.revisionPending", (params: Parameters<DaemonClient["inputsRevisionPending"]>[0]) =>
  client().inputsRevisionPending(params),
);
handle("orca:inputs.replaceRevision", (params: Parameters<DaemonClient["inputsReplaceRevision"]>[0]) =>
  client().inputsReplaceRevision(params),
);
handle("orca:inputs.answer", (params: Parameters<DaemonClient["inputsAnswer"]>[0]) => client().inputsAnswer(params));
handle("orca:runs.cancel", (params: Parameters<DaemonClient["runsCancel"]>[0]) => client().runsCancel(params));
handle("orca:runs.resume", (params: Parameters<DaemonClient["runsResume"]>[0]) => client().runsResume(params));
handle("orca:runs.start", (params: Parameters<DaemonClient["runsStart"]>[0]) => client().runsStart(params));
// Operator recovery (#357): a read and a side-effect review. Checkpoint attempts go through
// `orca:recoveryIntents.*` below, whose keys live in the encrypted journal.
handle("orca:runs.recovery", (params: Parameters<DaemonClient["runsRecovery"]>[0]) => client().runsRecovery(params));
handle("orca:runs.reviewEffect", (params: Parameters<DaemonClient["runsReviewEffect"]>[0]) =>
  client().runsReviewEffect(params),
);
// The fourth (#174, #266). It writes a file rather than a run, so no lease is involved, but
// it is still absent from a `--read-only` daemon and `useWritability()` still governs it.
handle("orca:config.set", (params: Parameters<DaemonClient["configSet"]>[0]) => client().configSet(params));
// Protocol 2.12 (#701): a plain-language rule, saved to the permission sidecar.
handle("orca:permissions.saveJudgedRule", (params: Parameters<DaemonClient["permissionsSaveJudgedRule"]>[0]) =>
  client().permissionsSaveJudgedRule(params),
);
// Protocol 2.12 (#701): where the judge's setup stands, read-only.
handle("orca:judge.status", () => client().judgeStatus());

// The plan writes and `claims.release` (#169, #88). `--read-only` omits them exactly as it
// omits the three above, so the same `useWritability()` answer covers all of them.
handle("orca:dependencies.waive", (params: Parameters<DaemonClient["dependenciesWaive"]>[0]) =>
  client().dependenciesWaive(params),
);
handle("orca:decisions.decide", (params: Parameters<DaemonClient["decisionsDecide"]>[0]) =>
  client().decisionsDecide(params),
);
handle("orca:decisions.reopen", (params: Parameters<DaemonClient["decisionsReopen"]>[0]) =>
  client().decisionsReopen(params),
);
handle("orca:risks.update", (params: Parameters<DaemonClient["risksUpdate"]>[0]) => client().risksUpdate(params));
handle("orca:claims.release", (params: Parameters<DaemonClient["claimsRelease"]>[0]) => client().claimsRelease(params));

/** Everything the main process pushes goes out the same way: every window, none destroyed. */
function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload, workspace.connectionTarget.epoch);
  }
}

/**
 * One socket for the whole app, store-wide, forwarded to every open window. A subscription
 * per window would mean one daemon connection per window showing the same runs, and the
 * renderer has no business choosing what the main process connects to — it says which
 * notifications interest it by what it does with them.
 *
 * The stream reconnects and resumes on its own (`../client/subscription.ts`), so nothing
 * here retries and nothing here notices a daemon restarting. A daemon *swap* is a different
 * thing and belongs to the workspace, which closes this stream and opens another.
 */
function broadcast(notification: NotificationMessage): void {
  send("orca:notification", notification);
}

/* ---------- watched machines (#882) ---------- */

/**
 * Every daemon on the Machines surface that is not the focused one: saved profiles a person
 * chose to watch, and the bundled daemon the workspace parked when focus moved elsewhere.
 * Each has its own client, stream and credential and is only ever read (`./fleet.ts`);
 * writes go to the focused daemon alone, through the workspace. Declared before the
 * connection machine and the workspace because both tell it when focus or state changes;
 * its own dependencies are read at call time.
 */
const fleet = new Fleet({
  open: async (target, hooks) => {
    if (target.kind === "profile") {
      // Watching only: never signs in, renews or pins a key (#882). Focusing signs in.
      const lease = await remoteProfiles.observe(target.id);
      try {
        const reader = new DaemonClient(daemonEndpoint(lease.url), lease.transport.fetch, {
          socket: lease.transport.socket,
          requireAuthentication: true,
          auth: lease.auth,
          onHello: hooks.onHello,
        });
        return {
          client: reader,
          explainFailure: () =>
            lease.remoteRefused()
              ? `SSH to ${lease.profile.destination} works, but no ORCA daemon is listening on its port ${lease.profile.remotePort}.`
              : undefined,
          release: () => lease.release(),
        };
      } catch (error) {
        await lease.release();
        throw error;
      }
    }
    const url = daemonEndpoint(target.url);
    return {
      client: new DaemonClient(url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({
          url,
          workspace: target.workspace,
          ...(target.tokenFile ? { tokenFile: target.tokenFile } : {}),
          env: {},
        }),
        onHello: hooks.onHello,
      }),
      // The workspace owns the parked daemon's process; the fleet only lets go of its reads.
      release: async () => undefined,
    };
  },
  focusedReader: () =>
    connection.current.state === "live" || connection.current.state === "file"
      ? { reader: workspace.client, epoch: workspace.connectionTarget.epoch }
      : undefined,
  onChange: (snapshot) => send("orca:fleet", snapshot),
  onAlerts: (update) => {
    fleetAlerts = update;
    publishAlerts();
  },
  onError: (message) => console.error(message),
});

/** The focused daemon as the Machines surface names it. Its key matches a watched member's. */
function focusedMachine(): FocusedMachine | undefined {
  const target = workspace.connectionTarget;
  const state = connection.current;
  if (!target.url && !target.profile) return undefined;
  const bundled = target.source === "bundled";
  return {
    key: target.profile ? `profile:${target.profile.id}` : bundled ? "bundled" : `url:${target.url}`,
    name: target.profile?.name ?? (bundled ? "This computer" : target.url),
    detail: target.profile
      ? `ssh ${target.profile.destination}`
      : bundled
        ? "Bundled daemon"
        : target.source === "env"
          ? "ORCA_DAEMON_URL"
          : "Daemon URL",
    workspaceId: target.identity?.workspaceId,
    epoch: target.epoch,
    state: state.state,
    since: state.since,
    authority: connection.authority,
  };
}

/** What the fleet should watch: the saved choice of profiles, plus a parked bundled daemon. */
function fleetTargets(): FleetTarget[] {
  const targets: FleetTarget[] = [];
  const parked = workspace.parkedBundled;
  if (parked) targets.push({ kind: "bundled", ...parked });
  for (const id of preferences.read().watchedProfiles ?? []) {
    const profile = remoteProfiles.get(id);
    if (profile)
      targets.push({
        kind: "profile",
        id,
        name: profile.name,
        destination: profile.destination,
        revision: remoteProfiles.revisionOf(id),
      });
  }
  return targets;
}
/**
 * Off until startup has built the workspace, the connection machine and the alerts: both of
 * the first two report changes while they are still being constructed, and nothing here may
 * read them before they exist.
 */
let fleetStarted = false;
function refreshFleet(): void {
  if (!fleetStarted) return;
  fleet.setFocused(focusedMachine());
  fleet.setTargets(fleetTargets());
}
function syncFocus(): void {
  if (fleetStarted) fleet.setFocused(focusedMachine());
}

/**
 * The renderer states the focused daemon's alerts; the fleet states every other machine's.
 * Both are labelled with their machine here, so an alert keeps one id when focus moves to or
 * from its machine and is never posted twice. The badge stays the focused daemon's count, the
 * same one number the title bar and the sidebar carry (docs/design/20-attention-and-gates.md).
 */
let focusedAlerts: AlertsUpdate = { waiting: 0, items: [] };
/** The grant the focused report was read under; its alerts and their clicks carry it. */
let focusedAlertsGrant: number | undefined;
let fleetAlerts: AlertsUpdate = { waiting: 0, items: [] };
function publishAlerts(): void {
  if (!fleetStarted) {
    alerts.update(focusedAlerts);
    return;
  }
  const focused = focusedMachine();
  const named = fleetAlerts.items.length > 0 || fleet.snapshot.machines.length > 1;
  const own = focused
    ? labelAlerts(
        focusedAlerts.items,
        {
          key: focused.key,
          name: focused.name,
          focused: true,
          scope: alertScope(focused.workspaceId, focused.key),
          workspaceId: focused.workspaceId,
          grant: focusedAlertsGrant,
        },
        named,
      )
    : [...focusedAlerts.items];
  alerts.update({ waiting: focusedAlerts.waiting, items: [...own, ...fleetAlerts.items] });
}

/* ---------- the connection state ---------- */

/**
 * One connection state for the whole app, decided here because this is the only place that
 * can see the socket, the bundled daemon's exit and the handshake at once (see
 * `./connection-state.ts`). Built before `whenReady` so that a window opening at any moment
 * has a state to read rather than a hole; the client is read at call time, so the machine
 * follows every switch the workspace makes.
 */
const connection = new ConnectionMachine({
  hello: () => client().hello(`orca-app/${app.getVersion()}`),
  onHello: (hello) => {
    // Legacy replies acquire their distinct scope in subscription verification. An
    // identified post-subscribe reply may reveal a boot change, but only after fencing.
    if (hello.identity) workspace.observeHello(workspace.client, hello);
  },
  onChange: (snapshot) => {
    send("orca:connection", snapshot);
    syncFocus();
  },
  // A refusal takes the focused daemon's alerts down with it: they were read under an
  // authority the app no longer has, and the renderer's next report after a fresh hello
  // states them again (#882).
  onAuthority: (authority) => {
    if (authority !== focusedAlertsGrant) {
      focusedAlerts = { waiting: 0, items: [] };
      focusedAlertsGrant = undefined;
    }
    if (!fleetStarted) return;
    syncFocus();
    publishAlerts();
  },
  onDiagnostic: observeDiagnostic,
});

// Synchronous, like `preferences.read`: the chrome draws the status bar on its first pass.
ipcMain.on("orca:connection.read", (event) => {
  event.returnValue = connection.current satisfies ConnectionSnapshot;
});

/* ---------- the workspace ---------- */

let alertsEpoch = 0;

/**
 * The store on screen, and the daemon serving it. Everything Electron knows and the module
 * must not — where the resources are, what the home directory is, what the environment
 * said — arrives here as a dependency, which is what keeps the switch itself a plain test.
 */
/** "Switch to SQLite" and back for the app's own workspace (#339); created with the update guards below. */
const storeSwitchRef: { current?: StoreSwitchRestart } = {};
const storeSwitchRequestFile = join(app.getPath("userData"), "store-switch", "request.json");
// Offered to people only after the native signed/installed switch and rollback acceptance
// (#339); until then only that acceptance turns it on.
const sqliteSwitchEnabled = process.env.ORCA_SQLITE_SWITCH === "1";
const workspace = new Workspace({
  updateBootstrap: {
    get ordinaryAllowed() {
      return ordinaryStartupAllowed();
    },
    get existingWorkAllowed() {
      return appWriters.admitting && macReplacement?.bootstrap.existingWorkAllowed === true;
    },
  },
  findEntry: () =>
    findBundledDaemon([
      // A packaged app: electron-builder's `extraResources`, beside `app.asar`.
      process.resourcesPath,
      // A build run from the repository: `dist/`, one level up from `dist/main`.
      fileURLToPath(new URL("../", import.meta.url)),
    ]),
  start: ({ entry, cwd, readOnly, configPath, firstRunToken, storeSwitch: switchStore, onExit }) =>
    startBundledDaemon({
      entry,
      cwd,
      ...(switchStore ? { storeSwitch: switchStore } : {}),
      ...(configPath ? { configPath } : {}),
      ...(macReplacement
        ? {
            env: {
              ...process.env,
              ORCA_MANAGED_UPDATE_CONTROL: join(
                dirname(appWriterRoot),
                basename(appWriterRoot) + "-native-replacement",
              ),
              ORCA_MANAGED_UPDATE_ADDON: diagnosticsAddonPath("diagnostics_storage", {
                platform: process.platform,
                arch: process.arch,
                electron: process.versions.electron !== undefined,
                ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
              }),
            },
          }
        : {}),
      ...(firstRunToken ? { firstRunToken } : {}),
      // A first-run startup never retries an owned child whose exit could be uncertain.
      ...(configPath ? { attempts: 1 } : {}),
      // The one flag the app passes, through the seam `daemon-process.ts` left for it:
      // file mode *is* a read-only daemon, because ADR 0008 forbids a second store path
      // in the renderer (#164).
      ...(readOnly ? { args: ["--read-only"] } : {}),
      onStartupDiagnostic: diagnosticsInitializer.startupObserver,
      onLog: (line) => console.error(`[daemon] ${line}`),
      onExit: (exit) => {
        console.error(`the bundled daemon exited on its own (code ${exit.code}, signal ${exit.signal})`);
        // The socket will go on retrying, but a daemon this process started and then
        // watched exit is not coming back on its own: that is `disconnected`, not
        // `reconnecting`, and the difference is the whole of what the status bar says.
        onExit(exit);
      },
    }),
  client: (url, options) => {
    try {
      url = daemonEndpoint(url);
    } catch {
      // An inert client keeps IPC installed; Workspace publishes disconnected without
      // subscribing or falling back to a different store. Never retain the invalid input.
      return new DaemonClient("");
    }
    // A saved profile's requests and socket travel only on its tunnel's authenticated streams.
    const candidate = new DaemonClient(url, options.transport?.fetch ?? fetch, {
      ...(options.transport ? { socket: options.transport.socket } : {}),
      requireAuthentication: options.bundled || !isLoopbackDaemon(url),
      // A profile's credential comes from its keychain slot and always requires authentication.
      ...(options.auth ? { requireAuthentication: true } : {}),
      auth:
        options.auth ??
        new LocalDaemonToken({
          url,
          workspace: options.workspace,
          ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
          // A spawned daemon issues its own token. A remote override in the app's environment
          // belongs to the explicitly connected daemon, never to a newly opened local store.
          ...(options.bundled ? { env: {} } : {}),
        }),
      onAuthFailure: () => {
        if (workspace.client === candidate) connection.authenticationFailed();
      },
      onDiagnostic: (...fact) => {
        if (workspace.client === candidate) observeDiagnostic(...fact);
      },
      onHello: (hello) => {
        if (workspace.client !== candidate) return;
        workspace.observeHello(candidate, hello);
        connection.acceptHello(hello);
      },
    });
    return candidate;
  },
  subscribe: (daemonClient) =>
    daemonClient.subscribe({
      params: {},
      onNotification: (n) => {
        // The existing stream already validated this closed failure verdict.
        if (workspace.client === daemonClient && n.method === "run.changed" && n.params.event === "run.failed")
          observeDiagnostic("run", "run_failed");
        broadcast({ kind: "notification", method: n.method, params: n.params });
        if (fleetStarted && workspace.client === daemonClient) fleet.focusedChanged(n);
        // The cursor the stream would resume from. A sequence number is per-run, so this
        // store-wide subscription has none and the status bar shows no event number — see
        // the note on `ConnectionMachine.sawCursor`.
        connection.sawCursor(workspace.subscription?.lastSeq);
      },
      // The retry count comes with the word because `reconnecting` alone cannot say how
      // long it has been failing, which is what decides `disconnected` now (#239).
      onState: (state, retries) => connection.linkChanged(state, retries),
    }),
  onSwitch: (fileMode) => connection.reset(fileMode),
  onSnapshot: (snapshot) => {
    send("orca:workspace", snapshot);
    storeSwitchRef.current?.refresh();
  },
  // A chosen store whose daemon would not start is not connected to anything (#269). The
  // machine's own input for "there is no daemon" is the one to use, so the status bar reads
  // `disconnected` through the same path as a daemon that exited, and the reason is on the
  // console beside it rather than in a field the renderer has no rendering for.
  onDaemonGone: () => {
    connection.daemonExited();
    storeSwitchRef.current?.refresh();
  },
  onError: (message, cause) => {
    // The window still opens, on a status bar that reads disconnected. A desktop app that
    // refuses to start because its daemon would not is a worse failure than one that shows
    // you it has no daemon.
    console.error(message);
    console.error(cause instanceof Error ? cause.message : String(cause));
  },
  savedUrl: preferences.read().daemonUrl,
  savedProfile: (() => {
    const id = preferences.read().daemonProfile;
    return id && remoteProfiles.get(id) ? id : undefined;
  })(),
  openProfile: (id) => remoteProfiles.open(id),
  onParked: () => refreshFleet(),
  onTarget: (target) => {
    // The first verified hello enriches the current epoch. It must not erase alerts
    // already supplied by that epoch's renderer while verification was in flight.
    if (target.epoch !== alertsEpoch) {
      diagnostics.revokeExportAuthority();
      alertsEpoch = target.epoch;
      focusedAlerts = { waiting: 0, items: [] };
      publishAlerts();
    }
    send("orca:daemon.target", target);
    syncFocus();
  },
  explicitUrl: process.env.ORCA_DAEMON_URL,
  defaultUrl: DEFAULT_DAEMON_URL,
  defaultPath: () => process.env.ORCA_WORKSPACE || undefined,
  setupBusy: () => firstRun.isBusy,
  // The gate is checked here too: a request written while enabled is never acted on once not.
  takeStoreSwitch: (path, ownership) =>
    takeStoreSwitchRequest(storeSwitchRequestFile, path, ownership, sqliteSwitchEnabled),
  recoverFirstRun: async (path, check, prepareConnection) => {
    const attempt = ++firstRunConnectionAttempt;
    await appWriters.run(() =>
      firstRun.connect(
        () => {
          assertOrdinaryStartup();
          check();
          if (attempt !== firstRunConnectionAttempt) throw new Error("Connection cancelled");
        },
        { workspace: path, prepareConnection },
      ),
    );
  },
});

const firstRun = new FirstRunSetup({
  enroll: async (path) => {
    if (macReplacement) await macReplacement.enrollProtectedRoots([path]);
  },
  home: app.getPath("home"),
  receiptPath: join(app.getPath("userData"), "first-run", "selection.json"),
  choose: async (kind) => {
    const options = {
      title:
        kind === "project"
          ? "Choose a prepared Git project"
          : process.platform === "win32"
            ? "Choose a parent for a new private app workspace"
            : "Choose a separate empty app workspace",
      properties: ["openDirectory" as const],
      // Neutral, because the Linux portal (GTK on Ubuntu 24.04) ignores the label and says "Open",
      // and "Choose folder" and "Open" both read right there (#1200). The setup guide names both.
      buttonLabel: "Choose folder",
    };
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return result.canceled ? undefined : result.filePaths[0];
  },
  prepareConnection: async (path) => {
    const candidate = await workspace.prepareFirstRunConnection(path);
    return {
      ...candidate,
      activate: (hello) => {
        candidate.validateActivation(hello);
        assertOrdinaryStartup();
        preferences.saveDaemonUrl(null);
        candidate.activate(hello);
      },
    };
  },
  current: (path) => workspace.currentFirstRun(path),
  configuration: (path) => workspace.captureFirstRunConfiguration(path),
});

let firstRunConnectionAttempt = 0;
async function connectFirstRun(assertCurrent: () => void) {
  if (firstRun.isBusy || macUpdateWindows.active || workspace.macUpdateReserved)
    throw new FirstRunRefusal(
      "Project setup or an app update is already in progress. Wait for it to finish, then retry.",
    );
  const attempt = ++firstRunConnectionAttempt;
  const check = () => {
    assertCurrent();
    if (attempt !== firstRunConnectionAttempt)
      throw new FirstRunRefusal("A newer connect request replaced this one. Nothing was connected by this request.");
  };
  check();
  const release = await guardConnectionDrafts();
  if (!release)
    throw new FirstRunRefusal(
      "Save or discard pending edits before connecting a different workspace. Your edits were kept.",
    );
  try {
    check();
    return await firstRun.connect(check);
  } finally {
    release();
  }
}

function captureFirstRunCaller(event: Electron.IpcMainInvokeEvent, epoch: number): () => void {
  const frame = event.senderFrame;
  const generation = diagnosticWindowGenerations.get(event.sender.id) ?? 0;
  return () => {
    assertOrdinaryStartup();
    workspace.assertEpoch(epoch);
    if (workspace.macUpdateReserved) throw new Error("Update window preparation is in progress");
    if (
      !BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.webContents === event.sender) ||
      !frame ||
      frame !== event.sender.mainFrame ||
      generation !== (diagnosticWindowGenerations.get(event.sender.id) ?? 0)
    )
      throw new Error("Project setup belongs to a previous window document");
  };
}
installFirstRunIPC(firstRun, {
  ipc: ipcMain,
  ready: () => workspace.ready(),
  held: () => !ordinaryStartupAllowed() || macUpdateWindows.active || workspace.macUpdateReserved,
  run: (work) => appWriters.run(work),
  capture: captureFirstRunCaller,
  connect: connectFirstRun,
});

ipcMain.on("orca:workspace.read", (event) => {
  event.returnValue = workspace.snapshot satisfies WorkspaceSnapshot;
});

/** The dialog behind File ▸ Open a store…, and behind the file-mode banner's own button. */
const OPEN_STORE_DIALOG = {
  title: "Open a store",
  // A workspace directory rather than a file: a store is `<workspace>/.orca`, and the
  // daemon is pointed at the workspace above it.
  properties: ["openDirectory" as const],
  buttonLabel: "Open read-only",
};

/**
 * Open a store read-only. A path from the renderer is used as given; without one the
 * directory is asked for here, because a dialog belongs to the process that owns the
 * window. Cancelling answers the workspace unchanged — a cancelled dialog is not an error
 * and must not be rendered as one.
 */
async function openStore(path?: string): Promise<WorkspaceSnapshot> {
  if (macUpdateWindows.active || firstRun.isBusy) throw new Error("Setup or update preparation is in progress");
  let chosen = path;
  if (chosen === undefined) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await (window
      ? dialog.showOpenDialog(window, OPEN_STORE_DIALOG)
      : dialog.showOpenDialog(OPEN_STORE_DIALOG));
    if (result.canceled) return workspace.snapshot;
    chosen = result.filePaths[0];
    if (chosen === undefined) return workspace.snapshot;
  }
  const release = await guardConnectionDrafts();
  if (!release) throw new Error("Save or discard pending edits before opening a store");
  try {
    const snapshot = await workspace.open(storeRoot(chosen));
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    return snapshot;
  } finally {
    release();
  }
}

handle("orca:workspace.open", (params: { path?: string }) => openStore(params.path));
handle("orca:workspace.connectLive", async () => {
  // Returning from a store to the launch-pinned target does not override the environment.
  if (workspace.connectionTarget.environmentOverride) {
    try {
      await targets.returnToEnvironment();
      return workspace.snapshot;
    } catch (error) {
      throw new Error(connectionFailure(error), { cause: error });
    }
  }
  send("orca:daemon.show", null);
  return workspace.snapshot;
});

const macUpdateWindows = new MacUpdateWindows({
  windows: () => BrowserWindow.getAllWindows(),
  ipc: ipcMain,
  createDeferred: createWindow,
});
// Trusted candidate/recovery/native owners are absent: production routing stays unavailable.
export const macUpdateGuards = new MacUpdateGuards(
  workspace,
  macUpdateWindows,
  () => firstRun.isBusy,
  (target) => workspace.captureMacUpdateDrainTarget(target),
);
// Source composition is present while the catalog/invitation authority and native
// acceptance are unresolved. Casey's activation hold is independent of that policy.
export const managedMacUpdates = createManagedMacUpdateApplication({
  control: join(dirname(appWriterRoot), basename(appWriterRoot) + "-native-replacement"),
  workspace,
  guards: macUpdateGuards,
  providers: createManagedMacNativeProviders({
    appRoot: appWriterRoot,
    control: join(dirname(appWriterRoot), basename(appWriterRoot) + "-native-replacement"),
    executable: () => app.getPath("exe"),
    helper: () => join(process.resourcesPath, "native/mac-validator/tools/deploy/native-mac-runtime.py"),
    intents: intentJournal,
    storage: safeStorage,
    permissions: () => systemPreferences,
  }),
  native: () => autoUpdater,
  activationAllowed: () => false,
  pauseAppWriters: pauseMacUpdateAppWriters,
});
const macUpdates = managedMacUpdates.application;
installMacUpdateIPC(macUpdates, {
  ipc: ipcMain,
  windows: () => BrowserWindow.getAllWindows(),
  epoch: () => workspace.connectionTarget.epoch,
  held: () => macUpdateWindows.active || firstRun.isBusy,
});
app.on("browser-window-created", (_event, window) => macUpdateWindows.track(window));

async function guardConnectionDrafts(): Promise<(() => void) | undefined> {
  const relinquish = macUpdateWindows.beginLegacy();
  if (!relinquish) return undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      send("orca:update.prepare", null);
    } finally {
      relinquish();
    }
  };
  const ids = BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed())
    .map((win) => win.webContents.id);
  if (ids.length === 0) return release;
  try {
    await prepareDrafts({
      ids,
      send: (nonce) => send("orca:update.prepare", nonce),
      listen: (callback) => {
        const listener = (event: Electron.IpcMainEvent, value: unknown) => {
          if (event.senderFrame === event.sender.mainFrame) callback(event.sender.id, value);
        };
        ipcMain.on("orca:update.prepared", listener);
        return () => {
          ipcMain.off("orca:update.prepared", listener);
        };
      },
    });
    return release;
  } catch {
    release();
    return undefined;
  }
}
let connectionDraftRelease: (() => void) | undefined;
const targets = new ConnectionTarget({
  explicitUrl: process.env.ORCA_DAEMON_URL,
  prepare: (url, source) => workspace.prepareConnection(url, source),
  save: (request) => {
    assertOrdinaryStartup();
    if (request !== null && typeof request === "object") preferences.saveDaemonProfile(request.profile);
    else preferences.saveDaemonUrl(request);
  },
  guard: async () => {
    connectionDraftRelease = await guardConnectionDrafts();
    return connectionDraftRelease !== undefined;
  },
  release: () => {
    connectionDraftRelease?.();
    connectionDraftRelease = undefined;
  },
});
ipcMain.on("orca:daemon.read", (event) => {
  event.returnValue = workspace.connectionTarget;
});
ipcMain.on("orca:daemon.show", () => send("orca:daemon.show", null));
ipcMain.on("orca:daemon.cancel", () => {
  targets.cancel();
  firstRunConnectionAttempt++;
});
ipcMain.handle("orca:daemon.connect", async (event, target: unknown, epoch: number) => {
  const url = connectionRequest(target);
  if (url === undefined) return { ok: false, message: "Invalid daemon URL" };
  try {
    assertOrdinaryStartup();
    if (macUpdateWindows.active || firstRun.isBusy) throw new Error("Setup or update preparation is in progress");
    await appWriters.run(async () => {
      assertOrdinaryStartup();
      if (url === null && !process.env.ORCA_WORKSPACE) {
        const check = captureFirstRunCaller(event, epoch);
        await connectFirstRun(check);
      } else await targets.connect(url);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: connectionFailure(error) };
  }
});

/** `orca:daemon.connect`'s argument: a URL, `null` (bundled), or `{ profile }`. */
function connectionRequest(value: unknown): DaemonConnectionRequest | undefined {
  if (value === null || typeof value === "string") return value;
  const parsed = z
    .object({ profile: z.string().max(64) })
    .strict()
    .safeParse(value);
  return parsed.success ? { profile: parsed.data.profile } : undefined;
}
async function profileResult<T>(run: () => T | Promise<T>): Promise<ProfileResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: connectionFailure(error) };
  }
}
const ProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** The profile the current connection runs through: never edited or removed underneath it. */
function profileInUse(id: string): boolean {
  return workspace.connectionTarget.profile?.id === id;
}
/* Updating the connected server (#879): its own updater, over the profile's own ssh. The
   daemon only said where the updater is; nothing installs through it. */
const serverUpdater = new ServerUpdater({
  version: app.getVersion(),
  connection: () => workspace.serverConnection,
  serverVersion: () => connection.current.orcaVersion,
  declared: () => connection.managedDeployment(),
  approved: (profile) => remoteProfiles.serverUpdater(profile),
  approve: (profile, approval) => remoteProfiles.approveServerUpdater(profile, approval),
  run: (command, onLine) => workspace.runOnServer(command, onLine),
  hello: async () => {
    const hello = await workspace.client.hello(`orca-app/${app.getVersion()}`);
    return { orcaVersion: hello.orcaVersion, ...(hello.identity ? { workspaceId: hello.identity.workspaceId } : {}) };
  },
  onProgress: (progress) => send("orca:server.update.progress", progress),
});
/* The renderer names a preview main made; ServerUpdater checks the connection still matches
   it. Anything malformed is refused before it gets there. */
const PreviewId = z.uuid();
const ServerUpdateRequestSchema = z.object({ preview: PreviewId }).strict();
const ServerUpdaterApprovalSchema = z
  .object({ preview: PreviewId, adapter: ServerPathSchema, manifest: ServerPathSchema })
  .strict();
ipcMain.handle("orca:server.read", () => serverUpdater.read());
ipcMain.handle("orca:server.approve", (_event, approval: unknown) => {
  const parsed = ServerUpdaterApprovalSchema.safeParse(approval);
  if (!parsed.success) return { ok: false, message: "Enter the updater's and the manifest's full paths." };
  try {
    return serverUpdater.approve(parsed.data);
  } catch (error) {
    return { ok: false, message: connectionFailure(error) };
  }
});
ipcMain.handle("orca:server.update", (_event, request: unknown) => {
  const parsed = ServerUpdateRequestSchema.safeParse(request);
  if (!parsed.success) return { status: "unavailable", reason: "Invalid update request" };
  return serverUpdater.update(parsed.data);
});

ipcMain.handle("orca:profiles.list", () => remoteProfiles.list());
// Synchronous, like `daemon.read`: the Machines surface draws from it on its first pass.
ipcMain.on("orca:fleet.read", (event) => {
  event.returnValue = fleet.snapshot;
});
/** Watch or stop watching a saved profile. Reads only; focusing one is `daemon.connect`. */
ipcMain.handle("orca:fleet.watch", (_event, id: unknown, watched: unknown) =>
  profileResult(() => {
    // A preference write: under the same fence as every other app writer, and not while
    // setup, an update's preparation or native recovery holds the app (#882).
    if (!ordinaryStartupAllowed() || macUpdateWindows.active || workspace.macUpdateReserved || firstRun.isBusy)
      throw new ConnectionRefusal("Setup or an update is in progress. Try again when it has finished.");
    return appWriters.run(() => watch(id, watched));
  }),
);
/** Save the choice of watched profiles. Watching reads only; focusing one is `daemon.connect`. */
function watch(id: unknown, watched: unknown): null {
  const valid = ProfileIdSchema.parse(id);
  if (typeof watched !== "boolean") throw new ConnectionRefusal("Say whether to watch the machine.");
  const current = preferences.read().watchedProfiles ?? [];
  if (watched) {
    if (!remoteProfiles.get(valid)) throw new ConnectionRefusal("That profile no longer exists.");
    if (!current.includes(valid) && current.length >= MAX_WATCHED_PROFILES)
      throw new ConnectionRefusal(`The app watches at most ${MAX_WATCHED_PROFILES} machines at once.`);
    if (!current.includes(valid)) preferences.saveWatchedProfiles([...current, valid]);
  } else preferences.saveWatchedProfiles(current.filter((other) => other !== valid));
  refreshFleet();
  return null;
}
ipcMain.handle("orca:profiles.save", (_event, input: unknown) =>
  profileResult(async () => {
    const id = typeof input === "object" && input !== null && "id" in input ? input.id : undefined;
    const save = () => {
      const saved = remoteProfiles.save(input);
      // A renamed or re-pointed watched profile reconnects under its new name.
      refreshFleet();
      return saved;
    };
    // A watched profile lets go of its tunnel while it is edited, then reconnects.
    return typeof id === "string" ? await fleet.whileReleased(id, save) : save();
  }),
);
ipcMain.handle("orca:profiles.remove", (_event, id: unknown) =>
  profileResult(async () => {
    const valid = ProfileIdSchema.parse(id);
    if (profileInUse(valid)) throw new ConnectionRefusal("Connect to another daemon before removing this profile.");
    // Revokes the credential on the server first, when it can be reached (#875).
    const revoke = await fleet.whileReleased(valid, async () => {
      const outcome = await remoteProfiles.remove(valid);
      const watched = preferences.read().watchedProfiles ?? [];
      if (watched.includes(valid)) preferences.saveWatchedProfiles(watched.filter((other) => other !== valid));
      refreshFleet();
      return outcome;
    });
    if (preferences.read().daemonProfile === valid) preferences.saveDaemonProfile(null);
    return { revoke };
  }),
);
ipcMain.handle("orca:profiles.forgetHostKey", (_event, id: unknown) =>
  profileResult(() => {
    const valid = ProfileIdSchema.parse(id);
    if (profileInUse(valid)) throw new ConnectionRefusal("Connect to another daemon before forgetting this key.");
    return fleet.whileReleased(valid, () => {
      remoteProfiles.forgetHostKey(valid);
      refreshFleet();
      const view = remoteProfiles.describe(valid);
      if (!view) throw new ConnectionRefusal("That profile no longer exists.");
      return view;
    });
  }),
);
ipcMain.handle("orca:profiles.useAutomaticSignIn", (_event, id: unknown) =>
  profileResult(() => {
    const valid = ProfileIdSchema.parse(id);
    if (profileInUse(valid)) throw new ConnectionRefusal("Connect to another daemon before changing its sign-in.");
    return fleet.whileReleased(valid, () => {
      const view = remoteProfiles.useAutomaticSignIn(valid);
      refreshFleet();
      return view;
    });
  }),
);
/**
 * Set up the profile's machine as a managed ORCA server (#881), at this app's own version. The
 * setup and the adapter it installs are this build's own files: shipped beside app.asar, or
 * read from the checkout in development.
 */
function serverSetupScripts(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "server-setup")
    : fileURLToPath(new URL("../../../../tools/deploy/", import.meta.url));
}
ipcMain.handle("orca:profiles.inspectServer", (_event, id: unknown) =>
  profileResult(async () => {
    const valid = ProfileIdSchema.parse(id);
    if (profileInUse(valid)) throw new ConnectionRefusal("Connect to another daemon before setting up this server.");
    const { inspection, outcome } = await remoteProfiles.inspectServer(valid, {
      version: app.getVersion(),
      scripts: serverSetupScripts(),
    });
    return inspection ? { inspection } : { setup: outcome as Exclude<typeof outcome, { kind: "inspected" }> };
  }),
);
ipcMain.handle("orca:profiles.setUpServer", (_event, id: unknown, confirmation: unknown) =>
  profileResult(async () => {
    const valid = ProfileIdSchema.parse(id);
    if (typeof confirmation !== "string" || confirmation.length > 64)
      throw new ConnectionRefusal("Confirm the server first.");
    if (profileInUse(valid)) throw new ConnectionRefusal("Connect to another daemon before setting up this server.");
    return remoteProfiles.setUpServer(valid, {
      version: app.getVersion(),
      scripts: serverSetupScripts(),
      confirmation,
    });
  }),
);
/** Main reads the file the person picks; the token goes from disk to the keychain slot only. */
ipcMain.handle("orca:profiles.importCredential", (event, id: unknown) =>
  profileResult(async () => {
    const valid = ProfileIdSchema.parse(id);
    // The picker can stay open while the profile is edited, removed or reset elsewhere:
    // the ticket makes the write below refuse unless it is still the same profile.
    const ticket = remoteProfiles.ticket(valid);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Import daemon credential",
      buttonLabel: "Import",
      properties: ["openFile"],
    };
    const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const path = picked.canceled ? undefined : picked.filePaths[0];
    if (!path) return null;
    let token: string;
    try {
      if (statSync(path).size > 8192) throw new Error("too large");
      token = readFileSync(path, "utf8");
    } catch {
      throw new ConnectionRefusal("That file could not be read as a daemon credential.");
    }
    return fleet.whileReleased(valid, () => {
      const view = remoteProfiles.importCredential(valid, token, ticket);
      refreshFleet();
      return view;
    });
  }),
);

/* Updates use their own IPC and never wait on daemon readiness to check/download. */
let windowsDraftRelease: (() => void) | undefined;
/** The restart guards: the Windows updater's, and the Linux `.deb` restart's (#905). */
const updateGuards: UpdateGuards = {
  prepareDrafts: async () => {
    const relinquish = macUpdateWindows.beginLegacy();
    if (!relinquish) throw new Error("Window draft preparation is busy");
    windowsDraftRelease = () => {
      try {
        send("orca:update.prepare", null);
      } finally {
        relinquish();
      }
    };
    await prepareDrafts({
      ids: BrowserWindow.getAllWindows().map((win) => win.webContents.id),
      send: (nonce) => send("orca:update.prepare", nonce),
      listen: (callback) => {
        const listener = (event: Electron.IpcMainEvent, value: unknown) => {
          if (event.senderFrame === event.sender.mainFrame) callback(event.sender.id, value);
        };
        ipcMain.on("orca:update.prepared", listener);
        return () => {
          ipcMain.off("orca:update.prepared", listener);
        };
      },
    });
  },
  prepareDaemon: (token, options) => workspace.prepareUpdate(token, options),
  stopDaemon: (token) => workspace.stopForUpdate(token),
  handOff: (token, from, to) => workspace.handOffForUpdate(token, from, to),
  resume: (token) => workspace.cancelUpdate(token),
  releaseDrafts: () => {
    windowsDraftRelease?.();
    windowsDraftRelease = undefined;
  },
};
const updates = new Updates(
  updateDriver(app.isPackaged, process.platform, process.arch),
  app.getVersion(),
  updateGuards,

  (state) => send("orca:update", state),
);
/* Check, download and install at a natural idle moment unless turned off (#566). */
const autoUpdates = new AutoUpdates({
  updates,
  enabled: () => preferences.read().updates.automatic,
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  now: () => Date.now(),
  timing: idleThreshold(process.env.ORCA_UPDATE_IDLE_SECONDS, process.env.ORCA_UPDATE_URL),
});
const storeSwitch = new StoreSwitchRestart({
  guards: updateGuards,
  target: () => workspace.storeSwitchTarget,
  settle: (token) => workspace.settleForStoreSwitch(token),
  request: (path, after, to) => writeStoreSwitchRequest(storeSwitchRequestFile, path, after, to),
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
  changed: (state) => send("orca:storeSwitch", state),
  enabled: sqliteSwitchEnabled,
});
storeSwitchRef.current = storeSwitch;
storeSwitch.refresh();
ipcMain.on("orca:storeSwitch.read", (event) => {
  event.returnValue = storeSwitch.state;
});
ipcMain.handle("orca:storeSwitch.restart", async (event) => {
  if (
    updates.state.phase === "restarting" ||
    linuxRestart?.state?.phase === "restarting" ||
    macUpdateWindows.active ||
    firstRun.isBusy ||
    !BrowserWindow.getAllWindows().some((win) => win.webContents === event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  )
    return {
      ok: false,
      error: { code: "UPDATE", message: "Switching the workspace storage is not available right now" },
    };
  return { ok: true, result: await storeSwitch.restart() };
});
ipcMain.on("orca:update.read", (event) => {
  event.returnValue = updates.state;
});
ipcMain.handle("orca:update.act", async (event, action: unknown) => {
  if (
    macUpdateWindows.active ||
    firstRun.isBusy ||
    !BrowserWindow.getAllWindows().some((win) => win.webContents === event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !isUpdateAction(action)
  ) {
    return { ok: false, error: { code: "UPDATE", message: "Invalid update request" } };
  }
  return { ok: true, result: await updates.act(action) };
});

/* The Linux .deb has no updater: a read-only release check and a notice (#888). Only the
   two main-built strings ever leave here: the renderer cannot name a URL or a command. */
const linuxReleases = isDebInstall(app.isPackaged, process.platform, process.execPath)
  ? new LinuxReleaseWatch({
      current: app.getVersion(),
      arch: process.arch,
      fetch: (url, init) => net.fetch(url, init),
      changed: (notice) => send("orca:linuxUpdate", notice ?? null),
    })
  : undefined;
/* The `.deb` upgraded beneath this app (#905): restart through the same guards as the Windows
   updater, hand the store to the installed version, and start it. */
const linuxRestart = isDebInstall(app.isPackaged, process.platform, process.execPath)
  ? new LinuxPackageRestart({
      current: app.getVersion(),
      readInstalled: () => readInstalledDebVersion(),
      verifyTarget: (installed) =>
        readInstalledDebVersion() === installed && executableMatchesPackage(process.execPath),
      guards: updateGuards,
      relaunch: () => {
        // process.execPath is /opt/ORCA/orca-desktop (isDebInstall), now the installed package's
        // binary, just verified against dpkg's checksum.
        app.relaunch({ execPath: process.execPath, args: process.argv.slice(1) });
        app.quit();
      },
      changed: (state) => send("orca:linuxRestart", state ?? null),
    })
  : undefined;
ipcMain.on("orca:linuxRestart.read", (event) => {
  event.returnValue = linuxRestart?.state ?? null;
});
ipcMain.handle("orca:linuxRestart.restart", async (event) => {
  if (
    !linuxRestart ||
    updates.state.phase === "restarting" ||
    macUpdateWindows.active ||
    firstRun.isBusy ||
    !BrowserWindow.getAllWindows().some((win) => win.webContents === event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  )
    return { ok: false, error: { code: "UPDATE", message: "No restart to finish an update is available" } };
  return { ok: true, result: (await linuxRestart.restart()) ?? null };
});
ipcMain.on("orca:linuxUpdate.read", (event) => {
  event.returnValue = linuxReleases?.notice ?? null;
});
ipcMain.handle("orca:linuxUpdate.act", async (event, action: unknown) => {
  const notice = linuxReleases?.notice;
  if (!notice || event.senderFrame !== event.sender.mainFrame || (action !== "open" && action !== "copy"))
    return { ok: false, error: { code: "UPDATE", message: "No release notice to act on" } };
  try {
    if (action === "copy") await clipboard.writeText(notice.installCommand);
    else await shell.openExternal(notice.releaseUrl);
  } catch {
    return {
      ok: false,
      error: {
        code: "UPDATE",
        message: action === "copy" ? "The install command could not be copied" : "The release page could not be opened",
      },
    };
  }
  return { ok: true, result: null };
});

/* ---------- deep links ---------- */

// Synchronous and draining: a link is delivered to one reader once (`./deep-link.ts`).
ipcMain.on("orca:deepLink.take", (event) => {
  event.returnValue = deepLinks.take();
});

/** Bring the window forward. A link that opens behind the browser is a link that was lost. */
function focusWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

deepLinks.subscribe((url) => {
  focusWindow();
  send("orca:deepLink", url);
});

/**
 * macOS, for a running app — and for one that is still starting, which is why the queue
 * holds a URL rather than requiring a window. `preventDefault` is required, or Electron
 * logs the event as unhandled.
 */
app.on("open-url", (event, url) => {
  event.preventDefault();
  deepLinks.offer(url);
});

/** Windows and Linux: the second launch's command line, courtesy of the single-instance lock. */
app.on("second-instance", (_event, argv) => {
  focusWindow();
  deepLinks.offer(urlFromArgv(argv));
});

ipcMain.on("orca:preferences.read", (event) => {
  event.returnValue = preferences.read();
});
ipcMain.handle("orca:preferences.write", (_event, patch: unknown): BridgeResult<Preferences> => {
  try {
    assertOrdinaryStartup();
    const next = preferences.write(patch);
    applyTheme(next.theme);
    autoUpdates.refresh();
    return { ok: true, result: next };
  } catch (e) {
    return { ok: false, error: { code: "PREFERENCES", message: e instanceof Error ? e.message : String(e) } };
  }
});

/* ---------- OS notifications ---------- */

/**
 * The Electron half of `./alerts.ts` (#162). One `Notification` per tier, kept so a second
 * ask can update the one already showing instead of stacking a second behind it, and a
 * badge that carries the same one number the title bar and the sidebar show.
 *
 * Nothing here decides *whether* to post: the tier table, the 60-second gate delay and the
 * unfocused escalation are all in the module, which is Electron-free so that they can be
 * tested with fake timers.
 */
const liveAlerts = new Map<AlertTier, Notification>();

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.isFocused());
}

/** Tell every open window a person clicked a notification, or that Attention should come forward. */
function activate(item: AlertItem | undefined): void {
  // The item as it is stated now if it is still open, else as it was posted (#882).
  const current = item && withFocus(alerts.current(item.id) ?? item);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("orca:alerts.activate", current ? { item: current } : {});
  }
}

/**
 * Whether the alert's machine is the focused one *now*, not when it was posted, and still on
 * the store the alert came from (#882). A stale alert routes nowhere: the window still comes
 * forward, but no card opens on a daemon the alert was never about.
 */
function withFocus(item: AlertItem): AlertItem | undefined {
  if (!fleetStarted) return item;
  // Read the focused connection's authority now, not as of its last state change.
  syncFocus();
  return fleet.routeAlert(item);
}

const alerts = createAlerts(
  {
    show: ({ tier, title, body, item }) => {
      if (!Notification.isSupported()) return;
      // Closed and replaced rather than mutated: `Notification.title` is writable but only
      // some platforms redraw a notification that is already on screen, and a stale count
      // is worse than a redraw.
      liveAlerts.get(tier)?.close();
      const notification = new Notification({ title, body });
      // Focus the window the person is coming back to, which is the one thing a click on a
      // notification is allowed to do — the *card* it opens is #165's route table, and
      // `activate` already carries the item a route will be built from.
      notification.on("click", () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        win?.show();
        activate(item);
      });
      liveAlerts.set(tier, notification);
      notification.show();
    },
    dismiss: (tier) => {
      liveAlerts.get(tier)?.close();
      liveAlerts.delete(tier);
    },
    badge: (count) => {
      // `setBadgeCount` is the dock on macOS, the launcher badge on Linux, and a no-op on
      // Windows (where the taskbar wants an overlay icon there is no artwork for yet).
      if (typeof app.setBadgeCount === "function") app.setBadgeCount(count);
    },
    isFocused: () => focusedWindow() !== undefined,
    // Inside the focused window only, and never `show()`: a permission ask may take the
    // person's attention where they already are, and may not move a window at them
    // (docs/design/20-attention-and-gates.md).
    focusAttention: (item) => {
      const current = withFocus(item);
      if (current) focusedWindow()?.webContents.send("orca:alerts.activate", { item: current });
    },
  },
  () => preferences.read().alerts,
);

ipcMain.on("orca:alerts.update", (_event, update: AlertsUpdate, epoch: number, authority: unknown) => {
  if (epoch !== workspace.connectionTarget.epoch) return;
  // The renderer stamps a report with the grant its reads ran under. One read before or
  // during a refusal is not shown, not even after a hello on the same store grants a new
  // one: only a report read under the current grant is (#882).
  if (typeof authority !== "number" || authority !== connection.authority) return;
  focusedAlerts = update;
  focusedAlertsGrant = authority;
  publishAlerts();
});

app.on("browser-window-focus", () => alerts.focusChanged(true));
app.on("browser-window-blur", () => alerts.focusChanged(false));

/* ---------- theme ---------- */

/** The theme the window is actually showing: the preference, or the OS when it is `system`. */
function resolveTheme(pref: ThemePreference): ThemeId {
  return pref === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : pref;
}

/**
 * The window's own background, painted before the renderer has loaded a byte of CSS. It is
 * `surface-canvas` from the resolved theme via `rawTokens`, the one place in the app a token
 * is read as a literal — a CSS variable cannot reach a native window.
 */
function canvasColor(theme: ThemeId): string {
  const color = rawTokens[theme]["surface-canvas"];
  if (!color) throw new Error(`@orca/design has no surface-canvas for theme ${theme}`);
  return color;
}

function applyTheme(pref: ThemePreference): void {
  // Chromium's `prefers-color-scheme` and the OS-drawn chrome (title bar, menus, dialogs)
  // follow themeSource, so an explicit choice reaches everything the renderer's attribute
  // cannot. The renderer sets `data-theme` for the same choice; the two never disagree.
  nativeTheme.themeSource = pref;
  const theme = resolveTheme(pref);
  const color = canvasColor(theme);
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(color);
    // The caption buttons are painted by the OS from the colours they were given, not from
    // the renderer's CSS, so a theme change has to reach them here too.
    if (hasTitleBarOverlay(process.platform)) win.setTitleBarOverlay(titleBarOverlay(theme));
  }
}

nativeTheme.on("updated", () => applyTheme(preferences.read().theme));

/* ---------- window ---------- */

function createWindow(): void {
  if (!macUpdateWindows.requestCreation()) return;
  const theme = resolveTheme(preferences.read().theme);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // No white flash on open in dark: the native background is the theme's canvas, and the
    // window stays hidden until the renderer has painted once.
    backgroundColor: canvasColor(theme),
    // The renderer draws the title bar; the OS keeps only its buttons (window-chrome.ts).
    ...windowChrome(process.platform, theme),
    ...windowIcon(process.platform, {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appRoot: fileURLToPath(new URL("../..", import.meta.url)),
    }),
    show: false,
    webPreferences: {
      // `.cjs`, because a sandboxed preload is evaluated as a plain script and this package
      // is `"type": "module"` — an ESM preload is silently refused and `window.orca` never
      // exists. `tsconfig.preload.json` is what emits it; src/preload/index.cts has the why.
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const diagnosticsWindowId = win.webContents.id;
  const advanceDiagnosticDocument = () => {
    diagnosticWindowGenerations.set(
      diagnosticsWindowId,
      (diagnosticWindowGenerations.get(diagnosticsWindowId) ?? 0) + 1,
    );
  };
  win.webContents.on("did-start-loading", () => {
    advanceDiagnosticDocument();
    diagnostics.revokeExportAuthority();
  });
  win.webContents.on("did-navigate", () => diagnostics.rendererDisposed());
  win.webContents.on("render-process-gone", () => {
    advanceDiagnosticDocument();
    diagnostics.rendererDisposed();
  });
  // Closing the last window installs a downloaded update first, when automatic updates are on
  // and the same guards as an idle install pass (#566). Refused, the window closes as usual.
  win.on("close", (event) => {
    if (BrowserWindow.getAllWindows().length !== 1 || !autoUpdates.installsOnClose) return;
    event.preventDefault();
    win.hide();
    void autoUpdates.installOnClose().then(
      (launched) => {
        if (!launched && !win.isDestroyed()) win.close();
      },
      () => {
        if (!win.isDestroyed()) win.close();
      },
    );
  });
  win.on("closed", () => {
    diagnosticWindowGenerations.delete(diagnosticsWindowId);
    diagnostics.revokeExportAuthority();
    diagnostics.rendererDisposed();
  });
  macUpdateWindows.track(win);
  // `ready-to-show` alone can leave the window hidden for good under Wayland (#858).
  revealWhenReady(win, {
    onReveal: (reason) => {
      if (reason !== "ready-to-show")
        console.warn(`[orca] window shown by the ${reason} fallback; no first paint was reported`);
    },
  });
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
}

if (!primary) {
  // Another copy holds the lock and has already been handed this process's command line,
  // so quitting here is what makes the link open over there.
  app.quit();
} else {
  void app.whenReady().then(async () => {
    if (macReplacement) await macReplacement.initialize([appWriterRoot]);
    if (!ordinaryStartupAllowed()) {
      createWindow();
      if (macReplacement?.resettable) void offerUpdateProtectionReset(macReplacement);
      else
        dialog.showErrorBox(
          "Native replacement recovery is required",
          "Protected startup remains closed. Keep the app, stores and OS keychain intact for explicit recovery.",
        );
      return;
    }
    void appWriters.run(async () => {
      await diagnosticsInitializer.initialize();
      observeDiagnostic("lifecycle", "app_started");
    });
    powerMonitor.on("suspend", observeSuspend);
    powerMonitor.on("resume", observeResume);
    powerObservationMounted = true;
    applyTheme(preferences.read().theme);
    /* Registering the scheme is what makes `orca://` reach this app at all. In development
       the executable is Electron itself and the app is an argument to it, which is what
       `protocolClientArgs` supplies; a packaged app is its own executable and needs none. */
    app.setAsDefaultProtocolClient(ORCA_SCHEME, process.execPath, [
      ...(protocolClientArgs(app.isPackaged, process.argv) ?? []),
    ]);
    /* The app had no menu at all until there was something to put in one. Replacing the
       default menu also replaces the Edit menu, which on macOS is where ⌘C lives — so
       `appMenuTemplate` restates the standard roles rather than dropping them. */
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate(
          process.platform,
          app.getName(),
          {
            openStore: () =>
              void openStore().catch((error: unknown) => {
                dialog.showErrorBox(
                  "Store could not be opened",
                  error instanceof Error ? error.message : "Try opening the store again.",
                );
              }),
            connectLive: () => send("orca:daemon.show", null),
          },
          rendererUrl !== undefined,
        ),
      ),
    );
    // Watched machines connect beside the focused one; none of them waits on it.
    fleetStarted = true;
    refreshFleet();
    // Not awaited: the shell paints while the daemon starts, and a call that arrives in
    // that second or two waits on `workspace.ready()` rather than going to the wrong URL.
    const startupEpoch = workspace.connectionTarget.epoch;
    void appWriters
      .run(() =>
        startFirstRunWorkspace(firstRun, {
          explicitTarget: Boolean(
            process.env.ORCA_DAEMON_URL ||
            process.env.ORCA_WORKSPACE ||
            preferences.read().daemonUrl ||
            workspace.connectionTarget.source === "saved",
          ),
          connectExplicit: () => workspace.connect(),
          assertCurrent: () => workspace.assertEpoch(startupEpoch),
        }),
      )
      .catch(() =>
        console.error(
          "The selected first-run workspace could not be verified or connected. Open Config to review setup.",
        ),
      );
    createWindow();
    linuxReleases?.start();
    linuxRestart?.start();
    autoUpdates.start();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop pushing at a process that is going.
app.on("before-quit", () => {
  stopDiagnosticObservations();
  targets.cancel();
  linuxReleases?.stop();
  linuxRestart?.stop();
  autoUpdates.stop();
  serverUpdater.stop();
  connection.close();
  alerts.close();
});

/**
 * A daemon this process started has to die with it: an orphan holding a port is the thing
 * a user notices the second time they launch the app. `will-quit` is the last event before
 * the process goes, and closing the workspace is asynchronous, so the first pass defers the
 * quit and the second — after `quitting` is set — lets it through.
 *
 * Two things here are deliberate, and both are about a quit that must not be able to hang:
 *
 * - **The re-quit is on the next tick.** Calling `app.quit()` from a continuation of the
 *   very dispatch that cancelled the quit is asking Electron to start a sequence it still
 *   believes it is in; `setImmediate` puts it after that sequence has unwound.
 * - **Closing is bounded.** A daemon that will not answer `stop()` already gets a SIGKILL
 *   with its own deadline, but nothing else in this path is allowed to hold the window
 *   open either: after `SHUTDOWN_DEADLINE_MS` the app leaves anyway. An app that will not
 *   close is a worse thing to ship than a stray child process, which the OS reaps.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;
let quitting = false;
app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  stopDiagnosticObservations();
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref?.());
  // Begin owned-child shutdown immediately, including when an RPC is stuck. A reserved
  // updater drain still keeps its child. App lifetime ownership waits for both paths.
  const workspaceClosed = workspace.close().then(
    () => true,
    () => false,
  );
  // Tunnels close after the workspace has let go of its client; nothing waits on them.
  void Promise.allSettled([workspaceClosed, fleet.close()]).finally(() =>
    remoteProfiles.close().catch(() => undefined),
  );
  void Promise.race([
    appWriters.pause(
      async () => {
        if (!(await workspaceClosed)) throw new Error("Workspace shutdown did not settle");
        await diagnosticsInitializer.close();
      },
      async () => macReplacement?.close(),
    ),
    deadline,
  ]).finally(() => setImmediate(() => app.quit()));
});
