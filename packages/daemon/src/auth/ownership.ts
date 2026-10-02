/** Durable exact root ownership, merged under a cross-process mutex for daemon and local Request admissions. */
import { readFileSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { withFileLock } from "@orca/store";
import { writePrivateFile } from "./credentials.js";
const OwnershipFileSchema = z.object({ version: z.literal(1), runs: z.record(z.string(), z.string()) });
interface Change {
  runId: string;
  principalId: string;
  remove?: boolean;
}
export class OwnershipStore {
  private readonly runs = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Change>();
  constructor(private readonly file?: string) {
    if (file) for (const [run, owner] of this.readDisk()) this.runs.set(run, owner);
  }
  owner(rootRunId: string): string | undefined {
    if (!this.file) return this.runs.get(rootRunId);
    const durable = this.readDisk().get(rootRunId),
      pending = this.pending.get(rootRunId);
    if (pending?.remove && durable === pending.principalId) return undefined;
    return durable ?? (pending && !pending.remove ? pending.principalId : undefined);
  }
  /** The first durable owner wins. Pending attribution is visible in-process until flush. */
  record(rootRunId: string, principalId: string): void {
    if (this.owner(rootRunId)) {
      if (this.owner(rootRunId) === principalId && (this.lastError || this.pending.has(rootRunId)))
        this.persist({ runId: rootRunId, principalId });
      return;
    }
    this.runs.set(rootRunId, principalId);
    this.persist({ runId: rootRunId, principalId });
  }
  private persist(change: Change): void {
    if (!this.file) return;
    const file = this.file;
    this.pending.set(change.runId, change);
    this.writing = this.writing
      .then(async () => {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        await withFileLock(`${file}.lock`, async () => {
          const current = this.readDisk();
          if (change.remove) {
            if (current.get(change.runId) === change.principalId) current.delete(change.runId);
          } else if (!current.has(change.runId)) current.set(change.runId, change.principalId);
          writePrivateFile(file, `${JSON.stringify({ version: 1, runs: Object.fromEntries(current) })}\n`);
          const fd = openSync(file, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          if (process.platform !== "win32") {
            const directory = openSync(dirname(file), "r");
            try {
              fsyncSync(directory);
            } finally {
              closeSync(directory);
            }
          }
          this.runs.clear();
          for (const [run, owner] of current) this.runs.set(run, owner);
          if (this.pending.get(change.runId) === change) this.pending.delete(change.runId);
          this.lastError = undefined;
        });
      })
      .catch((e: unknown) => {
        this.lastError = e;
      });
  }
  private readDisk(): Map<string, string> {
    if (!this.file) return new Map(this.runs);
    try {
      return new Map(Object.entries(OwnershipFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).runs));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw e;
    }
  }
  lastError: unknown;
  /** Correction only, never a takeover. */
  forget(rootRunId: string, principalId: string): void {
    if (this.owner(rootRunId) !== principalId) return;
    this.runs.delete(rootRunId);
    this.persist({ runId: rootRunId, principalId, remove: true });
  }
  async flush(): Promise<void> {
    await this.writing;
    if (this.pending.size && !this.lastError) this.lastError = new Error("ownership changes remain unpersisted");
  }
}
