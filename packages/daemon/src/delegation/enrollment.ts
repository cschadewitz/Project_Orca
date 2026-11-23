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
 *
 * Enrollment can also issue the credential itself (#883 part 4): once the hops are verified,
 * it runs the remote's ORCA CLI over the same pinned ssh (`auth issue … --preset client
 * --workflow-scope …`), checks the credential it got back like any other, and saves it (0600)
 * in its own generation file beside the config. The record is the commit point: until it is
 * replaced the previous generation stays in use. Credentials enrollment issued and no longer
 * uses are revoked only on the daemon that issued them, and listed as pending until they are.
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
import { hostname } from "node:os";
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

/**
 * The route a remote was enrolled over: where ssh goes (and through which jump host) and which
 * daemon port and server it reaches there. A session over any other route is refused before
 * the bearer is used, even on the same pinned host.
 */
export const EnrolledRouteSchema = z
  .object({
    destination: z.string().min(1),
    sshPort: z.number().int().nullable(),
    jump: z
      .object({ destination: z.string().min(1), sshPort: z.number().int().nullable() })
      .strict()
      .nullable(),
    remotePort: z.number().int().nullable(),
    serverCommand: z.string().nullable(),
    serverConfig: z.string().nullable(),
  })
  .strict();
export type EnrolledRoute = z.infer<typeof EnrolledRouteSchema>;

/** A profile's route, as enrollment records and sessions compare it. */
export function routeOf(profile: ConnectionProfile): EnrolledRoute {
  return {
    destination: profile.destination,
    sshPort: profile.sshPort ?? null,
    jump: profile.jump ? { destination: profile.jump.destination, sshPort: profile.jump.sshPort ?? null } : null,
    remotePort: profile.remotePort ?? null,
    serverCommand: profile.serverCommand ?? null,
    serverConfig: profile.serverConfig ?? null,
  };
}

export function sameRoute(a: EnrolledRoute, b: EnrolledRoute): boolean {
  return JSON.stringify(EnrolledRouteSchema.parse(a)) === JSON.stringify(EnrolledRouteSchema.parse(b));
}

export const EnrollmentSchema = z
  .object({
    version: z.literal(1),
    profile: z.string().min(1),
    route: EnrolledRouteSchema,
    /** `SshTunnel.pinnedKeys` after the enrolling connect: the server's (and jump host's) keys. */
    keys: z.string().min(1),
    workspaceId: z.string().min(1),
    principalId: z.string().min(1),
    /** The id half of the enrolled credential (`orca1.<id>.<secret>`). Never the secret. */
    credentialId: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    enrolledAt: z.string(),
    /** Enrollment issued this credential (#883 part 4), so a later enrollment may revoke it. */
    issued: z.literal(true).optional(),
    /** The issued credential's own file beside this record (`<id>.<credential id>.token`). */
    tokenFile: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}\.[A-Za-z0-9_-]{12}\.token$/)
      .optional(),
  })
  .strict()
  .refine((r) => (r.issued === true) === (r.tokenFile !== undefined), "issued and tokenFile go together")
  .refine(
    (r) => r.tokenFile === undefined || r.tokenFile === `${r.profile}.${r.credentialId}.token`,
    "tokenFile names another credential",
  );
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

/** Issue the credential on the remote rather than read one the person saved (#883 part 4). */
export interface IssueRequest {
  /** The principal the remote issues it to: this daemon's own, one per delegating workspace. */
  principal: string;
  /** The only workflows it may start: those this daemon's agents delegate to that remote. */
  workflows: readonly string[];
  /** Issue a new credential even when the one an earlier enrollment issued still serves. */
  rotate?: boolean;
}

export interface EnrollOptions {
  remote: RemoteDaemonSpec;
  profile: ConnectionProfile;
  knownHostsFile: string;
  file: string;
  /** A credential the person saved; or `issue`, to have the remote issue one. */
  token?: string;
  issue?: IssueRequest;
  /** Told about anything left to tidy by hand (a stale credential that could not be revoked). */
  warn?: (message: string) => void;
  /** Fingerprints the server's key may have, from the remote itself (`ssh-keygen -l` there). */
  hostKeys?: readonly string[];
  /** The same for the jump host, when the profile has one. */
  jumpHostKeys?: readonly string[];
  /** Test seam: the tunnel over a pin file. */
  tunnel?: (knownHostsFile: string, pinnedOnly: boolean) => SshTunnel;
  /** Test seam: runs just before the new generation commits; a throw interrupts enrollment there. */
  beforeCommit?: () => void | Promise<void>;
}

interface Hop {
  name: string;
  file: string;
  supplied: string[];
  state: ReturnType<typeof pinState>;
}

/** An issued credential's own file, beside the record: one per credential generation. */
export function tokenFileName(remoteId: string, credentialId: string): string {
  return `${remoteId}.${credentialId}.token`;
}

/** The token a record binds through its own generation file, or undefined when it has none or it is unreadable. */
export function readIssuedToken(file: string, record: Enrollment | undefined): string | undefined {
  if (!record?.tokenFile) return undefined;
  try {
    const token = readFileSync(join(dirname(file), record.tokenFile), "utf8").trim();
    return credentialIdOf(token) === record.credentialId ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Credentials enrollment issued and could not take back yet: kept beside the record until a
 * later enrollment reaches the daemon that issued them and revokes them there.
 */
const PendingRevokeSchema = z
  .object({
    credentialId: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    /** Where it was issued: revoked only over this route, to these keys, at this workspace. */
    route: EnrolledRouteSchema,
    keys: z.string().min(1),
    /** Unknown when enrollment stopped before the daemon named its workspace. */
    workspaceId: z.string().min(1).optional(),
    reason: z.string(),
    since: z.string(),
  })
  .strict();
type PendingRevoke = z.infer<typeof PendingRevokeSchema>;
const PendingRevokesSchema = z.object({ version: z.literal(1), entries: z.array(PendingRevokeSchema) }).strict();

export function pendingRevokeFile(file: string): string {
  return `${file}.pending-revoke`;
}

/** Credentials still to be revoked for this remote. Unreadable refuses, so none is forgotten. */
export function readPendingRevokes(file: string): PendingRevoke[] {
  let text: string;
  try {
    text = readFileSync(pendingRevokeFile(file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return PendingRevokesSchema.parse(JSON.parse(text)).entries;
}

function writePendingRevokes(file: string, entries: readonly PendingRevoke[]): void {
  if (entries.length) writeAtomic(pendingRevokeFile(file), JSON.stringify({ version: 1, entries }, null, 2));
  else rmSync(pendingRevokeFile(file), { force: true });
}

/**
 * One enrollment per remote at a time: `<record>.lock`, created exclusively. A lock left by a
 * process on this host that no longer runs is taken over; any other refuses.
 */
function lockEnrollment(file: string, remoteId: string): () => void {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(lock, "utf8") === owner) rmSync(lock, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && staleLock(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      throw new OrcaError(
        "DELEGATION_REFUSED",
        `Remote ${remoteId} is already being enrolled (${lock}). Wait for it to finish; if no enrollment is running, remove that file.`,
        { reason: "enrollment-in-progress", profile: remoteId },
      );
    }
  }
  throw new OrcaError("INTERNAL", `could not lock ${lock}`);
}

function staleLock(lock: string): boolean {
  try {
    const owner = z.object({ pid: z.number().int(), host: z.string() }).parse(JSON.parse(readFileSync(lock, "utf8")));
    if (owner.host !== hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/**
 * Verify the hops' keys, then prove the credential and record what was proven. The person
 * runs this; it is the only place a delegating daemon pins a host key, and only one it was
 * given the fingerprint of.
 *
 * The record is the commit point. Everything a new credential generation needs (its token
 * file, any newly pinned key) is written before it, and nothing the previous generation uses
 * is touched until it has been replaced, so an enrollment that fails or is cut off at any step
 * leaves the previous one working. An issued credential is noted as pending revocation the
 * moment it exists and stays noted until it is either committed or revoked by the daemon that
 * issued it.
 */
export async function enrollRemote(options: EnrollOptions): Promise<Enrollment> {
  const id = options.remote.id;
  const refuse = (message: string, details: Record<string, unknown> = {}) =>
    new OrcaError("DELEGATION_REFUSED", message, { reason: "not-enrolled", profile: id, ...details });
  if ((options.token === undefined) === (options.issue === undefined))
    throw new OrcaError("INTERNAL", "enrollRemote needs a token or an issue request, not both");
  if (options.issue && !options.issue.workflows.length)
    throw refuse(`No agent delegates to remote ${id}, so there is no workflow to issue a credential for.`);
  const unlock = lockEnrollment(options.file, id);
  try {
    return await enrollLocked(options, refuse);
  } finally {
    unlock();
  }
}

async function enrollLocked(
  options: EnrollOptions,
  refuse: (message: string, details?: Record<string, unknown>) => OrcaError,
): Promise<Enrollment> {
  const id = options.remote.id;
  const route = routeOf(options.profile);
  // Read before anything is sent: an unreadable record or pending list refuses here.
  const previous = readEnrollment(options.file);
  // The active generation's credential is never pending, whatever a cut-off run left listed.
  let pending = readPendingRevokes(options.file).filter((p) => p.credentialId !== previous?.credentialId);
  const previousToken = readIssuedToken(options.file, previous);
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
  // A pin already on file is never rewritten, so the previous generation's pins stay as they were.
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
  let client: RemoteDaemonClient | undefined;
  let issued: { token: string; credentialId: string; tokenFile: string } | undefined;
  let committed = false;
  let keys: string | undefined;
  let workspaceId: string | undefined;
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
    keys = tunnel.pinnedKeys;
    if (!keys)
      throw new OrcaError("DELEGATION_REFUSED", `The host keys of ${id} could not be pinned.`, {
        reason: "tunnel",
        profile: id,
      });
    // Verified: commands and the bearer may cross now.
    // A credential this enrollment issued earlier is reused, provenance and all, while it is
    // still bound to this very route and these keys; `--issue` (`rotate`) replaces it.
    const reuse =
      options.issue &&
      !options.issue.rotate &&
      previous?.issued &&
      previousToken &&
      sameRoute(previous.route, route) &&
      previous.keys === keys
        ? previousToken
        : undefined;
    if (options.issue && !reuse) {
      const got = await issueOver(tunnel, options.remote, options.issue);
      issued = { ...got, tokenFile: tokenFileName(id, got.credentialId) };
      // Noted before anything else can fail, so even a crash leaves it on the list to revoke.
      pending = [
        ...pending,
        {
          credentialId: got.credentialId,
          route,
          keys,
          reason: "issued, not yet enrolled",
          since: new Date().toISOString(),
        },
      ];
      writePendingRevokes(options.file, pending);
    }
    const token = issued?.token ?? reuse ?? options.token!;
    client = new RemoteDaemonClient({ connect: () => tunnel.connect(), token });
    const hello = HelloResultSchema.parse(
      await client.call("hello", { client: "orca-daemon/enroll", ...helloOffer() }),
    );
    const discovery = OperatorDiscoverySchema.parse(await client.call("operator.discover", {}));
    if (hello.identity && hello.identity.workspaceId !== discovery.target.workspaceId)
      throw new OrcaError("DELEGATION_REFUSED", `The daemon on ${id} named two different workspaces.`, {
        reason: "scope-changed",
        profile: id,
      });
    workspaceId = discovery.target.workspaceId;
    if (issued && discovery.principalId !== options.issue!.principal)
      throw new OrcaError("DELEGATION_REFUSED", `The daemon on ${id} did not accept the credential it issued.`, {
        reason: "credential-missing",
        profile: id,
      });
    const credentialId = credentialIdOf(token);
    // The exact credential an earlier enrollment issued keeps its provenance (and its file),
    // however it was handed back in.
    const kept =
      !issued && previous?.issued && previous.tokenFile && previous.credentialId === credentialId
        ? previous.tokenFile
        : undefined;
    // The new generation's own token file: written before the record that names it, and never
    // the file the previous record names, so the previous generation keeps working until the
    // record below replaces it.
    if (issued) writeAtomic(join(dirname(options.file), issued.tokenFile), `${issued.token}\n`);
    for (const hop of fresh) {
      writeAtomic(hop.file, readFileSync(stagedOf(hop), "utf8"));
      markPinEnrolled(hop.file);
    }
    const tokenFile = issued?.tokenFile ?? kept;
    const record: Enrollment = {
      version: 1,
      profile: id,
      route,
      keys,
      workspaceId,
      principalId: discovery.principalId,
      credentialId,
      enrolledAt: new Date().toISOString(),
      ...(tokenFile ? { issued: true as const, tokenFile } : {}),
    };
    await options.beforeCommit?.();
    // Commit: the one rename that makes this generation the active one.
    writeAtomic(options.file, JSON.stringify(record, null, 2));
    committed = true;
    pending = pending.filter((p) => p.credentialId !== credentialId);
    // The previous generation is retired: its credential is taken back only by the daemon that
    // issued it (same route, same keys, same workspace); otherwise it waits on the list.
    if (previous?.issued && previous.credentialId !== credentialId) {
      if (previous.tokenFile && previous.tokenFile !== tokenFile)
        rmSync(join(dirname(options.file), previous.tokenFile), { force: true });
      if (!pending.some((p) => p.credentialId === previous.credentialId))
        pending.push({
          credentialId: previous.credentialId,
          route: previous.route,
          keys: previous.keys,
          workspaceId: previous.workspaceId,
          reason: "replaced by a newer enrollment",
          since: new Date().toISOString(),
        });
    }
    writePendingRevokes(options.file, pending);
    pending = await revokePending(tunnel, options, pending, { route, keys, workspaceId, credentialId });
    return record;
  } finally {
    // Interrupted before the commit: the credential it issued must not stay valid. If it cannot
    // be revoked now it stays on the list for the next enrollment.
    if (issued && !committed) {
      const ok = await revokeOver(tunnel, options.remote, issued.credentialId).then(
        () => true,
        () => false,
      );
      if (ok) pending = pending.filter((p) => p.credentialId !== issued!.credentialId);
      else if (workspaceId)
        pending = pending.map((p) => (p.credentialId === issued!.credentialId ? { ...p, workspaceId } : p));
      try {
        writePendingRevokes(options.file, pending);
      } catch {
        // The entry written when it was issued is still there.
      }
      if (!ok)
        options.warn?.(
          `The credential ${issued.credentialId} issued on remote ${id} could not be revoked yet; the next \`orca remote enroll ${id}\` will retry, or run \`orca auth revoke ${issued.credentialId}\` there.`,
        );
      rmSync(join(dirname(options.file), issued.tokenFile), { force: true });
    }
    client?.close();
    await tunnel.close().catch(() => undefined);
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Revoke what is pending, but only on the daemon that issued it: the route and keys must be the
 * ones it was issued over, and the workspace (when it was learned) the one this daemon names.
 * Whatever cannot be proven or revoked stays on the list, with a warning.
 */
async function revokePending(
  tunnel: SshTunnel,
  options: EnrollOptions,
  pending: readonly PendingRevoke[],
  here: { route: EnrolledRoute; keys: string; workspaceId: string; credentialId: string },
): Promise<PendingRevoke[]> {
  const id = options.remote.id;
  const left: PendingRevoke[] = [];
  for (const entry of pending) {
    if (entry.credentialId === here.credentialId) continue;
    const issuer =
      sameRoute(entry.route, here.route) &&
      entry.keys === here.keys &&
      (entry.workspaceId === undefined || entry.workspaceId === here.workspaceId);
    if (
      issuer &&
      (await revokeOver(tunnel, options.remote, entry.credentialId).then(
        () => true,
        () => false,
      ))
    )
      continue;
    left.push(entry);
    options.warn?.(
      issuer
        ? `The credential ${entry.credentialId} on remote ${id} could not be revoked yet; the next enrollment will retry, or run \`orca auth revoke ${entry.credentialId}\` there.`
        : `The credential ${entry.credentialId} was issued by the daemon remote ${id} was enrolled to before (another address, host key or workspace), so it was not revoked here. Run \`orca auth revoke ${entry.credentialId}\` on that daemon, then remove it from ${pendingRevokeFile(options.file)}.`,
    );
  }
  if (left.length !== pending.length) writePendingRevokes(options.file, left);
  return left;
}

const IssuedSchema = z.object({
  token: z.string().regex(/^orca1\.[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/),
  credential: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{12}$/), principal: z.string() }),
});

function cliOf(remote: RemoteDaemonSpec, ...args: string[]): string[] {
  return [remote.serverCommand ?? "orca", ...args, ...(remote.serverConfig ? ["--config", remote.serverConfig] : [])];
}

/**
 * Have the remote's ORCA CLI issue this daemon a client credential for exactly `workflows`,
 * over the verified tunnel. Its output is parsed, never shown or logged.
 */
async function issueOver(
  tunnel: SshTunnel,
  remote: RemoteDaemonSpec,
  request: IssueRequest,
): Promise<{ token: string; credentialId: string }> {
  const fail = (why: string) =>
    new OrcaError("DELEGATION_REFUSED", `Remote ${remote.id} did not issue a credential: ${why}.`, {
      reason: "credential-missing",
      profile: remote.id,
    });
  const command = cliOf(
    remote,
    "auth",
    "issue",
    request.principal,
    "--preset",
    "client",
    ...request.workflows.flatMap((w) => ["--workflow-scope", w]),
    "--label",
    `orca-delegation-${remote.id}`,
    "--json",
  );
  let result;
  try {
    result = await tunnel.exec(command, 60_000);
  } catch (error) {
    throw fail(error instanceof TunnelRefusal ? `ssh ${error.code}` : "its command could not be run");
  }
  if (result.code !== 0)
    throw fail(`\`${command[0]} auth issue\` exited ${result.code} (is ORCA installed there, and serverConfig right?)`);
  let parsed: z.infer<typeof IssuedSchema>;
  try {
    parsed = IssuedSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw fail("its answer was not a credential");
  }
  const issued = { token: parsed.token, credentialId: parsed.credential.id };
  // Not what was asked for: never kept, and taken back.
  if (parsed.credential.principal !== request.principal || credentialIdOf(parsed.token) !== parsed.credential.id) {
    await revokeOver(tunnel, remote, parsed.credential.id).catch(() => undefined);
    throw fail("it issued a credential other than the one asked for");
  }
  return issued;
}

async function revokeOver(tunnel: SshTunnel, remote: RemoteDaemonSpec, credentialId: string): Promise<void> {
  // After `--`, an id starting with `-` is never read as an option.
  const result = await tunnel.exec([...cliOf(remote, "auth", "revoke", "--json"), "--", credentialId], 60_000);
  if (result.code !== 0) throw new Error("revoke failed");
}
