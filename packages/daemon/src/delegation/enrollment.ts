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
import {
  daemonRelation,
  formatProtocolVersion,
  HelloResultSchema,
  helloOffer,
  OperatorDiscoverySchema,
} from "@orca/protocol";
import {
  markPinEnrolled,
  pinState,
  SshTunnel,
  TunnelRefusal,
  type ConnectionProfile,
} from "@orca/protocol/remote-access";
import { DELEGATION_METHODS } from "./daemon-session.js";
import { DelegationReceipts } from "./receipts.js";
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

/** The label an issued credential carries on the remote: unique to the one issuing request. */
const LABEL = /^orca-delegation-[a-z0-9][a-z0-9-]{0,62}-[0-9a-f]{16}$/;

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
    /** The unique label it was issued under on the remote: how its issuer finds it to revoke it. */
    label: z.string().regex(LABEL).optional(),
  })
  .strict()
  .refine(
    (r) => (r.issued === true) === (r.tokenFile !== undefined) && (r.issued === true) === (r.label !== undefined),
    "issued, tokenFile and label go together",
  )
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

/**
 * Replace `file` with `text`: written aside and flushed, renamed into place, and the directory
 * flushed so the rename itself survives power loss. With `durable`, a directory that cannot be
 * flushed throws: the caller's ordering depends on it. Without, it is best effort.
 */
function writeAtomic(file: string, text: string, durable = false): void {
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
  syncDir(dirname(file), durable);
}

/** Flush a directory's entries (a rename or removal in it). */
function syncDir(dir: string, durable: boolean): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (durable) throw error;
  }
}

/**
 * Whether this platform can order enrollment's files across power loss (a flushed directory
 * after each rename). Issuing and rotating credentials depend on it; Windows cannot flush a
 * directory, so there enrollment uses only a credential the person saved.
 */
export function durableEnrollment(): boolean {
  return process.platform !== "win32";
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
  /** Issue a new credential even when the one an earlier enrollment issued still serves. */
  rotate?: boolean;
}

export interface EnrollOptions {
  remote: RemoteDaemonSpec;
  profile: ConnectionProfile;
  knownHostsFile: string;
  file: string;
  /**
   * The workflows this config's agents delegate to the remote. An issued credential must be
   * scoped to exactly these; a saved one must at least cover them.
   */
  workflows: readonly string[];
  /** This daemon's delegation receipts (the store's `delegations/`): what still depends on the current enrollment. */
  receiptsDir: string;
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
  /** Test seam: runs just after it commits, before anything is retired; a throw interrupts there. */
  afterCommit?: () => void | Promise<void>;
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
 * The journal of credentials enrollment issued and that are not (or no longer) the active
 * one. An entry is written before the request that issues it and before any record that
 * replaces it is published, so neither a lost answer nor a crash leaves a credential valid on
 * the remote and unknown here. It leaves the journal only once the daemon that issued it is
 * proven (the entry's unique label found in that daemon's own credential list, over the same
 * route and keys, at the same workspace when known) and has revoked it.
 */
const PendingRevokeSchema = z
  .object({
    /** The unique label it was issued under: how the issuing store is found, even without an id. */
    label: z.string().regex(LABEL),
    principal: z.string().min(1),
    /** Unknown when the issuing answer never arrived or could not be trusted. */
    credentialId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{12}$/)
      .optional(),
    /** Its generation file (`<remote>.<credential id>.token`), kept until it is revoked. */
    tokenFile: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}\.[A-Za-z0-9_-]{12}\.token$/)
      .optional(),
    route: EnrolledRouteSchema,
    keys: z.string().min(1),
    /** Unknown when enrollment stopped before the daemon named its workspace. */
    workspaceId: z.string().min(1).optional(),
    reason: z.string(),
    since: z.string(),
    /** Why the last attempt left it here, for the person. */
    unresolved: z.string().optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.tokenFile === undefined || (p.credentialId !== undefined && p.tokenFile.endsWith(`.${p.credentialId}.token`)),
    "tokenFile names another credential",
  );
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
  if (entries.length) writeAtomic(pendingRevokeFile(file), JSON.stringify({ version: 1, entries }, null, 2), true);
  else {
    rmSync(pendingRevokeFile(file), { force: true });
    syncDir(dirname(file), durableEnrollment());
  }
}

/**
 * Whether an enrollment of this remote is under way: its lock is held by a live process (or
 * by one this host cannot judge). Delegation does not start new work while it is, so nothing
 * new binds the generation the enrollment may replace.
 */
export function enrollmentInProgress(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(`${file}.lock`, "utf8");
  } catch {
    return false;
  }
  return !deadOwner(text);
}

/**
 * One enrollment per remote at a time: `<record>.lock`, created exclusively, and only ever
 * removed by its owner. A lock left by a process on this host that no longer runs is taken
 * over through a claim file named by that lock's exact contents, which only one contender can
 * create: only the claimant removes the dead lock, and every other contender only ever creates
 * one, so no live lock is removed by anyone else.
 */
function lockEnrollment(file: string, remoteId: string): () => void {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const owner = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    since: new Date().toISOString(),
    nonce: randomUUID(),
  });
  const create = (): boolean => {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, owner);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  const busy = (detail: string) =>
    new OrcaError("DELEGATION_REFUSED", `Remote ${remoteId} is already being enrolled (${lock}). ${detail}`, {
      reason: "enrollment-in-progress",
      profile: remoteId,
    });
  if (!create()) {
    let held: string;
    try {
      held = readFileSync(lock, "utf8");
    } catch {
      throw busy("Try again.");
    }
    if (!deadOwner(held)) throw busy("Wait for it to finish.");
    const claim = `${lock}.claim-${createHash("sha256").update(held).digest("hex").slice(0, 32)}`;
    try {
      closeSync(openSync(claim, "wx", 0o600));
    } catch {
      throw busy(
        `Its process is gone and another enrollment is taking it over; if none is, remove ${lock} and ${claim}.`,
      );
    }
    try {
      // Only this claimant may remove that dead lock, and nobody else can have replaced it.
      if (readFileSync(lock, "utf8") === held) rmSync(lock);
      if (!create()) throw busy("Wait for it to finish.");
    } finally {
      rmSync(claim, { force: true });
    }
  }
  return () => {
    try {
      if (readFileSync(lock, "utf8") === owner) rmSync(lock, { force: true });
    } catch {
      // Already gone.
    }
  };
}

function deadOwner(text: string): boolean {
  try {
    const owner = z.object({ pid: z.number().int(), host: z.string() }).parse(JSON.parse(text));
    if (owner.host !== hostname() || owner.pid === process.pid) return false;
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
 * leaves the previous one working. Every issued credential that is not the active one is in
 * the revocation journal from before the step that could orphan it (see `PendingRevokeSchema`).
 */
export async function enrollRemote(options: EnrollOptions): Promise<Enrollment> {
  const id = options.remote.id;
  const refuse = (message: string, details: Record<string, unknown> = {}) =>
    new OrcaError("DELEGATION_REFUSED", message, { reason: "not-enrolled", profile: id, ...details });
  if ((options.token === undefined) === (options.issue === undefined))
    throw new OrcaError("INTERNAL", "enrollRemote needs a token or an issue request, not both");
  if (options.issue && !options.workflows.length)
    throw refuse(`No agent delegates to remote ${id}, so there is no workflow to issue a credential for.`);
  if (options.issue && !durableEnrollment())
    throw refuse(
      `Issuing the credential for remote ${id} during enrollment is not available on this platform yet: it cannot order the files it writes across a power loss. On the remote run \`orca auth issue <name> --preset client --json\`, save the token beside this config, then enroll again.`,
    );
  const unlock = lockEnrollment(options.file, id);
  try {
    return await enrollLocked(options, refuse);
  } finally {
    unlock();
  }
}

/** What a credential proved it may do on the remote, checked against what delegation needs. */
function checkAuthority(
  hello: z.infer<typeof HelloResultSchema>,
  discovery: z.infer<typeof OperatorDiscoverySchema>,
  workflows: readonly string[],
  exact: { principal: string } | undefined,
): string | undefined {
  if (!daemonRelation(hello.protocol))
    return `it speaks protocol ${formatProtocolVersion(hello.protocol)}, which this daemon cannot delegate to`;
  const missing = DELEGATION_METHODS.filter((m) => !hello.methods?.includes(m));
  if (missing.length) return `it does not answer ${missing.join(", ")}`;
  if (!discovery.operations.includes("runs.admit")) return "the credential may not start runs there";
  const scope = discovery.scope;
  if (exact) {
    // An issued credential is exactly what was asked for: this daemon's principal, its own runs,
    // and the delegated workflows, no more and no fewer.
    if (discovery.principalId !== exact.principal) return `the credential answers for ${discovery.principalId}`;
    if (scope.runs !== "owned") return "the credential may see runs it did not start";
    const granted = scope.workflows === "*" ? ["*"] : [...scope.workflows].sort();
    if (JSON.stringify(granted) !== JSON.stringify([...workflows].sort()))
      return `the credential is scoped to ${granted.join(", ") || "no workflow"}, not ${workflows.join(", ")}`;
    return undefined;
  }
  const uncovered = scope.workflows === "*" ? [] : workflows.filter((w) => !scope.workflows.includes(w));
  if (uncovered.length) return `the credential may not start ${uncovered.join(", ")} there`;
  return undefined;
}

async function enrollLocked(
  options: EnrollOptions,
  refuse: (message: string, details?: Record<string, unknown>) => OrcaError,
): Promise<Enrollment> {
  const id = options.remote.id;
  const route = routeOf(options.profile);
  const dir = dirname(options.file);
  const receipts = new DelegationReceipts(options.receiptsDir);
  // Read before anything is sent: an unreadable record or journal refuses here.
  const previous = readEnrollment(options.file);
  // The active generation's credential is never pending, whatever a cut-off run left listed:
  // this is how a run cut off just before or after its commit is reconciled.
  let pending = readPendingRevokes(options.file).filter((p) => p.credentialId !== previous?.credentialId);
  const previousToken = readIssuedToken(options.file, previous);
  // A re-enrollment is a new binding: delegations still running under the current one would be
  // stranded (and lose their credential on a rotation). They finish first.
  if (previous) {
    const busy = receipts.unsettled(id);
    if (busy)
      throw new OrcaError(
        "DELEGATION_REFUSED",
        `${busy} delegation${busy === 1 ? " is" : "s are"} still running on remote ${id} under its current enrollment. Re-enrolling now would strand ${busy === 1 ? "it" : "them"}; wait for ${busy === 1 ? "it" : "them"} to finish (or cancel ${busy === 1 ? "it" : "them"}), then enroll again.`,
        { reason: "enrollment-in-use", profile: id, delegations: busy },
      );
  }
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
  let issuing: PendingRevoke | undefined;
  let committed = false;
  // Once the record's publication has begun, whether it is the active one is not known until
  // it is read back: what it names is never revoked on that doubt.
  let publishing = false;
  let keys: string | undefined;
  let workspaceId: string | undefined;
  const journal = () => writePendingRevokes(options.file, pending);
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
    const pinned = tunnel.pinnedKeys;
    if (!pinned)
      throw new OrcaError("DELEGATION_REFUSED", `The host keys of ${id} could not be pinned.`, {
        reason: "tunnel",
        profile: id,
      });
    keys = pinned;
    // Verified: commands and the bearer may cross now.

    /** Prove a credential against the daemon: its identity and the authority it was granted. */
    const prove = async (token: string, exact: { principal: string } | undefined) => {
      const client = new RemoteDaemonClient({ connect: () => tunnel.connect(), token });
      try {
        const hello = HelloResultSchema.parse(
          await client.call("hello", { client: "orca-daemon/enroll", ...helloOffer() }),
        );
        const discovery = OperatorDiscoverySchema.parse(await client.call("operator.discover", {}));
        if (hello.identity && hello.identity.workspaceId !== discovery.target.workspaceId)
          throw new OrcaError("DELEGATION_REFUSED", `The daemon on ${id} named two different workspaces.`, {
            reason: "scope-changed",
            profile: id,
          });
        return { discovery, problem: checkAuthority(hello, discovery, options.workflows, exact) };
      } finally {
        client.close();
      }
    };

    let token: string;
    let tokenFile: string | undefined;
    let label: string | undefined;
    let proven: z.infer<typeof OperatorDiscoverySchema> | undefined;
    // A credential this enrollment issued earlier is reused, provenance and all, while it is
    // still bound to this very route and these keys and still grants exactly what the config
    // delegates; `--issue` (`rotate`), or any of those changing, issues a new one instead.
    if (
      options.issue &&
      !options.issue.rotate &&
      previous?.issued &&
      previousToken &&
      sameRoute(previous.route, route) &&
      previous.keys === keys
    ) {
      const reused = await prove(previousToken, { principal: options.issue.principal });
      if (!reused.problem && reused.discovery.target.workspaceId === previous.workspaceId) {
        token = previousToken;
        tokenFile = previous.tokenFile;
        label = previous.label;
        proven = reused.discovery;
      } else
        options.warn?.(
          `The credential issued for remote ${id} earlier no longer fits (${reused.problem ?? "the daemon names another workspace"}); issuing a new one.`,
        );
    }
    if (!proven && options.issue) {
      label = `orca-delegation-${id}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Journaled before the request: whatever becomes of the answer, the label finds it.
      issuing = {
        label,
        principal: options.issue.principal,
        route,
        keys,
        reason: "issued, not yet enrolled",
        since: new Date().toISOString(),
      };
      pending = [...pending, issuing];
      journal();
      const got = await issueOver(tunnel, options.remote, options.issue.principal, options.workflows, label);
      tokenFile = tokenFileName(id, got.credentialId);
      issuing.credentialId = got.credentialId;
      issuing.tokenFile = tokenFile;
      journal();
      const fresh = await prove(got.token, { principal: options.issue.principal });
      if (fresh.problem)
        throw new OrcaError(
          "DELEGATION_REFUSED",
          `The daemon on ${id} did not grant the credential it issued what delegation needs: ${fresh.problem}.`,
          { reason: "credential-missing", profile: id },
        );
      token = got.token;
      proven = fresh.discovery;
      workspaceId = issuing.workspaceId = proven.target.workspaceId;
      journal();
      // The new generation's own token file: never the file the previous record names, so the
      // previous generation keeps working until the record below replaces it.
      writeAtomic(join(dir, tokenFile), `${token}\n`, true);
    }
    if (!proven) {
      token = options.token!;
      const saved = await prove(token, undefined);
      if (saved.problem)
        throw new OrcaError(
          "DELEGATION_REFUSED",
          `The credential saved for remote ${id} cannot delegate there: ${saved.problem}.`,
          { reason: "auth", profile: id },
        );
      proven = saved.discovery;
      // The exact credential an earlier enrollment issued keeps its provenance, however it was
      // handed back in.
      if (previous?.issued && previous.credentialId === credentialIdOf(token)) {
        tokenFile = previous.tokenFile;
        label = previous.label;
      }
    }
    workspaceId = proven.target.workspaceId;
    const credentialId = credentialIdOf(token!);
    for (const hop of fresh) {
      writeAtomic(hop.file, readFileSync(stagedOf(hop), "utf8"));
      markPinEnrolled(hop.file);
    }
    const record: Enrollment = {
      version: 1,
      profile: id,
      route,
      keys,
      workspaceId,
      principalId: proven.principalId,
      credentialId,
      enrolledAt: new Date().toISOString(),
      ...(tokenFile && label ? { issued: true as const, tokenFile, label } : {}),
    };
    // The generation being replaced is journaled before the record stops naming it, so a crash
    // right after the commit still finds it; until then the filter above ignores it.
    if (previous?.issued && previous.credentialId !== credentialId && previous.label)
      pending = [
        ...pending.filter((p) => p.label !== previous.label),
        {
          label: previous.label,
          principal: previous.principalId,
          credentialId: previous.credentialId,
          ...(previous.tokenFile ? { tokenFile: previous.tokenFile } : {}),
          route: previous.route,
          keys: previous.keys,
          workspaceId: previous.workspaceId,
          reason: "replaced by a newer enrollment",
          since: new Date().toISOString(),
        },
      ];
    journal();
    await options.beforeCommit?.();
    // Commit: the one rename that makes this generation the active one. The journal and the
    // generation file above were flushed, directory and all, before it.
    publishing = true;
    writeAtomic(
      options.file,
      JSON.stringify(record, null, 2),
      options.issue !== undefined || previous?.issued === true,
    );
    committed = true;
    await options.afterCommit?.();
    pending = pending.filter((p) => p.credentialId !== credentialId);
    journal();
    pending = await settlePending(tunnel, options, receipts, pending, { route, keys, workspaceId, credentialId });
    return record;
  } finally {
    // Cut off before the commit: the credential it issued must not stay valid. It is taken
    // back only through the journal's proof of its issuer, like any other.
    if (issuing && !committed && publishing)
      options.warn?.(
        `Enrollment of remote ${id} stopped while publishing its record, so whether credential ${issuing.credentialId ?? issuing.label} is now the active one is not known. It was left in ${pendingRevokeFile(options.file)}; the next \`orca remote enroll ${id}\` settles it against whichever record is active.`,
      );
    else if (issuing && !committed && keys && pending.includes(issuing)) {
      try {
        pending = await settlePending(tunnel, options, receipts, pending, {
          route,
          keys,
          ...(workspaceId ? { workspaceId } : {}),
          credentialId: previous?.credentialId,
          only: issuing.label,
        });
      } catch {
        // The journal entry stays for the next enrollment.
      }
    }
    await tunnel.close().catch(() => undefined);
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

const RemoteCredentialsSchema = z.array(
  z.object({ id: z.string(), principal: z.string(), label: z.string().optional(), revokedAt: z.string().optional() }),
);

/**
 * Revoke journaled credentials, but only on the daemon that issued them. That daemon is the one
 * reached over the entry's route and keys (and at its workspace, when known) whose own
 * credential list holds the entry's unique label for the entry's principal (and id, when
 * known): only then is the id it lists revoked. Anything that cannot be proven, is still used
 * by a running delegation, or cannot be revoked stays in the journal, with a warning saying why.
 */
async function settlePending(
  tunnel: SshTunnel,
  options: EnrollOptions,
  receipts: DelegationReceipts,
  pending: readonly PendingRevoke[],
  here: {
    route: EnrolledRoute;
    keys: string;
    workspaceId?: string;
    credentialId: string | undefined;
    only?: string;
  },
): Promise<PendingRevoke[]> {
  const id = options.remote.id;
  const dir = dirname(options.file);
  const left: PendingRevoke[] = [];
  let listed: z.infer<typeof RemoteCredentialsSchema> | undefined | null;
  const list = async () => {
    if (listed !== undefined) return listed;
    try {
      const result = await tunnel.exec(cliOf(options.remote, "auth", "list", "--json"), 60_000);
      listed = result.code === 0 ? RemoteCredentialsSchema.parse(JSON.parse(result.stdout)) : null;
    } catch {
      listed = null;
    }
    return listed;
  };
  const keep = (entry: PendingRevoke, why: string) => {
    left.push({ ...entry, unresolved: why });
    options.warn?.(
      `The credential ${entry.credentialId ?? `labelled ${entry.label}`} for remote ${id} is not revoked yet: ${why}. It stays in ${pendingRevokeFile(options.file)}; the next enrollment retries, or run \`orca auth revoke <id>\` on the daemon that issued it and remove the entry.`,
    );
  };
  for (const entry of pending) {
    if (entry.credentialId !== undefined && entry.credentialId === here.credentialId) continue;
    if (here.only !== undefined && entry.label !== here.only) {
      left.push(entry);
      continue;
    }
    if (!sameRoute(entry.route, here.route) || entry.keys !== here.keys) {
      keep(entry, "it was issued over another address or host key than this enrollment reached");
      continue;
    }
    if (entry.workspaceId && here.workspaceId && entry.workspaceId !== here.workspaceId) {
      keep(entry, "it was issued by a daemon at another workspace");
      continue;
    }
    if (entry.workspaceId && !here.workspaceId) {
      keep(entry, "this daemon's workspace could not be confirmed");
      continue;
    }
    const busy = entry.credentialId ? receipts.unsettled(id, entry.credentialId) : 0;
    if (busy) {
      keep(entry, `${busy} delegation${busy === 1 ? " still uses" : "s still use"} it`);
      continue;
    }
    const credentials = await list();
    if (!credentials) {
      keep(entry, "the daemon's credential list could not be read over ssh");
      continue;
    }
    const matches = credentials.filter(
      (c) =>
        c.label === entry.label &&
        c.principal === entry.principal &&
        (entry.credentialId === undefined || c.id === entry.credentialId),
    );
    if (!matches.length) {
      keep(
        entry,
        entry.credentialId
          ? "this daemon does not hold it"
          : "this daemon holds nothing under its label (its issuing request may never have arrived)",
      );
      continue;
    }
    let revoked = true;
    for (const match of matches)
      if (!match.revokedAt)
        revoked =
          (await revokeOver(tunnel, options.remote, match.id).then(
            () => true,
            () => false,
          )) && revoked;
    if (!revoked) {
      keep(entry, "the daemon refused to revoke it");
      continue;
    }
    // Only the exact generation file of this remote and this credential is ever removed.
    if (entry.tokenFile && entry.credentialId && entry.tokenFile === tokenFileName(id, entry.credentialId))
      rmSync(join(dir, entry.tokenFile), { force: true });
  }
  writePendingRevokes(options.file, left);
  return left;
}

const IssuedSchema = z.object({
  token: z.string().regex(/^orca1\.[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/),
  credential: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    principal: z.string(),
    label: z.string().optional(),
  }),
});

function cliOf(remote: RemoteDaemonSpec, ...args: string[]): string[] {
  return [remote.serverCommand ?? "orca", ...args, ...(remote.serverConfig ? ["--config", remote.serverConfig] : [])];
}

/**
 * Have the remote's ORCA CLI issue this daemon a client credential for exactly `workflows`,
 * under a label no other credential has, over the verified tunnel. Its output is parsed, never
 * shown or logged; an answer that is not exactly what was asked for is not trusted for
 * anything, and the journal entry's label is what finds the credential later.
 */
async function issueOver(
  tunnel: SshTunnel,
  remote: RemoteDaemonSpec,
  principal: string,
  workflows: readonly string[],
  label: string,
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
    principal,
    "--preset",
    "client",
    ...workflows.flatMap((w) => ["--workflow-scope", w]),
    "--label",
    label,
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
  if (
    parsed.credential.principal !== principal ||
    parsed.credential.label !== label ||
    credentialIdOf(parsed.token) !== parsed.credential.id
  )
    throw fail("it answered with a credential other than the one asked for");
  return { token: parsed.token, credentialId: parsed.credential.id };
}

async function revokeOver(tunnel: SshTunnel, remote: RemoteDaemonSpec, credentialId: string): Promise<void> {
  // After `--`, an id starting with `-` is never read as an option.
  const result = await tunnel.exec([...cliOf(remote, "auth", "revoke", "--json"), "--", credentialId], 60_000);
  if (result.code !== 0) throw new Error("revoke failed");
}
