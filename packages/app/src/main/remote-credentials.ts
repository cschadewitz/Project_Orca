/**
 * Automatic sign-in for SSH profiles (#875), main process only.
 *
 * A profile's daemon credential is issued, renewed and revoked by ORCA's own command line on
 * the server, run over the profile's pinned SSH connection: `orca auth issue|rotate|revoke
 * --json`. The token goes from that command's output straight into the profile's keychain
 * slot; it is never printed, logged or kept anywhere else. Beside the slot, a small nonsecret
 * record (`credentials/<id>.json`) remembers which server credential it is and when it expires,
 * so it can be renewed before then and revoked when the profile is deleted.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ConnectionProfile, RemoteResult } from "@orca/protocol/remote-access";
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
  "cli-missing" | "cli-permission" | "server-not-set-up" | "cli-failed" | "wrong-workspace" | "credential-refused";

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

export function serverCommand(profile: ConnectionProfile): string {
  return profile.serverCommand ?? "orca";
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
  }
}

export function credentialRefusal(code: CredentialSetupCode, profile: ConnectionProfile): CredentialSetupRefusal {
  return new CredentialSetupRefusal(code, refusalMessage(code, profile));
}

/**
 * Who the credential is for on the server: this computer. `desktop-<hostname>`, cut to the
 * daemon's principal rules (1-64 of letters, digits, `. _ @ -`).
 */
export function principalFor(hostname: string): string {
  const host =
    hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 56)
      .replace(/[-.]+$/, "") || "computer";
  return `desktop-${host}`;
}

function configArgs(profile: ConnectionProfile): string[] {
  return profile.serverConfig ? ["--config", profile.serverConfig] : [];
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

export function rotateCommand(profile: ConnectionProfile, credentialId: string, expiresAt: Date): string[] {
  return [
    serverCommand(profile),
    "auth",
    "rotate",
    credentialId,
    "--expires-at",
    expiresAt.toISOString(),
    ...configArgs(profile),
    "--json",
  ];
}

export function revokeCommand(profile: ConnectionProfile, credentialId: string): string[] {
  return [serverCommand(profile), "auth", "revoke", credentialId, ...configArgs(profile), "--json"];
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
export function issuedFrom(result: RemoteResult, profile: ConnectionProfile): Issued {
  if (result.code !== 0) throw credentialRefusal(classifyFailure(result), profile);
  let parsed: z.infer<typeof IssuedSchema>;
  try {
    parsed = IssuedSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw credentialRefusal("cli-failed", profile);
  }
  return { token: parsed.token, credentialId: parsed.credential.id, expiresAt: parsed.credential.expiresAt };
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

/** The nonsecret record of a credential ORCA issued for a profile. */
const RecordSchema = z
  .object({
    version: z.literal(1),
    credentialId: z.string().regex(CREDENTIAL_ID),
    principal: z.string().max(64),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    issuedAt: z.string().datetime({ offset: true }),
    /** Issued under settings since replaced: revoke it on the server at the next chance. */
    retired: z.array(z.string().regex(CREDENTIAL_ID)).max(16).optional(),
  })
  .strict();
export type CredentialRecord = z.infer<typeof RecordSchema>;

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `credentials/<id>.json`: which server credential sits in a profile's keychain slot. */
export class CredentialRecords {
  constructor(private readonly dir: string) {}

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
}

/** Due for renewal under the policy, at `now`. A credential with no expiry never is. */
export function dueForRenewal(record: CredentialRecord, policy: CredentialPolicy, now: number): boolean {
  if (!record.expiresAt) return false;
  return Date.parse(record.expiresAt) - now <= policy.renewBeforeMs;
}
