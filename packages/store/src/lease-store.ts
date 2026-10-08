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
 * Why not the lock from #97: that lock is held for one append,
 * and has no way to say "I am still here". A lease is held for as long as an interpreter is
 * attached - minutes or hours, most of it spent waiting on an agent - so it carries a `ttlMs`
 * and a `renewedAt` that the holder refreshes (see `keepLease`). A holder that stops
 * refreshing has lapsed, and a lapsed lease may be taken over without an operator in the loop.
 * Lease record mutations serialize under a separate short-lived directory mutex.
 *
 * Liveness has two rules, and a lease needs only one of them to be good:
 *   - the heartbeat: nothing refreshed the lease within `ttlMs`;
 *   - the pid: the holder is on this host and its process is gone (an immediate take-over
 *     after a crash, rather than waiting out the TTL).
 * The pid rule is skipped when the record names another host, since pids do not travel
 * between hosts or pid namespaces - the same limitation #103 tracks for the lock file. The
 * heartbeat is what covers those holders, so it is never skipped.
 *
 * Mutation and execution writes share a mutex that is never stolen from a live process.
 * On disk sentinel ttlMs and host values prevent legacy takeover of an upgraded lease;
 * guarded fields retain the real values. All legacy and unreadable records fail closed.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OrcaError, systemClock, type Clock } from "@orca/core";
import { breakIfStale, processAlive, withFileLock } from "./file-lock.js";

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
  /** New writers use this TTL; the disk ttlMs is a legacy-visible no-takeover fence. */
  guardedTtlMs: z.number().int().positive().optional(),
  guardedHost: z.string().optional(),
  /** Attachment incarnation, retained by a live same-holder refresh only. */
  guardedId: z.string().optional(),
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
  readonly clock?: Clock;
  /** Validate ownership and perform a write under the same exclusion as takeover/release. */
  withOwnership<T>(lease: Lease, write: () => Promise<T>): Promise<T>;
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
  /** Read after release begins: settlement of every already-scheduled heartbeat,
   * including a renewal that outlives release's last-confirmed-TTL bound. */
  readonly renewalSettled: Promise<void>;
  /** Stop the heartbeat and drop the lease when possible; bound renewal waits by its last confirmed TTL. Idempotent. */
  release(): Promise<void>;
}

/**
 * Keep renewing a lease we already hold until `release()`. The timer is unref'd, so a
 * forgotten keeper cannot hold a CLI process open - a leaked lease lapses on its own, which
 * is the whole point of the TTL.
 */
export function keepLease(store: LeaseStore, lease: Lease, options: KeepLeaseOptions = {}): HeldLease {
  const renewMs = options.renewMs ?? Math.max(1, Math.floor(lease.ttlMs / 3));
  const clock = options.clock ?? store.clock ?? systemClock;
  let current = lease;
  let held = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let beating: Promise<void> = Promise.resolve();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const lose = () => {
    if (!held) return;
    held = false;
    if (timer) clearTimeout(timer);
    if (expiry) clearTimeout(expiry);
    options.onLost?.(undefined);
  };
  const watchExpiry = () => {
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(
      () => {
        if (clock.now() >= Date.parse(current.renewedAt) + current.ttlMs) lose();
        else watchExpiry();
      },
      Math.max(1, Math.min(current.ttlMs, 2_147_483_647, Date.parse(current.renewedAt) + current.ttlMs - clock.now())),
    );
    expiry.unref?.();
  };

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
          next = clock.now() < Date.parse(current.renewedAt) + current.ttlMs ? current : undefined;
        }
        if (!held) return;
        if (!next) {
          lose();
          return;
        }
        current = next;
        watchExpiry();
        schedule();
      });
    }, renewMs);
    timer.unref?.();
  };
  schedule();
  watchExpiry();

  return {
    get lease() {
      return current;
    },
    get held() {
      return held;
    },
    get renewalSettled() {
      return beating;
    },
    async release() {
      if (timer) clearTimeout(timer);
      if (expiry) clearTimeout(expiry);
      timer = undefined;
      const wasHeld = held;
      held = false;
      if (!wasHeld) return;
      // A stalled renewal may own the store's mutation lock. Shutdown must not await it
      // forever or queue a release behind that same stalled lock. Only wait through the
      // last confirmed heartbeat's TTL, then leave the durable lease for safe recovery.
      const deadline = Date.parse(current.renewedAt) + current.ttlMs;
      const remaining = deadline - clock.now();
      if (remaining <= 0) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled: boolean;
      try {
        settled = await Promise.race([
          beating.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), Math.min(remaining, 2_147_483_647));
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!settled || clock.now() >= deadline) return;
      await store.release(current);
    },
  };
}

// ------------------------------------------------------------ implementations

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(readonly clock: Clock = systemClock) {}

  private exclusive<T>(resource: string, action: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(resource) ?? Promise.resolve()).then(action);
    this.chains.set(
      resource,
      next.catch(() => undefined),
    );
    return next;
  }

  withOwnership<T>(lease: Lease, write: () => Promise<T>): Promise<T> {
    return this.exclusive(lease.resource, async () => {
      assertOwnership(this.leases.get(lease.resource), lease, this.clock.now());
      return write();
    });
  }

  async acquire(request: LeaseRequest): Promise<Lease> {
    return this.exclusive(request.resource, () => this.acquireUnlocked(request));
  }
  private async acquireUnlocked(request: LeaseRequest): Promise<Lease> {
    const held = this.leases.get(request.resource);
    if (held) assertSameHolderProcess(held, request, this.clock.now());
    if (held && held.holder !== request.holder && !lapsed(held, this.clock.now())) return held;
    const refresh = held?.holder === request.holder && !lapsed(held, this.clock.now());
    const lease = build(
      request,
      this.clock,
      refresh ? held.acquiredAt : undefined,
      refresh ? held.guardedId : undefined,
    );
    this.leases.set(lease.resource, lease);
    return lease;
  }
  async renew(lease: Lease): Promise<Lease | undefined> {
    return this.exclusive(lease.resource, () => this.renewUnlocked(lease));
  }
  private async renewUnlocked(lease: Lease): Promise<Lease | undefined> {
    const held = this.leases.get(lease.resource);
    if (!held || !sameLease(held, lease) || lapsed(held, this.clock.now())) return undefined;
    const next = { ...held, renewedAt: this.clock.isoNow() };
    this.leases.set(next.resource, next);
    return next;
  }
  async release(lease: Lease): Promise<void> {
    await this.exclusive(lease.resource, async () => {
      const current = this.leases.get(lease.resource);
      if (current && sameLease(current, lease)) this.leases.delete(lease.resource);
    });
  }
  async get(resource: string): Promise<Lease | undefined> {
    return this.leases.get(resource);
  }
  async list(): Promise<Lease[]> {
    return [...this.leases.values()];
  }
  async forceRelease(resource: string): Promise<Lease | undefined> {
    return this.exclusive(resource, async () => {
      const held = this.leases.get(resource);
      if (held) this.leases.delete(resource);
      return held;
    });
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
    readonly clock: Clock = systemClock,
  ) {}

  /** Resources are opaque strings; encode them so one can never escape the directory. */
  private file(resource: string): string {
    return join(this.dir, "leases", `${encodeURIComponent(resource)}.json`);
  }

  private async exclusive<T>(resource: string, action: () => Promise<T>): Promise<T> {
    await mkdir(join(this.dir, "leases"), { recursive: true });
    // A live process may be suspended inside a mutation. Age cannot safely revoke its lock.
    return withFileLock(`${this.file(resource)}.mutation.lock`, action, { staleMs: Infinity });
  }

  withOwnership<T>(lease: Lease, write: () => Promise<T>): Promise<T> {
    return this.exclusive(lease.resource, async () => {
      assertOwnership(await this.read(this.file(lease.resource)), lease, this.clock.now());
      return write();
    });
  }

  async acquire(request: LeaseRequest): Promise<Lease> {
    return this.exclusive(request.resource, () => this.acquireUnlocked(request));
  }
  private async acquireUnlocked(request: LeaseRequest): Promise<Lease> {
    const file = this.file(request.resource);
    await mkdir(join(this.dir, "leases"), { recursive: true });
    for (;;) {
      const held = await this.read(file);
      if (held) assertLegacySafe(held);
      if (held) assertSameHolderProcess(held, request, this.clock.now());
      // Ours already: refresh in place rather than conflict with ourselves. Writing over our
      // own record is safe precisely because we are the holder.
      if (held?.holder === request.holder) {
        const refresh = !lapsed(held, this.clock.now());
        const lease = build(
          request,
          this.clock,
          refresh ? held.acquiredAt : undefined,
          refresh ? held.guardedId : undefined,
        );
        await this.overwrite(file, lease);
        return lease;
      }
      if (!held) {
        const lease = build(request, this.clock);
        if (await this.linkInto(file, lease)) return lease;
        // Either someone linked between our read and our link, or the record on disk is not
        // readable at all (`read` cannot tell those apart). Both are for the breaker below.
      }
      // Remove a lapsed guarded record while holding the mutation mutex. The legacy-visible
      // sentinels also prevent an older automatic contender from bypassing that mutex.
      const verdict = await breakIfStale(file, (text) => {
        const parsed = parse(text);
        if (!parsed) throw new OrcaError("RUN_LEASED", `unreadable lease ${file}; refusing takeover`);
        assertLegacySafe(parsed);
        return lapsed(parsed, this.clock.now());
      });
      if (verdict !== "live") continue;
      const incumbent = await this.read(file);
      if (incumbent) return incumbent;
      // Live a moment ago, gone now; try to take it.
    }
  }

  async renew(lease: Lease): Promise<Lease | undefined> {
    return this.exclusive(lease.resource, () => this.renewUnlocked(lease));
  }
  private async renewUnlocked(lease: Lease): Promise<Lease | undefined> {
    const file = this.file(lease.resource);
    const held = await this.read(file);
    if (held) assertLegacySafe(held);
    if (!held || !sameLease(held, lease) || lapsed(held, this.clock.now())) return undefined;
    const next: Lease = { ...held, renewedAt: this.clock.isoNow() };
    await this.overwrite(file, next);
    return next;
  }

  async release(lease: Lease): Promise<void> {
    return this.exclusive(lease.resource, () => this.releaseUnlocked(lease));
  }
  private async releaseUnlocked(lease: Lease): Promise<void> {
    const file = this.file(lease.resource);
    const held = await this.read(file);
    if (!held || !sameLease(held, lease)) return;
    assertLegacySafe(held);
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
    return this.exclusive(resource, () => this.forceReleaseUnlocked(resource));
  }
  private async forceReleaseUnlocked(resource: string): Promise<Lease | undefined> {
    const file = this.file(resource);
    const held = await this.read(file);
    if (held) assertLegacySafe(held);
    if (held) await unlink(file).catch(ignoreMissing);
    return held;
  }

  /** True when we created the file; false when someone else got there first. */
  private async linkInto(file: string, lease: Lease): Promise<boolean> {
    const tmp = this.tmp(file);
    await writeFile(tmp, serializeLease(lease), "utf8");
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
    await writeFile(tmp, serializeLease(lease), "utf8");
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
    const lease = parse(text);
    if (!lease)
      throw new OrcaError("RUN_LEASED", `unreadable lease ${file}; ownership cannot be established safely`, { file });
    return lease;
  }
}

/**
 * Parsing distinguishes the legacy-visible TTL from the actual guarded TTL. Callers must
 * refuse unreadable records: corrupt bytes do not prove that the writer stopped.
 */
function parse(text: string): Lease | undefined {
  try {
    const parsed = LeaseSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? {
          ...parsed.data,
          host: parsed.data.guardedHost ?? parsed.data.host,
          ttlMs: parsed.data.guardedTtlMs ?? parsed.data.ttlMs,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function build(request: LeaseRequest, clock: Clock, acquiredAt?: string, guardedId?: string): Lease {
  const at = clock.isoNow();
  return {
    resource: request.resource,
    holder: request.holder,
    pid: process.pid,
    host: hostname(),
    acquiredAt: acquiredAt ?? at,
    renewedAt: at,
    ttlMs: request.ttlMs ?? DEFAULT_LEASE_TTL_MS,
    guardedTtlMs: request.ttlMs ?? DEFAULT_LEASE_TTL_MS,
    guardedHost: hostname(),
    guardedId: guardedId ?? randomUUID(),
    ...(request.note ? { note: request.note } : {}),
  };
}

function ignoreMissing(e: NodeJS.ErrnoException): void {
  if (e.code !== "ENOENT") throw e;
}

function assertOwnership(current: Lease | undefined, lease: Lease, now: number): asserts current is Lease {
  if (current) assertLegacySafe(current);
  if (!current || !sameLease(current, lease) || lapsed(current, now))
    throw new OrcaError("RUN_LEASED", `ownership of ${lease.resource} was lost; refusing obsolete write`, {
      resource: lease.resource,
    });
}

/** Legacy readers see neither an expiring TTL nor a local host eligible for PID recovery. */
function serializeLease(lease: Lease): string {
  return JSON.stringify(
    {
      ...lease,
      host: "\u0000orca-guarded-lease",
      guardedHost: lease.host,
      ttlMs: Number.MAX_SAFE_INTEGER,
      guardedTtlMs: lease.ttlMs,
    },
    null,
    2,
  );
}

function assertLegacySafe(lease: Lease): void {
  if (lease.guardedTtlMs === undefined || lease.guardedId === undefined || lease.guardedHost === undefined)
    throw new OrcaError(
      "RUN_LEASED",
      `legacy lease on ${lease.resource} cannot be safely taken over: quiesce all writers before removing the legacy lease record`,
      {
        resource: lease.resource,
        host: lease.host,
        pid: lease.pid,
      },
    );
}

function sameLease(a: Lease, b: Lease): boolean {
  return (
    a.resource === b.resource && a.holder === b.holder && a.acquiredAt === b.acquiredAt && a.guardedId === b.guardedId
  );
}

function assertSameHolderProcess(lease: Lease, request: LeaseRequest, now: number): void {
  if (
    lease.holder === request.holder &&
    !lapsed(lease, now) &&
    (lease.pid !== process.pid || lease.host !== hostname())
  )
    throw new OrcaError("RUN_LEASED", `holder ${request.holder} is already active in another process`, {
      resource: request.resource,
      pid: lease.pid,
      host: lease.host,
    });
}
