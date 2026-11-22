/**
 * The main process's half of updating a remote server (#879): one update at a time, run as
 * the server's own updater over the current SSH profile's pinned connection, its output
 * streamed to the windows and its exit read into an outcome (`../server-update.ts`).
 *
 * Nothing here goes through the daemon. It only reported where its updater is.
 */
import type { ManagedDeployment } from "@orca/protocol";
import { TunnelRefusal, type RemoteCommand, type TunnelRefusalCode } from "@orca/protocol/remote-access";
import {
  classifyServerUpdate,
  SERVER_UPDATE_MAX_LINES,
  SERVER_UPDATE_VERSION,
  serverUpdateCommand,
  type ServerUpdateOutcome,
  type ServerUpdateProgress,
} from "../server-update.js";

export interface ServerUpdaterDeps {
  /** This app's version: the release the server is updated to. */
  version: string;
  /** `hello.deployment` of the connected daemon, when the managed updater launched it. */
  deployment(): ManagedDeployment | undefined;
  /** Runs `command` over the current profile's ssh; `undefined` when the connection is not a profile. */
  run(
    command: readonly string[],
    onLine: (stream: "stdout" | "stderr", line: string) => void,
  ): { command: RemoteCommand } | undefined;
  onProgress(progress: ServerUpdateProgress): void;
}

export class ServerUpdater {
  private running: Promise<ServerUpdateOutcome> | undefined;
  private current: RemoteCommand | undefined;

  constructor(private readonly deps: ServerUpdaterDeps) {}

  /** Single-flight: a second ask while one runs gets the same outcome, not a second updater. */
  update(): Promise<ServerUpdateOutcome> {
    this.running ??= this.attempt().finally(() => {
      this.running = undefined;
      this.current = undefined;
    });
    return this.running;
  }

  /** Quit: hang up the ssh session. The server's updater finishes or rolls back on its own. */
  stop(): void {
    this.current?.kill();
  }

  private async attempt(): Promise<ServerUpdateOutcome> {
    const deployment = this.deps.deployment();
    if (!deployment)
      return { status: "unavailable", reason: "This server was not installed by the managed server updater." };
    if (!SERVER_UPDATE_VERSION.test(this.deps.version))
      return { status: "unavailable", reason: `This app (${this.deps.version}) is not a release build.` };
    const lines: ServerUpdateProgress[] = [];
    const onLine = (stream: "stdout" | "stderr", line: string) => {
      const progress = { stream, line };
      lines.push(progress);
      if (lines.length > SERVER_UPDATE_MAX_LINES) lines.shift();
      this.deps.onProgress(progress);
    };
    let started: { command: RemoteCommand } | undefined;
    try {
      started = this.deps.run(serverUpdateCommand(deployment, this.deps.version), onLine);
    } catch (error) {
      if (!(error instanceof TunnelRefusal)) throw error;
      return { status: "unreachable", refusal: error.code, message: error.message };
    }
    if (!started)
      return { status: "unavailable", reason: "Only a server reached through an SSH profile can be updated." };
    this.current = started.command;
    return classifyServerUpdate(await started.command.exit, lines, this.deps.version, explainRefusal);
  }
}

/** The app's own words for an ssh refusal, never ssh's. */
function explainRefusal(refusal: string): string {
  return new TunnelRefusal(refusal as TunnelRefusalCode).message;
}
