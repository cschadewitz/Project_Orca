/**
 * Durable delegation receipts (#883): what this daemon has asked a remote daemon to run for
 * one logical delegation, so that neither an engine retry of the step nor a restart of this
 * daemon submits replacement work before the earlier submission's fate is known.
 *
 * A logical delegation is one parent run's one step, across its retry attempts: the step's
 * first attempt names it (`TurnContext.delegationId`), and every later attempt of the same
 * visit reads the same receipt. Its remote admission key changes only when a new `generation`
 * starts, and a new generation starts only once the previous remote run is verified finished
 * without success (or verified never admitted).
 *
 * States:
 * - `submitting`: an admission was (or is about to be) sent and its answer is not known. The
 *   same key is safe to send again (the remote replays it); anything else first looks it up.
 * - `admitted`: the remote run exists (`remoteRunId`); follow it, never submit.
 * - `cancel-pending`: the parent cancelled, and it is not yet authoritative what that left on
 *   the remote. Without `remoteRunId`, the key is to be fenced (`admissions.fence`), which
 *   either makes any later admission under it impossible or names the run it made; with one,
 *   that run is to be cancelled and seen ended. Nothing in this state submits work.
 * - `settled`: the remote run was seen ended (`outcome`), or the key was fenced before any
 *   admission (`never-admitted`). A succeeded run is the delegation's result for good: a
 *   later attempt brings its artifacts back again. Any other outcome lets a later attempt of
 *   the step start a new generation.
 *
 * Every receipt is bound to the scope it was made in (`binding`): the enrolled workspace,
 * principal and enrollment, and the delegation's own configuration (remote target, workflow,
 * prompt variable). A session under any other binding never acts on it.
 *
 * One JSON file per delegation under `<store>/delegations/`, replaced atomically. Every
 * transition is a compare-and-swap on `revision` under a per-receipt lock file, so two
 * sessions (a sweep and a retry, say) cannot commit a stale decision over a newer one: the
 * loser gets `ReceiptConflict` and reads again.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** What a receipt is bound to; see the module comment. */
export const DelegationBindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    principalId: z.string().min(1),
    /** Digest of the enrollment record: a re-enrollment is another binding. */
    enrollment: z.string().min(1),
    /** Digest of the remote target and the agent's delegation fields. */
    target: z.string().min(1),
  })
  .strict();
export type DelegationBinding = z.infer<typeof DelegationBindingSchema>;

export const DelegationReceiptSchema = z
  .object({
    version: z.literal(1),
    /** Bumped by every transition; what a writer must have read to replace the receipt. */
    revision: z.number().int().nonnegative(),
    profile: z.string().min(1),
    binding: DelegationBindingSchema,
    parentRunId: z.string().min(1),
    delegationId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    key: z.string().min(1),
    state: z.enum(["submitting", "admitted", "cancel-pending", "settled"]),
    remoteRunId: z.string().min(1).optional(),
    outcome: z.enum(["succeeded", "failed", "cancelled", "never-admitted"]).optional(),
    updatedAt: z.string(),
  })
  .strict();
export type DelegationReceipt = z.infer<typeof DelegationReceiptSchema>;

/** Another session replaced the receipt since it was read: read it again and decide anew. */
export class ReceiptConflict extends Error {
  constructor() {
    super("the delegation receipt changed since it was read");
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class DelegationReceipts {
  constructor(readonly dir: string) {}

  private file(parentRunId: string, delegationId: string): string {
    const name = createHash("sha256").update(`${parentRunId}\n${delegationId}`).digest("hex").slice(0, 40);
    return join(this.dir, `${name}.json`);
  }

  /** The delegation's receipt, or undefined. A receipt that cannot be read refuses: never guess. */
  read(parentRunId: string, delegationId: string): DelegationReceipt | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(parentRunId, delegationId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const receipt = DelegationReceiptSchema.parse(JSON.parse(text));
    if (receipt.parentRunId !== parentRunId || receipt.delegationId !== delegationId)
      throw new Error("delegation receipt does not match its delegation");
    return receipt;
  }

  /**
   * Replace the receipt if it is still at `receipt.revision` (absent: if there is none yet):
   * written, flushed and renamed into place before this returns, at the next revision.
   * Anything else throws `ReceiptConflict` and writes nothing.
   */
  write(
    receipt: Omit<DelegationReceipt, "version" | "updatedAt" | "revision"> & { revision?: number | undefined },
  ): DelegationReceipt {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(receipt.parentRunId, receipt.delegationId);
    const release = this.lock(target);
    try {
      const current = this.read(receipt.parentRunId, receipt.delegationId);
      if (current?.revision !== receipt.revision) throw new ReceiptConflict();
      const full = DelegationReceiptSchema.parse({
        ...receipt,
        version: 1,
        revision: (receipt.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
      });
      this.replace(target, full);
      return full;
    } finally {
      release();
    }
  }

  /** An exclusive lock file beside the receipt; one left by a dead writer goes stale. */
  private lock(target: string): () => void {
    const file = `${target}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(file, "wx", 0o600));
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) rmSync(file, { force: true });
        } catch {
          // Gone already.
        }
        if (Date.now() > until) throw new ReceiptConflict();
        pause(10);
      }
    }
  }

  private replace(target: string, full: DelegationReceipt): void {
    const temp = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(full));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    try {
      const dir = openSync(this.dir, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // Directory fsync is not available everywhere (Windows); the rename stands.
    }
  }

  /** Cancellations still being settled under one binding (never another's). */
  cancelPending(binding: DelegationBinding, limit = 20): DelegationReceipt[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: DelegationReceipt[] = [];
    for (const name of names) {
      if (out.length >= limit) break;
      try {
        const receipt = DelegationReceiptSchema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (receipt.state === "cancel-pending" && sameBinding(receipt.binding, binding)) out.push(receipt);
      } catch {
        // An unreadable receipt is left for its own delegation to refuse on.
      }
    }
    return out;
  }
}

export function sameBinding(a: DelegationBinding, b: DelegationBinding): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.principalId === b.principalId &&
    a.enrollment === b.enrollment &&
    a.target === b.target
  );
}

/** The remote admission key for one generation of one delegation: ≤128 bytes, stable. */
export function delegationKey(parentRunId: string, delegationId: string, generation: number): string {
  const digest = createHash("sha256").update(`${parentRunId}\n${delegationId}\n${generation}`).digest("hex");
  return `orca-delegate-${digest.slice(0, 48)}`;
}
