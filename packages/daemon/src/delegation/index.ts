/**
 * Delegating steps to another ORCA daemon (#883): the session factory that routes a
 * `type: orca-daemon` agent to its remote, and everything about a remote that lives beside
 * this daemon's config.
 *
 * Per remote, beside the config file (all under `auth/`, which ORCA refuses to its agents):
 *
 * - `auth/remotes/<id>.token`: the bearer credential the remote daemon issued for this daemon
 *   (`orca auth issue <principal> --json` there). Read at every session open, never logged.
 *   `credentialFile` moves it.
 * - `auth/remotes/<id>.known_hosts`: the remote's SSH host keys (and its jump host's), pinned
 *   only by `orca remote enroll <id>`.
 * - `auth/remotes/<id>.json`: the enrollment record (`enrollment.ts`): the sealed keys, the
 *   workspace and principal the daemon there named, and the enrolled credential's id.
 *
 * A remote that was never enrolled is refused before any connection. Each session opens its own
 * tunnel, trusting only the enrolled keys, and closes it with the session, so a session's slot
 * (#873) is held exactly while its ssh processes live. What each session asked the remote to run
 * is recorded under the store's `delegations/` (`receipts.ts`).
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { OrcaError, type AgentSpec, type OrcaConfig, type RemoteDaemonSpec } from "@orca/core";
import type { AgentSession, OpenSessionOptions } from "@orca/agents";
import {
  ConnectionProfileSchema,
  SshTunnel,
  TunnelRefusal,
  type ConnectionProfile,
  type TunnelRefusalCode,
} from "@orca/protocol/remote-access";
import { delegationRefusal, openDaemonSession, type DelegationTransport } from "./daemon-session.js";
import { credentialIdOf, enrollmentFile, readEnrollment, routeOf, sameRoute, type Enrollment } from "./enrollment.js";
import { DelegationReceipts, type DelegationBinding } from "./receipts.js";

export {
  delegationRefusal,
  DELEGATION_METHODS,
  openDaemonSession,
  type DelegationRefusalReason,
  type DelegationTransport,
  type OpenDaemonSessionOptions,
} from "./daemon-session.js";
export { RemoteDaemonClient, RemoteFault, RemoteUnreachable } from "./remote-client.js";
export {
  delegationKey,
  DelegationReceipts,
  DelegationReceiptSchema,
  ReceiptConflict,
  type DelegationBinding,
  type DelegationReceipt,
} from "./receipts.js";
export {
  credentialIdOf,
  enrollmentFile,
  enrollRemote,
  EnrollmentSchema,
  readEnrollment,
  type Enrollment,
  type EnrollOptions,
} from "./enrollment.js";

/** Tunnel refusals that only the person can fix; a retry would meet them again. */
const PERMANENT_TUNNEL: ReadonlySet<TunnelRefusalCode> = new Set([
  "ssh-missing",
  "host-key-changed",
  "host-key-missing",
  "pin-write-failed",
  "auth-failed",
]);

/** The shared connection profile for a configured remote, or why it is not one. */
export function remoteProfile(remote: RemoteDaemonSpec): ConnectionProfile {
  const parsed = ConnectionProfileSchema.safeParse({
    id: remote.id,
    name: remote.name ?? remote.id,
    destination: remote.destination,
    ...(remote.sshPort !== undefined ? { sshPort: remote.sshPort } : {}),
    ...(remote.identityFile !== undefined ? { identityFile: remote.identityFile } : {}),
    ...(remote.jump ? { jump: remote.jump } : {}),
    ...(remote.remotePort !== undefined ? { remotePort: remote.remotePort } : {}),
    ...(remote.serverCommand !== undefined ? { serverCommand: remote.serverCommand } : {}),
    ...(remote.serverConfig !== undefined ? { serverConfig: remote.serverConfig } : {}),
  });
  if (!parsed.success)
    throw delegationRefusal(
      remote.id,
      "profile-invalid",
      `remotes[${remote.id}]: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

/** Problems with the configured remotes, as `path: message` lines for config validation. */
export function validateRemotes(config: Pick<OrcaConfig, "remotes">): string[] {
  const problems: string[] = [];
  for (const remote of config.remotes)
    try {
      remoteProfile(remote);
    } catch (error) {
      problems.push((error as Error).message);
    }
  return problems;
}

export interface RemoteFiles {
  credentialFile: string;
  knownHostsFile: string;
  enrollmentFile: string;
}

/** Where a remote's credential and pinned host key live, beside the config. */
export function remoteFiles(configDir: string, remote: RemoteDaemonSpec): RemoteFiles {
  const credential = remote.credentialFile ?? `auth/remotes/${remote.id}.token`;
  return {
    credentialFile: isAbsolute(credential) ? credential : resolve(configDir, credential),
    knownHostsFile: resolve(configDir, "auth", "remotes", `${remote.id}.known_hosts`),
    enrollmentFile: enrollmentFile(configDir, remote.id),
  };
}

const TOKEN = /^orca1\.[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/;

/** The remote's credential, or a refusal saying how to provide one. Never echoes the file. */
export function readRemoteCredential(remote: RemoteDaemonSpec, file: string): string {
  const missing = (detail: string) =>
    delegationRefusal(
      remote.id,
      "credential-missing",
      `No usable credential for remote ${remote.id} (${detail}). On the remote, run \`orca auth issue <name> --preset client --json\` and save its token to ${file}, readable only by this user.`,
    );
  let text: string;
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0)
      throw missing("the file is readable by other users");
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof OrcaError) throw error;
    throw missing("the file cannot be read");
  }
  // The file may be a bare token, or `orca auth issue --json`'s output saved as is.
  let token = text.trim();
  if (token.startsWith("{"))
    try {
      const field = (JSON.parse(token) as { token?: unknown }).token;
      token = typeof field === "string" ? field : "";
    } catch {
      token = "";
    }
  if (!TOKEN.test(token)) throw missing("it does not hold an ORCA token");
  return token;
}

/**
 * What a session's receipts are bound to: the enrolled scope and credential, the enrollment
 * itself (a re-enrollment is another binding), the workflow, the parent run's configuration
 * generation, and the remote endpoint and prompt variable.
 */
export function delegationBinding(
  enrollment: Enrollment,
  profile: ConnectionProfile,
  agent: Pick<AgentSpec, "workflow" | "promptVar">,
  configGeneration: string,
): DelegationBinding {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    workspaceId: enrollment.workspaceId,
    principalId: enrollment.principalId,
    credentialId: enrollment.credentialId,
    workflowId: agent.workflow!,
    configGeneration,
    enrollment: digest(enrollment),
    target: digest({
      destination: profile.destination,
      sshPort: profile.sshPort ?? null,
      jump: profile.jump ?? null,
      remotePort: profile.remotePort ?? null,
      serverCommand: profile.serverCommand ?? null,
      serverConfig: profile.serverConfig ?? null,
      promptVar: agent.promptVar ?? "prompt",
    }),
  };
}

/** The remote's enrollment record, or a refusal saying how to enroll it. */
export function enrolled(remote: RemoteDaemonSpec, files: RemoteFiles): Enrollment {
  let record: Enrollment | undefined;
  try {
    record = readEnrollment(files.enrollmentFile);
  } catch {
    throw delegationRefusal(
      remote.id,
      "not-enrolled",
      `The enrollment record for remote ${remote.id} (${files.enrollmentFile}) cannot be read. Run \`orca remote enroll ${remote.id}\` again.`,
    );
  }
  if (!record || record.profile !== remote.id)
    throw delegationRefusal(
      remote.id,
      "not-enrolled",
      `Remote ${remote.id} is not enrolled, so this daemon does not send it a credential. Run \`orca remote enroll ${remote.id}\` once to pin its host keys and check its credential.`,
    );
  return record;
}

/** An SSH tunnel as the session's transport. */
export function tunnelTransport(tunnel: SshTunnel): DelegationTransport {
  let permanent: TunnelRefusalCode | undefined;
  return {
    connect: () => {
      try {
        return tunnel.connect();
      } catch (error) {
        if (error instanceof TunnelRefusal && PERMANENT_TUNNEL.has(error.code)) permanent = error.code;
        throw error;
      }
    },
    failed: () => {
      const state = tunnel.state;
      if (state.phase === "failed" && PERMANENT_TUNNEL.has(state.refusal)) permanent = state.refusal;
      return permanent ? "tunnel" : undefined;
    },
    close: () => tunnel.close(),
  };
}

export interface DelegationOptions {
  /** The config's remotes, read at each open so an applied config edit takes effect. */
  remotes: () => readonly RemoteDaemonSpec[];
  configDir: string;
  /** Where delegation receipts are kept: the store's `delegations/`. */
  receiptsDir: string;
  /** Test seam: the tunnel for a profile (always pinned-only, expecting the enrolled keys). */
  tunnel?: (profile: ConnectionProfile, files: RemoteFiles, enrollment: Enrollment) => SshTunnel;
  /** Test seam: how often a running remote run is read. */
  pollMs?: number;
}

/** What the engine says a session is opened for (`SessionOrigin` in `@orca/engine`). */
export interface DelegationOrigin {
  runId: string;
  generationId?: string;
  remotes?: readonly RemoteDaemonSpec[];
}
export type SessionFactoryLike = (options: OpenSessionOptions & { origin?: DelegationOrigin }) => Promise<AgentSession>;

/**
 * Wrap a session factory so `type: orca-daemon` agents open a session on their remote daemon
 * and every other agent goes to `base` unchanged.
 */
export function delegatingSessionFactory(base: SessionFactoryLike, options: DelegationOptions): SessionFactoryLike {
  const receipts = new DelegationReceipts(options.receiptsDir);
  return async (open) => {
    if (open.agent.type !== "orca-daemon") return base(open);
    const id = open.agent.profile!;
    // The remotes of the generation the parent run is bound to, not of whichever is current.
    const remote = (open.origin?.remotes ?? options.remotes()).find((r) => r.id === id);
    if (!remote) throw delegationRefusal(id, "profile-invalid", `no remotes[] entry has id ${id}`);
    const profile = remoteProfile(remote);
    const files = remoteFiles(options.configDir, remote);
    const token = readRemoteCredential(remote, files.credentialFile);
    const enrollment = enrolled(remote, files);
    // The bearer goes only where enrollment proved it belongs: this route, these keys, this
    // credential. Each is checked before ssh starts.
    if (!sameRoute(routeOf(profile), enrollment.route))
      throw delegationRefusal(
        id,
        "not-enrolled",
        `Remote ${id} is configured to a different address, port or jump host than it was enrolled over. Nothing was sent. Run \`orca remote enroll ${id}\` to enroll the new route.`,
      );
    if (credentialIdOf(token) !== enrollment.credentialId)
      throw delegationRefusal(
        id,
        "not-enrolled",
        `The credential for remote ${id} is not the one it was enrolled with. Run \`orca remote enroll ${id}\` to enroll it.`,
      );
    const tunnel =
      options.tunnel?.(profile, files, enrollment) ??
      new SshTunnel({
        profile,
        knownHostsFile: files.knownHostsFile,
        pinnedOnly: true,
        expectKeys: enrollment.keys,
      });
    try {
      await tunnel.open();
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      const code = error instanceof TunnelRefusal ? error.code : "ssh-failed";
      if (PERMANENT_TUNNEL.has(code))
        throw delegationRefusal(id, "tunnel", `SSH to remote ${id} was refused: ${(error as Error).message}`, {
          tunnel: code,
        });
      throw new OrcaError("AGENT_TRANSPORT", `SSH to remote ${id} failed: ${(error as Error).message}`, {
        profile: id,
        tunnel: code,
      });
    }
    return openDaemonSession({
      agent: open.agent,
      host: open.host,
      cwd: open.cwd,
      profile: id,
      remoteName: profile.name,
      transport: tunnelTransport(tunnel),
      token,
      binding: delegationBinding(enrollment, profile, open.agent, open.origin?.generationId ?? "unversioned"),
      receipts,
      ...(open.askPermission ? { askPermission: (req, invocation) => open.askPermission!(req, invocation) } : {}),
      ...(open.logger ? { logger: open.logger } : {}),
      ...(open.clock ? { clock: open.clock } : {}),
      ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    });
  };
}
