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
 * principal, credential and enrollment (pinned keys), the remote endpoint, the workflow, and
 * the parent run's configuration generation. A session under any other binding never acts on
 * it, and every remote mutation it makes for the receipt is scoped by it.
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
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RunOriginSchema } from "@orca/core";

/** What a receipt is bound to; see the module comment. */
export const DelegationBindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    principalId: z.string().min(1),
    /** The enrolled credential's id; never its secret. */
    credentialId: z.string().min(1),
    /** The remote workflow every admission and fence of this delegation names. */
    workflowId: z.string().min(1),
    /** The parent run's configuration generation: where the remote and agent were resolved. */
    configGeneration: z.string().min(1),
    /** Digest of the enrollment record (pinned keys included): a re-enrollment is another binding. */
    enrollment: z.string().min(1),
    /** Digest of the remote endpoint (destination, ports, jump, server) and the prompt variable. */
    target: z.string().min(1),
  })
  .strict();
export type DelegationBinding = z.infer<typeof DelegationBindingSchema>;

export const DelegationReceiptSchema = z
  .object({
    version: z.literal(1),
    /** Bumped by every transition; what a writer must have read to replace the receipt. */
    revision: z.number().int().nonnegative(),
    /**
     * Random, fixed when the receipt file is created and never reused: a receipt removed and
     * made again at the same path is another instance, so a writer holding the old one can
     * never compare equal to the new one at the same revision.
     */
    instance: z.string().min(1),
    profile: z.string().min(1),
    binding: DelegationBindingSchema,
    parentRunId: z.string().min(1),
    delegationId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    key: z.string().min(1),
    state: z.enum(["reserved", "submitting", "admitted", "cancel-pending", "settled"]),
    remoteRunId: z.string().min(1).optional(),
    /**
     * The origin this generation's admission states (#883): this daemon's
     * workspace, the parent run and the step. Fixed when the generation is created, so every
     * replay of its key sends the same command; absent when the remote did not list `origin` in `hello.admitFields`. A remote that stops
     * taking it is refused the replay rather than sent a different command.
     */
    origin: RunOriginSchema.optional(),
    outcome: z.enum(["succeeded", "failed", "cancelled", "never-admitted"]).optional(),
    /**
     * A `reserved` next generation: the settled generation it would replace, restored if the
     * reservation is backed out.
     */
    previous: z
      .object({
        generation: z.number().int().nonnegative(),
        key: z.string().min(1),
        remoteRunId: z.string().min(1).optional(),
        outcome: z.enum(["succeeded", "failed", "cancelled", "never-admitted"]),
        origin: RunOriginSchema.optional(),
      })
      .strict()
      .optional(),
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

const LOCK_WAIT_MS = 5_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Set aside a lock whose owner is provably gone; leave every other lock alone. */
function breakIfAbandoned(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  let owner: { pid?: unknown; host?: unknown } | undefined;
  try {
    owner = JSON.parse(text) as { pid?: unknown; host?: unknown };
  } catch {
    owner = undefined;
  }
  // Only a dead process on this host is provably gone; a slow or suspended owner, or one on
  // another host, keeps its lock.
  const abandoned =
    owner !== undefined &&
    typeof owner.pid === "number" &&
    owner.host === hostname() &&
    owner.pid !== process.pid &&
    !alive(owner.pid);
  if (!abandoned) return;
  // Move it aside atomically, then make sure it is the lock that was judged; a lock taken in
  // between goes back where it was.
  const aside = `${file}.${randomUUID()}.abandoned`;
  try {
    renameSync(file, aside);
  } catch {
    return;
  }
  try {
    if (readFileSync(aside, "utf8") !== text) linkSync(aside, file);
  } catch {
    // Put back if it could be; a lock that cannot be restored was a new one the owner re-takes.
  }
  rmSync(aside, { force: true });
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
    receipt: Omit<DelegationReceipt, "version" | "updatedAt" | "revision" | "instance"> & {
      revision?: number | undefined;
      instance?: string | undefined;
    },
  ): DelegationReceipt {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(receipt.parentRunId, receipt.delegationId);
    const lock = this.lock(target);
    try {
      const current = this.read(receipt.parentRunId, receipt.delegationId);
      if (current?.revision !== receipt.revision || current?.instance !== receipt.instance) throw new ReceiptConflict();
      const full = DelegationReceiptSchema.parse({
        ...receipt,
        version: 1,
        revision: (receipt.revision ?? -1) + 1,
        instance: receipt.instance ?? randomUUID(),
        updatedAt: new Date().toISOString(),
      });
      // The lock must still be ours at the commit: never write over a successor's decision.
      if (!lock.held()) throw new ReceiptConflict();
      this.replace(target, full);
      return full;
    } finally {
      lock.release();
    }
  }

  /**
   * Back a `reserved` receipt out, if it is still the revision read: nothing was ever sent
   * under it. A next generation goes back to the settled generation it would have replaced; a
   * first one leaves no receipt. Anything else throws `ReceiptConflict` and changes nothing.
   */
  unreserve(receipt: DelegationReceipt): void {
    if (receipt.state !== "reserved") throw new ReceiptConflict();
    const { previous, version: _v, updatedAt: _u, ...rest } = receipt;
    if (!previous) return this.discard(receipt);
    const { remoteRunId: _r, origin: _o, outcome: _x, ...base } = rest;
    this.write({
      ...base,
      generation: previous.generation,
      key: previous.key,
      state: "settled",
      outcome: previous.outcome,
      ...(previous.remoteRunId ? { remoteRunId: previous.remoteRunId } : {}),
      ...(previous.origin ? { origin: previous.origin } : {}),
    });
  }

  /**
   * Back out every `reserved` receipt for `profile` (an enrollment does this under its lock):
   * a reservation is never sent under until a session promotes it after checking that lock,
   * so one backed out here is either promoted never or re-reserved under the new enrollment.
   */
  unreserveAll(profile: string): void {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const receipt = DelegationReceiptSchema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (receipt.profile === profile && receipt.state === "reserved") this.unreserve(receipt);
      } catch {
        // Unreadable, or moved on meanwhile: `unsettled` counts what is left.
      }
    }
  }

  /**
   * Remove a receipt that nothing was ever sent under, if it is still the revision written:
   * a delegation that backed out before submitting leaves no receipt to strand. Anything else
   * throws `ReceiptConflict` and removes nothing.
   */
  discard(receipt: Pick<DelegationReceipt, "parentRunId" | "delegationId" | "revision" | "instance">): void {
    const target = this.file(receipt.parentRunId, receipt.delegationId);
    const lock = this.lock(target);
    try {
      const current = this.read(receipt.parentRunId, receipt.delegationId);
      if (current?.revision !== receipt.revision || current?.instance !== receipt.instance || !lock.held())
        throw new ReceiptConflict();
      rmSync(target);
      try {
        const dir = openSync(this.dir, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } catch {
        // Directory fsync is not available everywhere (Windows); the removal stands.
      }
    } finally {
      lock.release();
    }
  }

  /**
   * An exclusive lock file beside the receipt, naming its owner (a random token, this process
   * and host). It is created with its owner already in it (written aside, then hard-linked into
   * place), so there is never an ownerless lock. Released only by its owner and only while it
   * still holds the owner's token; broken only when the owner is provably gone (a process on
   * this host that no longer exists). `held()` re-checks ownership just before a commit.
   */
  private lock(target: string): { release(): void; held(): boolean } {
    const file = `${target}.lock`;
    const body = JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname() });
    const staged = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(staged, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const held = () => {
      try {
        return readFileSync(file, "utf8") === body;
      } catch {
        return false;
      }
    };
    try {
      const until = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          linkSync(staged, file);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          breakIfAbandoned(file);
          if (Date.now() > until) throw new ReceiptConflict();
          pause(10);
        }
      }
    } finally {
      rmSync(staged, { force: true });
    }
    return {
      held,
      release: () => {
        if (held()) rmSync(file, { force: true });
      },
    };
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

  /**
   * How many delegations to `profile` (under `credentialId`, when given) are not settled yet:
   * still submitting, running or being cancelled. A receipt that cannot be read counts, so an
   * enrollment never strands what it cannot see.
   */
  unsettled(profile: string, credentialId?: string): number {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let count = 0;
    for (const name of names) {
      try {
        const receipt = DelegationReceiptSchema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (
          receipt.profile === profile &&
          receipt.state !== "settled" &&
          (credentialId === undefined || receipt.binding.credentialId === credentialId)
        )
          count++;
      } catch {
        count++;
      }
    }
    return count;
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
    a.credentialId === b.credentialId &&
    a.workflowId === b.workflowId &&
    a.configGeneration === b.configGeneration &&
    a.enrollment === b.enrollment &&
    a.target === b.target
  );
}

/** The remote admission key for one generation of one delegation: ≤128 bytes, stable. */
export function delegationKey(parentRunId: string, delegationId: string, generation: number): string {
  const digest = createHash("sha256").update(`${parentRunId}\n${delegationId}\n${generation}`).digest("hex");
  return `orca-delegate-${digest.slice(0, 48)}`;
}
