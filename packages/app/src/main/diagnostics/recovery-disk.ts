/** Bounded encrypted recovery files; no execution store, logger, or network dependencies. */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  RECOVERY_LIMITS,
  validReading,
  type BootReading,
  type DiagnosticsSetting,
  type ExportState,
  type RecoveryDisk,
  type StageIdentity,
  type StoredCheckpoint,
} from "./recovery-contract.js";
import { isCode, sameIdentity, type DiagnosticsKeyAdapter, type RecoveryNativeAdapter } from "./native-adapter.js";

type Slot = 0 | 1 | 2;
interface RecordHeader {
  version: 1;
  scopeVersion: number;
  epoch: string;
  slot: Slot;
  sessionId: string;
  keyId: string;
  generation: number;
  anchor: BootReading;
  bytes: number;
}
interface Manifest {
  version: 1;
  scopeVersion: number;
  epoch: string;
  generation: number;
  current?: RecordHeader;
  previous?: RecordHeader;
}
interface KeyEnvelope {
  version: 1;
  purpose: "control" | "session";
  epoch: string;
  keyId: string;
  sessionId: string;
  key: string;
}
const DEFAULT_SETTING: DiagnosticsSetting = { enabled: false, scopeVersion: 1, minutes: 5 };
const RECORD_OVERHEAD = 16_384;
const CONTROL_LIMIT = 4096;
const allowedNames = new Set([
  "setting.json",
  "setting.json.tmp",
  "manifest.json",
  "manifest.json.tmp",
  "control.key",
  "control.key.tmp",
  "export.json",
  "export.json.tmp",
  "export-stage.tmp",
  "writer.lock",
  ...[0, 1, 2].flatMap((slot) => [`slot-${slot}.bin`, `session-${slot}.key`]),
]);
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;

export interface RecoveryDiskOptions {
  root: string;
  keys: DiagnosticsKeyAdapter;
  native: RecoveryNativeAdapter;
  scopeVersion?: number;
}

/** One disk object/profile writer. Outstanding native calls retain its mutation gate.
 * No timeout is treated as cancellation; callers revoke admission immediately and
 * retain their reservation until this operation actually settles.
 */
export class NodeRecoveryDisk implements RecoveryDisk {
  revoke(): void {
    this.active = false;
    this.revoked = true;
    this.maintenanceEpoch++;
  }
  private readonly root: string;
  private readonly scope: number;
  private tail: Promise<void> = Promise.resolve();
  private manifest: Manifest | undefined;
  private control: Buffer | undefined;
  private session: { key: Buffer; id: string; keyId: string } | undefined;
  private active = false;
  private captureOpened = false;
  private revoked = false;
  private closed = false;
  private maintenanceEpoch = 0;
  private lease = false;
  private lastReading: BootReading | undefined;
  private rootIdentity: StageIdentity | undefined;

  constructor(private readonly options: RecoveryDiskOptions) {
    this.root = resolve(options.root);
    this.scope = options.scopeVersion ?? 1;
    if (this.root !== options.root || !Number.isSafeInteger(this.scope) || this.scope < 1)
      throw new Error("unavailable");
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private path(name: string): string {
    return join(this.root, name);
  }
  private async safeRoot(): Promise<void> {
    if (!(await this.options.native.verifyRoot(this.root))) throw new Error("unavailable");
    const stat = await lstat(this.root);
    if (this.rootIdentity && !sameIdentity(stat, this.rootIdentity)) throw new Error("cleanup_pending");
    this.rootIdentity ??= { device: String(stat.dev), inode: String(stat.ino) };
  }
  private async acquire(): Promise<void> {
    await this.safeRoot();
    if (!this.lease) {
      if (!(await this.options.native.acquire(this.root))) throw new Error("unavailable");
      this.lease = true;
    }
  }
  private async inspect(): Promise<{ retained: number; controls: number; export: number; entries: number }> {
    await this.safeRoot();
    const names = await readdir(this.root);
    if (names.length > RECOVERY_LIMITS.entries) throw new Error("capacity_limited");
    let retained = 0,
      controls = 0,
      exported = 0,
      cleanup = 0;
    for (const name of names) {
      if (!allowedNames.has(name)) throw new Error("cleanup_pending");
      const stat = await lstat(this.path(name));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.uid !== process.getuid?.() && process.platform !== "win32") ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw new Error("cleanup_pending");
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("capacity_limited");
      if (name === "export-stage.tmp") exported += stat.size;
      else {
        retained += stat.size;
        if (!/^slot-[012]\.bin$/.test(name)) controls += stat.size;
      }
      if (name.startsWith("export.json")) cleanup += stat.size;
      const limit =
        name === "export-stage.tmp"
          ? RECOVERY_LIMITS.exportBytes
          : /^slot-[012]\.bin$/.test(name)
            ? RECOVERY_LIMITS.exportBytes + RECORD_OVERHEAD
            : CONTROL_LIMIT;
      if (stat.size > limit) throw new Error("capacity_limited");
    }
    if (
      retained > RECOVERY_LIMITS.retainedBytes ||
      controls > RECOVERY_LIMITS.controlBytes ||
      exported > RECOVERY_LIMITS.exportBytes ||
      cleanup > RECOVERY_LIMITS.cleanupBytes
    )
      throw new Error("capacity_limited");
    return { retained, controls, export: exported, entries: names.length };
  }
  private async reserve(bytes: number, control: boolean, name: string): Promise<void> {
    const budget = await this.inspect();
    if (
      budget.retained + bytes > RECOVERY_LIMITS.retainedBytes ||
      (control && budget.controls + bytes > RECOVERY_LIMITS.controlBytes) ||
      budget.entries + 1 > RECOVERY_LIMITS.entries
    )
      throw new Error("capacity_limited");
    try {
      await lstat(this.path(name));
      throw new Error("cleanup_pending");
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  private async read(name: string, maximum = CONTROL_LIMIT): Promise<Buffer | undefined> {
    await this.safeRoot();
    let file: FileHandle;
    try {
      file = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > maximum ||
        stat.size < 0 ||
        (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
      )
        throw new Error("unavailable");
      // Preallocate only the already bounded size; reject growth/shrink while reading.
      const bytes = Buffer.alloc(stat.size);
      let position = 0;
      while (position < bytes.length) {
        const result = await file.read(bytes, position, bytes.length - position, position);
        if (result.bytesRead === 0) throw new Error("unavailable");
        position += result.bytesRead;
      }
      if ((await file.stat()).size !== stat.size) throw new Error("unavailable");
      return bytes;
    } finally {
      await file.close();
    }
  }
  private async create(name: string, bytes: Buffer): Promise<void> {
    await this.reserve(bytes.length, !name.endsWith(".bin"), name);
    const handle = await open(
      this.path(name),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await this.options.native.write(handle, bytes);
    } finally {
      await handle.close();
    }
  }
  private async atomic(name: string, bytes: Buffer): Promise<void> {
    if (bytes.length > CONTROL_LIMIT) throw new Error("capacity_limited");
    await this.create(`${name}.tmp`, bytes);
    await this.safeRoot();
    await this.options.native.replace(this.path(`${name}.tmp`), this.path(name));
  }
  private async remove(name: string, identity?: StageIdentity): Promise<void> {
    await this.safeRoot();
    let stat;
    try {
      stat = await lstat(this.path(name));
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) ||
      (identity && !sameIdentity(stat, identity))
    )
      throw new Error("cleanup_pending");
    await this.options.native.remove(this.path(name));
  }
  private async setting(): Promise<DiagnosticsSetting> {
    const bytes = await this.read("setting.json");
    if (!bytes) return { ...DEFAULT_SETTING, scopeVersion: this.scope };
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isObject(value) ||
      !keysExactly(value, ["enabled", "scopeVersion", "minutes"]) ||
      typeof value.enabled !== "boolean" ||
      value.scopeVersion !== this.scope ||
      !validMinutes(value.minutes)
    )
      return { ...DEFAULT_SETTING, scopeVersion: this.scope };
    return { enabled: value.enabled, scopeVersion: this.scope, minutes: value.minutes };
  }
  readSetting(): Promise<DiagnosticsSetting> {
    return this.serialized(async () => {
      try {
        await lstat(this.root);
        return await this.setting();
      } catch {
        return { ...DEFAULT_SETTING, scopeVersion: this.scope };
      }
    });
  }
  writeSetting(setting: DiagnosticsSetting): Promise<void> {
    // Revocation affects admission before waiting for any outstanding disk operation.
    if (!setting.enabled) {
      this.active = false;
      this.revoked = true;
      this.maintenanceEpoch++;
    }
    return this.serialized(async () => {
      if (setting.scopeVersion !== this.scope || typeof setting.enabled !== "boolean" || !validMinutes(setting.minutes))
        throw new Error("unavailable");
      await this.acquire();
      if (await this.options.native.writersStopped(this.root)) await this.remove("setting.json.tmp");
      await this.atomic("setting.json", json(setting));
      if (!setting.enabled) this.active = false;
    });
  }
  private reading(now: BootReading | undefined): boolean {
    if (
      !validReading(now) ||
      (this.lastReading && (now.bootId !== this.lastReading.bootId || now.elapsedMs < this.lastReading.elapsedMs))
    )
      return false;
    this.lastReading = { ...now };
    return true;
  }
  private eligible(record: RecordHeader, now: BootReading | undefined): boolean {
    return (
      validReading(now) &&
      validReading(record.anchor) &&
      now.bootId === record.anchor.bootId &&
      now.elapsedMs >= record.anchor.elapsedMs &&
      now.elapsedMs - record.anchor.elapsedMs < RECOVERY_LIMITS.retentionMs
    );
  }
  private async protect(envelope: KeyEnvelope, key: Buffer): Promise<Buffer> {
    if (!(await this.options.keys.available())) throw new Error("unavailable");
    const plaintext = json({ ...envelope, key: key.toString("base64") });
    try {
      const wrapped = await this.options.keys.wrap(plaintext);
      if (wrapped.length > CONTROL_LIMIT) throw new Error("capacity_limited");
      return wrapped;
    } finally {
      plaintext.fill(0);
    }
  }
  private async unprotect(
    name: string,
    purpose: KeyEnvelope["purpose"],
    epoch: string,
    keyId: string,
    sessionId: string,
  ): Promise<Buffer> {
    if (!(await this.options.keys.available())) throw new Error("unavailable");
    const wrapped = await this.read(name);
    if (!wrapped) throw new Error("unavailable");
    const plaintext = await this.options.keys.unwrap(wrapped);
    try {
      if (plaintext.length > 2048) throw new Error("unavailable");
      const value: unknown = JSON.parse(plaintext.toString("utf8"));
      if (
        !isObject(value) ||
        !keysExactly(value, ["version", "purpose", "epoch", "keyId", "sessionId", "key"]) ||
        value.version !== 1 ||
        value.purpose !== purpose ||
        value.epoch !== epoch ||
        value.keyId !== keyId ||
        value.sessionId !== sessionId ||
        typeof value.key !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(value.key)
      )
        throw new Error("unavailable");
      const key = Buffer.from(value.key, "base64");
      if (key.length !== 32) throw new Error("unavailable");
      return key;
    } finally {
      plaintext.fill(0);
    }
  }
  private async commit(manifest: Manifest, admit: () => boolean = () => true): Promise<void> {
    if (!this.control) throw new Error("unavailable");
    const payload = json(manifest);
    const bytes = json({ payload: manifest, mac: createHmac("sha256", this.control).update(payload).digest("hex") });
    await this.create("manifest.json.tmp", bytes);
    if (!admit()) {
      await this.remove("manifest.json.tmp");
      throw new Error("off");
    }
    await this.safeRoot();
    // Admission is adjacent to dispatch; no await can separate the final check.
    if (!admit()) {
      await this.remove("manifest.json.tmp");
      throw new Error("off");
    }
    await this.options.native.replace(this.path("manifest.json.tmp"), this.path("manifest.json"));
    this.manifest = manifest;
  }
  private async authenticatedManifest(bytes?: Buffer): Promise<{ manifest: Manifest; control: Buffer }> {
    bytes ??= await this.read("manifest.json");
    if (!bytes) throw new Error("unavailable");
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isObject(envelope) ||
      !keysExactly(envelope, ["payload", "mac"]) ||
      typeof envelope.mac !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.mac) ||
      !validManifest(envelope.payload, this.scope)
    )
      throw new Error("unavailable");
    const manifest = envelope.payload;
    const control = await this.unprotect("control.key", "control", manifest.epoch, manifest.epoch, "");
    const mac = createHmac("sha256", control).update(json(manifest)).digest();
    if (!timingSafeEqual(mac, Buffer.from(envelope.mac, "hex"))) {
      control.fill(0);
      throw new Error("unavailable");
    }
    return { manifest, control };
  }
  private async verifyRecordEnvelope(record: RecordHeader): Promise<void> {
    const expected = json(record);
    if (expected.length > CONTROL_LIMIT) throw new Error("unavailable");
    const file = await open(this.path(`slot-${record.slot}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (stat.size !== record.bytes + expected.length + 32) throw new Error("unavailable");
      const prefix = Buffer.alloc(expected.length + 4);
      let position = 0;
      while (position < prefix.length) {
        const { bytesRead } = await file.read(prefix, position, prefix.length - position, position);
        if (!bytesRead) throw new Error("unavailable");
        position += bytesRead;
      }
      if (prefix.readUInt32BE(0) !== expected.length || !prefix.subarray(4).equals(expected))
        throw new Error("unavailable");
    } finally {
      await file.close();
    }
  }
  open(now: BootReading): Promise<boolean> {
    const epoch = this.maintenanceEpoch;
    const admit = () => this.maintenanceEpoch === epoch;
    return this.serialized(async () => {
      await this.acquire();
      await this.inspect();
      if (!(await this.setting()).enabled || !(await this.options.keys.available()) || !this.reading(now))
        throw new Error("unavailable");
      if (!(await this.options.native.writersStopped(this.root))) throw new Error("unavailable");
      if (!admit()) throw new Error("off");
      const bytes = await this.read("manifest.json");
      if (!bytes) {
        // Never regenerate authority over stray history/key files.
        const names = await readdir(this.root);
        if (names.some((name) => /^(slot-|session-|control\.key|manifest\.)/.test(name)))
          throw new Error("unavailable");
        const epoch = randomUUID();
        this.control = randomBytes(32);
        await this.atomic(
          "control.key",
          await this.protect(
            { version: 1, purpose: "control", epoch, keyId: epoch, sessionId: "", key: "" },
            this.control,
          ),
        );
        await this.commit({ version: 1, scopeVersion: this.scope, epoch, generation: 0 }, admit);
      } else {
        const { manifest, control } = await this.authenticatedManifest(bytes);
        this.control?.fill(0);
        this.control = control;
        this.manifest = manifest;
        // Only the authenticated predecessor can survive interrupted replacement.
        await this.remove("manifest.json.tmp");
        if (manifest.current && manifest.previous) {
          const { previous: _previous, ...revoked } = manifest;
          await this.commit(revoked, admit);
          await this.cleanUnreferenced();
        }
        // A latest crashed current invalidates the older candidate even when the
        // latest is expired or from another boot; never resurrect older history.
        const previous = manifest.current
          ? this.eligible(manifest.current, now)
            ? manifest.current
            : undefined
          : manifest.previous && this.eligible(manifest.previous, now)
            ? manifest.previous
            : undefined;
        await this.commit(
          {
            version: 1,
            scopeVersion: this.scope,
            epoch: manifest.epoch,
            generation: manifest.generation,
            ...(previous ? { previous } : {}),
          },
          admit,
        );
      }
      await this.cleanUnreferenced();
      if (!admit()) throw new Error("off");
      this.revoked = false;
      this.closed = false;
      this.session?.key.fill(0);
      this.session = undefined;
      this.captureOpened = true;
      this.active = true;
      return this.manifest?.previous !== undefined;
    });
  }
  private async cleanUnreferenced(): Promise<void> {
    if (!this.manifest || !this.control) throw new Error("unavailable");
    const used = new Set([this.manifest?.current?.slot, this.manifest?.previous?.slot]);
    for (const slot of [0, 1, 2] as const)
      if (!used.has(slot)) {
        await this.remove(`slot-${slot}.bin`);
        await this.remove(`session-${slot}.key`);
      }
    // Interrupted manifest replacement cannot promote its contents.
    await this.remove("manifest.json.tmp");
  }
  /** Bounded maintenance does not promote a current session, decrypt reports,
   * mutate export obligations, or create replacement authority over lost keys.
   */
  maintain(now: BootReading | undefined): Promise<boolean> {
    const epoch = this.maintenanceEpoch;
    const admit = () => !this.revoked && !this.closed && this.maintenanceEpoch === epoch;
    return this.serialized(async () => {
      if (!admit()) throw new Error("off");
      try {
        await lstat(this.root);
      } catch (error) {
        if (isCode(error, "ENOENT") && !this.manifest && !this.control) return false;
        throw new Error("unavailable", { cause: error });
      }
      await this.acquire();
      await this.inspect();
      if (!(await this.setting()).enabled) throw new Error("off");
      if (!(await this.options.native.writersStopped(this.root))) throw new Error("cleanup_pending");
      // A failed replacement may have committed. Re-read the authenticated disk
      // authority before choosing orphan files; cached roles cannot decide this.
      const bytes = await this.read("manifest.json");
      if (!bytes) {
        const names = await readdir(this.root);
        if (
          this.manifest ||
          this.control ||
          names.some((name) => /^(slot-|session-|control\.key|manifest\.)/.test(name))
        )
          throw new Error("unavailable");
        if (!admit()) throw new Error("off");
        return false;
      }
      const { manifest, control } = await this.authenticatedManifest(bytes);
      if (this.manifest && (manifest.epoch !== this.manifest.epoch || manifest.generation < this.manifest.generation)) {
        control.fill(0);
        throw new Error("unavailable");
      }
      if (!admit()) {
        control.fill(0);
        throw new Error("off");
      }
      this.control?.fill(0);
      this.control = control;
      this.manifest = manifest;
      const certain = this.reading(now);
      const { current, previous, ...authority } = manifest;
      const retainedCurrent = current && certain && this.eligible(current, now) ? current : undefined;
      const retainedPrevious = previous && certain && this.eligible(previous, now) ? previous : undefined;
      if (current !== retainedCurrent || previous !== retainedPrevious) {
        const revoked: Manifest = {
          ...authority,
          ...(retainedCurrent ? { current: retainedCurrent } : {}),
          ...(retainedPrevious ? { previous: retainedPrevious } : {}),
        };
        // Durable revocation precedes unlink. A failed unlink stays pending and
        // the next maintenance attempt retries only the now-unreferenced files.
        await this.remove("manifest.json.tmp");
        await this.commit(revoked, admit);
      }
      // Check referenced wrappers without opening report plaintext. Missing or
      // lost keys cannot yield a false successful cleanup or ready status.
      for (const record of [this.manifest.current, this.manifest.previous])
        if (record) {
          const key = await this.unprotect(
            `session-${record.slot}.key`,
            "session",
            record.epoch,
            record.keyId,
            record.sessionId,
          );
          key.fill(0);
          await this.verifyRecordEnvelope(record);
        }
      if (!admit()) throw new Error("off");
      await this.cleanUnreferenced();
      await this.remove("control.key.tmp");
      if (!certain) throw new Error("age_uncertain");
      return this.manifest.previous !== undefined;
    });
  }
  checkpoint(bytes: Buffer, anchor: BootReading, admit: () => boolean): Promise<void> {
    return this.serialized(async () => {
      if (!this.active || !this.manifest || !admit() || !(await this.setting()).enabled) throw new Error("off");
      if (bytes.length > RECOVERY_LIMITS.exportBytes || bytes.length === 0) throw new Error("capacity_limited");
      if (!this.reading(anchor)) throw new Error("age_uncertain");
      await this.inspect();
      if (!this.session) this.session = { key: randomBytes(32), id: randomUUID(), keyId: randomUUID() };
      const manifest = this.manifest;
      const slot = ([0, 1, 2] as const).find(
        (slot) => slot !== manifest.current?.slot && slot !== manifest.previous?.slot,
      );
      if (slot === undefined || manifest.generation >= Number.MAX_SAFE_INTEGER) throw new Error("capacity_limited");
      const record: RecordHeader = {
        version: 1,
        scopeVersion: this.scope,
        epoch: manifest.epoch,
        slot,
        sessionId: this.session.id,
        keyId: this.session.keyId,
        generation: manifest.generation + 1,
        anchor: { ...anchor },
        bytes: bytes.length,
      };
      const aad = json(record);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.session.key, nonce);
      cipher.setAAD(aad);
      const encrypted = cipher.update(bytes);
      cipher.final();
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(aad.length);
      const sealed = Buffer.concat([prefix, aad, nonce, cipher.getAuthTag(), encrypted]);
      if (sealed.length > RECOVERY_LIMITS.exportBytes + RECORD_OVERHEAD) throw new Error("capacity_limited");
      await this.create(
        `session-${slot}.key`,
        await this.protect(
          {
            version: 1,
            purpose: "session",
            epoch: manifest.epoch,
            keyId: record.keyId,
            sessionId: record.sessionId,
            key: "",
          },
          this.session.key,
        ),
      );
      await this.create(`slot-${slot}.bin`, sealed);
      await this.commit({ ...manifest, generation: record.generation, current: record }, () => this.active && admit());
      await this.cleanUnreferenced();
    });
  }
  previous(now: BootReading): Promise<StoredCheckpoint | undefined> {
    return this.serialized(async () => {
      if (!this.active || !(await this.setting()).enabled) return undefined;
      const record = this.manifest?.previous;
      if (!record) return undefined;
      if (!this.reading(now) || !this.eligible(record, now)) {
        await this.discardPreviousInternal();
        throw new Error("age_uncertain");
      }
      const bytes = await this.read(`slot-${record.slot}.bin`, RECOVERY_LIMITS.exportBytes + RECORD_OVERHEAD);
      if (!bytes || bytes.length < 32) throw new Error("unavailable");
      const size = bytes.readUInt32BE(0);
      if (size > CONTROL_LIMIT || size + 32 + record.bytes !== bytes.length) throw new Error("unavailable");
      const aad = bytes.subarray(4, 4 + size);
      if (!aad.equals(json(record))) throw new Error("unavailable");
      const key = await this.unprotect(
        `session-${record.slot}.key`,
        "session",
        record.epoch,
        record.keyId,
        record.sessionId,
      );
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(4 + size, 16 + size));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(16 + size, 32 + size));
        const plaintext = decipher.update(bytes.subarray(32 + size));
        try {
          decipher.final();
        } catch {
          plaintext.fill(0);
          throw new Error("unavailable");
        }
        return { bytes: plaintext, anchor: { ...record.anchor } };
      } finally {
        key.fill(0);
      }
    });
  }
  private async discardPreviousInternal(): Promise<void> {
    if (!this.manifest?.previous) return;
    const { previous: _previous, ...next } = this.manifest;
    await this.commit(next);
    await this.cleanUnreferenced();
  }
  discardPrevious(): Promise<void> {
    return this.serialized(() => this.discardPreviousInternal());
  }
  cleanExit(): Promise<void> {
    this.active = false;
    this.closed = true;
    this.maintenanceEpoch++;
    return this.serialized(async () => {
      // A maintenance-only adapter did not own the crashed capture session.
      // Closing it must not relabel that session as a clean current exit.
      if (this.captureOpened && this.manifest && this.control) {
        const { current: _current, ...next } = this.manifest;
        await this.commit(next);
        await this.cleanUnreferenced();
      }
      this.session?.key.fill(0);
      this.session = undefined;
      this.control?.fill(0);
      this.control = undefined;
      this.manifest = undefined;
      this.captureOpened = false;
      if (this.lease) {
        await this.options.native.release(this.root);
        this.lease = false;
      }
    });
  }
  cleanup(): Promise<void> {
    this.active = false;
    this.revoked = true;
    this.maintenanceEpoch++;
    return this.serialized(async () => {
      try {
        await lstat(this.root);
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
      await this.acquire();
      await this.inspect();
      if (!(await this.options.native.writersStopped(this.root))) throw new Error("cleanup_pending");
      // Remove publication authority before any referenced ciphertext or wrapper.
      for (const name of [
        "manifest.json",
        "manifest.json.tmp",
        ...[0, 1, 2].flatMap((slot) => [`slot-${slot}.bin`, `session-${slot}.key`]),
        "control.key",
        "control.key.tmp",
      ])
        await this.remove(name);
      this.session?.key.fill(0);
      this.session = undefined;
      this.control?.fill(0);
      this.control = undefined;
      this.manifest = undefined;
      this.captureOpened = false;
      const state = await this.exportState();
      await this.clearStageInternal(state.current?.stage);
      if (!state.current && !(await this.setting()).enabled) await this.remove("export.json");
    });
  }
  private async exportState(): Promise<ExportState> {
    const bytes = await this.read("export.json");
    if (!bytes) {
      if (await this.options.native.writersStopped(this.root)) await this.remove("export.json.tmp");
      return {};
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!validExportState(value)) throw new Error("cleanup_pending");
    if (await this.options.native.writersStopped(this.root)) await this.remove("export.json.tmp");
    return value;
  }
  readExportState(): Promise<ExportState> {
    return this.serialized(async () => {
      try {
        await lstat(this.root);
      } catch (error) {
        if (isCode(error, "ENOENT")) return {};
        throw error;
      }
      await this.inspect();
      return this.exportState();
    });
  }
  private async exportCommit(state: ExportState): Promise<void> {
    if (!validExportState(state)) throw new Error("cleanup_pending");
    await this.atomic("export.json", json(state));
  }
  writeExportState(state: ExportState): Promise<void> {
    return this.serialized(async () => {
      await this.acquire();
      await this.exportCommit(state);
    });
  }
  stageExport(id: string, bytes: Buffer): Promise<StageIdentity> {
    return this.serialized(async () => {
      await this.acquire();
      if (bytes.length > RECOVERY_LIMITS.exportBytes || bytes.length === 0) throw new Error("capacity_limited");
      const state = await this.exportState();
      if (state.current?.id !== id || state.current.phase !== "intent" || state.current.stage)
        throw new Error("cleanup_pending");
      await this.reserve(0, false, "export-stage.tmp");
      const file = await open(
        this.path("export-stage.tmp"),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = await file.stat();
        const identity = { device: String(stat.dev), inode: String(stat.ino) };
        // The intent and identity commit are durable before the first plaintext write.
        await this.exportCommit({ ...state, current: { id, phase: "staged", stage: identity } });
        await this.options.native.write(file, bytes);
        // Verify the entire exact copy without another full-size buffer.
        const check = await open(this.path("export-stage.tmp"), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const observed = await check.stat();
          if (!sameIdentity(observed, identity) || observed.size !== bytes.length) throw new Error("cleanup_pending");
          const chunk = Buffer.alloc(Math.min(65_536, bytes.length));
          for (let offset = 0; offset < bytes.length; offset += chunk.length) {
            const length = Math.min(chunk.length, bytes.length - offset);
            const result = await check.read(chunk, 0, length, offset);
            if (
              result.bytesRead !== length ||
              !chunk.subarray(0, length).equals(bytes.subarray(offset, offset + length))
            )
              throw new Error("cleanup_pending");
          }
        } finally {
          await check.close();
        }
        return identity;
      } finally {
        await file.close();
      }
    });
  }
  private async clearStageInternal(identity?: StageIdentity): Promise<void> {
    if (!(await this.options.native.writersStopped(this.root))) throw new Error("cleanup_pending");
    if (!identity) {
      try {
        await lstat(this.path("export-stage.tmp"));
        throw new Error("cleanup_pending");
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      return;
    }
    await this.remove("export-stage.tmp", identity);
  }
  clearStage(identity?: StageIdentity): Promise<void> {
    return this.serialized(async () => {
      try {
        await lstat(this.root);
      } catch (error) {
        if (isCode(error, "ENOENT") && !identity) return;
        throw error;
      }
      await this.safeRoot();
      await this.clearStageInternal(identity);
    });
  }
  validateDestination(destination: string): Promise<boolean> {
    return this.serialized(() => this.options.native.validateDestination(this.root, destination));
  }
  publishStage(
    identity: StageIdentity,
    destination: string,
    admit: () => boolean,
  ): Promise<"saved" | "refused" | "unknown"> {
    return this.serialized(async () => {
      await this.inspect();
      const state = await this.exportState();
      if (
        !state.current?.stage ||
        !sameStage(state.current.stage, identity) ||
        !["staged", "dispatched"].includes(state.current.phase)
      )
        return "refused";
      if (state.current.phase === "staged")
        await this.exportCommit({ ...state, current: { ...state.current, phase: "dispatched" } });
      return this.options.native.publish(this.root, this.path("export-stage.tmp"), destination, identity, admit);
    });
  }
  writersStopped(): Promise<boolean> {
    return this.serialized(() => this.options.native.writersStopped(this.root));
  }
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keysExactly(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function validMinutes(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 15;
}
function validRecord(value: unknown, scope: number, epoch: string): value is RecordHeader {
  return (
    isObject(value) &&
    keysExactly(value, [
      "version",
      "scopeVersion",
      "epoch",
      "slot",
      "sessionId",
      "keyId",
      "generation",
      "anchor",
      "bytes",
    ]) &&
    value.version === 1 &&
    value.scopeVersion === scope &&
    value.epoch === epoch &&
    [0, 1, 2].includes(Number(value.slot)) &&
    Number.isSafeInteger(value.slot) &&
    typeof value.sessionId === "string" &&
    uuidPattern.test(value.sessionId) &&
    typeof value.keyId === "string" &&
    uuidPattern.test(value.keyId) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 1 &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) > 0 &&
    Number(value.bytes) <= RECOVERY_LIMITS.exportBytes &&
    isObject(value.anchor) &&
    keysExactly(value.anchor, ["bootId", "elapsedMs"]) &&
    validReading(value.anchor as unknown as BootReading)
  );
}
function validManifest(value: unknown, scope: number): value is Manifest {
  return (
    isObject(value) &&
    keysExactly(value, ["version", "scopeVersion", "epoch", "generation"], ["current", "previous"]) &&
    value.version === 1 &&
    value.scopeVersion === scope &&
    typeof value.epoch === "string" &&
    uuidPattern.test(value.epoch) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    (value.current === undefined || validRecord(value.current, scope, value.epoch)) &&
    (value.previous === undefined || validRecord(value.previous, scope, value.epoch)) &&
    (!value.current || !value.previous || value.current.slot !== value.previous.slot) &&
    (!value.current || value.current.generation <= Number(value.generation)) &&
    (!value.previous || value.previous.generation <= Number(value.generation))
  );
}
function validIdentity(value: unknown): value is StageIdentity {
  return (
    isObject(value) &&
    keysExactly(value, ["device", "inode"]) &&
    typeof value.device === "string" &&
    /^\d{1,32}$/.test(value.device) &&
    typeof value.inode === "string" &&
    /^\d{1,32}$/.test(value.inode)
  );
}
function sameStage(a: StageIdentity, b: StageIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}
function validExportState(value: unknown): value is ExportState {
  if (!isObject(value) || !keysExactly(value, [], ["current", "summary"])) return false;
  if (
    value.current !== undefined &&
    (!isObject(value.current) ||
      !keysExactly(value.current, ["id", "phase"], ["stage"]) ||
      typeof value.current.id !== "string" ||
      !idPattern.test(value.current.id) ||
      !["intent", "staged", "dispatched", "unknown"].includes(String(value.current.phase)) ||
      (value.current.stage !== undefined && !validIdentity(value.current.stage)))
  )
    return false;
  if (
    value.summary !== undefined &&
    (!isObject(value.summary) ||
      !keysExactly(value.summary, ["id", "outcome", "acknowledged", "olderUnknowns"]) ||
      typeof value.summary.id !== "string" ||
      !idPattern.test(value.summary.id) ||
      value.summary.outcome !== "unknown" ||
      value.summary.acknowledged !== true ||
      typeof value.summary.olderUnknowns !== "boolean")
  )
    return false;
  return true;
}
