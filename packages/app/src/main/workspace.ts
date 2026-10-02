/**
 * Owns the app's daemon clients, streams and bundled processes. Startup and read-only
 * store opening retain the existing fallback behavior; ConnectionTarget stages live URL
 * replacements through prepareConnection without detaching the current stream.
 *
 * ready() gates startup/file-mode transitions. Resource IPC also validates the caller's
 * connection epoch before dispatch and after completion, so a queued write or late reply
 * cannot cross onto another target. Identity changes and daemon boots advance that epoch.
 * Bundled execution stays alive while the user views an external daemon and is reused on
 * return. Credentials and lifecycle dependencies stay in main; the renderer sees only the
 * nonsecret target snapshot. Electron-free so the transitions can be tested directly.
 */
import { daemonEndpoint, type DaemonTargetSnapshot } from "../daemon-connection.js";
import type { ConnectionCandidate, IdentifiedHello } from "./connection-target.js";
import type { WorkspaceSnapshot, WorkspaceSource } from "../bridge.js";
import type { DaemonClient } from "../client/daemon-client.js";
import type { DaemonSubscription } from "../client/subscription.js";
import type { BundledDaemon, DaemonExit } from "./daemon-process.js";

/** Where a workspace to serve comes from, and whether it is read-only. */
export interface WorkspaceTarget {
  /** The directory `orca serve --cwd` is given; it reads `<path>/.orca`. */
  path: string;
  readOnly: boolean;
  source: WorkspaceSource;
}

export interface WorkspaceDeps {
  /** The bundled daemon's entry point, or undefined in a development build. */
  findEntry: () => string | undefined;
  /** Start `orca serve` on a workspace. `readOnly` becomes the `--read-only` flag. */
  start: (options: {
    entry: string;
    cwd: string;
    readOnly: boolean;
    onExit: (exit: DaemonExit) => void;
  }) => Promise<BundledDaemon>;
  /** Build the read client for a daemon URL. */
  client: (url: string, options: { workspace: string; bundled: boolean; tokenFile?: string }) => DaemonClient;
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
  /** The default URL to look for when nothing is bundled and nothing was said. */
  savedUrl?: string | undefined;
  onTarget?: (target: DaemonTargetSnapshot) => void;
  defaultUrl: string;
  /**
   * The workspace the bundled daemon serves by default: `ORCA_WORKSPACE`, or the user's
   * home directory. Home is a placeholder with a known shape — `orca serve` reads `~/.orca`
   * and answers an empty run list rather than failing — and **Open a store…** is the way
   * off it.
   */
  defaultPath: () => string;
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
  private epoch = 0;
  private identity: IdentifiedHello["identity"];
  private source: DaemonTargetSnapshot["source"] = "development";
  private savedUrl: string | undefined;
  /** Keep a live bundled daemon running when the UI leaves it; switching is not cancellation. */
  private parkedDefault: BundledDaemon | undefined;
  private candidates = new Set<BundledDaemon>();

  get connectionTarget(): DaemonTargetSnapshot {
    return {
      epoch: this.epoch,
      url: daemonEndpoint(this.clientNow.url),
      source: this.source,
      environmentOverride: Boolean(this.deps.explicitUrl),
      ...(this.identity ? { identity: this.identity } : {}),
    };
  }

  assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new Error("The daemon changed. This operation belongs to the previous connection.");
  }

  /** Every boot boundary also resets scopes: a restored history may have rewound. */
  observeHello(client: DaemonClient, hello: IdentifiedHello): void {
    if (client !== this.clientNow) return;
    const next = hello.identity;
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

  /** Prepare without stopping the current daemon or opening a replacement stream. */
  async prepareConnection(url: string | null, source: "saved" | "env" = "saved"): Promise<ConnectionCandidate> {
    if (this.updating || this.closed || this.pending) throw new Error("Workspace is busy");
    if (source === "env" && (!this.deps.explicitUrl || url !== daemonEndpoint(this.deps.explicitUrl)))
      throw new Error("The environment return must use the launch-pinned daemon");
    const epoch = this.epoch;
    let daemon: BundledDaemon | undefined;
    const path = this.deps.defaultPath();
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
        if (this.closed || this.updating || this.pending) throw new Error("Workspace changed while connecting");
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
        if (source === "saved") this.savedUrl = url ?? undefined;
        this.source = source === "env" ? "env" : url ? "saved" : daemon ? "bundled" : "development";
        this.target = { path, readOnly: false, source: source === "env" ? "env" : "default" };
        this.identity = hello.identity;
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

  private updateStopped = false;

  async stopForUpdate(): Promise<void> {
    if (!this.updating) throw new Error("Update was not prepared");
    if (this.daemon) {
      await this.daemon.stop();
      this.daemon = undefined;
      this.updateStopped = true;
    }
  }

  async prepareUpdate(token: string): Promise<void> {
    if (this.parkedDefault) throw new Error("Return to the bundled daemon before updating the app");
    this.updating = true;
    try {
      await this.ready();
      if (this.daemon) {
        const result = await this.client.maintenance({ action: "prepare", token });
        if (!result.ready) throw new Error(`Bundled daemon busy: ${result.active.join(", ")}`);
      }
    } catch (error) {
      this.updating = false;
      throw error;
    }
  }

  async cancelUpdate(token: string): Promise<void> {
    try {
      if (this.daemon) await this.client.maintenance({ action: "resume", token });
    } finally {
      this.updating = false;
      if (this.updateStopped) {
        this.updateStopped = false;
        await this.connect();
      }
    }
  }

  constructor(deps: WorkspaceDeps) {
    this.deps = deps;
    this.savedUrl = deps.savedUrl;
    this.target = { path: deps.defaultPath(), readOnly: false, source: deps.explicitUrl ? "env" : "default" };
    this.clientNow = deps.client(deps.explicitUrl ?? deps.savedUrl ?? deps.defaultUrl, {
      workspace: this.target.path,
      bundled: false,
    });
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
    while (this.pending) await this.pending;
  }

  /** The first connection, from `whenReady`. Never rejects — see `switchTo`. */
  connect(): Promise<void> {
    return this.switchTo(this.target);
  }

  /**
   * Point the app at a store a person chose, read-only (#164). Throws when this build has
   * no daemon to start, which the bridge answers as a protocol error rather than as a
   * window that silently did nothing.
   */
  async open(path: string): Promise<WorkspaceSnapshot> {
    if (this.updating) throw new Error("Update restart is in progress");
    if (!this.deps.findEntry()) throw new NoBundledDaemonError(path);
    await this.switchTo({ path, readOnly: true, source: "chosen" });
    return this.snapshot;
  }

  /** The banner's **Connect to a daemon**: back to the daemon the app would have used. */
  async connectLive(): Promise<WorkspaceSnapshot> {
    if (this.updating) throw new Error("Update restart is in progress");
    const { explicitUrl, defaultPath } = this.deps;
    await this.switchTo({ path: defaultPath(), readOnly: false, source: explicitUrl ? "env" : "default" });
    return this.snapshot;
  }

  /** Stop the daemon this process started and close the stream. Safe to call twice. */
  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
    this.stream?.close();
    this.stream = undefined;
    const daemon = this.daemon;
    this.daemon = undefined;
    await daemon?.stop();
    const parked = this.parkedDefault;
    this.parkedDefault = undefined;
    if (parked !== daemon) await parked?.stop();
    await Promise.all([...this.candidates].map((candidate) => candidate.stop()));
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

    const stopping = this.daemon?.stop();
    this.daemon = undefined;
    await stopping;

    const override = this.deps.explicitUrl ?? this.savedUrl;
    const entry = override && !target.readOnly ? undefined : this.deps.findEntry();
    let url = override ?? this.deps.defaultUrl;
    if (entry) {
      try {
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
    });
    this.source = target.readOnly
      ? "store"
      : this.deps.explicitUrl
        ? "env"
        : this.savedUrl
          ? "saved"
          : this.daemon
            ? "bundled"
            : "development";
    this.identity = undefined;
    this.epoch += 1;
    this.deps.onTarget?.(this.connectionTarget);
    this.stream = this.deps.subscribe(this.clientNow);
    this.deps.onSnapshot(this.snapshot);
  }

  /**
   * A daemon this process started went away by itself. Recorded on the machine by
   * `index.ts`; here it only means there is nothing left to stop, so quitting does not wait
   * on a process that is already gone.
   */
  private daemonExited(): void {
    this.daemon = undefined;
    this.deps.onDaemonGone("The bundled daemon exited");
  }
}
