/**
 * `remotes.list` and `remotes.enroll` (#1206, protocol 2.13): delegation remotes enrolled by the
 * daemon that owns the workspace.
 *
 * `orca remote enroll` writes the enrollment files from a separate CLI process, which a
 * workspace the desktop app set up in first-run refuses ("First-run mutation requires owned
 * daemon admission"): only the daemon the app launched holds that workspace's writer fence. This
 * is the same enrollment run inside that daemon. It takes the same enrollment lock, makes the
 * same host-key and credential checks and writes the same files, so the CLI and the app can
 * never enroll one remote at once, and every later delegation trusts only the record either
 * leaves. Before it writes anything it requires the fence to be still held (`admitted`).
 */
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { OrcaError, type OrcaConfig, type RemoteDaemonSpec } from "@orca/core";
import type {
  RemoteEnrollmentView,
  RemotesEnrollParams,
  RemotesEnrollResult,
  RemotesListResult,
  RemoteView,
} from "@orca/protocol";
import type { SshTunnel } from "@orca/protocol/remote-access";
import { durableEnrollment, enrollRemote, pinFingerprints, readEnrollment, routeOf, sameRoute } from "./enrollment.js";
import { parseRemoteCredential, readRemoteCredential, remoteFiles, remoteProfile } from "./index.js";

export interface RemotesSource {
  configDir: string;
  /** The active generation's remotes and agents: the ones delegation uses. */
  config: () => Pick<OrcaConfig, "remotes" | "agents">;
  /** This daemon's delegation receipts (the store's `delegations/`). */
  receiptsDir: string;
  /** The principal a remote issues this workspace's credential to (`delegate-<workspace id>`). */
  principal: () => Promise<string>;
  /**
   * Whether this daemon may write the workspace now. For a workspace the desktop app set up in
   * first-run, whether this process still holds its writer fence; otherwise always true.
   */
  admitted: () => boolean;
  /** Test seam: the enrolling tunnel. */
  tunnel?: (knownHostsFile: string, pinnedOnly: boolean) => SshTunnel;
}

export interface RemotesModel {
  list(): RemotesListResult;
  enroll(params: RemotesEnrollParams): Promise<RemotesEnrollResult>;
}

/** The workflows a config's agents delegate to one remote, sorted and once each. */
function delegatedWorkflows(config: Pick<OrcaConfig, "agents">, id: string): string[] {
  return [
    ...new Set(
      config.agents.flatMap((a) =>
        a.type === "orca-daemon" && a.profile === id && a.workflow !== undefined ? [a.workflow] : [],
      ),
    ),
  ].sort();
}

function enrollmentView(remote: RemoteDaemonSpec, file: string): RemoteEnrollmentView {
  let record;
  try {
    record = readEnrollment(file);
  } catch {
    return { state: "unreadable" };
  }
  if (!record) return { state: "none" };
  if (record.profile !== remote.id) return { state: "unreadable" };
  let routeCurrent: boolean;
  try {
    routeCurrent = sameRoute(record.route, routeOf(remoteProfile(remote)));
  } catch {
    routeCurrent = false;
  }
  return {
    state: "enrolled",
    workspaceId: record.workspaceId,
    principalId: record.principalId,
    credentialId: record.credentialId,
    enrolledAt: record.enrolledAt,
    issued: record.issued === true,
    routeCurrent,
  };
}

/** Save a credential the person pasted where the remote's config says it lives: this user's only. */
function saveCredential(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

export function remotesModel(source: RemotesSource): RemotesModel {
  const view = (remote: RemoteDaemonSpec, config: Pick<OrcaConfig, "agents">): RemoteView => {
    const files = remoteFiles(source.configDir, remote);
    return {
      id: remote.id,
      name: remote.name ?? remote.id,
      destination: remote.destination,
      ...(remote.sshPort !== undefined ? { sshPort: remote.sshPort } : {}),
      ...(remote.jump ? { jump: remote.jump.destination } : {}),
      workflows: delegatedWorkflows(config, remote.id),
      pinned: pinFingerprints(files.knownHostsFile),
      jumpPinned: remote.jump ? pinFingerprints(`${files.knownHostsFile}.jump`) : [],
      credentialSaved: existsSync(files.credentialFile),
      enrollment: enrollmentView(remote, files.enrollmentFile),
    };
  };
  const fenced = () =>
    new OrcaError(
      "DELEGATION_REFUSED",
      "This daemon no longer holds the workspace's writer fence, so it cannot enroll a remote for it. Reconnect from the desktop app and try again.",
      { reason: "not-enrolled" },
    );
  return {
    list() {
      const config = source.config();
      return { remotes: config.remotes.map((r) => view(r, config)), canIssue: durableEnrollment() };
    },
    async enroll(params) {
      if (!source.admitted()) throw fenced();
      const config = source.config();
      const remote = config.remotes.find((r) => r.id === params.id);
      if (!remote)
        throw new OrcaError(
          "CONFIG_INVALID",
          `No remotes[] entry in the active configuration has id ${params.id}. Add it, save and apply, then enroll.`,
          { id: params.id },
        );
      if (params.credential !== undefined && params.rotate)
        throw new OrcaError("CONFIG_INVALID", "A saved credential cannot be combined with issuing a new one.");
      const profile = remoteProfile(remote);
      const files = remoteFiles(source.configDir, remote);
      const workflows = delegatedWorkflows(config, remote.id);
      let token: string | undefined;
      if (params.credential !== undefined) {
        token = parseRemoteCredential(params.credential);
        if (token === undefined)
          throw new OrcaError(
            "CONFIG_INVALID",
            "That is not an ORCA credential. Paste the token, or the whole output of `orca auth issue <name> --preset client --json` on the remote.",
          );
        // Again just before the write: the fence may have been lost while the request waited.
        if (!source.admitted()) throw fenced();
        saveCredential(files.credentialFile, token);
      }
      // As the CLI decides: a saved credential is used as given; without one, or with `rotate`,
      // the remote issues it.
      const rotate = params.rotate === true;
      const issue = token === undefined && (rotate || !existsSync(files.credentialFile));
      if (!issue && token === undefined) token = readRemoteCredential(remote, files.credentialFile);
      const warnings: string[] = [];
      if (!source.admitted()) throw fenced();
      await enrollRemote({
        remote,
        profile,
        knownHostsFile: files.knownHostsFile,
        file: files.enrollmentFile,
        workflows,
        receiptsDir: source.receiptsDir,
        ...(issue ? { issue: { principal: await source.principal(), rotate } } : { token: token! }),
        hostKeys: params.hostKeys ?? [],
        jumpHostKeys: params.jumpHostKeys ?? [],
        warn: (message) => warnings.push(message),
        ...(source.tunnel ? { tunnel: source.tunnel } : {}),
      });
      return { remote: view(remote, config), warnings };
    },
  };
}
