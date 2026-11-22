/**
 * The main process's half of updating a remote server (#879): one update at a time, of the
 * connection the person confirmed, with the updater they approved for that SSH profile.
 *
 * Every request is checked again here against the connection as it is now: the same profile,
 * the same connection epoch, the host key that tunnel authenticated, the daemon's workspace
 * identity and this app's own version. The updater's paths come from the profile's approval;
 * the daemon's `hello.deployment` must match them and never chooses them. Its output goes to
 * the windows as it runs, and a success is reported only once a fresh authenticated hello from
 * the same server says it runs the new version.
 *
 * Nothing here goes through the daemon's RPC except that hello.
 */
import type { ManagedDeployment } from "@orca/protocol";
import { TunnelRefusal, type RemoteCommand, type TunnelRefusalCode } from "@orca/protocol/remote-access";
import {
  classifyServerUpdate,
  samePaths,
  SERVER_UPDATE_MAX_LINES,
  SERVER_UPDATE_VERSION,
  serverUpdateCommand,
  type ServerUpdaterApproval,
  type ServerUpdaterPaths,
  type ServerUpdaterState,
  type ServerUpdateOutcome,
  type ServerUpdateProgress,
  type ServerUpdateRequest,
  type ServerUpdateTarget,
} from "../server-update.js";

/** The current connection, as main knows it. `profile` and `hostKey` only for an SSH profile. */
export interface ServerConnection {
  epoch: number;
  profile?: string;
  hostKey?: string;
  workspaceId?: string;
}

export interface ServerUpdaterDeps {
  /** This app's version: the only release the server is updated to. */
  version: string;
  connection(): ServerConnection;
  /** `hello.deployment` of the connected daemon: a hint, checked against the approval. */
  declared(): ManagedDeployment | undefined;
  approved(profile: string): ServerUpdaterPaths | undefined;
  approve(profile: string, paths: ServerUpdaterPaths): void;
  /** Runs `command` over the current profile's ssh; `undefined` when the connection is not a profile. */
  run(
    command: readonly string[],
    onLine: (stream: "stdout" | "stderr", line: string) => void,
  ): { command: RemoteCommand } | undefined;
  /** A fresh authenticated hello on the current connection. */
  hello(): Promise<{ orcaVersion: string; workspaceId?: string }>;
  onProgress(progress: ServerUpdateProgress): void;
  /** How long a restarted server has to answer with its new version. */
  confirm?: { attempts: number; delayMs: number };
  sleep?: (ms: number) => Promise<void>;
}

const CONFIRM = { attempts: 30, delayMs: 2_000 };

export class ServerUpdater {
  private running: Promise<ServerUpdateOutcome> | undefined;
  private current: RemoteCommand | undefined;
  private stopped = false;

  constructor(private readonly deps: ServerUpdaterDeps) {}

  /** The current profile connection's server, for the dialog. */
  read(): ServerUpdaterState | undefined {
    const now = this.deps.connection();
    if (!now.profile) return undefined;
    const declared = this.deps.declared();
    const approved = this.deps.approved(now.profile);
    return {
      profile: now.profile,
      epoch: now.epoch,
      ...(now.hostKey ? { hostKey: now.hostKey } : {}),
      ...(now.workspaceId ? { workspaceId: now.workspaceId } : {}),
      ...(declared ? { declared: { adapter: declared.adapter, manifest: declared.manifest } } : {}),
      ...(approved ? { approved } : {}),
    };
  }

  /** Approve the updater the person saw, for the connection they saw it on. */
  approve(approval: ServerUpdaterApproval): { ok: true } | { ok: false; message: string } {
    const stale = this.mismatch(approval);
    if (stale) return { ok: false, message: stale };
    const paths = { adapter: approval.adapter, manifest: approval.manifest };
    if (!samePaths(paths, this.deps.declared()))
      return { ok: false, message: "The server no longer reports that updater. Check the server again." };
    this.deps.approve(approval.profile, paths);
    return { ok: true };
  }

  /** Single-flight: a second ask while one runs gets the same outcome, not a second updater. */
  update(request: ServerUpdateRequest): Promise<ServerUpdateOutcome> {
    this.running ??= this.attempt(request).finally(() => {
      this.running = undefined;
      this.current = undefined;
    });
    return this.running;
  }

  /** Quit: hang up the ssh session and stop waiting. The server's updater finishes or rolls back on its own. */
  stop(): void {
    this.stopped = true;
    this.current?.kill();
  }

  /** Why the connection is no longer the one confirmed, or `undefined` when it still is. */
  private mismatch(target: ServerUpdateTarget): string | undefined {
    const now = this.deps.connection();
    if (!now.profile) return "Only a server reached through an SSH profile can be updated.";
    if (
      now.profile !== target.profile ||
      now.epoch !== target.epoch ||
      now.hostKey === undefined ||
      now.hostKey !== target.hostKey ||
      now.workspaceId === undefined ||
      now.workspaceId !== target.workspaceId
    )
      return "The connection changed since you confirmed. Check the server again before updating.";
    return undefined;
  }

  private async attempt(request: ServerUpdateRequest): Promise<ServerUpdateOutcome> {
    if (!SERVER_UPDATE_VERSION.test(this.deps.version))
      return { status: "unavailable", reason: `This app (${this.deps.version}) is not a release build.` };
    if (request.version !== this.deps.version)
      return { status: "unavailable", reason: `This app updates servers to its own version, ${this.deps.version}.` };
    const stale = this.mismatch(request);
    if (stale) return { status: "unavailable", reason: stale };
    const approved = this.deps.approved(request.profile);
    if (!approved) return { status: "unavailable", reason: "Approve this server's updater first." };
    if (!samePaths(approved, this.deps.declared()))
      return {
        status: "unavailable",
        reason:
          "The server reports its updater somewhere other than you approved, so nothing ran. Review it in the connection dialog.",
      };
    const lines: ServerUpdateProgress[] = [];
    const onLine = (stream: "stdout" | "stderr", line: string) => {
      const progress = { stream, line };
      lines.push(progress);
      if (lines.length > SERVER_UPDATE_MAX_LINES) lines.shift();
      this.deps.onProgress(progress);
    };
    let started: { command: RemoteCommand } | undefined;
    try {
      started = this.deps.run(serverUpdateCommand(approved, request.version), onLine);
    } catch (error) {
      if (!(error instanceof TunnelRefusal)) throw error;
      return { status: "unreachable", refusal: error.code, message: error.message };
    }
    if (!started)
      return { status: "unavailable", reason: "Only a server reached through an SSH profile can be updated." };
    this.current = started.command;
    const ended = classifyServerUpdate(await started.command.exit, lines, request.version, explainRefusal);
    if (ended.status !== "updated" && ended.status !== "unknown") return ended;
    return this.confirm(request, ended.status === "updated" ? "not-confirmed" : "connection-lost");
  }

  /**
   * Ask the same server, freshly, what it runs. The connection may be re-established meanwhile
   * (the daemon restarted), so it is matched by profile, host key and workspace, not by epoch.
   */
  private async confirm(
    request: ServerUpdateRequest,
    reason: "connection-lost" | "not-confirmed",
  ): Promise<ServerUpdateOutcome> {
    const { attempts, delayMs } = this.deps.confirm ?? CONFIRM;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let serverVersion: string | undefined;
    for (let attempt = 0; attempt < attempts && !this.stopped; attempt++) {
      if (attempt > 0) await sleep(delayMs);
      const now = this.deps.connection();
      if (now.profile !== request.profile || now.hostKey !== request.hostKey) break;
      try {
        const hello = await this.deps.hello();
        if (hello.workspaceId !== request.workspaceId) break;
        serverVersion = hello.orcaVersion;
        if (hello.orcaVersion === request.version) return { status: "updated", version: request.version };
      } catch {
        // Restarting, or the tunnel is reconnecting: ask again.
      }
    }
    return { status: "unknown", reason, ...(serverVersion !== undefined ? { serverVersion } : {}) };
  }
}

/** The app's own words for an ssh refusal, never ssh's. */
function explainRefusal(refusal: string): string {
  return new TunnelRefusal(refusal as TunnelRefusalCode).message;
}
