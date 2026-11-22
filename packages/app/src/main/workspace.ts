/**
 * Owns the app's daemon clients, streams and bundled processes. Startup and read-only
 * store opening fail closed without an explicit target; ConnectionTarget stages live URL
 * replacements through prepareConnection without detaching the current stream.
 *
 * ready() gates startup/file-mode transitions. Resource IPC also validates the caller's
 * connection epoch before dispatch and after completion, so a queued write or late reply
 * cannot cross onto another target. Identity changes and daemon boots advance that epoch.
 * Bundled execution stays alive while the user views an external daemon and is reused on
 * return. Credentials and lifecycle dependencies stay in main; the renderer sees only the
 * nonsecret target snapshot. Electron-free so the transitions can be tested directly.
 */
import { UpdatePreflightRefusal } from "./updates.js";
import { daemonEndpoint, type DaemonConnectionRequest, type DaemonTargetSnapshot } from "../daemon-connection.js";
import type { ProfileLease } from "./remote-profiles.js";
import { serverKey } from "./remote-credentials.js";
import type { RemoteCommand } from "@orca/protocol/remote-access";
import { ConnectionRefusal, type ConnectionCandidate } from "./connection-target.js";
import { FirstRunRefusal } from "./first-run/refusal.js";
import { handOffStoreForUpdate, withdrawUpdateHandoff } from "./first-run/update-handoff.js";
import type { UpdateHandoff } from "@orca/protocol/update-handoff";
import {
  MAINTENANCE_RUNTIME_METHOD,
  RuntimeMaintenanceResultSchema,
  RuntimeDrainResultSchema,
  type RuntimeDrainResult,
  type RuntimeMaintenanceResult,
  type HelloResult,
} from "@orca/protocol";
import { resolve, join } from "node:path";
import { DaemonClient as AuthenticatedClient } from "../client/daemon-client.js";
import { isLoopbackDaemon, LocalDaemonToken, type DaemonTokenSource } from "../client/auth.js";
import { appSpeaks } from "../client/protocol-window.js";
import type { MacDrainOwner } from "./mac-update-drain.js";
import type { MacUpdateTarget } from "./mac-updates.js";
import type { WorkspaceSnapshot, WorkspaceSource } from "../bridge.js";
import type { DaemonClient } from "../client/daemon-client.js";
import type { DaemonSubscription } from "../client/subscription.js";
import type { StreamTransport } from "../client/stream-transport.js";
import type { BundledDaemon, DaemonExit } from "./daemon-process.js";
import type { MacOwnedStopResult } from "./mac-update-restart.js";
import {
  assertNoFirstRunOwnership,
  FirstRunOwnershipRefusal,
  reserveFirstRunOwnership,
  type FirstRunOwnership,
} from "./first-run/ownership.js";

/** A bundled daemon left running while another daemon is focused. Nonsecret: a token file path, not a token. */
export interface ParkedBundled {
  url: string;
  tokenFile?: string;
  workspace: string;
}

/** Where a workspace to serve comes from, and whether it is read-only. */
export interface WorkspaceTarget {
  /** The directory `orca serve --cwd` is given; it reads `<path>/.orca`. */
  path: string;
  readOnly: boolean;
  source: WorkspaceSource;
}

type FirstRunCandidate = ConnectionCandidate & {
  expectedProcessId: number;
  validateActivation(hello: HelloResult): void;
};
interface WindowsUpdateAttempt {
  token: string;
  daemon: BundledDaemon | undefined;
  ownership: FirstRunOwnership | undefined;
  firstRun: { path: string; identity: NonNullable<HelloResult["identity"]> } | undefined;
  client: DaemonClient;
  epoch: number;
  identity: HelloResult["identity"];
  processId: number | undefined;
  storeDir: string | undefined;
  target: WorkspaceTarget;
  stopAttempted: boolean;
  /** The store handoff written for the version being installed, kept to withdraw exactly it (#897). */
  handedOff: UpdateHandoff | undefined;
  recovering: boolean;
  busy: boolean;
}

export interface WorkspaceDeps {
  /** Main creates this closed before any protected-state bootstrap or producer work. */
  updateBootstrap?: { readonly ordinaryAllowed: boolean; readonly existingWorkAllowed?: boolean };
  /** The bundled daemon's entry point, or undefined in a development build. */
  findEntry: () => string | undefined;
  /** Start `orca serve` on a workspace. `readOnly` becomes the `--read-only` flag. */
  start: (options: {
    entry: string;
    cwd: string;
    readOnly: boolean;
    configPath?: string;
    firstRunToken?: string;
    onExit: (exit: DaemonExit) => void;
  }) => Promise<BundledDaemon>;
  /** Build the read client for a daemon URL. */
  client: (
    url: string,
    options: {
      workspace: string;
      bundled: boolean;
      tokenFile?: string;
      auth?: DaemonTokenSource;
      /** A saved profile's connections: every request and the socket go over these streams. */
      transport?: StreamTransport;
    },
  ) => DaemonClient;
  /** Open the push stream on a client, wired to the broadcast and the connection machine. */
  subscribe: (client: DaemonClient) => DaemonSubscription;
  /**
   * Tell the connection machine the daemon on the other end is about to be a different
   * one, and whether it is a read-only replay. `ConnectionMachine.reset`.
   */
  onSwitch: (fileMode: boolean) => void;
  /** Push the new workspace to every window. */
  onSnapshot: (snapshot: WorkspaceSnapshot) => void;
  /**
   * There is no daemon on the other end and none is coming: the file-mode daemon would not
   * start, so nothing was connected to instead (#269). The connection machine is told the
   * daemon is gone — `ConnectionMachine.daemonExited`, the one input that already means
   * exactly this — so the status bar reads `disconnected` rather than describing a daemon
   * the app never reached. The reason is the same sentence `onError` puts on the console.
   */
  onDaemonGone: (reason: string) => void;
  /** A daemon that would not start, for the console. */
  onError?: (message: string, cause: unknown) => void;
  /**
   * `ORCA_DAEMON_URL`. It wins outright for the default connection — someone who points the
   * app at a daemon on another machine has said what they want, and starting a second one
   * beside it would only confuse which store is on screen.
   */
  explicitUrl?: string | undefined;
  /** A development endpoint used only with an explicitly supplied workspace. */
  savedUrl?: string | undefined;
  /** The saved SSH profile (#874); used when there is no environment override or saved URL. */
  savedProfile?: string | undefined;
  /** Open a profile's tunnel and credential. Absent: profiles are refused. */
  openProfile?: (id: string) => Promise<ProfileLease>;
  onTarget?: (target: DaemonTargetSnapshot) => void;
  /** The parked bundled daemon changed (#882): started being, or stopped being, parked. */
  onParked?: (parked: ParkedBundled | undefined) => void;
  defaultUrl: string;
  /** Explicit environment workspace only. No home-directory bootstrap. */
  defaultPath: () => string | undefined;
  setupBusy?: () => boolean;
  /** Injected for tests; default to the first-run journal's update handoff (#897). */
  handOffStore?: (path: string, from: string, to: string) => UpdateHandoff;
  withdrawHandoff?: (path: string, issued: UpdateHandoff) => boolean;
  /** Saved-receipt verification must bind this exact path before requesting its candidate. */
  recoverFirstRun?: (
    path: string,
    check: () => void,
    prepare: (path: string) => Promise<FirstRunCandidate>,
  ) => Promise<void>;
  /** Test seam; production uses the store-local durable reservation. */
  reserveFirstRunOwnership?: (path: string) => FirstRunOwnership;
}

/**
 * The workspace above a chosen directory. Choosing `.orca` itself is the obvious mistake —
 * it is the directory a person sees when they go looking for a store — and pointing the
 * daemon at it would have it read `<chosen>/.orca/.orca` and find nothing there. Both
 * separators are checked because a store copied from another machine keeps its path.
 */
export function storeRoot(chosen: string): string {
  const trimmed = chosen.replace(/[/\\]$/, "");
  return /[/\\]\.orca$/.test(trimmed) ? trimmed.slice(0, trimmed.length - ".orca".length - 1) : trimmed;
}

/** Nothing bundled means nothing to start; the message says what to do instead. */
export class NoBundledDaemonError extends Error {
  override readonly name = "NoBundledDaemonError";
  constructor(path: string) {
    super(
      `this build has no bundled daemon to open a store with; run 'orca serve --read-only --cwd ${path}' and set ORCA_DAEMON_URL to it`,
    );
  }
}

export class Workspace {
  private readonly deps: WorkspaceDeps;

  private clientNow: DaemonClient;
  private target: WorkspaceTarget;
  private daemon: BundledDaemon | undefined;
  private stream: DaemonSubscription | undefined;
  /** The switch in flight, if there is one. `ready()` is the whole reason it is held. */
  private pending: Promise<void> | undefined;
  private closed = false;
  private updating = false;
  private windowsUpdate: WindowsUpdateAttempt | undefined;
  private epoch = 0;
  private identity: HelloResult["identity"];
  private verifiedHello: HelloResult | undefined;
  private observedHello = false;
  private source: DaemonTargetSnapshot["source"] = "development";
  private savedUrl: string | undefined;
  private savedProfile: string | undefined;
  /** The profile tunnel the current client goes through, if any. Released when it stops being current. */
  private lease: ProfileLease | undefined;
  /** Keep a live bundled daemon running when the UI leaves it; switching is not cancellation. */
  private parked: BundledDaemon | undefined;
  private get parkedDefault(): BundledDaemon | undefined {
    return this.parked;
  }
  /** Every change is told to `onParked`, so the Machines surface can watch the parked daemon (#882). */
  private set parkedDefault(next: BundledDaemon | undefined) {
    if (next === this.parked) return;
    this.parked = next;
    this.deps.onParked?.(this.parkedBundled);
  }
  private candidates = new Set<BundledDaemon>();
  private connectionPreparations = new Set<symbol>();
  private macUpdateHold: symbol | undefined;
  private macUpdateFrozen = false;
  /** Process-local restart fence. No replacement/admission may reopen after a stop attempt. */
  private macUpdateStopping = false;
  private firstRunHold: symbol | undefined;
  private durableFirstRunOwners = new WeakMap<BundledDaemon, FirstRunOwnership>();
  private firstRunOwners = new WeakMap<
    BundledDaemon,
    { path: string; identity: NonNullable<HelloResult["identity"]> }
  >();

  /** Setup cannot change durable ownership while updater completion calls remain open. */
  get macUpdateReserved(): boolean {
    return this.macUpdateHold !== undefined;
  }

  /** Main-only facts for the authenticated managed process. A held update may keep
   * checking this same owner after its clean stop; no replacement is discovered. */
  captureMacUpdateOwnerFacts(expected: MacUpdateTarget) {
    const daemon = this.daemon,
      client = this.clientNow,
      hello = this.verifiedHello;
    const directory = resolve(this.target.path);
    const current = () =>
      !this.closed &&
      !this.pending &&
      !this.updating &&
      !this.firstRunHold &&
      !this.connectionPreparations.size &&
      !this.candidates.size &&
      !this.parkedDefault &&
      !this.deps.setupBusy?.() &&
      this.source === "bundled" &&
      !this.target.readOnly &&
      this.daemon === daemon &&
      this.clientNow === client &&
      this.verifiedHello === hello &&
      this.epoch === expected.epoch &&
      this.identity?.workspaceId === expected.workspaceId &&
      this.identity.instanceId === expected.instanceId &&
      resolve(this.target.path) === directory &&
      daemon?.pid === hello?.processId &&
      hello !== undefined &&
      appSpeaks(hello.protocol) &&
      hello?.identity?.workspaceId === expected.workspaceId &&
      hello.identity.instanceId === expected.instanceId &&
      hello.storeDir === join(directory, ".orca");
    if (!daemon || !hello || !Number.isSafeInteger(daemon.pid) || !daemon.pid || !current()) return undefined;
    return Object.freeze({
      target: Object.freeze({ ...expected }),
      previousTarget: Object.freeze({
        workspaceId: expected.workspaceId,
        instanceId: expected.instanceId,
        processId: daemon.pid,
      }),
      configDir: directory,
      storeDir: hello.storeDir!,
      check: current,
    });
  }

  /** Main-only saved-config binding over the exact surviving first-run owner.
   * Config bytes may have changed after an explicit Config save; rebind checks the old/new hashes.
   * This captures no alternate target and creates no process or permission grant.
   */
  captureFirstRunConfiguration(path: string) {
    const daemon = this.daemon;
    const client = this.clientNow;
    const epoch = this.epoch;
    const identity = this.identity;
    const owner = daemon && this.firstRunOwners.get(daemon);
    const durable = daemon && this.durableFirstRunOwners.get(daemon);
    if (
      !daemon ||
      !owner ||
      !durable?.rebindConfig ||
      !identity ||
      owner.path !== path ||
      owner.identity.workspaceId !== identity.workspaceId ||
      owner.identity.instanceId !== identity.instanceId
    )
      throw new FirstRunOwnershipRefusal();
    const check = () => {
      this.assertEpoch(epoch);
      if (
        this.closed ||
        this.updating ||
        this.macUpdateStopping ||
        this.macUpdateHold ||
        this.firstRunHold ||
        this.pending ||
        this.connectionPreparations.size ||
        this.daemon !== daemon ||
        daemon.exited === true ||
        this.clientNow !== client ||
        this.source !== "bundled" ||
        this.target.readOnly ||
        this.target.path !== path ||
        this.identity?.workspaceId !== identity.workspaceId ||
        this.identity.instanceId !== identity.instanceId
      )
        throw new FirstRunOwnershipRefusal();
    };
    check();
    return {
      client: client.withCapturedAuthentication(),
      check,
      rebind: (expectedHash: string, savedHash: string) => {
        check();
        durable.rebindConfig!(expectedHash, savedHash);
        check();
      },
    };
  }

  /** Capture a locally owned target without sending maintenance or stopping any process.
   * The reservation fences connection changes through authentication and subsequent checks.
   * It does not certify idle execution, authorize installation or reopen remote admission.
   */
  async captureMacUpdateTarget(expected: MacUpdateTarget): Promise<
    | {
        readonly target: Readonly<MacUpdateTarget>;
        readonly runtimeTarget: MacDrainOwner["runtimeTarget"];
        freeze(this: void): boolean;
        maintenanceDrain?: (
          action: "drain" | "defer",
          token: string,
          signal?: AbortSignal,
        ) => Promise<RuntimeDrainResult>;
        check(this: void): boolean;
        release(this: void): void;
        stopOwned(
          signal: AbortSignal,
          operationMs: number,
          draftsValid: () => boolean,
          token: string,
        ): Promise<MacOwnedStopResult>;
        maintenanceRuntime?: (
          action: "prepare" | "resume",
          token: string,
          signal?: AbortSignal,
        ) => Promise<RuntimeMaintenanceResult>;
      }
    | undefined
  > {
    const daemon = this.daemon;
    const client = this.clientNow;
    const identity = this.identity;
    const epoch = this.epoch;
    if (
      this.closed ||
      this.updating ||
      this.macUpdateHold ||
      this.pending ||
      this.firstRunHold ||
      this.deps.setupBusy?.() ||
      this.connectionPreparations.size ||
      this.candidates.size ||
      this.parkedDefault ||
      this.source !== "bundled" ||
      this.target.readOnly ||
      !daemon ||
      !identity ||
      !Number.isSafeInteger(daemon.pid) ||
      !daemon.pid ||
      daemon.pid < 1 ||
      !daemon.tokenFile ||
      !isLoopbackDaemon(daemon.url) ||
      daemonEndpoint(daemon.url) !== this.endpoint() ||
      expected.epoch !== epoch ||
      expected.workspaceId !== identity.workspaceId ||
      expected.instanceId !== identity.instanceId
    )
      return undefined;
    const processId = daemon.pid;
    const ownedStop = daemon.stopForMacUpdate;
    const hold = Symbol("mac-update-target");
    this.macUpdateHold = hold;
    const target = Object.freeze({ epoch, workspaceId: identity.workspaceId, instanceId: identity.instanceId });
    const check = () =>
      this.macUpdateHold === hold &&
      !this.closed &&
      !this.pending &&
      !this.updating &&
      !this.parkedDefault &&
      !this.connectionPreparations.size &&
      this.daemon === daemon &&
      daemon.pid === processId &&
      this.clientNow === client &&
      this.epoch === epoch &&
      this.identity?.workspaceId === target.workspaceId &&
      this.identity.instanceId === target.instanceId &&
      this.source === "bundled" &&
      !this.target.readOnly;
    const release = () => {
      if (!this.macUpdateStopping && this.macUpdateHold === hold) {
        this.macUpdateHold = undefined;
        this.macUpdateFrozen = false;
      }
    };
    let captured = false;
    try {
      const authenticated = new AuthenticatedClient(daemon.url, fetch, {
        auth: new LocalDaemonToken({ url: daemon.url, tokenFile: daemon.tokenFile, env: {} }),
        requireAuthentication: true,
      });
      const hello = await authenticated.hello("orca-app/mac-update-guard", false);
      if (
        !check() ||
        hello.processId !== processId ||
        hello.identity?.workspaceId !== target.workspaceId ||
        hello.identity.instanceId !== target.instanceId ||
        !appSpeaks(hello.protocol) ||
        hello.storeDir !== join(resolve(this.target.path), ".orca")
      )
        return undefined;
      captured = true;
      const runtime = async (action: "prepare" | "resume", token: string, signal?: AbortSignal) => {
        if (!check() || (action === "resume" && this.macUpdateStopping)) throw new Error("Owned update target changed");
        const result = await authenticated.call(
          MAINTENANCE_RUNTIME_METHOD,
          {
            action,
            token,
            target: { workspaceId: target.workspaceId, instanceId: target.instanceId, processId },
          },
          RuntimeMaintenanceResultSchema,
          false,
          signal,
          false,
        );
        if (
          !check() ||
          result.target.workspaceId !== target.workspaceId ||
          result.target.instanceId !== target.instanceId ||
          result.target.processId !== processId
        )
          throw new Error("Owned runtime proof target changed");
        return result;
      };
      const runtimeTarget = Object.freeze({
        workspaceId: target.workspaceId,
        instanceId: target.instanceId,
        processId,
      });
      const drain = async (action: "drain" | "defer", token: string, signal?: AbortSignal) => {
        if (!check() || this.macUpdateStopping) throw new Error("Owned drain target changed");
        const result = await authenticated.call(
          MAINTENANCE_RUNTIME_METHOD,
          { action, token, target: runtimeTarget },
          RuntimeDrainResultSchema,
          false,
          signal,
          false,
        );
        if (
          !check() ||
          result.target.workspaceId !== target.workspaceId ||
          result.target.instanceId !== target.instanceId ||
          result.target.processId !== processId
        )
          throw new Error("Owned drain proof changed");
        return result;
      };
      let stop: Promise<MacOwnedStopResult> | undefined;
      const stopOwned = (
        signal: AbortSignal,
        operationMs: number,
        draftsValid: () => boolean,
        token: string,
      ): Promise<MacOwnedStopResult> => {
        if (stop) return stop;
        if (!check() || !draftsValid() || !ownedStop || !hello.methods?.includes(MAINTENANCE_RUNTIME_METHOD))
          return Promise.resolve({ outcome: "refused" });
        this.macUpdateStopping = true;
        // Reserve before async callbacks. Close the old reconnect stream; never seek a replacement.
        stop = Promise.resolve().then(async () => {
          try {
            this.stream?.close();
            this.stream = undefined;
            return await ownedStop(
              { workspaceId: target.workspaceId, instanceId: target.instanceId, processId },
              {
                check: () => check() && draftsValid(),
                proof: (_target, bounded) => runtime("prepare", token, bounded),
              },
              operationMs,
              signal,
            );
          } catch {
            return { outcome: "unknown" };
          }
        });
        return stop;
      };
      return {
        target,
        runtimeTarget,
        freeze: () => {
          if (!check()) return false;
          this.macUpdateFrozen = true;
          return true;
        },
        check,
        release,
        stopOwned,
        ...(hello.methods?.includes(MAINTENANCE_RUNTIME_METHOD)
          ? {
              maintenanceRuntime: runtime,
              maintenanceDrain: drain,
            }
          : {}),
      };
    } finally {
      // No remote boundary was changed: releasing this local reservation is safe even
      // when the hello result is lost or refused. Never resume an unverified daemon.
      if (!captured) release();
    }
  }

  /** Capture keeps existing completion IPC usable; final freeze is owned by held drain proof. */
  async captureMacUpdateDrainTarget(expected: MacUpdateTarget): Promise<MacDrainOwner | undefined> {
    const owned = await this.captureMacUpdateTarget(expected);
    if (!owned) return undefined;
    if (!owned.maintenanceRuntime || !owned.maintenanceDrain) {
      owned.release();
      return undefined;
    }
    const runtime = owned.maintenanceRuntime,
      drain = owned.maintenanceDrain;
    return {
      target: owned.target,
      runtimeTarget: owned.runtimeTarget,
      check: owned.check,
      release: owned.release,
      freeze: owned.freeze,
      runtime: (action, token, signal) =>
        action === "drain" || action === "defer" ? drain(action, token, signal) : runtime(action, token, signal),
      stopOwned: (signal, operationMs, token) =>
        owned.stopOwned(signal, operationMs, () => this.macUpdateFrozen, token),
    };
  }

  get connectionTarget(): DaemonTargetSnapshot {
    return {
      epoch: this.epoch,
      url: this.endpoint(),
      source: this.source,
      environmentOverride: Boolean(this.deps.explicitUrl),
      ...(this.identity ? { identity: this.identity } : {}),
      ...(this.lease
        ? {
            profile: {
              id: this.lease.profile.id,
              name: this.lease.profile.name,
              destination: this.lease.profile.destination,
            },
          }
        : {}),
    };
  }

  /** A saved target (URL or profile) replaces the bundled default. */
  private hasSavedTarget(): boolean {
    return Boolean(this.savedUrl || this.savedProfile);
  }

  /**
   * Run one command on the server the current SSH profile reaches (#879), over that
   * profile's own pinned ssh. `undefined` when the current connection is not a profile.
   */
  runOnServer(
    command: readonly string[],
    onLine: (stream: "stdout" | "stderr", line: string) => void,
  ): { profile: string; command: RemoteCommand } | undefined {
    const lease = this.lease;
    if (!lease) return undefined;
    return { profile: lease.profile.id, command: lease.exec(command, onLine) };
  }

  /**
   * The verified server a profile connection reaches (#357), stable across tunnel reconnects:
   * the profile, the SSH server and jump chain its pins vouch for (`serverKey`), the daemon's
   * remote port and the pins the lease's tunnel sealed (never the last-observed host key, which
   * another stream's ssh output can update). Absent for a direct connection, and while the
   * lease has no sealed pins that still hold.
   */
  get profileEndpoint(): { id: string; server: string; remotePort: number; pins: string } | undefined {
    const lease = this.lease;
    const pins = lease?.pinnedKeys();
    if (!lease || !pins) return undefined;
    return { id: lease.profile.id, server: serverKey(lease.profile), remotePort: lease.profile.remotePort, pins };
  }

  /**
   * The current connection, as a server update is bound to it (#879): the epoch, and for an
   * SSH profile its id and the host key its tunnel authenticated, and the daemon's workspace.
   */
  get serverConnection(): { epoch: number; profile?: string; hostKey?: string; workspaceId?: string } {
    const lease = this.lease;
    const hostKey = lease?.hostKey();
    return {
      epoch: this.epoch,
      ...(lease ? { profile: lease.profile.id } : {}),
      ...(hostKey ? { hostKey } : {}),
      ...(this.identity ? { workspaceId: this.identity.workspaceId } : {}),
    };
  }

  /** Make `next` the current profile lease and let go of the previous one. */
  private adoptLease(next: ProfileLease | undefined): void {
    const previous = this.lease;
    this.lease = next;
    if (previous && previous !== next)
      void previous.release().catch(() => this.deps.onError?.("The previous SSH tunnel did not close", undefined));
  }

  private endpoint(): string {
    try {
      return daemonEndpoint(this.clientNow.url);
    } catch {
      // A malformed launch override must not throw through synchronous preload IPC.
      return "";
    }
  }

  assertEpoch(epoch: number): void {
    if (this.updating || this.macUpdateStopping || this.macUpdateFrozen || !this.existingDispatchAllowed())
      throw new Error("Update restart admission is closed");
    if (epoch !== this.epoch) throw new Error("The daemon changed. This operation belongs to the previous connection.");
  }

  /** Every boot boundary also resets scopes: a restored history may have rewound. */
  observeHello(client: DaemonClient, hello: HelloResult): void {
    if (this.macUpdateStopping) return;
    if (client !== this.clientNow) return;
    this.verifiedHello = hello;
    const next = hello.identity;
    if (!this.observedHello) {
      // The switch already fenced the old target. Its first verified identity enriches
      // that same epoch; later boot/identity changes still invalidate outstanding work.
      this.observedHello = true;
      this.identity = next;
      this.deps.onTarget?.(this.connectionTarget);
      return;
    }
    if (
      !next ||
      !this.identity ||
      next.workspaceId !== this.identity.workspaceId ||
      next.instanceId !== this.identity.instanceId
    ) {
      this.identity = next;
      this.epoch += 1;
      this.deps.onTarget?.(this.connectionTarget);
    }
  }

  /** Receipt verification belongs to FirstRunSetup; this checks the exact live child and identity. */
  currentFirstRun(path: string): boolean {
    const owner = this.daemon && this.firstRunOwners.get(this.daemon);
    if (owner?.path === path && this.daemon) {
      const reservation = this.durableFirstRunOwners.get(this.daemon);
      if (!reservation) throw new FirstRunOwnershipRefusal();
      reservation.check();
    }
    return Boolean(
      !this.closed &&
      !this.macUpdateStopping &&
      this.daemon?.exited !== true &&
      owner &&
      this.identity &&
      this.verifiedHello &&
      appSpeaks(this.verifiedHello.protocol) &&
      this.verifiedHello.processId === this.daemon?.pid &&
      this.verifiedHello.storeDir === join(path, ".orca") &&
      (["runs.read", "runs.control", "runs.subscribe"] as const).every((capability) =>
        this.verifiedHello?.capabilities.includes(capability),
      ) &&
      owner.path === path &&
      this.target.path === path &&
      !this.target.readOnly &&
      this.source === "bundled" &&
      owner.identity.workspaceId === this.identity.workspaceId &&
      owner.identity.instanceId === this.identity.instanceId,
    );
  }

  /** Stage only a bundled owned child for this exact reviewed workspace; never seek a default port. */
  async prepareFirstRunConnection(path: string): Promise<FirstRunCandidate> {
    return this.firstRunConnection(path);
  }

  private async firstRunConnection(path: string, recovery?: WindowsUpdateAttempt): Promise<FirstRunCandidate> {
    const checkRecovery = () => {
      if (!recovery) return;
      this.checkWindowsUpdate(recovery);
      if (!recovery.busy || !recovery.recovering || path !== recovery.firstRun?.path)
        throw new FirstRunOwnershipRefusal();
    };
    checkRecovery();
    if (this.deps.updateBootstrap?.ordinaryAllowed === false) throw new Error("Update replacement bootstrap is closed");
    // Setup shows only FirstRunRefusal text, so this is one: without it the person sees a generic refusal and
    // no hint that an environment variable, not their folders, is what stopped Connect.
    if (this.deps.explicitUrl)
      throw new FirstRunRefusal(
        "ORCA_DAEMON_URL is set, so this launch uses that daemon and setup cannot start its own. Unset ORCA_DAEMON_URL, restart ORCA, then connect again.",
      );
    if (
      this.closed ||
      (this.updating && !recovery) ||
      this.macUpdateHold ||
      this.firstRunHold ||
      this.pending ||
      this.connectionPreparations.size
    )
      throw new Error("Workspace is busy");
    if (!path || resolve(path) !== path) throw new ConnectionRefusal("A canonical selected workspace is required.");
    const hold = Symbol("first-run-candidate");
    this.firstRunHold = hold;
    const epoch = this.epoch;
    let daemon: BundledDaemon | undefined;
    let exited = false;
    let settled = false;
    let reuse = false;
    let startupAttempted = false;
    let ownership: FirstRunOwnership | undefined;
    const release = () => {
      if (this.firstRunHold === hold) this.firstRunHold = undefined;
    };
    try {
      for (const owned of [this.daemon, this.parkedDefault]) {
        if (!owned) continue;
        const owner = this.firstRunOwners.get(owned);
        if (owner?.path === path) {
          daemon = owned;
          reuse = true;
          ownership = this.durableFirstRunOwners.get(owned);
          if (!ownership) throw new FirstRunOwnershipRefusal();
          ownership.check();
          break;
        }
        // Never start a competing writer for an active store of unknown first-run identity.
        if (owned === this.daemon && this.target.path === path)
          throw new ConnectionRefusal("The selected workspace already has an unverified owned daemon.");
      }
      if (!reuse && this.parkedDefault)
        throw new ConnectionRefusal("Return to the parked bundled workspace before selecting another.");
      if (!daemon) {
        const entry = this.deps.findEntry();
        if (!entry) throw new NoBundledDaemonError(path);
        ownership = (this.deps.reserveFirstRunOwnership ?? reserveFirstRunOwnership)(path);
        ownership.check();
        startupAttempted = true;
        daemon = await this.deps.start({
          entry,
          cwd: path,
          readOnly: false,
          configPath: join(path, "orca.config.yaml"),
          ...(ownership.launchToken ? { firstRunToken: ownership.launchToken() } : {}),
          onExit: () => {
            exited = true;
            if (daemon) this.recordFirstRunExit(daemon);
            if (this.daemon === daemon) this.daemonExited();
            if (this.parkedDefault === daemon) this.parkedDefault = undefined;
          },
        });
        this.candidates.add(daemon);
        this.durableFirstRunOwners.set(daemon, ownership);
        ownership.attach(daemon);
      }
      const owned = daemon;
      const processId = owned.pid;
      if (
        !Number.isSafeInteger(processId) ||
        !processId ||
        processId < 1 ||
        typeof owned.exited !== "boolean" ||
        owned.tokenFile !== join(path, "auth", "local-client.token")
      )
        throw new ConnectionRefusal("The bundled daemon did not supply owned process and authentication metadata.");
      const client = this.deps.client(owned.url, { workspace: path, bundled: true, tokenFile: owned.tokenFile });
      const check = () => {
        ownership?.check();
        if (recovery) checkRecovery();
        else this.assertEpoch(epoch);
        if (
          settled ||
          exited ||
          owned.exited === true ||
          this.closed ||
          (this.updating && !recovery) ||
          this.macUpdateHold ||
          this.pending ||
          this.firstRunHold !== hold
        )
          throw new Error("Workspace changed while connecting");
        if (reuse && owned !== this.daemon && owned !== this.parkedDefault) throw new Error("Owned daemon changed");
      };
      check();
      const validateActivation = (hello: HelloResult) => {
        check();
        if (!hello.identity || hello.processId !== processId || hello.storeDir !== join(path, ".orca"))
          throw new ConnectionRefusal("Owned first-run identity changed.");
        if (recovery && hello.identity.workspaceId !== recovery.firstRun?.identity.workspaceId)
          throw new FirstRunOwnershipRefusal();
        ownership?.verify(hello);
        const previousOwner = this.firstRunOwners.get(owned);
        if (
          reuse &&
          (!previousOwner ||
            previousOwner.identity.workspaceId !== hello.identity.workspaceId ||
            previousOwner.identity.instanceId !== hello.identity.instanceId)
        )
          throw new ConnectionRefusal("Owned first-run identity changed.");
      };
      return {
        client,
        expectedProcessId: processId,
        check,
        validateActivation,
        dispose: async () => {
          if (settled) return;
          settled = true;
          try {
            if (!reuse) await this.stopFirstRunOwned(owned);
          } finally {
            // A timeout/throw is not exit proof. Keep unknown ownership reserved.
            if (reuse || (owned.exited === true && ownership?.complete())) {
              this.candidates.delete(owned);
              release();
            }
          }
          if (!reuse && owned.exited !== true) throw new FirstRunOwnershipRefusal();
        },
        activate: (hello) => {
          validateActivation(hello);
          if (!hello.identity) throw new ConnectionRefusal("Owned first-run identity changed.");
          const old = this.daemon;
          const oldSource = this.source;
          if (owned === this.parkedDefault) this.parkedDefault = undefined;
          if (old && old !== owned && this.source === "bundled") this.parkedDefault = old;
          this.stream?.close();
          this.stream = undefined;
          this.daemon = owned;
          this.clientNow = client;
          this.target = { path, readOnly: false, source: "default" };
          this.source = "bundled";
          this.savedUrl = undefined;
          this.savedProfile = undefined;
          this.adoptLease(undefined);
          this.identity = hello.identity;
          this.verifiedHello = hello;
          this.observedHello = true;
          this.firstRunOwners.set(owned, { path, identity: hello.identity });
          this.candidates.delete(owned);
          settled = true;
          release();
          this.epoch += 1;
          this.deps.onSwitch(false);
          this.deps.onTarget?.(this.connectionTarget);
          this.stream = this.deps.subscribe(client);
          this.deps.onSnapshot(this.snapshot);
          if (old && old !== owned && oldSource !== "bundled")
            void old.stop().catch(() => this.deps.onError?.("Previous bundled daemon did not stop", undefined));
        },
      };
    } catch (error) {
      try {
        if (daemon && !reuse) await this.stopFirstRunOwned(daemon);
      } finally {
        if (!startupAttempted || (daemon && daemon.exited === true && ownership?.complete())) {
          if (daemon) this.candidates.delete(daemon);
          release();
        }
      }
      if (startupAttempted && !daemon) throw new FirstRunOwnershipRefusal(error);
      throw error;
    }
  }

  private recordFirstRunExit(daemon: BundledDaemon): void {
    // Installer uncertainty must not turn a late exit callback into startup permission.
    if (this.windowsUpdate?.daemon === daemon) return;
    try {
      this.durableFirstRunOwners.get(daemon)?.complete();
    } catch (error) {
      this.deps.onError?.("First-run ownership evidence could not be settled; startup remains blocked", error);
    }
  }

  private async stopFirstRunOwned(daemon: BundledDaemon): Promise<void> {
    try {
      await daemon.stop();
    } finally {
      // Ordinary termination proves only this child ended, never safe updater installation.
      if (daemon.exited === true) this.durableFirstRunOwners.get(daemon)?.complete();
    }
  }

  /** Prepare without stopping the current daemon or opening a replacement stream. */
  async prepareConnection(
    url: DaemonConnectionRequest,
    source: "saved" | "env" = "saved",
  ): Promise<ConnectionCandidate> {
    if (this.deps.updateBootstrap?.ordinaryAllowed === false) throw new Error("Update replacement bootstrap is closed");
    if (this.macUpdateHold || this.firstRunHold) throw new Error("Workspace is busy");
    const ticket = Symbol("connection-preparation");
    this.connectionPreparations.add(ticket);
    try {
      const candidate = await this.makeConnection(url, source);
      return {
        ...candidate,
        activate: (hello) => {
          candidate.check?.();
          candidate.activate(hello);
          this.connectionPreparations.delete(ticket);
        },
        dispose: async () => {
          try {
            await candidate.dispose();
          } finally {
            this.connectionPreparations.delete(ticket);
          }
        },
      };
    } catch (error) {
      this.connectionPreparations.delete(ticket);
      throw error;
    }
  }

  private async makeConnection(
    request: DaemonConnectionRequest,
    source: "saved" | "env",
  ): Promise<ConnectionCandidate> {
    if (this.updating || this.macUpdateHold || this.closed || this.pending) throw new Error("Workspace is busy");
    if (request !== null && typeof request === "object") {
      if (source !== "saved") throw new Error("The environment return must use the launch-pinned daemon");
      return this.makeProfileConnection(request.profile);
    }
    const url = request;
    if (source === "env" && (!this.deps.explicitUrl || url !== daemonEndpoint(this.deps.explicitUrl)))
      throw new Error("The environment return must use the launch-pinned daemon");
    if (
      source === "saved" &&
      url !== null &&
      [this.daemon, this.parkedDefault].some((daemon) => daemon && daemonEndpoint(daemon.url) === daemonEndpoint(url))
    )
      throw new ConnectionRefusal("Use the bundled daemon button instead of saving its temporary URL.");
    const epoch = this.epoch;
    let daemon: BundledDaemon | undefined;
    const path = this.deps.defaultPath() ?? "";
    if (url === null && !path) throw new ConnectionRefusal("Prepare and connect a selected first-run workspace first.");
    const reuse = url === null ? (this.source === "bundled" ? this.daemon : this.parkedDefault) : undefined;
    let client: DaemonClient;
    if (reuse) {
      daemon = reuse;
      client =
        this.daemon === reuse
          ? this.clientNow
          : this.deps.client(reuse.url, {
              workspace: path,
              bundled: true,
              ...(reuse.tokenFile ? { tokenFile: reuse.tokenFile } : {}),
            });
    } else if (url === null) {
      assertNoFirstRunOwnership(storeRoot(path));
      const entry = this.deps.findEntry();
      if (entry)
        daemon = await this.deps.start({
          entry,
          cwd: path,
          readOnly: false,
          onExit: () => {
            if (this.daemon === daemon) this.daemonExited();
            if (this.parkedDefault === daemon) this.parkedDefault = undefined;
          },
        });
      if (daemon) {
        if (this.closed) {
          await daemon.stop();
          throw new Error("Workspace closed");
        }
        this.candidates.add(daemon);
      }
      client = this.deps.client(daemon?.url ?? this.deps.defaultUrl, {
        workspace: path,
        bundled: Boolean(daemon),
        ...(daemon?.tokenFile ? { tokenFile: daemon.tokenFile } : {}),
      });
    } else client = this.deps.client(url, { workspace: path, bundled: false });
    return {
      client,
      check: () => {
        this.assertEpoch(epoch);
        if (this.closed || this.updating || this.macUpdateHold || this.pending)
          throw new Error("Workspace changed while connecting");
      },
      dispose: async () => {
        if (daemon) this.candidates.delete(daemon);
        if (!reuse) await daemon?.stop();
      },
      activate: (hello) => {
        if (daemon) this.candidates.delete(daemon);
        const old = this.daemon;
        const oldSource = this.source;
        if (daemon === this.parkedDefault) this.parkedDefault = undefined;
        if (old && old !== daemon && oldSource === "bundled") this.parkedDefault = old;
        this.stream?.close();
        this.stream = undefined;
        this.clientNow = client;
        this.daemon = daemon;
        this.adoptLease(undefined);
        if (source === "saved") {
          this.savedUrl = url ?? undefined;
          this.savedProfile = undefined;
        }
        this.source = source === "env" ? "env" : url ? "saved" : daemon ? "bundled" : "development";
        this.target = { path, readOnly: false, source: source === "env" ? "env" : "default" };
        this.identity = hello.identity;
        this.observedHello = hello.identity !== undefined;
        this.epoch += 1;
        this.deps.onSwitch(false);
        this.deps.onTarget?.(this.connectionTarget);
        this.stream = this.deps.subscribe(client);
        this.deps.onSnapshot(this.snapshot);
        if (old && old !== daemon && oldSource !== "bundled")
          void old.stop().catch(() => this.deps.onError?.("Previous bundled daemon did not stop", undefined));
      },
    };
  }

  /**
   * A saved SSH profile (#874): the tunnel opens here, before the probe, and closes again if
   * the probe or the draft guard refuses; the current connection is untouched until then.
   */
  private async makeProfileConnection(id: string): Promise<ConnectionCandidate> {
    if (!this.deps.openProfile) throw new ConnectionRefusal("This build cannot connect through SSH profiles.");
    const epoch = this.epoch;
    const path = this.deps.defaultPath() ?? "";
    const lease = await this.deps.openProfile(id);
    let adopted = false;
    let client: DaemonClient;
    try {
      if (this.closed) throw new Error("Workspace closed");
      client = this.deps.client(lease.url, {
        workspace: path,
        bundled: false,
        auth: lease.auth,
        transport: lease.transport,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
    return {
      client,
      explainFailure: () => (lease.remoteRefused() ? remoteDaemonMissing(lease) : undefined),
      check: () => {
        this.assertEpoch(epoch);
        if (this.closed || this.updating || this.macUpdateHold || this.pending)
          throw new Error("Workspace changed while connecting");
      },
      dispose: async () => {
        if (!adopted) await lease.release();
      },
      activate: (hello) => {
        adopted = true;
        const old = this.daemon;
        const oldSource = this.source;
        if (old && oldSource === "bundled") this.parkedDefault = old;
        this.stream?.close();
        this.stream = undefined;
        this.clientNow = client;
        this.daemon = undefined;
        this.adoptLease(lease);
        this.savedUrl = undefined;
        this.savedProfile = id;
        this.source = "saved";
        this.target = { path, readOnly: false, source: "default" };
        this.identity = hello.identity;
        this.observedHello = hello.identity !== undefined;
        this.epoch += 1;
        this.deps.onSwitch(false);
        this.deps.onTarget?.(this.connectionTarget);
        this.stream = this.deps.subscribe(client);
        this.deps.onSnapshot(this.snapshot);
        if (old && oldSource !== "bundled")
          void old.stop().catch(() => this.deps.onError?.("Previous bundled daemon did not stop", undefined));
      },
    };
  }

  private checkWindowsUpdate(attempt: WindowsUpdateAttempt): void {
    if (
      this.closed ||
      !this.updating ||
      this.windowsUpdate !== attempt ||
      this.epoch !== attempt.epoch ||
      this.clientNow !== attempt.client ||
      attempt.daemon?.pid !== attempt.processId ||
      (attempt.firstRun !== undefined &&
        (!this.verifiedHello ||
          this.verifiedHello.processId !== attempt.processId ||
          this.verifiedHello?.storeDir !== attempt.storeDir ||
          !appSpeaks(this.verifiedHello.protocol) ||
          !(["runs.read", "runs.control", "runs.subscribe"] as const).every((capability) =>
            this.verifiedHello?.capabilities.includes(capability),
          ))) ||
      this.identity?.workspaceId !== attempt.identity?.workspaceId ||
      this.identity?.instanceId !== attempt.identity?.instanceId ||
      this.target.path !== attempt.target.path ||
      this.target.readOnly !== attempt.target.readOnly ||
      (this.daemon !== attempt.daemon && !(attempt.stopAttempted && !this.daemon && attempt.daemon?.exited === true))
    )
      throw new Error("Update attempt or target changed; admission remains closed");
  }

  async stopForUpdate(token: string): Promise<void> {
    const attempt = this.windowsUpdate;
    if (!attempt || attempt.token !== token) throw new Error("Update was not prepared for this token");
    this.checkWindowsUpdate(attempt);
    if (attempt.busy || attempt.stopAttempted) throw new Error("Update stop already attempted");
    attempt.busy = true;
    attempt.stopAttempted = true;
    try {
      // Retain the handle and durable reservation, even on a throw/timeout or observed exit.
      // Settlement is allowed only when the caller positively knows installation never began.
      attempt.ownership?.check();
      if (attempt.daemon) {
        await attempt.daemon.stop();
        this.checkWindowsUpdate(attempt);
        if (attempt.daemon.exited !== true) throw new Error("Exact child termination is uncertain");
        this.stream?.close();
        this.stream = undefined;
        this.deps.onDaemonGone("Bundled daemon stopped for update; admission remains closed");
      }
    } finally {
      attempt.busy = false;
    }
  }

  /**
   * After the exact stop, before the installer: hand the stopped bundled daemon's store to the
   * first start of `to` (#897). Only for an app-owned first-run workspace whose daemon this
   * attempt prepared (admission closed, no active work), stopped, and saw exit.
   */
  async handOffForUpdate(token: string, from: string, to: string): Promise<void> {
    const attempt = this.windowsUpdate;
    if (!attempt || attempt.token !== token) throw new Error("Update was not prepared for this token");
    this.checkWindowsUpdate(attempt);
    if (attempt.busy || !attempt.stopAttempted || attempt.handedOff || attempt.recovering)
      throw new Error("Update handoff is not available");
    if (!attempt.daemon || attempt.daemon.exited !== true || !attempt.firstRun || !attempt.ownership)
      throw new Error("No stopped bundled daemon to hand off");
    attempt.busy = true;
    try {
      if (!attempt.ownership.complete()) throw new FirstRunOwnershipRefusal();
      attempt.handedOff = (this.deps.handOffStore ?? handOffStoreForUpdate)(attempt.firstRun.path, from, to);
    } finally {
      attempt.busy = false;
    }
  }

  async prepareUpdate(token: string): Promise<void> {
    const refuseUnclaimed = (message: string): never => {
      // A duplicate exact-token caller cannot declare its existing reservation absent.
      if (this.windowsUpdate?.token === token) throw new Error("Update token already has a reservation");
      throw new UpdatePreflightRefusal(token, message);
    };
    const checkPreflight = () => {
      if (
        this.closed ||
        this.updating ||
        this.pending ||
        this.candidates.size ||
        this.macUpdateHold ||
        this.firstRunHold ||
        this.deps.setupBusy?.() ||
        this.connectionPreparations.size
      )
        refuseUnclaimed("Workspace is busy");
      if (this.parkedDefault) refuseUnclaimed("Return to the bundled daemon before updating the app");
    };
    checkPreflight();
    try {
      await this.ready();
    } catch {
      refuseUnclaimed("Workspace update preflight could not complete");
    }
    checkPreflight();
    const daemon = this.daemon;
    const attempt: WindowsUpdateAttempt = {
      token,
      daemon,
      ownership: daemon && this.durableFirstRunOwners.get(daemon),
      firstRun: daemon && this.firstRunOwners.get(daemon),
      client: this.clientNow,
      epoch: this.epoch,
      identity: this.identity ? { ...this.identity } : undefined,
      processId: daemon?.pid,
      storeDir: this.verifiedHello?.storeDir,
      target: { ...this.target },
      stopAttempted: false,
      handedOff: undefined,
      recovering: false,
      busy: true,
    };
    this.windowsUpdate = attempt;
    this.updating = true;
    try {
      attempt.ownership?.check();
      if (attempt.firstRun && (!attempt.ownership || !this.currentFirstRun(attempt.firstRun.path)))
        throw new FirstRunOwnershipRefusal();
      if (daemon) {
        const result = await attempt.client.maintenance({ action: "prepare", token });
        this.checkWindowsUpdate(attempt);
        if (!result.ready) throw new Error(`Bundled daemon busy: ${result.active.join(", ")}`);
      }
    } finally {
      // A failed or ambiguous prepare still belongs to this token until resume succeeds.
      attempt.busy = false;
    }
  }

  /** Called only with positive installer non-launch evidence (including pre-install failure). */
  async cancelUpdate(token: string): Promise<void> {
    const attempt = this.windowsUpdate;
    if (!attempt || attempt.token !== token) throw new Error("Update token is stale");
    this.checkWindowsUpdate(attempt);
    if (attempt.busy || attempt.recovering) throw new Error("Update recovery already attempted");
    attempt.busy = true;
    attempt.recovering = true;
    try {
      if (!attempt.stopAttempted) {
        if (attempt.daemon) {
          const result = await attempt.client.maintenance({ action: "resume", token });
          this.checkWindowsUpdate(attempt);
          if (result.ready) throw new Error("Bundled daemon admission is still held");
        }
      } else if (attempt.daemon) {
        if (attempt.daemon.exited !== true) throw new Error("Exact child termination is uncertain");
        // Nothing was installed: the store goes back to this version, so its handoff is withdrawn.
        if (attempt.handedOff && attempt.firstRun) {
          (this.deps.withdrawHandoff ?? withdrawUpdateHandoff)(attempt.firstRun.path, attempt.handedOff);
          attempt.handedOff = undefined;
        }
        attempt.ownership?.check();
        if (attempt.ownership && !attempt.ownership.complete()) throw new FirstRunOwnershipRefusal();
        // The old captured child is now settled. Generic reconnect cannot authorize a new writer.
        if (!attempt.firstRun || !this.deps.recoverFirstRun) throw new Error("Saved-receipt recovery is unavailable");
        this.daemon = undefined;
        const check = () => {
          this.checkWindowsUpdate(attempt);
          if (!attempt.busy || !attempt.recovering) throw new Error("Update recovery is no longer open");
        };
        await this.deps.recoverFirstRun(attempt.firstRun.path, check, (path) => this.firstRunConnection(path, attempt));
        this.assertWindowsReplacement(attempt);
      }
      this.windowsUpdate = undefined;
      this.updating = false;
    } finally {
      attempt.busy = false;
    }
  }

  private assertWindowsReplacement(attempt: WindowsUpdateAttempt): void {
    // Activation advances the epoch; require a verified replacement of the same workspace.
    if (
      this.closed ||
      this.windowsUpdate !== attempt ||
      !this.daemon ||
      this.daemon === attempt.daemon ||
      this.daemon.exited === true ||
      !attempt.firstRun ||
      this.identity?.workspaceId !== attempt.firstRun.identity.workspaceId ||
      !this.currentFirstRun(attempt.firstRun.path)
    )
      throw new FirstRunOwnershipRefusal();
  }

  constructor(deps: WorkspaceDeps) {
    this.deps = deps;
    this.savedUrl = deps.savedUrl;
    this.savedProfile = deps.savedUrl ? undefined : deps.savedProfile;
    this.source = deps.explicitUrl ? "env" : this.hasSavedTarget() ? "saved" : "development";
    this.target = { path: deps.defaultPath() ?? "", readOnly: false, source: deps.explicitUrl ? "env" : "default" };
    // A saved profile has no URL until its tunnel opens in the first switch: inert until then.
    const initial =
      deps.explicitUrl ?? deps.savedUrl ?? (this.savedProfile || !this.target.path ? "" : deps.defaultUrl);
    this.clientNow = deps.client(initial, {
      workspace: this.target.path,
      bundled: false,
    });
  }

  /**
   * The bundled daemon the app parked when focus moved to another daemon, for the Machines
   * surface to watch read-only (#882). Never the focused one: the workspace streams that.
   */
  get parkedBundled(): ParkedBundled | undefined {
    const parked = this.parked;
    if (!parked || parked.exited === true || this.closed) return undefined;
    return {
      url: parked.url,
      ...(parked.tokenFile ? { tokenFile: parked.tokenFile } : {}),
      workspace: this.deps.defaultPath() ?? "",
    };
  }

  /** The client every bridge handler reads, at call time and after `ready()`. */
  get client(): DaemonClient {
    return this.clientNow;
  }

  /** The push stream, for the cursor the connection machine reports. */
  get subscription(): DaemonSubscription | undefined {
    return this.stream;
  }

  /** What the renderer is told: the store on screen, and whether it can be written to. */
  get snapshot(): WorkspaceSnapshot {
    return { path: this.target.path, readOnly: this.target.readOnly, source: this.target.source };
  }

  /**
   * Settle before reading `client`. A loop rather than one `await`, because a second switch
   * can begin while the first is finishing and the caller wants the daemon that is there
   * when it stops waiting, not the one that was there when it started.
   */
  async ready(): Promise<void> {
    if (this.updating || this.macUpdateStopping || this.macUpdateFrozen || !this.existingDispatchAllowed())
      throw new Error("Update restart admission is closed");
    while (this.pending) await this.pending;
  }

  private existingDispatchAllowed(): boolean {
    return (
      this.deps.updateBootstrap?.ordinaryAllowed !== false ||
      (this.macUpdateHold !== undefined && this.deps.updateBootstrap.existingWorkAllowed === true)
    );
  }

  /** The first connection, from `whenReady`. Never rejects — see `switchTo`. */
  connect(): Promise<void> {
    if (this.deps.updateBootstrap?.ordinaryAllowed === false)
      return Promise.reject(new Error("Update replacement bootstrap is closed"));
    if (this.closed || this.updating || this.macUpdateHold || this.firstRunHold || this.connectionPreparations.size)
      return Promise.reject(new Error("Workspace is busy"));
    if (!this.deps.explicitUrl && !this.hasSavedTarget() && !this.target.path) {
      this.deps.onDaemonGone("Choose a project and empty app workspace in Config.");
      this.deps.onSnapshot(this.snapshot);
      return Promise.resolve();
    }
    return this.switchTo(this.target);
  }

  /**
   * Point the app at a store a person chose, read-only (#164). Throws when this build has
   * no daemon to start, which the bridge answers as a protocol error rather than as a
   * window that silently did nothing.
   */
  async open(path: string): Promise<WorkspaceSnapshot> {
    if (this.deps.updateBootstrap?.ordinaryAllowed === false) throw new Error("Update replacement bootstrap is closed");
    if (this.closed || this.updating || this.macUpdateHold || this.firstRunHold || this.connectionPreparations.size)
      throw new Error("Update restart or connection preparation is in progress");
    if (!this.deps.findEntry()) throw new NoBundledDaemonError(path);
    if (this.parkedDefault && this.firstRunOwners.get(this.parkedDefault)?.path === path)
      throw new ConnectionRefusal("This workspace has a parked owned daemon. Return to it before opening its store.");
    assertNoFirstRunOwnership(storeRoot(path));
    await this.switchTo({ path, readOnly: true, source: "chosen" });
    return this.snapshot;
  }

  /** The banner's **Connect to a daemon**: back to the daemon the app would have used. */
  async connectLive(): Promise<WorkspaceSnapshot> {
    if (this.deps.updateBootstrap?.ordinaryAllowed === false) throw new Error("Update replacement bootstrap is closed");
    if (this.closed || this.updating || this.macUpdateHold || this.firstRunHold || this.connectionPreparations.size)
      throw new Error("Update restart or connection preparation is in progress");
    const { explicitUrl, defaultPath } = this.deps;
    const path = defaultPath() ?? "";
    if (!explicitUrl && !this.hasSavedTarget() && !path)
      throw new Error("Prepare and connect a selected first-run workspace first.");
    await this.switchTo({ path, readOnly: false, source: explicitUrl ? "env" : "default" });
    return this.snapshot;
  }

  /** Ordinary quit cleanup. Never escalates or certifies a reserved updater stop. */
  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
    this.stream?.close();
    this.stream = undefined;
    const lease = this.lease;
    this.lease = undefined;
    await lease?.release().catch(() => undefined);
    const daemon = this.daemon;
    this.daemon = undefined;
    if (!this.windowsUpdate && !this.macUpdateStopping && !this.macUpdateHold && daemon)
      await this.stopFirstRunOwned(daemon);
    const parked = this.parkedDefault;
    this.parkedDefault = undefined;
    if (parked && parked !== daemon) await this.stopFirstRunOwned(parked);
    await Promise.all([...this.candidates].map((candidate) => this.stopFirstRunOwned(candidate)));
    this.candidates.clear();
  }

  /**
   * The one place a daemon is swapped. In order, because every pair of these steps has a
   * window in which the app would be talking to the wrong process:
   *
   * 1. the old stream is closed, so nothing arrives from a store nobody is looking at;
   * 2. the connection machine is reset, so the status bar stops claiming the old daemon's
   *    version and capabilities before the new handshake has happened;
   * 3. the old daemon — if this process started it — is stopped, because two daemons on one
   *    store is the orphan-holding-a-port problem a person notices on the second launch;
   * 4. the new one is started and the client rebuilt, so `client` is right for everything
   *    that was waiting on `ready()`;
   * 5. the stream is reopened and the snapshot pushed.
   *
   * It never rejects for a daemon that would not start: the window stays open on a status
   * bar that reads disconnected, because an app that refuses to run because its daemon did
   * is a worse failure than one that shows you it has none. `open()` checks the one case a
   * person can act on — no bundled daemon at all — before it gets here.
   *
   * **What "stays open" means depends on the mode (#269).** In the *launch* case the daemon
   * that would not start was a placeholder over the default workspace, so looking for one on
   * `explicitUrl ?? defaultUrl` is looking for the daemon the app expected anyway. In *file
   * mode* it is not: the person named a store, and any daemon answering on the default port
   * is serving some other one. Falling back there would show that store's runs under a
   * banner naming the chosen path as read-only, so a failed start is a failed open — no
   * client, no stream, and the connection left down with the reason.
   */
  private switchTo(target: WorkspaceTarget): Promise<void> {
    // Check before detaching the current target, and again immediately before spawn.
    try {
      if (target.readOnly || (!this.deps.explicitUrl && !this.hasSavedTarget()))
        assertNoFirstRunOwnership(storeRoot(target.path));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new FirstRunOwnershipRefusal(error));
    }
    const run = this.performSwitch(target);
    this.pending = run;
    return run.finally(() => {
      if (this.pending === run) this.pending = undefined;
    });
  }

  private async performSwitch(target: WorkspaceTarget): Promise<void> {
    this.stream?.close();
    this.stream = undefined;
    this.target = target;
    this.deps.onSwitch(target.readOnly);

    const stopping = this.daemon && this.stopFirstRunOwned(this.daemon);
    this.daemon = undefined;
    await stopping;

    const override = this.deps.explicitUrl ?? this.savedUrl;
    const profileId = override || target.readOnly ? undefined : this.savedProfile;
    const entry = (override || profileId) && !target.readOnly ? undefined : this.deps.findEntry();
    let url = override ?? this.deps.defaultUrl;
    let lease: ProfileLease | undefined;
    if (profileId) {
      try {
        if (!this.deps.openProfile) throw new ConnectionRefusal("This build cannot connect through SSH profiles.");
        lease = await this.deps.openProfile(profileId);
        url = lease.url;
      } catch (e) {
        const reason = `the saved SSH profile could not connect: ${e instanceof Error ? e.message : "unknown failure"}`;
        this.deps.onError?.(reason, e);
        if (this.closed) return;
        // Nothing to fall back to: the person chose that remote daemon. Inert client, new
        // epoch, disconnected with the reason; the connection dialog retries it.
        this.adoptLease(undefined);
        this.clientNow = this.deps.client("", { workspace: target.path, bundled: false });
        this.source = "saved";
        this.identity = undefined;
        this.observedHello = false;
        this.epoch += 1;
        this.deps.onTarget?.(this.connectionTarget);
        this.deps.onDaemonGone(reason);
        this.deps.onSnapshot(this.snapshot);
        return;
      }
      if (this.closed) {
        await lease.release();
        return;
      }
    }
    if (entry) {
      try {
        assertNoFirstRunOwnership(storeRoot(target.path));
        const starting: { daemon?: BundledDaemon } = {};
        const started = await this.deps.start({
          entry,
          cwd: target.path,
          readOnly: target.readOnly,
          onExit: () => {
            if (starting.daemon && this.daemon === starting.daemon) this.daemonExited();
            if (starting.daemon === this.parkedDefault) this.parkedDefault = undefined;
          },
        });
        starting.daemon = started;
        this.daemon = started;
        url = started.url;
      } catch (e) {
        if (e instanceof FirstRunOwnershipRefusal) throw e;
        if (target.readOnly) {
          const reason = `the store at ${target.path} could not be opened: the bundled daemon did not start`;
          this.deps.onError?.(reason, e);
          if (this.closed) return;
          // No client and no subscription: the previous connection was already stopped above
          // and stays stopped, so there is nothing attached to any store. The workspace
          // snapshot still goes out, because the banner has to name the store that failed.
          this.deps.onDaemonGone(reason);
          this.deps.onSnapshot(this.snapshot);
          return;
        }
        this.deps.onError?.(`the bundled daemon did not start; the app will look for one on ${url}`, e);
      }
    }

    if (this.closed) return;
    this.clientNow = this.deps.client(url, {
      workspace: target.path,
      bundled: this.daemon !== undefined,
      ...(this.daemon?.tokenFile ? { tokenFile: this.daemon.tokenFile } : {}),
      ...(lease ? { auth: lease.auth, transport: lease.transport } : {}),
    });
    this.adoptLease(lease);
    this.source = target.readOnly
      ? "store"
      : this.deps.explicitUrl
        ? "env"
        : this.hasSavedTarget()
          ? "saved"
          : this.daemon
            ? "bundled"
            : "development";
    this.identity = undefined;
    this.observedHello = false;
    this.epoch += 1;
    this.deps.onTarget?.(this.connectionTarget);
    if (!this.endpoint()) {
      const reason =
        "Invalid daemon URL. Set ORCA_DAEMON_URL to an HTTP or HTTPS URL without credentials, query parameters or fragments and restart.";
      this.deps.onError?.(reason, undefined);
      this.deps.onDaemonGone(reason);
      this.deps.onSnapshot(this.snapshot);
      return;
    }
    this.stream = this.deps.subscribe(this.clientNow);
    this.deps.onSnapshot(this.snapshot);
  }

  /**
   * A daemon this process started went away by itself. Recorded on the machine by
   * `index.ts`; here it only means there is nothing left to stop, so quitting does not wait
   * on a process that is already gone.
   */
  private daemonExited(): void {
    if (this.windowsUpdate?.daemon === this.daemon) {
      this.deps.onDaemonGone("Bundled daemon exited during update; admission remains closed");
      return;
    }
    this.daemon = undefined;
    this.deps.onDaemonGone("The bundled daemon exited");
  }
}

/** A failed probe through a working tunnel: ssh is fine, the daemon is not there. */
function remoteDaemonMissing(lease: ProfileLease): string {
  return `SSH to ${lease.profile.destination} works, but no ORCA daemon is listening on its port ${lease.profile.remotePort}. Start it there with \`orca serve\` and try again.`;
}
