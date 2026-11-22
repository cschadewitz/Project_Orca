/**
 * The main process's half of updating a remote server (#879): one update at a time, of the
 * server the person confirmed, with the updater they entered and approved for it.
 *
 * - **One preview.** `read` makes a preview of the connection (profile, epoch, the host key
 *   its tunnel authenticated, the daemon's workspace, the server's version, the target
 *   version, the daemon's hint and the approval). Approving and updating name a preview by id;
 *   main makes a fresh one and runs nothing unless it is the same.
 * - **The person's paths.** The updater's paths are what the person typed, saved with the
 *   host key and workspace they were approved on, and apply to that server only. The file
 *   must be `orca-release.py`. The daemon's `hello.deployment` is a hint that must match them.
 * - **Only forward, only this app's release.** Main checks that the target is a release, is
 *   this app's own version, and is newer than what the server runs.
 * - **A confirmed outcome.** A success is reported only once a fresh authenticated hello from
 *   the same server says it runs the target, and the connection is checked again after that
 *   hello answers. A session lost after the updater could have started is "unknown".
 *
 * Nothing here goes through the daemon's RPC except that hello.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ManagedDeployment } from "@orca/protocol";
import { TunnelRefusal, type RemoteCommand, type TunnelRefusalCode } from "@orca/protocol/remote-access";
import {
  classifyServerUpdate,
  samePaths,
  SERVER_UPDATE_MAX_LINES,
  SERVER_UPDATE_VERSION,
  SERVER_UPDATER_NAME,
  serverBehind,
  serverUpdateCommand,
  type ServerUpdatePreview,
  type ServerUpdaterApproval,
  type ServerUpdaterPaths,
  type ServerUpdateOutcome,
  type ServerUpdateProgress,
  type ServerUpdateRequest,
} from "../server-update.js";

/** The current connection, as main knows it. `profile` and `hostKey` only for an SSH profile. */
export interface ServerConnection {
  epoch: number;
  profile?: string;
  hostKey?: string;
  workspaceId?: string;
}

/** An approval as saved: the paths, and the server they were approved on. */
export interface SavedApproval extends ServerUpdaterPaths {
  hostKey: string;
  workspaceId: string;
}

export interface ServerUpdaterDeps {
  /** This app's version: the only release the server is updated to. */
  version: string;
  connection(): ServerConnection;
  /** What the connected daemon said it runs, in its last hello. */
  serverVersion(): string | undefined;
  /** `hello.deployment` of the connected daemon: a hint, checked against the approval. */
  declared(): ManagedDeployment | undefined;
  approved(profile: string): SavedApproval | undefined;
  approve(profile: string, approval: SavedApproval): void;
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
  /** Preview ids; random in the app. */
  id?: () => string;
}

const CONFIRM = { attempts: 30, delayMs: 2_000 };
/** Previews main remembers: the dialog's current one, and a few it may still be answering. */
const PREVIEWS = 8;

/** The fields a preview is compared on: everything shown and confirmed, but its id. */
type Look = Omit<ServerUpdatePreview, "id">;

export class ServerUpdater {
  private running: Promise<ServerUpdateOutcome> | undefined;
  private current: RemoteCommand | undefined;
  private stopped = false;
  private readonly previews = new Map<string, Look>();

  constructor(private readonly deps: ServerUpdaterDeps) {}

  /** A fresh preview of the current profile connection's server, for the dialog. */
  read(): ServerUpdatePreview | undefined {
    const look = this.look();
    if (!look) return undefined;
    const id = (this.deps.id ?? randomUUID)();
    this.previews.set(id, look);
    while (this.previews.size > PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    return { id, ...look };
  }

  /** Approve the paths the person entered, for the server in the preview they saw. */
  approve(approval: ServerUpdaterApproval): { ok: true } | { ok: false; message: string } {
    const look = this.confirmed(approval.preview);
    if (typeof look === "string") return { ok: false, message: look };
    if (!look.hostKey || !look.workspaceId)
      return { ok: false, message: "This server has not identified itself yet. Reconnect and try again." };
    const paths = { adapter: approval.adapter, manifest: approval.manifest };
    const wrong = pathProblem(paths);
    if (wrong) return { ok: false, message: wrong };
    if (!samePaths(paths, look.declared))
      return {
        ok: false,
        message: "Those paths are not where this server says its updater is. Check them on the server.",
      };
    this.deps.approve(look.profile, { ...paths, hostKey: look.hostKey, workspaceId: look.workspaceId });
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

  /** What main sees now. The approval counts only for the host key and workspace it was made on. */
  private look(): Look | undefined {
    const now = this.deps.connection();
    if (!now.profile) return undefined;
    const declared = this.deps.declared();
    const saved = this.deps.approved(now.profile);
    const approved =
      saved && now.hostKey === saved.hostKey && now.workspaceId === saved.workspaceId
        ? { adapter: saved.adapter, manifest: saved.manifest }
        : undefined;
    const serverVersion = this.deps.serverVersion();
    const look: Look = {
      profile: now.profile,
      epoch: now.epoch,
      ...(now.hostKey ? { hostKey: now.hostKey } : {}),
      ...(now.workspaceId ? { workspaceId: now.workspaceId } : {}),
      ...(serverVersion !== undefined ? { serverVersion } : {}),
      targetVersion: this.deps.version,
      ...(declared ? { declared: { adapter: declared.adapter, manifest: declared.manifest } } : {}),
      ...(approved ? { approved } : {}),
    };
    const blocked = this.blocked(look);
    return blocked ? { ...look, blocked } : look;
  }

  /** Why no update may run on what `look` shows, or `undefined` when one may. */
  private blocked(look: Look): string | undefined {
    if (!SERVER_UPDATE_VERSION.test(look.targetVersion))
      return `This app (${look.targetVersion}) is not a release build.`;
    if (!look.hostKey || !look.workspaceId || look.serverVersion === undefined)
      return "This server has not identified itself yet.";
    if (!serverBehind(look.serverVersion, look.targetVersion))
      return `The server already runs ${look.serverVersion}; the app only updates a server that is older than it.`;
    if (!look.declared) return "This server was not installed by the managed server updater.";
    if (!look.approved) return "Approve this server's updater first.";
    if (!samePaths(look.approved, look.declared))
      return "The server reports its updater somewhere other than you approved, so nothing runs. Approve the new location.";
    return undefined;
  }

  /** The preview named, if the connection still looks exactly like it; otherwise why not. */
  private confirmed(id: string): Look | string {
    const seen = this.previews.get(id);
    const now = this.look();
    if (!seen || !now || JSON.stringify(seen) !== JSON.stringify(now))
      return "The server or the connection changed since this was shown. Check the server again.";
    return now;
  }

  private async attempt(request: ServerUpdateRequest): Promise<ServerUpdateOutcome> {
    const look = this.confirmed(request.preview);
    if (typeof look === "string") return { status: "unavailable", reason: look };
    if (look.blocked || !look.approved || !look.hostKey || !look.workspaceId)
      return { status: "unavailable", reason: look.blocked ?? "This server cannot be updated." };
    const lines: ServerUpdateProgress[] = [];
    const onLine = (stream: "stdout" | "stderr", line: string) => {
      const progress = { stream, line };
      lines.push(progress);
      if (lines.length > SERVER_UPDATE_MAX_LINES) lines.shift();
      this.deps.onProgress(progress);
    };
    let started: { command: RemoteCommand } | undefined;
    try {
      started = this.deps.run(serverUpdateCommand(look.approved, look.targetVersion), onLine);
    } catch (error) {
      if (!(error instanceof TunnelRefusal)) throw error;
      return { status: "unreachable", refusal: error.code, message: error.message };
    }
    if (!started)
      return { status: "unavailable", reason: "Only a server reached through an SSH profile can be updated." };
    this.current = started.command;
    const ended = classifyServerUpdate(await started.command.exit, lines, look.targetVersion, explainRefusal);
    if (ended.status !== "updated" && ended.status !== "unknown") return ended;
    const server = { profile: look.profile, hostKey: look.hostKey, workspaceId: look.workspaceId };
    return this.confirm(server, look.targetVersion, ended.status === "updated" ? "not-confirmed" : "connection-lost");
  }

  /**
   * Ask the same server, freshly, what it runs. The connection may be re-established meanwhile
   * (the daemon restarted), so it is matched by profile, host key and workspace, not by epoch,
   * before the hello and again after it answers.
   */
  private async confirm(
    server: { profile: string; hostKey: string; workspaceId: string },
    version: string,
    reason: "connection-lost" | "not-confirmed",
  ): Promise<ServerUpdateOutcome> {
    const { attempts, delayMs } = this.deps.confirm ?? CONFIRM;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const same = () => {
      const now = this.deps.connection();
      return now.profile === server.profile && now.hostKey === server.hostKey;
    };
    let serverVersion: string | undefined;
    for (let attempt = 0; attempt < attempts && !this.stopped; attempt++) {
      if (attempt > 0) await sleep(delayMs);
      if (!same()) break;
      let hello: { orcaVersion: string; workspaceId?: string };
      try {
        hello = await this.deps.hello();
      } catch {
        continue; // Restarting, or the tunnel is reconnecting: ask again.
      }
      // The connection may have moved while the hello was in flight: its answer is not this server's.
      if (!same() || hello.workspaceId !== server.workspaceId) break;
      serverVersion = hello.orcaVersion;
      if (hello.orcaVersion === version) return { status: "updated", version };
    }
    return { status: "unknown", reason, ...(serverVersion !== undefined ? { serverVersion } : {}) };
  }
}

/** Why these are not paths the app would run, or `undefined`. The schema already checked their form. */
function pathProblem(paths: ServerUpdaterPaths): string | undefined {
  if (posix.basename(paths.adapter) !== SERVER_UPDATER_NAME)
    return `The updater must be the server's ${SERVER_UPDATER_NAME}.`;
  if (!paths.manifest.endsWith(".json")) return "The deployment manifest is a .json file.";
  return undefined;
}

/** The app's own words for an ssh refusal, never ssh's. */
function explainRefusal(refusal: string): string {
  return new TunnelRefusal(refusal as TunnelRefusalCode).message;
}
