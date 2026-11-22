/**
 * Updating a remote server from the app (#879): the contract the main process, the preload
 * bridge and the connection dialog share, and the pure parts of the main process's work.
 *
 * **Nothing installs through the daemon, and the daemon does not choose what runs.** It
 * reports, in `hello.deployment`, that the managed server updater launched it and where that
 * updater is; that is a hint. The person enters the updater's two paths themselves and
 * approves them for that SSH profile, host key and workspace; the app runs only an approved
 * updater named `orca-release.py`, and refuses when the daemon's hint does not match it. Every
 * approval and update names one preview main made, and main rechecks the connection against
 * it. The update is that updater run on the server over the profile's own SSH connection
 * (`SshTunnel.exec`: the pinned host key, the person's key, no forwards), exactly the command
 * an operator types:
 *
 *     python3 <adapter> --deployment <manifest> update --bundle v<app version>
 *
 * so the server's own rules decide: the signed bundle's signer and digest, forward-only
 * versions, the update lock shared with the server's timer (#878), and the admission barrier
 * that refuses while work is running and never cancels it.
 *
 * The updater's outcome is read from its exit and its `orca-release: ` error line, which is
 * the server's own text and is shown as it is. ssh's own failure lines are never shown; they
 * become a refusal code (`SshTunnel.exec`).
 */
import type { ServerRing } from "@orca/protocol";

/** The versions the app offers to put on a server: a release tag's numbers. */
export const SERVER_UPDATE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
/** The updater prints its failures as `orca-release: <message>` on stderr, and exits 1. */
const UPDATER_ERROR = /^orca-release: (.*)$/;
/** Progress lines kept for the dialog; the server's output is short, but never unbounded. */
export const SERVER_UPDATE_MAX_LINES = 200;

/** Where a server's updater and its deployment manifest are. */
export interface ServerUpdaterPaths {
  adapter: string;
  manifest: string;
}

/**
 * One look at the connected server, made by main: everything the dialog shows and the person
 * confirms. Approving and updating name a preview by `id`, never the fields themselves, and
 * main runs nothing unless a fresh look at the connection is still exactly this preview.
 */
export interface ServerUpdatePreview {
  id: string;
  profile: string;
  /** The connection, the host key its tunnel authenticated, and the daemon's workspace. */
  epoch: number;
  hostKey?: string;
  workspaceId?: string;
  /** What the server runs, and the release the app would put on it (the app's own). */
  serverVersion?: string;
  targetVersion: string;
  /** Where the daemon says its updater is: a hint, never what runs. */
  declared?: ServerUpdaterPaths;
  /** What the person entered and approved for this profile, host key and workspace. */
  approved?: ServerUpdaterPaths;
  /** Why "Update now" is not offered, or `undefined` when it is. */
  blocked?: string;
}

export interface ServerUpdaterApproval extends ServerUpdaterPaths {
  preview: string;
}
export interface ServerUpdateRequest {
  preview: string;
}

/** The only updater file the app runs on a server, whatever directory the person names. */
export const SERVER_UPDATER_NAME = "orca-release.py";

/** How one update attempt ended, as the dialog says it. */
export type ServerUpdateOutcome =
  /** The updater succeeded and a fresh hello from the same server reports `version`. */
  | { status: "updated"; version: string }
  /**
   * The updater may have run but how it ended is not known: the SSH session was lost after it
   * started, or it reported success and the server has not since said it runs `version`.
   * `serverVersion` is what the server last said, when it answered at all.
   */
  | { status: "unknown"; reason: "connection-lost" | "not-confirmed"; serverVersion?: string }
  /** The server refused to activate while work is running; nothing was cancelled. */
  | { status: "work-running"; detail: string }
  /** Another update holds the server's update lock: its timer, or another operator. */
  | { status: "another-update"; detail: string }
  /** The server no longer runs the release the update was confirmed against; nothing changed. */
  | { status: "moved"; detail: string }
  /** The update failed. `restored`: the server says the previous release is back and healthy. */
  | { status: "failed"; detail: string; restored: boolean }
  /** ssh refused before the updater could start; nothing ran. `message` is the app's own. */
  | { status: "unreachable"; refusal: string; message: string }
  /** No update was attempted, and why. */
  | { status: "unavailable"; reason: string };

/** One line of the updater's own output, as it ran. */
export interface ServerUpdateProgress {
  stream: "stdout" | "stderr";
  line: string;
}

/** What the renderer may ask, each about one preview main made. */
export interface ServerUpdateBridge {
  /** A fresh preview of the current profile connection's server, or `undefined` when it is not one. */
  read(this: void): Promise<ServerUpdatePreview | undefined>;
  /** Approve the updater paths the person entered, for the server in this preview. */
  approve(this: void, approval: ServerUpdaterApproval): Promise<{ ok: true } | { ok: false; message: string }>;
  update(this: void, request: ServerUpdateRequest): Promise<ServerUpdateOutcome>;
  /** Each line the updater prints while it runs. Returns the unsubscribe. */
  onProgress(this: void, listener: (progress: ServerUpdateProgress) => void): () => void;
}

/** What the connection snapshot says about the connected server's installation. */
export interface ManagedServerView {
  ring?: ServerRing;
}

/** A version a server can be running, as the updater records it. */
export const SERVER_RUNNING_VERSION = /^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/;

/**
 * The exact argv run on the server. `current` is the release the person confirmed the server
 * runs: the updater checks it under its update lock, where the update commits, and refuses
 * with `Server moved:` when another update got there first. Throws for a version the app
 * would never offer.
 */
export function serverUpdateCommand(deployment: ServerUpdaterPaths, version: string, current: string): string[] {
  if (!SERVER_UPDATE_VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!SERVER_RUNNING_VERSION.test(current)) throw new Error(`Not a release version: ${current}`);
  return [
    "python3",
    deployment.adapter,
    "--deployment",
    deployment.manifest,
    "update",
    "--bundle",
    `v${version}`,
    "--expect-current",
    current,
  ];
}

/** The updater's last `orca-release:` message, if it printed one. */
export function updaterError(lines: readonly ServerUpdateProgress[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = lines[i]!;
    if (entry.stream !== "stderr") continue;
    const match = UPDATER_ERROR.exec(entry.line);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

/** ssh refusals that come before the remote command can start: nothing ran on the server. */
const BEFORE_START = new Set(["ssh-missing", "host-key-changed", "host-key-missing", "auth-failed"]);

export function samePaths(a: ServerUpdaterPaths | undefined, b: ServerUpdaterPaths | undefined): boolean {
  return a !== undefined && b !== undefined && a.adapter === b.adapter && a.manifest === b.manifest;
}

/**
 * Read an exit and the updater's output into an outcome. An ssh failure that can come after
 * the command started (a dropped connection, a signal) is `unknown`, never "nothing changed";
 * a success is only provisional here, until a fresh hello confirms it (`ServerUpdater`).
 *
 * The messages matched are `orca-release.py`'s own: `Busy: update.lock` (another update
 * holds the lock), `Busy: admission.lock` and `Daemon busy:` (work is running; the CLI path's
 * blocker), an unmanaged ORCA process blocking activation, and `Activation failed; previous
 * release restored and healthy`.
 */
export function classifyServerUpdate(
  exit: { kind: "exited"; code: number } | { kind: "signalled"; signal: string } | { kind: "refused"; refusal: string },
  lines: readonly ServerUpdateProgress[],
  version: string,
  explain: (refusal: string) => string,
): ServerUpdateOutcome {
  if (exit.kind === "refused")
    return BEFORE_START.has(exit.refusal)
      ? { status: "unreachable", refusal: exit.refusal, message: explain(exit.refusal) }
      : { status: "unknown", reason: "connection-lost" };
  if (exit.kind === "signalled") return { status: "unknown", reason: "connection-lost" };
  if (exit.code === 0) return { status: "updated", version };
  const detail = updaterError(lines) ?? `The updater exited with ${exit.code}.`;
  if (/^Busy: update\.lock\b/.test(detail)) return { status: "another-update", detail };
  if (/^Server moved:/.test(detail)) return { status: "moved", detail };
  if (
    /^Busy: admission\.lock\b/.test(detail) ||
    /^Daemon busy:/.test(detail) ||
    /^Unmanaged ORCA process blocks activation/.test(detail)
  )
    return { status: "work-running", detail };
  return { status: "failed", detail, restored: /previous release restored and healthy/.test(detail) };
}

/** Whether `server` is older than `app`, by release numbers; an rc is older than its release. */
export function serverBehind(server: string, app: string): boolean {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(version);
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])]
      : undefined;
  };
  const a = parse(server);
  const b = parse(app);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}
