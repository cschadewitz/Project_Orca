/** Durable closed-replacement identity. Stored consent is never installation authority. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { RuntimeMaintenanceTargetSchema } from "@orca/protocol";
import type { DiagnosticsKeyAdapter, RecoveryNativeAdapter } from "./diagnostics/native-adapter.js";
import type { RecoveryFileSystem } from "./diagnostics/recovery-files.js";
import { sameIdentity } from "./diagnostics/native-adapter.js";
import { freezeMacMetadata } from "./mac-candidate-manifest.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(128);
export const MacProtectedPairSchema = z.strictObject({
  id: z.uuid(),
  manifestSha256: digest,
  binarySha256: digest,
  stateSha256: digest,
  /** Digests cover content/topology/access of every protected root, not only store epoch. */
  roots: z
    .array(z.strictObject({ id: text, sha256: digest }))
    .min(1)
    .max(32),
  /** Includes safeStorage/Keychain, protected intent and TCC continuity; no reset fallback. */
  continuitySha256: digest,
  /** Monotonic complete writer ledger includes startup/migration and reverted writes. */
  writerEpoch: z.uuid(),
  writeRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type MacProtectedPair = z.infer<typeof MacProtectedPairSchema>;
export const MacReplacementRecordSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  fenceId: z.uuid(),
  token: z.uuid(),
  previousTarget: RuntimeMaintenanceTargetSchema,
  candidate: z.strictObject({ manifestSha256: digest, channel: text, compatibilityPlanId: text, recoveryPlanId: text }),
  /** Required set is captured from the configured writer owner, never renderer input. */
  rootIds: z.array(text).min(1).max(32),
  phase: z.enum(["closed", "launching", "verified-closed", "preserved", "restoring", "restored-closed"]),
  previous: MacProtectedPairSchema,
  current: MacProtectedPairSchema.optional(),
});
export type MacReplacementRecord = z.infer<typeof MacReplacementRecordSchema>;
export interface MacReplacementStorage {
  /** Exclusive, handle-relative, durable native storage over a separate updater-owned root. */
  readonly native: RecoveryNativeAdapter;
  readonly files: RecoveryFileSystem;
  readonly keys: DiagnosticsKeyAdapter;
}
const JOURNAL_LIMIT = 40 * 1024;
const RECORD_LIMIT = 32 * 1024;
const unavailable = () => new Error("Replacement recovery unavailable");

/** Reuses existing native durability/secure-storage guards; no path-based production fallback.
 * Unacknowledged writes retain the temp/record; a new process stays closed and cannot retry.
 * No deletion, cleanup, rollback selection, approval resurrection or credential mutation.
 */
export class MacReplacementJournal {
  private tail: Promise<void> = Promise.resolve();
  private acquired = false;
  private failed = false;
  constructor(
    private readonly root: string,
    private readonly storage: MacReplacementStorage,
  ) {
    if (!isAbsolute(root) || resolve(root) !== root) throw unavailable();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async acquire(): Promise<void> {
    if (this.failed) throw unavailable();
    if (!this.acquired) {
      if (
        !(await this.storage.keys.available()) ||
        !(await this.storage.native.verifyRoot(this.root)) ||
        !(await this.storage.native.acquire(this.root))
      )
        throw unavailable();
      this.acquired = true;
    }
    const names = await this.storage.files.readdir(this.root);
    if (names.some((name) => !["writer.lock", "replacement.enc"].includes(name))) throw unavailable();
  }
  read(): Promise<MacReplacementRecord | undefined> {
    return this.serial(async () => {
      try {
        await this.acquire();
        let file;
        try {
          file = await this.storage.files.open(
            join(this.root, "replacement.enc"),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        }
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size <= 0 ||
            stat.size > JOURNAL_LIMIT ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o077) !== 0
          )
            throw unavailable();
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) throw unavailable();
            offset += read.bytesRead;
          }
          const end = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
          const final = await file.stat();
          if (
            end.bytesRead ||
            final.size !== stat.size ||
            !sameIdentity(final, { device: String(stat.dev), inode: String(stat.ino) })
          )
            throw unavailable();
          if (bytes.length < 33) throw unavailable();
          const keyLength = bytes.readUInt32BE(0);
          if (keyLength < 1 || keyLength > 4096 || bytes.length < keyLength + 33) throw unavailable();
          const key = await this.storage.keys.unwrap(bytes.subarray(4, 4 + keyLength));
          let plain: Buffer;
          try {
            if (key.length !== 32) throw unavailable();
            const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4 + keyLength, 16 + keyLength));
            decipher.setAAD(Buffer.from(`orca-replacement-v1:${this.root}`));
            decipher.setAuthTag(bytes.subarray(16 + keyLength, 32 + keyLength));
            const pending = decipher.update(bytes.subarray(32 + keyLength));
            try {
              plain = Buffer.concat([pending, decipher.final()]);
            } finally {
              pending.fill(0);
            }
          } finally {
            key.fill(0);
          }
          try {
            if (plain.length > RECORD_LIMIT) throw unavailable();
            return freezeMacMetadata(MacReplacementRecordSchema.parse(JSON.parse(plain.toString("utf8"))));
          } finally {
            plain.fill(0);
          }
        } finally {
          await file.close();
        }
      } catch {
        this.failed = true;
        throw unavailable();
      }
    });
  }
  commit(record: MacReplacementRecord): Promise<void> {
    return this.serial(async () => {
      try {
        await this.acquire();
        const plain = Buffer.from(JSON.stringify(MacReplacementRecordSchema.parse(record)));
        let bytes: Buffer;
        try {
          if (plain.length > RECORD_LIMIT) throw unavailable();
          const key = randomBytes(32);
          try {
            const wrapped = await this.storage.keys.wrap(key);
            if (!wrapped.length || wrapped.length > 4096) throw unavailable();
            const nonce = randomBytes(12),
              cipher = createCipheriv("aes-256-gcm", key, nonce);
            cipher.setAAD(Buffer.from(`orca-replacement-v1:${this.root}`));
            const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(wrapped.length);
            bytes = Buffer.concat([size, wrapped, nonce, cipher.getAuthTag(), encrypted]);
          } finally {
            key.fill(0);
          }
        } finally {
          plain.fill(0);
        }
        if (!bytes.length || bytes.length > JOURNAL_LIMIT) throw unavailable();
        const temp = join(this.root, "replacement.tmp");
        const file = await this.storage.files.open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await this.storage.native.write(file, bytes);
        } finally {
          await file.close();
        }
        await this.storage.native.replace(temp, join(this.root, "replacement.enc"));
      } catch {
        this.failed = true;
        throw unavailable();
      }
    });
  }
  /** Closing the app releases the handle, never the durable replacement admission fence. */
  close(): Promise<void> {
    return this.serial(async () => {
      if (this.acquired) {
        await this.storage.native.release(this.root);
        this.acquired = false;
      }
    });
  }
}
