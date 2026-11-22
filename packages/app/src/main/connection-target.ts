/** Probe, guard and commit one authenticated target without disturbing the live connection. */
import { isCompatible, PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { authenticationCode } from "../client/auth.js";
import type { DaemonClient } from "../client/daemon-client.js";
import { daemonEndpoint, type DaemonConnectionRequest } from "../daemon-connection.js";
import { CredentialTransportUnavailable } from "../client/auth.js";
import { CredentialStorageUnavailable, TunnelRefusal } from "@orca/protocol/remote-access";

export interface ConnectionCandidate {
  client: DaemonClient;
  check?: () => void;
  /** Main-only final identity validation before synchronous preference publication. */
  validateActivation?: (hello: HelloResult) => void;
  /** A sentence for a failed probe that the transport can explain (a profile's tunnel). */
  explainFailure?: (error: unknown) => string | undefined;
  /** Synchronous publication: no await between persistence and activation. */
  activate(hello: HelloResult): void;
  dispose(): Promise<void>;
}
export function connectionFailure(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null &&
    "code" in error.error &&
    error.error.code === "PROTOCOL_VERSION"
  ) {
    return "Daemon protocol mismatch. Install compatible app and daemon versions.";
  }
  const code = authenticationCode(error);
  if (code === "AUTH_REQUIRED")
    return "Authentication required. Import a credential for the profile, or configure ORCA_DAEMON_TOKEN_FILE for a URL connection.";
  if (code === "AUTH_INVALID")
    return "Credential invalid or revoked. Import a new credential for the profile, or update the configured credential file.";
  if (code === "AUTH_FORBIDDEN") return "This credential is not authorized to access the daemon.";
  return error instanceof ConnectionRefusal ||
    error instanceof TunnelRefusal ||
    error instanceof CredentialTransportUnavailable ||
    error instanceof CredentialStorageUnavailable
    ? error.message
    : "The daemon could not be reached or returned an invalid handshake.";
}
export class ConnectionRefusal extends Error {}

/** A candidate never touches the live stream or preference until its probe succeeds. */
export class ConnectionTarget {
  private attempt = 0;
  private committing = false;
  constructor(
    private readonly deps: {
      explicitUrl?: string | undefined;
      prepare(request: DaemonConnectionRequest, source: "saved" | "env"): Promise<ConnectionCandidate>;
      save(request: DaemonConnectionRequest): void;
      guard(): Promise<boolean>;
      release(): void;
    },
  ) {}
  cancel(): void {
    this.attempt += 1;
  }
  async connect(input: DaemonConnectionRequest): Promise<void> {
    if (this.deps.explicitUrl)
      throw new ConnectionRefusal("ORCA_DAEMON_URL controls this launch. Unset it and restart to change the daemon.");
    return this.change(input, "saved");
  }
  /** Return only to the launch-pinned endpoint; it is never a saved preference. */
  async returnToEnvironment(): Promise<void> {
    if (!this.deps.explicitUrl) throw new ConnectionRefusal("No environment daemon is configured for this launch.");
    return this.change(this.deps.explicitUrl, "env");
  }
  private async change(input: DaemonConnectionRequest, source: "saved" | "env"): Promise<void> {
    if (this.committing) throw new ConnectionRefusal("A connection change is already being committed.");
    let url: DaemonConnectionRequest;
    if (input !== null && typeof input === "object") {
      if (source !== "saved" || typeof input.profile !== "string")
        throw new ConnectionRefusal("Choose a saved connection profile.");
      url = { profile: input.profile };
    } else
      try {
        url = input === null ? null : daemonEndpoint(input);
      } catch {
        throw new ConnectionRefusal("Enter an HTTP or HTTPS URL without credentials, query parameters or fragments.");
      }
    const attempt = ++this.attempt;
    let candidate: ConnectionCandidate | undefined;
    let activated = false;
    let guarded = false;
    try {
      candidate = await this.deps.prepare(url, source);
      // Fetch is abortable and bounded in DaemonClient; cancellation also fences its result.
      let hello: HelloResult;
      try {
        hello = await candidate.client.hello("orca-app/connection");
      } catch (error) {
        const explained = candidate.explainFailure?.(error);
        if (explained) throw new ConnectionRefusal(explained);
        throw error;
      }
      if (!isCompatible(PROTOCOL_VERSION, hello.protocol))
        throw new ConnectionRefusal("Daemon protocol mismatch. Install compatible app and daemon versions.");
      if (!hello.capabilities.includes("runs.read") || !hello.capabilities.includes("runs.subscribe")) {
        throw new ConnectionRefusal(
          "This daemon does not authorize the read and subscription capabilities required by the app.",
        );
      }
      if (attempt !== this.attempt) throw new ConnectionRefusal("Connection cancelled.");
      this.committing = true;
      guarded = true;
      if (!(await this.deps.guard()))
        throw new ConnectionRefusal("Save or discard pending edits before changing daemons.");
      if (attempt !== this.attempt) throw new ConnectionRefusal("Connection cancelled.");
      candidate.check?.();
      candidate.validateActivation?.(hello);
      if (source === "saved") this.deps.save(url);
      candidate.activate(hello);
      activated = true;
    } finally {
      if (guarded) {
        this.deps.release();
        this.committing = false;
      }
      if (candidate && !activated) await candidate.dispose();
    }
  }
}

/** Fence queued requests and late results; never retry a write against a replacement. */
export async function callInConnection<R>(
  workspace: { ready(): Promise<void>; assertEpoch(epoch: number): void },
  epoch: number,
  run: () => Promise<R>,
): Promise<R> {
  workspace.assertEpoch(epoch);
  await workspace.ready();
  workspace.assertEpoch(epoch);
  const result = await run();
  workspace.assertEpoch(epoch);
  return result;
}
