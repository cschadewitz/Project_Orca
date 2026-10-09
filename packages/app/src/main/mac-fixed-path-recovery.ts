/** Closed-window whole-pair recovery. No live directory topology or all-write ledger. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ClosedUpdateWindow } from "@orca/protocol/update-window";
import { RuntimeMaintenanceTargetSchema } from "@orca/protocol";
import { readMacManifest, sha256 } from "./mac-candidate-manifest.js";
import { type PairTreePort, syncPairDirectory, syncPairRecord } from "./mac-fixed-path-files.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const RootSchema = z.strictObject({ path: z.string(), sha256: digest });
const PairSchema = z.strictObject({
  version: z.literal(1),
  attempt: z.uuid(),
  manifestSha256: digest,
  binaryVerified: z.boolean(),
  continuitySha256: digest,
  roots: z.array(RootSchema).min(1).max(32),
  binary: RootSchema,
});
export type FixedProtectedPair = z.infer<typeof PairSchema>;
const StartupSchema = z.strictObject({
  version: z.literal(1),
  attempt: z.uuid(),
  previousTarget: RuntimeMaintenanceTargetSchema,
  candidate: z.strictObject({
    manifestSha256: digest,
    channel: z.string().min(1).max(128),
    compatibilityPlanId: z.string().min(1).max(128),
    recoveryPlanId: z.string().min(1).max(128),
  }),
  storeDir: z.string().max(4096),
  manifestBase64: z.string().max(16384),
});
export type FixedStartupIdentity = z.infer<typeof StartupSchema>;
const ProgressSchema = z.strictObject({
  version: z.literal(1),
  attempt: z.uuid(),
  previous: PairSchema,
  current: PairSchema,
  next: z.number().int().min(0).max(33),
  phase: z.enum(["restoring", "restored"]),
});
export interface FixedPathRecoveryPorts {
  readonly trees: PairTreePort;
  /** Verify whole signed bundle/publisher/manifest/daemon bytes at the specified path,
   * including saved copies. Existing native candidate acceptance, never a declared hash. */
  verifyBinary(this: void, path: string, manifestSha256: string, signal: AbortSignal): Promise<boolean>;
  /** Read existing secure-storage/intent/TCC continuity; never reset, migrate or export
   * Keychain/TCC. Any observed continuity change refuses automatic restoration. */
  continuity(this: void, signal: AbortSignal): Promise<string>;
}
const unavailable = () => new Error("Protected fixed-path recovery unavailable");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** One window/attempt. Incomplete backups are evidence; they cannot authorize replacement.
 * Restore journals its intention before the first fixed-path write. Both complete backups
 * remain intact. A fresh same-boot owner resumes only with all writer slots and exact pairs.
 * This object never installs a candidate or reopens admission. */
export class MacFixedPathRecovery {
  private busy = false;
  private poisoned = false;
  private readonly roots: readonly string[];
  private readonly base: string;
  constructor(
    private readonly window: ClosedUpdateWindow,
    private readonly control: string,
    private readonly binary: string,
    private readonly ports: FixedPathRecoveryPorts,
  ) {
    this.ports = Object.freeze({
      trees: Object.freeze({ digest: ports.trees.digest, copy: ports.trees.copy, restore: ports.trees.restore }),
      verifyBinary: ports.verifyBinary,
      continuity: ports.continuity,
    });
    const snapshot = window.snapshot;
    if (
      !snapshot.attempt ||
      !isAbsolute(control) ||
      resolve(control) !== control ||
      !isAbsolute(binary) ||
      resolve(binary) !== binary
    )
      throw unavailable();
    this.roots = Object.freeze(snapshot.roots.map((r) => r.path));
    if (
      this.roots.some((r) => binary === r || binary.startsWith(r + "/") || r.startsWith(binary + "/")) ||
      binary === control ||
      binary.startsWith(control + "/") ||
      control.startsWith(binary + "/")
    )
      throw unavailable();
    this.base = join(control, "pairs", snapshot.attempt);
  }
  private check(signal: AbortSignal) {
    if (signal.aborted || this.poisoned || !this.window.check()) throw unavailable();
  }
  private async operation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (this.busy) throw unavailable();
    this.busy = true;
    try {
      this.check(signal);
      // Control receipts and directory flushes are dispatched writes too. Detach must
      // await the entire operation, including work between tree calls, before releasing.
      const result = await this.window.track(work);
      this.check(signal);
      return result;
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async inspect<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.check(signal);
    const result = await this.window.track(work);
    this.check(signal);
    return result;
  }
  private async privateDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || (await realpath(path)) !== path)
      throw unavailable();
  }
  private async createDirectory(path: string) {
    await mkdir(path, { mode: 0o700 });
    await syncPairDirectory(path);
    await syncPairDirectory(resolve(path, ".."));
  }
  private async record<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 16384
      )
        throw unavailable();
      const bytes = await handle.readFile();
      const final = await handle.stat(),
        entry = await lstat(path);
      if (
        bytes.length !== stat.size ||
        final.size !== stat.size ||
        final.mtimeMs !== stat.mtimeMs ||
        entry.dev !== stat.dev ||
        entry.ino !== stat.ino
      )
        throw unavailable();
      return schema.parse(JSON.parse(bytes.toString("utf8")));
    } finally {
      await handle.close();
    }
  }
  private async write(path: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > 16384) throw unavailable();
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await syncPairRecord(handle);
    } finally {
      await handle.close();
    }
    await syncPairDirectory(resolve(path, ".."));
  }
  private async verify(pair: FixedProtectedPair, kind: "previous" | "current", signal: AbortSignal): Promise<boolean> {
    if (
      pair.attempt !== this.window.snapshot.attempt ||
      !same(
        pair.roots.map((r) => r.path),
        this.roots,
      ) ||
      pair.binary.path !== this.binary ||
      pair.binaryVerified !== (kind === "previous")
    )
      return false;
    const directory = join(this.base, kind);
    await this.privateDirectory(directory);
    if (
      !same((await readdir(directory)).sort(), ["binary", "pair.json", ...this.roots.map((_, i) => "root-" + i)].sort())
    )
      return false;
    for (let i = 0; i < pair.roots.length; i++)
      if (
        (await this.inspect(signal, () => this.ports.trees.digest(join(directory, "root-" + i), signal))) !==
        pair.roots[i]!.sha256
      )
        return false;
    return (
      (await this.inspect(signal, () => this.ports.trees.digest(join(directory, "binary"), signal))) ===
        pair.binary.sha256 &&
      (kind === "current" ||
        (await this.inspect(signal, () =>
          this.ports.verifyBinary(join(directory, "binary"), pair.manifestSha256, signal),
        )))
    );
  }
  private async capture(
    kind: "previous" | "current",
    manifestSha256: string,
    signal: AbortSignal,
  ): Promise<FixedProtectedPair> {
    digest.parse(manifestSha256);
    await this.privateDirectory(this.control);
    const directory = join(this.base, kind);
    try {
      await lstat(directory);
      const existing = await this.record(join(directory, "pair.json"), PairSchema);
      if (existing.manifestSha256 !== manifestSha256 || !(await this.verify(existing, kind, signal)))
        throw unavailable();
      return existing;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    // Missing receipt behind an existing partial directory may never become a new backup.
    try {
      await lstat(directory);
      throw unavailable();
    } catch (error) {
      if (!absent(error)) throw error;
    }
    for (const path of [join(this.control, "pairs"), this.base]) {
      try {
        await this.privateDirectory(path);
      } catch (error) {
        if (!absent(error)) throw error;
        await this.createDirectory(path);
      }
    }
    await this.createDirectory(directory);
    const continuitySha256 = digest.parse(await this.inspect(signal, () => this.ports.continuity(signal)));
    if (
      kind === "previous" &&
      !(await this.inspect(signal, () => this.ports.verifyBinary(this.binary, manifestSha256, signal)))
    )
      throw unavailable();
    const roots: FixedProtectedPair["roots"] = [];
    for (let i = 0; i < this.roots.length; i++) {
      const path = this.roots[i]!;
      const sha256 = await this.inspect(signal, () => this.ports.trees.digest(path, signal));
      await this.inspect(signal, () => this.ports.trees.copy(path, join(directory, "root-" + i), signal));
      if ((await this.inspect(signal, () => this.ports.trees.digest(path, signal))) !== sha256) throw unavailable();
      roots.push({ path, sha256 });
    }
    const binarySha256 = await this.inspect(signal, () => this.ports.trees.digest(this.binary, signal));
    await this.inspect(signal, () => this.ports.trees.copy(this.binary, join(directory, "binary"), signal));
    if ((await this.inspect(signal, () => this.ports.trees.digest(this.binary, signal))) !== binarySha256)
      throw unavailable();
    const pair = PairSchema.parse({
      version: 1,
      attempt: this.window.snapshot.attempt,
      manifestSha256,
      // A failed candidate can contain incomplete bytes. Preserve its exact tree as
      // evidence without claiming it is a verified executable. Only the previous
      // matching binary is signature-accepted and eligible for execution/restoration.
      binaryVerified: kind === "previous",
      continuitySha256,
      roots,
      binary: { path: this.binary, sha256: binarySha256 },
    });
    if (
      (kind === "previous" &&
        !(await this.inspect(signal, () =>
          this.ports.verifyBinary(join(directory, "binary"), manifestSha256, signal),
        ))) ||
      (await this.inspect(signal, () => this.ports.continuity(signal))) !== continuitySha256
    )
      throw unavailable();
    await this.write(join(directory, "pair.json"), pair);
    if (!(await this.verify(pair, kind, signal))) throw unavailable();
    return pair;
  }
  backupPrevious(manifestSha256: string, signal: AbortSignal): Promise<FixedProtectedPair> {
    return this.operation(signal, async () => {
      if (this.window.snapshot.phase !== "closed") throw unavailable();
      return this.capture("previous", manifestSha256, signal);
    });
  }
  retainStartupIdentity(input: Omit<FixedStartupIdentity, "version" | "attempt">, signal: AbortSignal): Promise<void> {
    const captured = structuredClone(input);
    return this.operation(signal, async () => {
      if (
        this.window.snapshot.phase !== "closed" ||
        captured.candidate.manifestSha256 !== this.window.snapshot.candidate ||
        !isAbsolute(captured.storeDir) ||
        resolve(captured.storeDir) !== captured.storeDir ||
        !this.roots.some((root) => captured.storeDir === root || captured.storeDir.startsWith(root + "/"))
      )
        throw unavailable();
      const bytes = Buffer.from(captured.manifestBase64, "base64");
      if (
        bytes.toString("base64") !== captured.manifestBase64 ||
        sha256(bytes) !== captured.candidate.manifestSha256 ||
        readMacManifest(bytes).kind !== "candidate"
      )
        throw unavailable();
      const previous = await this.record(join(this.base, "previous", "pair.json"), PairSchema);
      if (!(await this.verify(previous, "previous", signal))) throw unavailable();
      await this.write(
        join(this.base, "startup.json"),
        StartupSchema.parse({ version: 1, attempt: this.window.snapshot.attempt, ...captured }),
      );
    });
  }
  readStartupIdentity(signal: AbortSignal): Promise<FixedStartupIdentity> {
    return this.operation(signal, async () => {
      const record = await this.record(join(this.base, "startup.json"), StartupSchema);
      const bytes = Buffer.from(record.manifestBase64, "base64");
      if (
        record.attempt !== this.window.snapshot.attempt ||
        record.candidate.manifestSha256 !== this.window.snapshot.candidate ||
        sha256(bytes) !== record.candidate.manifestSha256 ||
        readMacManifest(bytes).kind !== "candidate"
      )
        throw unavailable();
      return record;
    });
  }
  /** Migrations may write while the one-use child is closed. They are preserved as a
   * complete failed candidate pair, then discarded only while no user work was admitted.
   * Restoration after reopen is categorically refused, regardless of equal content. */
  restore(
    previousManifestSha256: string,
    candidateManifestSha256: string,
    signal: AbortSignal,
  ): Promise<"restored-closed"> {
    return this.operation(signal, async () => {
      if (
        candidateManifestSha256 !== this.window.snapshot.candidate ||
        !["closed", "migrating", "validating", "restoring", "restored"].includes(this.window.snapshot.phase)
      )
        throw unavailable();
      const previous = await this.record(join(this.base, "previous", "pair.json"), PairSchema);
      if (
        previous.manifestSha256 !== previousManifestSha256 ||
        !(await this.verify(previous, "previous", signal)) ||
        (await this.inspect(signal, () => this.ports.continuity(signal))) !== previous.continuitySha256
      )
        throw unavailable();
      let progress: z.infer<typeof ProgressSchema>;
      const progressPath = join(this.base, "restore.json");
      try {
        progress = await this.record(progressPath, ProgressSchema);
      } catch (error) {
        if (!absent(error) || this.window.snapshot.phase === "restoring" || this.window.snapshot.phase === "restored")
          throw error;
        const current = await this.capture("current", candidateManifestSha256, signal);
        progress = { version: 1, attempt: previous.attempt, previous, current, next: 0, phase: "restoring" };
        await this.write(progressPath, progress);
      }
      if (
        progress.attempt !== this.window.snapshot.attempt ||
        !same(progress.previous, previous) ||
        progress.current.manifestSha256 !== candidateManifestSha256 ||
        !(await this.verify(progress.current, "current", signal)) ||
        progress.current.continuitySha256 !== previous.continuitySha256
      )
        throw unavailable();
      if (this.window.snapshot.phase !== "restoring" && this.window.snapshot.phase !== "restored")
        this.window.setPhase("restoring");
      // Steps are append-only. A lost receipt repeats an idempotent fixed-path restore;
      // never rewrite/delete the pair or infer successful progress from a partial live tree.
      const steps = [
        ...this.roots.map((path, i) => ({
          path,
          source: join(this.base, "previous", "root-" + i),
          sha256: previous.roots[i]!.sha256,
        })),
        { path: this.binary, source: join(this.base, "previous", "binary"), sha256: previous.binary.sha256 },
      ];
      for (let i = 0; i < steps.length; i++) {
        const receipt = join(this.base, "step-" + i + ".json"),
          step = steps[i]!;
        try {
          const saved = await this.record(
            receipt,
            z.strictObject({ attempt: z.uuid(), index: z.number().int(), sha256: digest }),
          );
          if (!same(saved, { attempt: previous.attempt, index: i, sha256: step.sha256 })) throw unavailable();
        } catch (error) {
          if (!absent(error)) throw error;
          await this.inspect(signal, () => this.ports.trees.restore(step.source, step.path, signal));
          if ((await this.inspect(signal, () => this.ports.trees.digest(step.path, signal))) !== step.sha256)
            throw unavailable();
          await this.write(receipt, { attempt: previous.attempt, index: i, sha256: step.sha256 });
        }
        if ((await this.inspect(signal, () => this.ports.trees.digest(step.path, signal))) !== step.sha256)
          throw unavailable();
      }
      if (
        !(await this.inspect(signal, () => this.ports.verifyBinary(this.binary, previousManifestSha256, signal))) ||
        (await this.inspect(signal, () => this.ports.continuity(signal))) !== previous.continuitySha256
      )
        throw unavailable();
      if (this.window.snapshot.phase !== "restored") this.window.setPhase("restored");
      return "restored-closed" as const;
    });
  }
}
