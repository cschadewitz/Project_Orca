/**
 * Which principal started which root run.
 *
 * The run log has no owner field, and adding one is the engine's business rather than this
 * story's, so the daemon keeps the mapping beside the credentials: a root run id to the
 * principal id that started it through `runs.start`. A child run is never recorded - its
 * access is its root's (resources.ts) - and neither is a run that predates authentication or
 * was started by a CLI: those have no owner, and only an `all`-scoped principal sees them.
 * Missing ownership always narrows access; it never widens it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writePrivateFile } from "./credentials.js";

const OwnershipFileSchema = z.object({ version: z.literal(1), runs: z.record(z.string(), z.string()) });

export class OwnershipStore {
  private readonly runs = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();

  /** `file` absent keeps ownership in memory, which forgets it on restart (and so narrows access). */
  constructor(private readonly file?: string) {
    if (!file) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const [run, owner] of Object.entries(OwnershipFileSchema.parse(JSON.parse(text)).runs))
      this.runs.set(run, owner);
  }

  owner(rootRunId: string): string | undefined {
    return this.runs.get(rootRunId);
  }

  /**
   * Record an owner, synchronously in memory so the next access check sees it, and on disk
   * after. The first owner wins: a run is never re-attributed.
   */
  record(rootRunId: string, principalId: string): void {
    if (this.runs.has(rootRunId)) return;
    this.runs.set(rootRunId, principalId);
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const snapshot = JSON.stringify({ version: 1, runs: Object.fromEntries(this.runs) });
    // A failed write narrows access after the next restart and nothing else, so it is kept
    // for `flush` to report rather than allowed to wedge every later write.
    this.writing = this.writing
      .then(() => {
        writePrivateFile(file, `${snapshot}\n`);
        this.lastError = undefined;
      })
      .catch((e: unknown) => {
        this.lastError = e;
      });
  }

  /** The last persistence failure, if any. */
  lastError: unknown;

  /** Undo an attribution, only if it is still `principalId`'s - a correction, never a takeover. */
  forget(rootRunId: string, principalId: string): void {
    if (this.runs.get(rootRunId) !== principalId) return;
    this.runs.delete(rootRunId);
    this.persist();
  }

  /** Resolves once every recorded owner is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }
}
