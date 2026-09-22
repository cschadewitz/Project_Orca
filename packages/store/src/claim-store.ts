/**
 * ClaimStore - who owns a work item.
 *
 * A WorkItem's status is a projection of one run's event log (see the engine's work-items.ts),
 * which says nothing about *other* runs: two fan-outs over the same items - a program run and a
 * second dispatcher started by an operator - would each compute their ready set, each spawn a
 * child run for the same item, and leave two workspaces and two agent sessions racing to write
 * one result. The log cannot arbitrate that, because the two runs have separate logs.
 *
 * So launching a work item goes through a claim: an atomic compare-and-set outside the logs,
 * taken before the child run is spawned. Exactly one branch of one run can hold it.
 *
 * A claim is held by `(runId, branch)`, not by the step: a re-attempted or resumed step is the
 * same owner and re-claims its own items, so replay stays idempotent. Claims are deliberately
 * *not* released when the child run finishes - a finished item must not be dispatched twice
 * either - and a claim outlives the process that took it. Taking an item away from a run that
 * died is therefore an explicit act (`release`), not something a competing dispatcher decides
 * on its own: the operator does it through `Orchestrator.releaseClaim` / `orca claims release`,
 * which refuse while the owning run could still resume.
 */
import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withFileLock } from "./file-lock.js";

export const WorkItemClaimSchema = z.object({
  workItemId: z.string(),
  /** The run whose fan-out owns the item (the dispatching parent, not the child run). */
  runId: z.string(),
  /** The branch key within that run's fan-out; a second branch for the same item is not the owner. */
  branch: z.string(),
  /** The step run that took the claim. Informational: a later attempt of the same node still owns it. */
  stepRunId: z.string().optional(),
  at: z.string(),
});
export type WorkItemClaim = z.infer<typeof WorkItemClaimSchema>;

export interface ClaimStore {
  /**
   * Claim `claim.workItemId`, atomically. Returns the claim that now holds the item: the one
   * passed in when it was free (or already held by the same `(runId, branch)`), the incumbent
   * otherwise. Callers compare owners rather than catching an error - losing a claim is a
   * normal outcome, not a fault.
   */
  claim(claim: WorkItemClaim): Promise<WorkItemClaim>;
  get(workItemId: string): Promise<WorkItemClaim | undefined>;
  /** Every claim currently held, in no particular order. */
  list(): Promise<WorkItemClaim[]>;
  /** Drop the claim on `workItemId`, but only while `runId` still holds it. */
  release(workItemId: string, runId: string, beforeRelease?: () => Promise<void>): Promise<void>;
}

/** True when `claim` is held by this run's branch, i.e. the caller may launch the item. */
export function ownsClaim(claim: WorkItemClaim, runId: string, branch: string): boolean {
  return claim.runId === runId && claim.branch === branch;
}

export class InMemoryClaimStore implements ClaimStore {
  private readonly claims = new Map<string, WorkItemClaim>();
  private tail: Promise<unknown> = Promise.resolve();
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async claim(claim: WorkItemClaim): Promise<WorkItemClaim> {
    return this.exclusive(async () => {
      const held = this.claims.get(claim.workItemId);
      if (held) return held;
      this.claims.set(claim.workItemId, claim);
      return claim;
    });
  }
  async get(workItemId: string): Promise<WorkItemClaim | undefined> {
    return this.claims.get(workItemId);
  }
  async list(): Promise<WorkItemClaim[]> {
    return [...this.claims.values()];
  }
  async release(workItemId: string, runId: string, beforeRelease?: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      if (this.claims.get(workItemId)?.runId !== runId) return;
      await beforeRelease?.();
      this.claims.delete(workItemId);
    });
  }
}

/**
 * One file per claim under `<dir>/claims/`. Creating that file is the compare-and-set: the
 * kernel lets exactly one linker win, so the guarantee holds across processes and not just
 * across the promises of one orchestrator. Nothing is cached - a claim another process took a
 * millisecond ago has to be visible here.
 */
export class FileClaimStore implements ClaimStore {
  constructor(private readonly dir: string) {}

  /** Work item ids are opaque strings from a workflow expression; encode them so one can never escape the directory. */
  private file(workItemId: string): string {
    return join(this.dir, "claims", `${encodeURIComponent(workItemId)}.json`);
  }

  async claim(claim: WorkItemClaim): Promise<WorkItemClaim> {
    await mkdir(dirname(this.file(claim.workItemId)), { recursive: true });
    return withFileLock(`${this.file(claim.workItemId)}.lock`, () => this.claimLocked(claim), { staleMs: Infinity });
  }

  private async claimLocked(claim: WorkItemClaim): Promise<WorkItemClaim> {
    const file = this.file(claim.workItemId);
    await mkdir(dirname(file), { recursive: true });
    // Write the claim under a private name first and *link* it into place: linking is the
    // atomic create, and a reader can only ever see the finished file, never a half-written one.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(claim, null, 2), "utf8");
    try {
      for (;;) {
        try {
          await link(tmp, file);
          return claim;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const held = await this.read(file);
        // Released between the failed link and the read: the item is free again, so try once more.
        if (held) return held;
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async get(workItemId: string): Promise<WorkItemClaim | undefined> {
    return this.read(this.file(workItemId));
  }

  async list(): Promise<WorkItemClaim[]> {
    const dir = join(this.dir, "claims");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: WorkItemClaim[] = [];
    // `.tmp` files are claims still being written (see `claim`); a claim released between
    // the listing and the read is simply absent.
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const claim = await this.read(join(dir, name));
      if (claim) out.push(claim);
    }
    return out;
  }

  async release(workItemId: string, runId: string, beforeRelease?: () => Promise<void>): Promise<void> {
    await mkdir(dirname(this.file(workItemId)), { recursive: true });
    return withFileLock(
      `${this.file(workItemId)}.lock`,
      async () => {
        const file = this.file(workItemId);
        const held = await this.read(file);
        if (!held || held.runId !== runId) return;
        await beforeRelease?.();
        try {
          await unlink(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      },
      { staleMs: Infinity },
    );
  }

  private async read(file: string): Promise<WorkItemClaim | undefined> {
    try {
      return WorkItemClaimSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
}
