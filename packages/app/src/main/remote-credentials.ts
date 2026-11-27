/**
 * Automatic sign-in for SSH profiles (#875), main process only.
 *
 * A profile's daemon credential is issued, renewed and revoked by ORCA's own command line on
 * the server, run over the profile's already pinned SSH connection: `orca auth issue|revoke
 * --json`. A new credential goes from that command's output into a staging keychain slot,
 * and becomes the profile's credential only once the daemon has accepted it; the one it
 * replaces is revoked after that. Tokens are never printed, logged or kept anywhere else.
 * Beside the slots, a small nonsecret record (`credentials/<id>.json`) remembers which server
 * credentials they are, when they expire, and where each was issued (server, CLI and
 * workspace config), so every one of them is revoked where it came from, or kept on the list
 * until it can be.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LEGACY_SERVER_COMMAND, type ConnectionProfile, type RemoteResult } from "@orca/protocol/remote-access";
import { ConnectionRefusal } from "./connection-target.js";

/** How long issued credentials live, and when they are renewed. */
export interface CredentialPolicy {
  /** Lifetime of an issued or renewed credential. */
  ttlMs: number;
  /** Renew once less than this is left. */
  renewBeforeMs: number;
  /** How often an open connection checks whether its credential is due for renewal. */
  checkEveryMs: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_CREDENTIAL_POLICY: CredentialPolicy = {
  ttlMs: 90 * DAY,
  renewBeforeMs: 30 * DAY,
  checkEveryMs: 12 * 60 * 60 * 1000,
};

export type CredentialSetupCode =
  | "cli-missing"
  | "cli-permission"
  | "server-not-set-up"
  | "cli-failed"
  | "wrong-workspace"
  | "credential-refused"
  | "imported-refused"
  | "imported-reauthorize"
  | "unverified"
  | "store-failed";

/** Automatic sign-in could not finish. The message says what to do; it never carries server output. */
export class CredentialSetupRefusal extends ConnectionRefusal {
  override readonly name = "CredentialSetupRefusal";
  constructor(
    readonly code: CredentialSetupCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The CLI a profile's credentials are issued through. Omitted only on a profile saved before
 * 0.8.1 (the app now saves `orca-cli` explicitly), which keeps meaning `orca` (#1207).
 */
export function serverCommand(profile: ConnectionProfile): string {
  return profile.serverCommand ?? LEGACY_SERVER_COMMAND;
}

function refusalMessage(code: CredentialSetupCode, profile: ConnectionProfile): string {
  const command = serverCommand(profile);
  switch (code) {
    case "cli-missing":
      return `ORCA's command line was not found on ${profile.destination} as "${command}". Install ORCA there, or set the profile's server command to its full path.`;
    case "cli-permission":
      return `${profile.destination} refused to run "${command}" for the SSH user. Check that this user may run it, or set the profile's server command to one it may run.`;
    case "server-not-set-up":
      return `ORCA on ${profile.destination} has no workspace to issue a credential for. Set up the daemon there, or set the profile's workspace config to the daemon's config file.`;
    case "cli-failed":
      return `ORCA on ${profile.destination} could not set up sign-in. Run "${command} auth list" there to check it, then connect again.`;
    case "wrong-workspace":
      return `The daemon on ${profile.destination} port ${profile.remotePort} does not accept credentials from the workspace "${command}" uses. Set the profile's workspace config to the config file of the daemon on that port.`;
    case "credential-refused":
      return `The daemon on ${profile.destination} refused this profile's credential, and a new one could not be issued. Connect again, or import a credential.`;
    case "imported-refused":
      return `The daemon on ${profile.destination} refused the credential imported for ${profile.name}. Import a new one, or choose "Use automatic sign-in" to have ORCA issue one.`;
    case "imported-reauthorize":
      return `The host key of ${profile.destination} was reset since the credential for ${profile.name} was imported, so ORCA will not send it there. Import it again if this is the same server, or choose "Use automatic sign-in".`;
    case "unverified":
      return `The daemon on ${profile.destination} port ${profile.remotePort} did not confirm which workspace it serves, so ORCA did not use the new credential. Update ORCA on the server, then connect again.`;
    case "store-failed":
      return `ORCA could not keep a new credential for ${profile.name} in the system keychain, so it was not used. Check that the keychain is unlocked and available, then connect again.`;
  }
}

export function credentialRefusal(code: CredentialSetupCode, profile: ConnectionProfile): CredentialSetupRefusal {
  return new CredentialSetupRefusal(code, refusalMessage(code, profile));
}

/**
 * Who the credential is for on the server: this installation of the app, which owns the runs
 * it starts. `desktop-<hostname>-<installation id>`: the host name for people reading
 * `orca auth list`, the installation id so two installations never share a principal (and
 * so each other's runs), even on machines with the same name. Within the daemon's principal
 * rules (1-64 of letters, digits, `. _ @ -`).
 */
export function principalFor(hostname: string, installationId: string): string {
  if (!INSTALLATION_ID.test(installationId)) throw new Error("Invalid installation id");
  const host =
    hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 36)
      .replace(/[-.]+$/, "") || "computer";
  return `desktop-${host}-${installationId}`;
}

const INSTALLATION_ID = /^[a-z0-9]{16}$/;

/**
 * This installation's durable id (`<dir>/installation.json`), made once from 80 random bits.
 * Not secret: it names the installation in principals, it grants nothing.
 */
export function installationId(dir: string): string {
  const file = join(dir, "installation.json");
  try {
    const parsed = z
      .object({ id: z.string().regex(INSTALLATION_ID) })
      .safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data.id;
  } catch {
    // None yet, or unreadable: make one.
  }
  const id = [...randomBytes(16)].map((byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ id })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return id;
}

/** Where a credential was issued: which server, through which CLI, for which workspace config. */
const TargetSchema = z
  .object({
    server: z.string().max(1024),
    /** The pinned host keys (server, and jump host) it was issued through: its server's identity. */
    hostKeys: z.string().max(16384),
    serverCommand: z.string().max(1024).optional(),
    serverConfig: z.string().max(1024).optional(),
  })
  .strict();
export type CredentialTarget = z.infer<typeof TargetSchema>;

/** The SSH server a profile reaches (and through which jump host): what its pins vouch for. */
export function serverKey(profile: ConnectionProfile): string {
  return JSON.stringify([
    profile.destination,
    profile.sshPort ?? 22,
    profile.jump?.destination ?? null,
    profile.jump ? (profile.jump.sshPort ?? 22) : null,
    // A tailnet profile is its node (#1226): another node under the same name is another server.
    ...(profile.tailnet ? [profile.tailnet.node] : []),
  ]);
}

export function targetOf(profile: ConnectionProfile, hostKeys: string): CredentialTarget {
  return {
    server: serverKey(profile),
    hostKeys,
    // Always the command it was issued through, so it is revoked through the same one whatever
    // the profile later says. A target saved before 0.8.1 may omit it: then it was `orca`.
    serverCommand: serverCommand(profile),
    ...(profile.serverConfig ? { serverConfig: profile.serverConfig } : {}),
  };
}

function configArgs(target: { serverConfig?: string | undefined }): string[] {
  return target.serverConfig ? ["--config", target.serverConfig] : [];
}

export function issueCommand(profile: ConnectionProfile, principal: string, expiresAt: Date): string[] {
  return [
    serverCommand(profile),
    "auth",
    "issue",
    principal,
    "--preset",
    profile.readOnly ? "viewer" : "client",
    "--expires-at",
    expiresAt.toISOString(),
    "--label",
    `orca-app-${profile.id}`,
    ...configArgs(profile),
    "--json",
  ];
}

/** Revoke where it was issued: that CLI, that workspace config. */
export function revokeCommand(target: CredentialTarget, credentialId: string): string[] {
  // A credential id may start with `-`: after `--`, so it is never read as an option.
  return [
    target.serverCommand ?? LEGACY_SERVER_COMMAND,
    "auth",
    "revoke",
    ...configArgs(target),
    "--json",
    "--",
    credentialId,
  ];
}

const CREDENTIAL_ID = /^[A-Za-z0-9_-]{12}$/;

const IssuedSchema = z.object({
  token: z.string().min(16).max(4096),
  credential: z.object({
    id: z.string().regex(CREDENTIAL_ID),
    principal: z.string(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }),
});

export interface Issued {
  token: string;
  credentialId: string;
  expiresAt: string | undefined;
}

/**
 * What a command run by the server's ORCA CLI came to. A failure is classified from the exit
 * code and the server's error lines; neither is ever shown or logged, since a confused shell
 * could print anything.
 */
export function issuedFrom(result: RemoteResult, profile: ConnectionProfile, principal: string): Issued {
  if (result.code !== 0) throw credentialRefusal(classifyFailure(result), profile);
  let parsed: z.infer<typeof IssuedSchema>;
  try {
    parsed = IssuedSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw credentialRefusal("cli-failed", profile);
  }
  const issued = { token: parsed.token, credentialId: parsed.credential.id, expiresAt: parsed.credential.expiresAt };
  // Not the credential that was asked for (another principal, or a token that is not this
  // credential's): never stored, and the caller takes it back.
  if (parsed.credential.principal !== principal || tokenCredentialId(parsed.token) !== issued.credentialId)
    throw new StrayCredential(issued.credentialId);
  return issued;
}

/** The credential id a daemon token carries (`orca1.<id>.<secret>`). */
export function tokenCredentialId(token: string): string | undefined {
  return /^orca1\.([A-Za-z0-9_-]{12})\.[A-Za-z0-9_-]+$/.exec(token)?.[1];
}

/** The server issued a credential that is not the one asked for. Revoke it; never store it. */
export class StrayCredential extends Error {
  override readonly name = "StrayCredential";
  constructor(readonly credentialId: string) {
    super("The server issued a credential for another principal");
  }
}

export function classifyFailure(result: RemoteResult): CredentialSetupCode {
  const text = result.serverLines.join("\n");
  // The shell's own verdicts: 127 (sh) and 9009 (cmd) for no such command, 126 for not runnable.
  if (result.code === 127 || result.code === 9009 || /is not recognized as/i.test(text)) return "cli-missing";
  if (result.code === 126) return "cli-permission";
  // ORCA ran and said why: no workspace config, or a setup that is not finished.
  if (/^error \[(CONFIG_[A-Z_]+|FIRST_RUN[A-Z_]*)\]/m.test(text)) return "server-not-set-up";
  // A `--config` path with no file there.
  if (/^error: ENOENT\b/m.test(text)) return "server-not-set-up";
  if (/EACCES|EPERM|Permission denied|Access is denied/i.test(text)) return "cli-permission";
  return "cli-failed";
}

const CredentialEntrySchema = z
  .object({ credentialId: z.string().regex(CREDENTIAL_ID), target: TargetSchema })
  .strict();
export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

/**
 * A keychain slot holding one token. Slots are immutable: a new token always gets a new slot,
 * and the record says which slot is which. A token changes role (staged, current, imported)
 * only in one atomic record write; the slot it replaces is deleted after that write.
 */
const SLOT = /^[a-z0-9]{20}$/;
export function newSlotId(): string {
  return [...randomBytes(20)].map((byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
}

const IssuedEntrySchema = CredentialEntrySchema.extend({
  /** The keychain slot holding its token. */
  slot: z.string().regex(SLOT),
  principal: z.string().max(64),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  issuedAt: z.string().datetime({ offset: true }),
  /** The workspace whose daemon accepted it: later answers must come from the same one. */
  workspaceId: z.string().uuid().optional(),
}).strict();
export type IssuedEntry = z.infer<typeof IssuedEntrySchema>;

/**
 * The nonsecret record of the credentials ORCA issued for a profile. `current` is the one in
 * the keychain slot; `next` is staged in its own slot until the daemon accepts it; `retired`
 * are replaced ones still to revoke where they were issued.
 */
const RecordSchema = z
  .object({
    version: z.literal(1),
    current: IssuedEntrySchema.optional(),
    next: IssuedEntrySchema.optional(),
    retired: z.array(CredentialEntrySchema).max(64).optional(),
    /**
     * An imported credential: the host keys it was first accepted through, and whether a pin
     * reset since means the person must authorize it again before it is sent anywhere.
     */
    imported: z
      .object({
        slot: z.string().regex(SLOT),
        hostKeys: z.string().max(16384).optional(),
        reauthorize: z.literal(true).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // One credential is the profile's: ORCA's own, or the person's import, never both.
  .refine((record) => !(record.current && record.imported), "A record holds one active credential");
export type CredentialRecord = z.infer<typeof RecordSchema>;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `credentials/<id>.json`: which server credential sits in a profile's keychain slot. */
export class CredentialRecords {
  constructor(
    private readonly dir: string,
    /** Test seam: runs before each write, and may throw to interrupt it. */
    private readonly beforeWrite?: (id: string, record: CredentialRecord) => void,
  ) {}

  private file(id: string): string {
    if (!PROFILE_ID.test(id)) throw new Error("Invalid profile id");
    return join(this.dir, `${id}.json`);
  }

  read(id: string): CredentialRecord | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(id), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = RecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // An unreadable record is no record: the credential is treated as imported.
    }
    return undefined;
  }

  write(id: string, record: CredentialRecord): void {
    const value = RecordSchema.parse(record);
    this.beforeWrite?.(id, value);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }

  remove(id: string): void {
    rmSync(this.file(id), { force: true });
  }

  /**
   * Every slot any record refers to, or `undefined` when that cannot be known for certain:
   * the records could not be listed, or a record file could not be read or is not valid.
   * A record that cannot be read may still name a slot, so nothing may be swept then.
   */
  referencedSlots(): Set<string> | undefined {
    const slots = new Set<string>();
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      // No records at all is certain; anything else is not.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? slots : undefined;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = /^([a-z0-9][a-z0-9-]{0,62})\.json$/.exec(name)?.[1];
      if (!id) return undefined;
      let text: string;
      try {
        text = readFileSync(join(this.dir, name), "utf8");
      } catch (error) {
        // Removed since the listing: it names nothing now.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return undefined;
      }
      let record: CredentialRecord;
      try {
        const parsed = RecordSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return undefined;
        record = parsed.data;
      } catch {
        return undefined;
      }
      for (const slot of [record.current?.slot, record.next?.slot, record.imported?.slot]) if (slot) slots.add(slot);
    }
    return slots;
  }
}

/** Due for renewal under the policy, at `now`. A credential with no expiry never is. */
export function dueForRenewal(entry: IssuedEntry, policy: CredentialPolicy, now: number): boolean {
  if (!entry.expiresAt) return false;
  return Date.parse(entry.expiresAt) - now <= policy.renewBeforeMs;
}
