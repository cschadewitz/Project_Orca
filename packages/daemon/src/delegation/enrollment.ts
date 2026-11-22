/**
 * Enrolling a remote daemon (#883): the one deliberate step after which this daemon may send
 * that remote a bearer credential unattended.
 *
 * `orca remote enroll <id>` connects once and trusts nothing it has not verified first. Each
 * hop's host key must be either already pinned beside the config (`auth/remotes/<id>.known_hosts`
 * and `.jump`, placed there by the person) or match a fingerprint the person supplies
 * (`--host-key` / `--jump-host-key`, `SHA256:…` as `ssh-keygen -l` prints it on the remote).
 * A hop that is neither is refused before ssh starts; a presented key that matches no supplied
 * fingerprint is refused before any byte reaches the daemon, so the bearer is never sent to an
 * unverified host. Then the credential is checked: the daemon there must name one workspace,
 * and the principal it answers for is recorded with it in `auth/remotes/<id>.json`.
 *
 * Every later delegation session then:
 *
 * - opens its tunnel with `pinnedOnly` and `expectKeys` set to the recorded keys, so no ssh
 *   carries a byte to a host whose key is not the enrolled one;
 * - sends the bearer only if its credential id is the enrolled one;
 * - refuses before any mutation unless the daemon names the enrolled workspace and principal,
 *   and binds every admission to them with `expectedScope`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { OrcaError, type RemoteDaemonSpec } from "@orca/core";
import { HelloResultSchema, helloOffer, OperatorDiscoverySchema } from "@orca/protocol";
import {
  markPinEnrolled,
  pinState,
  SshTunnel,
  TunnelRefusal,
  type ConnectionProfile,
} from "@orca/protocol/remote-access";
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

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** A fingerprint as the person may type it: `SHA256:<base64>`, padding optional. */
export function normalizeFingerprint(value: string): string {
  const match = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(value.trim());
  if (!match)
    throw new OrcaError(
      "CONFIG_INVALID",
      `${value} is not a host key fingerprint; give it as ssh-keygen -l prints it, SHA256:…`,
    );
  return `SHA256:${match[1]}`;
}

/** The fingerprints (`SHA256:…`) of every key a known_hosts file holds. */
export function pinFingerprints(knownHostsFile: string): string[] {
  let text: string;
  try {
    text = readFileSync(knownHostsFile, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/^[^#\s]\S*\s+\S+\s+([A-Za-z0-9+/]+=*)(?:\s|$)/gm)].map(
    (m) => `SHA256:${createHash("sha256").update(Buffer.from(m[1]!, "base64")).digest("base64").replace(/=+$/, "")}`,
  );
}

export interface EnrollOptions {
  remote: RemoteDaemonSpec;
  profile: ConnectionProfile;
  knownHostsFile: string;
  file: string;
  token: string;
  /** Fingerprints the server's key may have, from the remote itself (`ssh-keygen -l` there). */
  hostKeys?: readonly string[];
  /** The same for the jump host, when the profile has one. */
  jumpHostKeys?: readonly string[];
  /** Test seam: the tunnel over a pin file. */
  tunnel?: (knownHostsFile: string, pinnedOnly: boolean) => SshTunnel;
}

interface Hop {
  name: string;
  file: string;
  supplied: string[];
  state: ReturnType<typeof pinState>;
}

/**
 * Verify the hops' keys, then prove the credential and record what was proven. The person
 * runs this; it is the only place a delegating daemon pins a host key, and only one it was
 * given the fingerprint of.
 */
export async function enrollRemote(options: EnrollOptions): Promise<Enrollment> {
  const id = options.remote.id;
  const refuse = (message: string, details: Record<string, unknown> = {}) =>
    new OrcaError("DELEGATION_REFUSED", message, { reason: "not-enrolled", profile: id, ...details });
  const hops: Hop[] = [
    {
      name: "server",
      file: options.knownHostsFile,
      supplied: (options.hostKeys ?? []).map(normalizeFingerprint),
      state: pinState(options.knownHostsFile),
    },
  ];
  if (options.profile.jump)
    hops.push({
      name: "jump host",
      file: `${options.knownHostsFile}.jump`,
      supplied: (options.jumpHostKeys ?? []).map(normalizeFingerprint),
      state: pinState(`${options.knownHostsFile}.jump`),
    });
  else if (options.jumpHostKeys?.length) throw refuse(`Remote ${id} has no jump host; drop --jump-host-key.`);

  for (const hop of hops) {
    if (hop.state === "broken")
      throw refuse(`The ${hop.name} pin for remote ${id} (${hop.file}) is damaged. Remove it, then enroll again.`);
    if (hop.state === "none" && hop.supplied.length === 0)
      throw refuse(
        `The ${hop.name} of remote ${id} has no pinned host key, so this daemon cannot tell it is the right machine. On that machine, run \`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\` and pass its SHA256:… fingerprint with ${hop.name === "server" ? "--host-key" : "--jump-host-key"}.`,
      );
    // A pin already on file must still be the key the person says it is.
    if (
      hop.state === "pinned" &&
      hop.supplied.length &&
      !pinFingerprints(hop.file).some((f) => hop.supplied.includes(f))
    )
      throw refuse(`The ${hop.name} key pinned for remote ${id} is not the one given; nothing was sent.`);
  }

  // Unpinned hops are pinned into a staging copy first, and checked against the supplied
  // fingerprints before anything else crosses the tunnel; only then do they become the pins.
  const fresh = hops.filter((h) => h.state === "none");
  const staging = fresh.length ? join(dirname(options.knownHostsFile), `.enroll-${randomUUID()}`) : undefined;
  const pinFile = staging ? join(staging, "known_hosts") : options.knownHostsFile;
  if (staging) {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const hop of hops)
      if (hop.state === "pinned")
        copyFileSync(hop.file, hop.file === options.knownHostsFile ? pinFile : `${pinFile}.jump`);
  }
  const stagedOf = (hop: Hop) => (hop.file === options.knownHostsFile ? pinFile : `${pinFile}.jump`);

  const tunnel =
    options.tunnel?.(pinFile, !staging) ??
    new SshTunnel({
      profile: options.profile,
      knownHostsFile: pinFile,
      ...(staging ? { markEnrolled: () => undefined } : { pinnedOnly: true }),
    });
  const client = new RemoteDaemonClient({ connect: () => tunnel.connect(), token: options.token });
  try {
    try {
      await tunnel.open();
    } catch (error) {
      throw new OrcaError("DELEGATION_REFUSED", `SSH to ${id} failed: ${(error as Error).message}`, {
        reason: "tunnel",
        profile: id,
        ...(error instanceof TunnelRefusal ? { tunnel: error.code } : {}),
      });
    }
    for (const hop of fresh) {
      const presented = pinFingerprints(stagedOf(hop));
      if (!presented.some((f) => hop.supplied.includes(f)))
        throw refuse(
          `The ${hop.name} of remote ${id} presented ${presented.join(", ") || "no key"}, which is not a fingerprint you gave. Nothing was sent to it.`,
          { presented },
        );
    }
    const keys = tunnel.pinnedKeys;
    if (!keys)
      throw new OrcaError("DELEGATION_REFUSED", `The host keys of ${id} could not be pinned.`, {
        reason: "tunnel",
        profile: id,
      });
    // Verified: the bearer may cross now.
    const hello = HelloResultSchema.parse(
      await client.call("hello", { client: "orca-daemon/enroll", ...helloOffer() }),
    );
    const discovery = OperatorDiscoverySchema.parse(await client.call("operator.discover", {}));
    if (hello.identity && hello.identity.workspaceId !== discovery.target.workspaceId)
      throw new OrcaError("DELEGATION_REFUSED", `The daemon on ${id} named two different workspaces.`, {
        reason: "scope-changed",
        profile: id,
      });
    for (const hop of fresh) {
      writeAtomic(hop.file, readFileSync(stagedOf(hop), "utf8"));
      markPinEnrolled(hop.file);
    }
    const record: Enrollment = {
      version: 1,
      profile: id,
      keys,
      workspaceId: discovery.target.workspaceId,
      principalId: discovery.principalId,
      credentialId: credentialIdOf(options.token),
      enrolledAt: new Date().toISOString(),
    };
    writeAtomic(options.file, JSON.stringify(record, null, 2));
    return record;
  } finally {
    client.close();
    await tunnel.close().catch(() => undefined);
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
