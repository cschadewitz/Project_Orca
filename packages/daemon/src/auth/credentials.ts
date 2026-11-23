/**
 * Bearer credentials: the smallest mechanism that gives a client a verified identity.
 *
 * A token is `orca1.<id>.<secret>`. The id is public - it names the credential in the audit
 * log, in `orca auth list` and in a revocation - and the secret is 256 random bits. The daemon
 * keeps only the SHA-256 of the secret, so the credentials file is not itself a credential: a
 * person who can read it cannot call the daemon with it. A fast hash is enough because the
 * secret is random rather than chosen; there is nothing to brute-force from a dictionary.
 *
 * The file is the source of truth and the daemon re-reads it when it changes, so a credential
 * issued or revoked by another process (the CLI) takes effect without a restart - on the next
 * request, and on an open socket within its revalidation interval (socket.ts). An unreadable
 * or malformed file fails closed: every credential is refused until it is fixed.
 *
 * Lifecycle: `issue` (with an optional expiry), `rotate` (a new secret for the same principal
 * and grants, the old one revoked), `revoke` (kept in the file, marked, so the audit trail
 * can still name it). Expired and revoked credentials are refused exactly like an unknown
 * one; the reason is recorded internally and never sent.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { withFileLock } from "@orca/store";
import {
  PRESETS,
  PermissionSchema,
  ResourceScopeSchema,
  SecretGrantSchema,
  CapabilityGrantSchema,
  DisclosureGrantSchema,
  WORKSPACE_PERMISSIONS,
  isUnrestricted,
  type Permission,
  type PresetName,
  type Principal,
  type ResourceScope,
  type SecretGrant,
  type CapabilityGrant,
  type DisclosureGrant,
} from "./principal.js";

export const TOKEN_PREFIX = "orca1";
const TOKEN_RE = /^orca1\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export const CredentialRecordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
  principal: z.string().regex(PRINCIPAL_RE),
  label: z.string().max(200).optional(),
  /** Hex SHA-256 of the secret half of the token. */
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  permissions: z.array(PermissionSchema),
  scope: ResourceScopeSchema,
  /** The secret references this credential's principal may use (#336). Absent: none. */
  secrets: SecretGrantSchema.optional(),
  /** The catalog capabilities this credential's principal's runs may be given (#337). Absent: none. */
  capabilities: CapabilityGrantSchema.optional(),
  /** What this credential's principal's runs may disclose to a plain-rule review judge (#701). Absent: nothing. */
  disclosures: DisclosureGrantSchema.optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  /** Issued by the daemon for local clients at startup, and revoked at the next startup. */
  bootstrap: z.literal(true).optional(),
});
export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
/** A record as it may be shown: everything but the hash. */
export type CredentialInfo = Omit<CredentialRecord, "secretSha256">;

const CredentialFileSchema = z.object({ version: z.literal(1), credentials: z.array(CredentialRecordSchema) });

/**
 * Why a credential was refused - for the audit log only. Every one of these is the same
 * `AUTH_INVALID` on the wire.
 */
export type CredentialFailure = "malformed" | "unknown" | "mismatch" | "expired" | "revoked" | "unavailable";

export type CredentialCheck =
  { ok: true; principal: Principal } | { ok: false; reason: CredentialFailure; credentialId?: string | undefined };

export interface IssueOptions {
  principal: string;
  label?: string | undefined;
  /** A preset, expanded into the record; or give `permissions` and `scope` explicitly. */
  preset?: PresetName | undefined;
  permissions?: readonly Permission[] | undefined;
  scope?: ResourceScope | undefined;
  /** The secret references it may use (#336); a preset's grant when not given. */
  secrets?: SecretGrant | undefined;
  /** The catalog capabilities its runs may be given (#337); a preset's grant when not given. */
  capabilities?: CapabilityGrant | undefined;
  /** What its runs may disclose to a plain-rule review judge (#701). Never from a preset. */
  disclosures?: DisclosureGrant | undefined;
  /** An absolute expiry; or `ttlMs` from now. Neither means it lasts until revoked. */
  expiresAt?: Date | undefined;
  ttlMs?: number | undefined;
  bootstrap?: boolean | undefined;
}

export interface CredentialStoreOptions {
  /** The credentials file. Absent keeps credentials in memory - for tests and embedders. */
  file?: string | undefined;
  now?: (() => Date) | undefined;
}

export class CredentialError extends Error {
  override readonly name = "CredentialError";
}

function sha256(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Twelve base64url characters, never starting with `-`: an id is typed as a command-line
 * argument (`orca auth revoke <id>`), where a leading dash reads as an option.
 */
export function newCredentialId(): string {
  for (;;) {
    const id = randomBytes(9).toString("base64url");
    if (!id.startsWith("-")) return id;
  }
}

/** Split a token into its parts without judging it; `undefined` when it is not a token at all. */
export function parseToken(token: string): { id: string; secret: string } | undefined {
  const m = TOKEN_RE.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : undefined;
}

/** Write JSON to `file` atomically, readable by its owner alone. */
export function writePrivateFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class CredentialStore {
  private readonly file: string | undefined;
  private readonly now: () => Date;
  private records: CredentialRecord[] = [];
  /** The file's identity when last read: re-read when it moves. */
  private seen: string | undefined;
  /** Set when the file could not be read or parsed: everything is refused until it can be. */
  private broken = false;

  constructor(opts: CredentialStoreOptions = {}) {
    this.file = opts.file;
    this.now = opts.now ?? (() => new Date());
    if (this.file) {
      // A malformed file at startup is a configuration error, not a quiet empty store.
      this.reload(true);
    }
  }

  /** Issue a credential. The token is returned once and is not recoverable afterwards. */
  async issue(opts: IssueOptions): Promise<{ token: string; credential: CredentialInfo }> {
    return this.mutate(() => this.create(opts));
  }

  private create(opts: IssueOptions): { token: string; credential: CredentialInfo } {
    if (!PRINCIPAL_RE.test(opts.principal))
      throw new CredentialError("a principal is 1-64 letters, digits and . _ @ -, starting with a letter or digit");
    const preset = opts.preset ? PRESETS[opts.preset] : undefined;
    const permissions = [...new Set(opts.permissions ?? preset?.permissions ?? [])];
    const scope = opts.scope ?? preset?.scope;
    const secrets = opts.secrets ?? (preset && "secrets" in preset ? preset.secrets : undefined);
    const capabilities = opts.capabilities ?? (preset && "capabilities" in preset ? preset.capabilities : undefined);
    // Never from a preset: a disclosure is granted only by naming it.
    const disclosures = opts.disclosures;
    if (!scope) throw new CredentialError("a credential needs a preset or an explicit scope");
    if (permissions.length === 0) throw new CredentialError("a credential needs at least one permission");
    const parsedScope = ResourceScopeSchema.parse(scope);
    if (!isUnrestricted(parsedScope)) {
      const wide = permissions.filter((p) => WORKSPACE_PERMISSIONS.includes(p));
      if (wide.length)
        throw new CredentialError(
          `${wide.join(", ")} cover the whole workspace and cannot be granted to a restricted scope`,
        );
    }
    const expiresAt =
      opts.expiresAt ?? (opts.ttlMs === undefined ? undefined : new Date(this.now().getTime() + opts.ttlMs));
    const id = newCredentialId();
    const secret = randomBytes(32).toString("base64url");
    const record: CredentialRecord = {
      id,
      principal: opts.principal,
      ...(opts.label ? { label: opts.label } : {}),
      secretSha256: sha256(secret).toString("hex"),
      permissions: permissions.map((p) => PermissionSchema.parse(p)),
      scope: parsedScope,
      ...(secrets !== undefined ? { secrets: SecretGrantSchema.parse(secrets) } : {}),
      ...(capabilities !== undefined ? { capabilities: CapabilityGrantSchema.parse(capabilities) } : {}),
      ...(disclosures !== undefined ? { disclosures: DisclosureGrantSchema.parse(disclosures) } : {}),
      createdAt: this.now().toISOString(),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      ...(opts.bootstrap ? { bootstrap: true as const } : {}),
    };
    this.records = [...this.records, record];
    return { token: `${TOKEN_PREFIX}.${id}.${secret}`, credential: info(record) };
  }

  /** Mark a credential revoked. False when there was no such live credential. */
  async revoke(id: string): Promise<boolean> {
    return this.mutate(() => this.markRevoked(id));
  }

  private markRevoked(id: string): boolean {
    const at = this.now().toISOString();
    let changed = false;
    this.records = this.records.map((r) => {
      if (r.id !== id || r.revokedAt) return r;
      changed = true;
      return { ...r, revokedAt: at };
    });
    return changed;
  }

  /** A new secret for the same principal and grants; the old credential is revoked. */
  async rotate(id: string, opts: { ttlMs?: number | undefined; expiresAt?: Date | undefined } = {}) {
    return this.mutate(() => {
      const old = this.records.find((r) => r.id === id && !r.revokedAt);
      if (!old) throw new CredentialError(`no live credential ${id}`);
      const issued = this.create({
        principal: old.principal,
        label: old.label,
        permissions: old.permissions,
        scope: old.scope,
        secrets: old.secrets,
        capabilities: old.capabilities,
        disclosures: old.disclosures,
        expiresAt: opts.expiresAt,
        ttlMs: opts.ttlMs,
        bootstrap: old.bootstrap,
      });
      this.markRevoked(id);
      return issued;
    });
  }

  /** Replace all bootstrap credentials and publish the matching token under the same lock. */
  async bootstrap(opts: IssueOptions, tokenFile: string): Promise<{ credentialId: string }> {
    return this.mutate(
      () => {
        for (const record of this.records) if (record.bootstrap) this.markRevoked(record.id);
        return this.create({ ...opts, bootstrap: true });
      },
      (issued) => writePrivateFile(tokenFile, `${issued.token}\n`),
    ).then((issued) => ({ credentialId: issued.credential.id }));
  }

  /** Lock covers reload, mutation, persistence and bootstrap publication across all writers. */
  private async mutate<T>(change: () => T, publish?: (result: T) => void): Promise<T> {
    const transaction = async () => {
      this.seen = undefined;
      this.reload();
      if (this.broken) throw new CredentialError("the credentials file cannot be read; fix or remove it first");
      const previous = this.records;
      try {
        const result = change();
        this.persist();
        publish?.(result);
        return result;
      } catch (error) {
        // Do not let a failed write become an in-memory authority change.
        this.records = previous;
        this.seen = undefined;
        this.reload();
        throw error;
      }
    };
    if (!this.file) return transaction();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    return withFileLock(`${this.file}.lock`, transaction);
  }

  list(): CredentialInfo[] {
    this.reload();
    return this.records.map(info);
  }

  /** Verify a presented token. Constant-time on the secret; the reason is for audit only. */
  authenticate(token: string): CredentialCheck {
    const parts = parseToken(token);
    if (!parts) return { ok: false, reason: "malformed" };
    this.reload();
    if (this.broken) return { ok: false, reason: "unavailable", credentialId: parts.id };
    const record = this.records.find((r) => r.id === parts.id);
    // Hash the presented secret either way, so an unknown id costs what a known one does.
    const presented = sha256(parts.secret);
    const expected = record ? Buffer.from(record.secretSha256, "hex") : sha256("");
    const match = timingSafeEqual(presented, expected);
    if (!record) return { ok: false, reason: "unknown", credentialId: parts.id };
    if (!match) return { ok: false, reason: "mismatch", credentialId: parts.id };
    return this.check(record);
  }

  /**
   * Re-check a credential that was verified earlier - an open socket asks this before every
   * message and notification, so a revocation or expiry ends the connection's authority.
   */
  current(credentialId: string): CredentialCheck {
    this.reload();
    if (this.broken) return { ok: false, reason: "unavailable", credentialId };
    const record = this.records.find((r) => r.id === credentialId);
    if (!record) return { ok: false, reason: "unknown", credentialId };
    return this.check(record);
  }

  private check(record: CredentialRecord): CredentialCheck {
    if (record.revokedAt) return { ok: false, reason: "revoked", credentialId: record.id };
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime())
      return { ok: false, reason: "expired", credentialId: record.id };
    return {
      ok: true,
      principal: {
        id: record.principal,
        kind: "credential",
        credentialId: record.id,
        permissions: new Set(record.permissions),
        scope: record.scope,
        ...(record.secrets !== undefined ? { secrets: record.secrets } : {}),
        ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
        ...(record.disclosures !== undefined ? { disclosures: record.disclosures } : {}),
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      },
    };
  }

  /**
   * Every principal record `principalId` holds right now: its credentials that are neither
   * revoked nor expired, re-read from the file. Empty when the file cannot be read.
   */
  currentForPrincipal(principalId: string): Principal[] {
    this.reload();
    if (this.broken) return [];
    return this.records
      .filter((r) => r.principal === principalId)
      .map((r) => this.check(r))
      .flatMap((c) => (c.ok ? [c.principal] : []));
  }

  private reload(strict = false): void {
    if (!this.file) return;
    let stamp: string;
    try {
      const st = statSync(this.file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // No file is an empty store, not a broken one: nothing has been issued yet.
        this.records = [];
        this.seen = "absent";
        this.broken = false;
        return;
      }
      this.broken = true;
      if (strict) throw new CredentialError(`cannot read the credentials file: ${(e as Error).message}`);
      return;
    }
    if (stamp === this.seen && !this.broken) return;
    try {
      const parsed = CredentialFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.records = parsed.credentials;
      this.seen = stamp;
      this.broken = false;
    } catch (e) {
      this.broken = true;
      this.seen = undefined;
      // The message names the file and the problem; it can never contain a secret, which the
      // file does not hold.
      if (strict) throw new CredentialError(`the credentials file is not valid: ${(e as Error).message}`);
    }
  }

  private persist(): void {
    if (!this.file) return;
    writePrivateFile(this.file, `${JSON.stringify({ version: 1, credentials: this.records }, null, 2)}\n`);
    const st = statSync(this.file);
    this.seen = `${st.ino}:${st.size}:${st.mtimeMs}`;
  }
}

function info(record: CredentialRecord): CredentialInfo {
  const { secretSha256: _hidden, ...rest } = record;
  return rest;
}
