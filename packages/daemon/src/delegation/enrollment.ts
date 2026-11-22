/**
 * Enrolling a remote daemon (#883): the one deliberate step after which this daemon may send
 * that remote a bearer credential unattended.
 *
 * `orca remote enroll <id>` connects once (the only connect that may pin a host key on first
 * use), seals the server's and jump host's pins, and checks with the credential that the
 * daemon there names the workspace and principal it does. It records all of that in
 * `auth/remotes/<id>.json`. Every later delegation session then:
 *
 * - opens its tunnel with `pinnedOnly` and `expectKeys` set to the recorded keys, so no ssh
 *   carries a byte to a host whose key is not the enrolled one, and no key is ever trusted on
 *   first use outside enrollment;
 * - sends the bearer only if its credential id is the enrolled one;
 * - refuses before any mutation unless the daemon names the enrolled workspace and principal,
 *   and binds every admission to them with `expectedScope`.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError, type RemoteDaemonSpec } from "@orca/core";
import { HelloResultSchema, helloOffer, OperatorDiscoverySchema } from "@orca/protocol";
import { SshTunnel, TunnelRefusal } from "@orca/protocol/remote-access";
import { RemoteDaemonClient } from "./remote-client.js";

export const EnrollmentSchema = z
  .object({
    version: z.literal(1),
    profile: z.string().min(1),
    /** `SshTunnel.pinnedKeys` after the enrolling connect: the server's (and jump host's) keys. */
    keys: z.string().min(1),
    workspaceId: z.string().min(1),
    principalId: z.string().min(1),
    /** The id half of the enrolled credential (`orca1.<id>.<secret>`). Never the secret. */
    credentialId: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    enrolledAt: z.string(),
  })
  .strict();
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export function enrollmentFile(configDir: string, remoteId: string): string {
  return resolve(configDir, "auth", "remotes", `${remoteId}.json`);
}

/** The credential id of an ORCA token. */
export function credentialIdOf(token: string): string {
  return token.split(".")[1] ?? "";
}

/** The enrollment record, or undefined when the remote was never enrolled. Unreadable refuses. */
export function readEnrollment(file: string): Enrollment | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return EnrollmentSchema.parse(JSON.parse(text));
}

function writeEnrollment(file: string, record: Enrollment): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(record, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

export interface EnrollOptions {
  remote: RemoteDaemonSpec;
  profile: import("@orca/protocol/remote-access").ConnectionProfile;
  knownHostsFile: string;
  file: string;
  token: string;
  /** Test seam. */
  tunnel?: SshTunnel;
}

/**
 * Connect once, seal the pins, prove the credential, and record what was proven. The person
 * runs this; it is the only place a delegating daemon trusts a host key on first use.
 */
export async function enrollRemote(options: EnrollOptions): Promise<Enrollment> {
  const tunnel = options.tunnel ?? new SshTunnel({ profile: options.profile, knownHostsFile: options.knownHostsFile });
  const client = new RemoteDaemonClient({ connect: () => tunnel.connect(), token: options.token });
  try {
    try {
      await tunnel.open();
    } catch (error) {
      throw new OrcaError("DELEGATION_REFUSED", `SSH to ${options.remote.id} failed: ${(error as Error).message}`, {
        reason: "tunnel",
        profile: options.remote.id,
        ...(error instanceof TunnelRefusal ? { tunnel: error.code } : {}),
      });
    }
    const keys = tunnel.pinnedKeys;
    if (!keys)
      throw new OrcaError("DELEGATION_REFUSED", `The host keys of ${options.remote.id} could not be pinned.`, {
        reason: "tunnel",
        profile: options.remote.id,
      });
    const hello = HelloResultSchema.parse(
      await client.call("hello", { client: "orca-daemon/enroll", ...helloOffer() }),
    );
    const discovery = OperatorDiscoverySchema.parse(await client.call("operator.discover", {}));
    if (hello.identity && hello.identity.workspaceId !== discovery.target.workspaceId)
      throw new OrcaError("DELEGATION_REFUSED", `The daemon on ${options.remote.id} named two different workspaces.`, {
        reason: "scope-changed",
        profile: options.remote.id,
      });
    const record: Enrollment = {
      version: 1,
      profile: options.remote.id,
      keys,
      workspaceId: discovery.target.workspaceId,
      principalId: discovery.principalId,
      credentialId: credentialIdOf(options.token),
      enrolledAt: new Date().toISOString(),
    };
    writeEnrollment(options.file, record);
    return record;
  } finally {
    client.close();
    await tunnel.close().catch(() => undefined);
  }
}
