/**
 * Updating a remote server from the app (#879): the contract the main process, the preload
 * bridge and the connection dialog share, and the pure parts of the main process's work.
 *
 * **Nothing installs through the daemon.** The daemon only reports, in `hello.deployment`,
 * that the managed server updater launched it and where that updater is. The update itself
 * is the updater run on the server over the profile's own SSH connection (`SshTunnel.exec`:
 * the pinned host key, the person's key, no forwards), exactly the command an operator types:
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
import type { ManagedDeployment, ServerRing } from "@orca/protocol";

/** The versions the app offers to put on a server: a release tag's numbers. */
export const SERVER_UPDATE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
/** The updater prints its failures as `orca-release: <message>` on stderr, and exits 1. */
const UPDATER_ERROR = /^orca-release: (.*)$/;
/** Progress lines kept for the dialog; the server's output is short, but never unbounded. */
export const SERVER_UPDATE_MAX_LINES = 200;

/** How one update attempt ended, as the dialog says it. */
export type ServerUpdateOutcome =
  /** This app's update ran and the server now runs `version`. */
  | { status: "updated"; version: string }
  /** The server refused to activate while work is running; nothing was cancelled. */
  | { status: "work-running"; detail: string }
  /** Another update holds the server's update lock: its timer, or another operator. */
  | { status: "another-update"; detail: string }
  /** The update failed. `restored`: the server says the previous release is back and healthy. */
  | { status: "failed"; detail: string; restored: boolean }
  /** ssh could not run the updater; the server's state is whatever it was. `message` is the app's own. */
  | { status: "unreachable"; refusal: string; message: string }
  /** No update was attempted, and why. */
  | { status: "unavailable"; reason: string };

/** One line of the updater's own output, as it ran. */
export interface ServerUpdateProgress {
  stream: "stdout" | "stderr";
  line: string;
}

/** What the renderer may ask: update the connected server to this app's version. */
export interface ServerUpdateBridge {
  update(this: void): Promise<ServerUpdateOutcome>;
  /** Each line the updater prints while it runs. Returns the unsubscribe. */
  onProgress(this: void, listener: (progress: ServerUpdateProgress) => void): () => void;
}

/** What the connection snapshot says about the connected server's installation. */
export interface ManagedServerView {
  ring?: ServerRing;
}

/** The exact argv run on the server. Throws for a version the app would never offer. */
export function serverUpdateCommand(deployment: ManagedDeployment, version: string): string[] {
  if (!SERVER_UPDATE_VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  return ["python3", deployment.adapter, "--deployment", deployment.manifest, "update", "--bundle", `v${version}`];
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

/**
 * Read an exit and the updater's output into an outcome. The messages matched are
 * `orca-release.py`'s own: `Busy: update.lock` (another update holds the lock),
 * `Busy: admission.lock` and `Daemon busy:` (work is running; the CLI path's blocker), an
 * unmanaged ORCA process blocking activation, and `Activation failed; previous release
 * restored and healthy`.
 */
export function classifyServerUpdate(
  exit: { kind: "exited"; code: number } | { kind: "signalled"; signal: string } | { kind: "refused"; refusal: string },
  lines: readonly ServerUpdateProgress[],
  version: string,
  explain: (refusal: string) => string,
): ServerUpdateOutcome {
  if (exit.kind === "refused") return { status: "unreachable", refusal: exit.refusal, message: explain(exit.refusal) };
  if (exit.kind === "exited" && exit.code === 0) return { status: "updated", version };
  const detail =
    updaterError(lines) ??
    (exit.kind === "signalled" ? `The updater stopped (${exit.signal}).` : `The updater exited with ${exit.code}.`);
  if (/^Busy: update\.lock\b/.test(detail)) return { status: "another-update", detail };
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
