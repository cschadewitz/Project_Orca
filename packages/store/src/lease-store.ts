/**
 * LeaseStore - who is allowed to *write* to a resource right now.
 *
 * The event log settles what happened; it cannot settle who gets to decide what happens next.
 * Two interpreters over one run id (an `orca acp` facade beside an `orca resume`, two
 * `orca resume` invocations, later a daemon beside a one-shot CLI command) each reduce the
 * same log, each pick the next node, and each append their own `step.started`/`step.finished`.
 * #97 made that log well-numbered; it is still two runs of one workflow interleaved into one
 * story. A lease is the missing arbiter: exactly one holder may drive `run:<runId>` at a time.
 *
 * Why not the lock file from #97: that lock is held for one append, is broken on a fixed age,
 * and has no way to say "I am still here". A lease is held for as long as an interpreter is
 * attached - minutes or hours, most of it spent waiting on an agent - so it carries a `ttlMs`
 * and a `renewedAt` that the holder refreshes (see `keepLease`). A holder that stops
 * refreshing has lapsed, and a lapsed lease may be taken over without an operator in the loop.
 * The file layout and the take-over dance are the lock's, reused via `breakIfStale`.
 *
 * Liveness has two rules, and a lease needs only one of them to be good:
 *   - the heartbeat: nothing refreshed the lease within `ttlMs`;
 *   - the pid: the holder is on this host and its process is gone (an immediate take-over
 *     after a crash, rather than waiting out the TTL).
 * The pid rule is skipped when the record names another host, since pids do not travel
 * between hosts or pid namespaces - the same limitation #103 tracks for the lock file. The
 * heartbeat is what covers those holders, so it is never skipped.
 *
 * Breaking a *live* lease is the one thing that puts two writers back on one run, so nothing
 * does it on its own: `Orchestrator.breakLease` is the operator's act, the way
 * `releaseClaim` is for work items.
 */
import { hostname } from "node:os";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "@orca/core";
import { breakIfStale, processAlive } from "./file-lock.js";

export const LeaseSchema = z.object({
  /** What is held. The engine uses `run:<runId>`; the namespace is the caller's to choose. */
  resource: z.string(),
  /**
   * Opaque id of the *attachment* that holds it - one per Orchestrator instance, not per
   * process: re-acquiring with the same holder id refreshes rather than conflicts, so a
   * resumed or re-entered run does not fight itself.
   */
  holder: z.string(),
  /** Where the holder runs. `pid` is only meaningful together with `host`. */
  pid: z.number().int(),
  host: z.string(),
  acquiredAt: z.string(),
  /** Last heartbeat. The lease has lapsed once this is older than `ttlMs`. */
  renewedAt: z.string(),
  ttlMs: z.number().int().positive(),
  /** Free-form, for operators staring at `orca leases`: the command, the run's workflow. */
  note: z.string().optional(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export interface LeaseRequest {
  resource: string;
  holder: string;
  /** How long the lease survives without a heartbeat. Default 60 s. */
  ttlMs?: number;
  note?: string;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface LeaseStore {
  /**
   * Take `resource`, atomically. Returns the lease that now holds it: ours when it was free,
   * lapsed, or already ours (refreshed in place), the incumbent otherwise. Callers compare
   * holders with `ownsLease` rather than catching an error - losing a race is an outcome, not
   * a fault.
   */
  acquire(request: LeaseRequest): Promise<Lease>;
  /** Refresh `renewedAt`. Returns the refreshed lease, or undefined once it is no longer ours. */
  renew(lease: Lease): Promise<Lease | undefined>;
  /** Drop the lease, but only while `lease.holder` still holds it. */
  release(lease: Lease): Promise<void>;
  get(resource: string): Promise<Lease | undefined>;
  /** Every lease on file, lapsed ones included; `lapsed()` tells them apart. */
  list(): Promise<Lease[]>;
  /**
   * Take the lease away from its holder. Unlike `release` this does not check who holds it,
   * so it is the operator's escape hatch and not something a competing writer may call.
   * Returns the lease that was removed, or undefined when there was none.
   */
  forceRelease(resource: string): Promise<Lease | undefined>;
}

/** True when `lease` is held by `holder`, i.e. the caller may write. */
export function ownsLease(lease: Lease, holder: string): boolean {
  return lease.holder === holder;
}

/**
 * Whether `lease` may be taken over without asking anyone: its heartbeat has run out, or its
 * holder was a process on this host and that process is gone. See the header for why the pid
 * rule is skipped for records from another host.
 */
export function lapsed(lease: Lease, now: number = Date.now()): boolean {
  const beat = Date.parse(lease.renewedAt);
  if (!Number.isNaN(beat) && now - beat >= lease.ttlMs) return true;
  return lease.host === hostname() && !processAlive(lease.pid);
}

/** Why a lease could not be taken, in the words an operator needs; used for error details. */
export function describeLease(lease: Lease): Record<string, unknown> {
  return {
    resource: lease.resource,
    holder: lease.holder,
    pid: lease.pid,
    host: lease.host,
    renewedAt: lease.renewedAt,
    ttlMs: lease.ttlMs,
    ...(lease.note ? { note: lease.note } : {}),
  };
}

// ------------------------------------------------------------------ heartbeat

export interface KeepLeaseOptions {
  /** Heartbeat interval. Default `ttlMs / 3`, so two missed beats still leave the lease good. */
  renewMs?: number;
  /**
   * Called once when a renewal finds the lease gone - an operator broke it, or the store was
   * wiped. The holder must stop writing; the engine cancels the run.
   */
  onLost?: (reason: Lease | undefined) => void;
  clock?: Clock;
}

export interface HeldLease {
  /** The lease as of the last successful heartbeat. */
  readonly lease: Lease;
  /** True until a heartbeat found the lease gone. */
  readonly held: boolean;
  /** Stop the heartbeat and drop the lease. Idempotent. */
  release(): Promise<void>;
}

/**
 * Keep renewing a lease we already hold until `release()`. The timer is unref'd, so a
 * forgotten keeper cannot hold a CLI process open - a leaked lease lapses on its own, which
 * is the whole point of the TTL.
 */
export function keepLease(store: LeaseStore, lease: Lease, options: KeepLeaseOptions = {}): HeldLease {
  const renewMs = options.renewMs ?? Math.max(1, Math.floor(lease.ttlMs / 3));
  let current = lease;
  let held = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let beating: Promise<void> = Promise.resolve();

  const schedule = () => {
    timer = setTimeout(() => {
      // Serialised onto one chain so `release()` can await whatever beat is in flight.
      beating = beating.then(async () => {
        if (!held) return;
        let next: Lease | undefined;
        try {
          next = await store.renew(current);
        } catch {
          // A transient store error is not proof the lease is gone; the TTL decides that.
          next = current;
        }
        if (!held) return;
        if (!next) {
          held = false;
          options.onLost?.(undefined);
          return;
        }
        current = next;
        schedule();
      });
    }, renewMs);
    timer.unref?.();
  };
  schedule();

  return {
    get lease() {
      return current;
    },
    get held() {
      return held;
    },
    async release() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const wasHeld = held;
      held = false;
      await beating;
      if (wasHeld) await store.release(current);
    },
  };
}

// ------------------------------------------------------------ implementations

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly clock: Clock = systemClock) {}

  async acquire(request: LeaseRequest): Promise<Lease> {
    const held = this.leases.get(request.resource);
    if (held && held.holder !== request.holder && !lapsed(held, this.clock.now())) return held;
    const lease = build(request, this.clock, held?.holder === request.holder ? held.acquiredAt : undefined);
    this.leases.set(lease.resource, lease);
    return lease;
  }
  async renew(lease: Lease): Promise<Lease | undefined> {
    const held = this.leases.get(lease.resource);
    if (!held || held.holder !== lease.holder) return undefined;
    const next = { ...held, renewedAt: this.clock.isoNow() };
    this.leases.set(next.resource, next);
    return next;
  }
  async release(lease: Lease): Promise<void> {
    if (this.leases.get(lease.resource)?.holder === lease.holder) this.leases.delete(lease.resource);
  }
  async get(resource: string): Promise<Lease | undefined> {
    return this.leases.get(resource);
  }
  async list(): Promise<Lease[]> {
    return [...this.leases.values()];
  }
  async forceRelease(resource: string): Promise<Lease | undefined> {
    const held = this.leases.get(resource);
    if (held) this.leases.delete(resource);
    return held;
  }
}

/**
 * One file per lease under `<dir>/leases/`. Taking it is the same compare-and-set the claim
 * store uses - write under a private name, `link()` it into place, and let the kernel elect
 * one winner - so the guarantee holds between processes and not merely between the promises
 * of one orchestrator. Nothing is cached: a lease another process took a millisecond ago has
 * to be visible here.
 */
export class FileLeaseStore implements LeaseStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Resources are opaque strings; encode them so one can never escape the directory. */
  private file(resource: string): string {
    return join(this.dir, "leases", `${encodeURIComponent(resource)}.json`);
  }

  async acquire(request: LeaseRequest): Promise<Lease> {
    const file = this.file(request.resource);
    await mkdir(join(this.dir, "leases"), { recursive: true });
    for (;;) {
      const held = await this.read(file);
      // Ours already: refresh in place rather than conflict with ourselves. Writing over our
      // own record is safe precisely because we are the holder.
      if (held?.holder === request.holder) {
        const lease = build(request, this.clock, held.acquiredAt);
        await this.overwrite(file, lease);
        return lease;
      }
      if (!held) {
        const lease = build(request, this.clock);
        if (await this.linkInto(file, lease)) return lease;
        // Either someone linked between our read and our link, or the record on disk is not
        // readable at all (`read` cannot tell those apart). Both are for the breaker below.
      }
      // Break a lapsed - or unreadable - record the way a stale lock is broken: rename, then
      // check the inode, so two would-be successors cannot each remove what the other took.
      const verdict = await breakIfStale(file, (text) => {
        const parsed = parse(text);
        return parsed === undefined || lapsed(parsed, this.clock.now());
      });
      if (verdict !== "live") continue;
      const incumbent = await this.read(file);
      if (incumbent) return incumbent;
      // Live a moment ago, gone now; try to take it.
    }
  }

  async renew(lease: Lease): Promise<Lease | undefined> {
    const file = this.file(lease.resource);
    const held = await this.read(file);
    if (!held || held.holder !== lease.holder) return undefined;
    const next: Lease = { ...held, renewedAt: this.clock.isoNow() };
    await this.overwrite(file, next);
    return next;
  }

  async release(lease: Lease): Promise<void> {
    const file = this.file(lease.resource);
    const held = await this.read(file);
    if (!held || held.holder !== lease.holder) return;
    await unlink(file).catch(ignoreMissing);
  }

  async get(resource: string): Promise<Lease | undefined> {
    return this.read(this.file(resource));
  }

  async list(): Promise<Lease[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, "leases"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: Lease[] = [];
    // `.tmp` files are leases still being written; one released between the listing and the
    // read is simply absent.
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const lease = await this.read(join(this.dir, "leases", name));
      if (lease) out.push(lease);
    }
    return out;
  }

  async forceRelease(resource: string): Promise<Lease | undefined> {
    const file = this.file(resource);
    const held = await this.read(file);
    if (held) await unlink(file).catch(ignoreMissing);
    return held;
  }

  /** True when we created the file; false when someone else got there first. */
  private async linkInto(file: string, lease: Lease): Promise<boolean> {
    const tmp = this.tmp(file);
    await writeFile(tmp, JSON.stringify(lease, null, 2), "utf8");
    try {
      await link(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    } finally {
      await unlink(tmp).catch(ignoreMissing);
    }
  }

  /** Replace a lease we hold, atomically, so a concurrent reader never sees a half-written record. */
  private async overwrite(file: string, lease: Lease): Promise<void> {
    const tmp = this.tmp(file);
    await writeFile(tmp, JSON.stringify(lease, null, 2), "utf8");
    await rename(tmp, file);
  }

  private tmp(file: string): string {
    return `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  }

  private async read(file: string): Promise<Lease | undefined> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    return parse(text);
  }
}

/**
 * A lease record that is not parseable is treated as lapsed rather than as a fault: an
 * unreadable holder can never be renewed or released by anybody, so refusing to break it
 * would wedge the resource forever.
 */
function parse(text: string): Lease | undefined {
  try {
    const parsed = LeaseSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function build(request: LeaseRequest, clock: Clock, acquiredAt?: string): Lease {
  const at = clock.isoNow();
  return {
    resource: request.resource,
    holder: request.holder,
    pid: process.pid,
    host: hostname(),
    acquiredAt: acquiredAt ?? at,
    renewedAt: at,
    ttlMs: request.ttlMs ?? DEFAULT_LEASE_TTL_MS,
    ...(request.note ? { note: request.note } : {}),
  };
}

function ignoreMissing(e: NodeJS.ErrnoException): void {
  if (e.code !== "ENOENT") throw e;
}
