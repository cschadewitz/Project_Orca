/** The single-writer lease: who may drive a run, and when that may be taken away. */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "@orca/core";
import {
  FileLeaseStore,
  InMemoryLeaseStore,
  keepLease,
  lapsed,
  ownsLease,
  type Lease,
  type LeaseStore,
} from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-leases-"));
  dirs.push(dir);
  return dir;
}

const req = (holder: string, resource = "run:run_1", ttlMs = 60_000) => ({ resource, holder, ttlMs });

describe("lease stores", () => {
  it("release before expiry stops waiting at the last confirmed TTL when renewal never settles", async () => {
    vi.useFakeTimers();
    const store = new InMemoryLeaseStore();
    const lease = await store.acquire(req("a", "run:shutdown", 20));
    let finish!: () => void;
    const renew = vi.spyOn(store, "renew").mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const release = vi.spyOn(store, "release");
    const held = keepLease(store, lease, { renewMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(renew).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = held.release().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(14);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(stopped).toBe(true);
    expect(held.held).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(await store.get("run:shutdown")).toEqual(lease);
    expect(vi.getTimerCount()).toBe(0);
    const successor = await store.acquire(req("b", "run:shutdown"));
    finish();
    await vi.advanceTimersByTimeAsync(1);
    await held.release();
    expect(release).not.toHaveBeenCalled();
    expect(await store.get("run:shutdown")).toEqual(successor);
  });

  it("expiry stops local ownership once even when renewals reject or never settle", async () => {
    vi.useFakeTimers();
    for (const hangs of [false, true]) {
      const store = new InMemoryLeaseStore();
      const lease = await store.acquire(req("a", "run:ttl", 20));
      const lost = vi.fn();
      let finish = () => {};
      vi.spyOn(store, "renew").mockImplementation(() =>
        hangs
          ? new Promise<undefined>((resolve) => {
              finish = () => resolve(undefined);
            })
          : Promise.reject(new Error("I/O unavailable")),
      );
      const held = keepLease(store, lease, { renewMs: 5, onLost: lost });
      await vi.advanceTimersByTimeAsync(21);
      expect(held.held).toBe(false);
      expect(lost).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(lost).toHaveBeenCalledTimes(1);
      const successor = await store.acquire(req("b", "run:ttl"));
      finish();
      await held.release();
      expect(await store.get("run:ttl")).toEqual(successor);
    }
  });

  it("file: takeover cannot interleave a paused ownership-checked append", async () => {
    const dir = await tmp();
    const clock = new FakeClock();
    const first = new FileLeaseStore(dir, clock);
    const second = new FileLeaseStore(dir, clock);
    const lease = await first.acquire(req("a", "run:guard", 10));
    let entered = () => {};
    let finish = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = first.withOwnership(lease, async () => {
      entered();
      await barrier;
      return "written";
    });
    await inside;
    clock.advance(11);
    const acquisition = second.acquire(req("b", "run:guard", 10));
    finish();
    expect(await write).toBe("written");
    const successor = await acquisition;
    expect(successor.holder).toBe("b");
    await expect(first.withOwnership(lease, async () => "obsolete")).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await first.renew(lease)).toBeUndefined();
    await first.release(lease);
    expect(await second.get("run:guard")).toEqual(successor);
  });
  for (const [name, make] of [
    ["memory", async (clock?: FakeClock): Promise<LeaseStore> => new InMemoryLeaseStore(clock)],
    ["file", async (clock?: FakeClock): Promise<LeaseStore> => new FileLeaseStore(await tmp(), clock)],
  ] as const) {
    it(`${name}: the first holder wins and the second is told who has it`, async () => {
      const store = await make();
      expect(await store.get("run:run_1")).toBeUndefined();
      const mine = await store.acquire(req("orc_a"));
      expect(ownsLease(mine, "orc_a")).toBe(true);

      const theirs = await store.acquire(req("orc_b"));
      expect(ownsLease(theirs, "orc_b")).toBe(false);
      expect(theirs.holder).toBe("orc_a");
      // A different resource is unaffected.
      expect(ownsLease(await store.acquire(req("orc_b", "run:run_2")), "orc_b")).toBe(true);
    });

    it(`${name}: re-acquiring as the same holder refreshes rather than conflicts`, async () => {
      const clock = new FakeClock();
      const store = await make(clock);
      const first = await store.acquire(req("orc_a"));
      clock.advance(5_000);
      const again = await store.acquire(req("orc_a"));
      expect(ownsLease(again, "orc_a")).toBe(true);
      expect(again.acquiredAt).toBe(first.acquiredAt);
      expect(Date.parse(again.renewedAt)).toBeGreaterThan(Date.parse(first.renewedAt));
    });

    it(`${name}: renew extends the lease, and reports it gone once someone else holds it`, async () => {
      const clock = new FakeClock();
      const store = await make(clock);
      const mine = await store.acquire(req("orc_a"));
      clock.advance(1_000);
      const renewed = await store.renew(mine);
      expect(renewed?.renewedAt).not.toBe(mine.renewedAt);

      await store.forceRelease("run:run_1");
      await store.acquire(req("orc_b"));
      expect(await store.renew(mine)).toBeUndefined();
      // Releasing a lease we no longer hold must not evict the new holder.
      await store.release(mine);
      expect((await store.get("run:run_1"))?.holder).toBe("orc_b");
    });

    it(`${name}: a lease nobody heartbeats for lapses and is taken over without asking`, async () => {
      const clock = new FakeClock();
      const store = await make(clock);
      const abandoned = await store.acquire(req("orc_a", "run:run_1", 30_000));
      expect(lapsed(abandoned, clock.now())).toBe(false);

      clock.advance(30_000);
      expect(lapsed(abandoned, clock.now())).toBe(true);
      const taken = await store.acquire(req("orc_b", "run:run_1", 30_000));
      expect(ownsLease(taken, "orc_b")).toBe(true);
      expect(await store.renew(abandoned)).toBeUndefined();
    });

    it(`${name}: release frees the resource, and list shows what is held`, async () => {
      const store = await make();
      const a = await store.acquire(req("orc_a", "run:run_1"));
      await store.acquire(req("orc_a", "run:run_2"));
      expect((await store.list()).map((l) => l.resource).sort()).toEqual(["run:run_1", "run:run_2"]);
      await store.release(a);
      expect(await store.get("run:run_1")).toBeUndefined();
      expect(ownsLease(await store.acquire(req("orc_b", "run:run_1")), "orc_b")).toBe(true);
    });
  }

  it("a dead holder on this host lapses at once, without waiting out the TTL", () => {
    const base: Lease = {
      resource: "run:run_1",
      holder: "orc_a",
      pid: 2,
      host: hostname(),
      acquiredAt: "2026-01-01T00:00:00.000Z",
      renewedAt: new Date().toISOString(),
      ttlMs: 3_600_000,
    };
    // pid 2 is the kernel thread daemon on Linux and never ours; a pid we cannot see at all
    // would be the honest test, so use one far beyond any plausible pid table.
    expect(lapsed({ ...base, pid: 0x7ffffff0 })).toBe(true);
    // The same record from somewhere else is judged only by its heartbeat: pids do not travel.
    expect(lapsed({ ...base, pid: 0x7ffffff0, host: "another-host" })).toBe(false);
    // Ours, beating: good.
    expect(lapsed({ ...base, pid: process.pid })).toBe(false);
  });

  it("file: an unreadable lease record refuses takeover rather than guessing that its writer is dead", async () => {
    const dir = await tmp();
    const store = new FileLeaseStore(dir);
    await store.acquire(req("orc_a"));
    const [file] = await readdir(join(dir, "leases"));
    await writeFile(join(dir, "leases", file!), '{"resource":"run:run_1"', "utf8");

    await expect(store.acquire(req("orc_b"))).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await readFile(join(dir, "leases", file!), "utf8")).toBe('{"resource":"run:run_1"');
  });

  it("file: two processes racing for one run leave exactly one holder", async () => {
    const dir = await tmp();
    const holders = ["orc_a", "orc_b", "orc_c", "orc_d"];
    const results = await Promise.all(holders.map((h) => new FileLeaseStore(dir).acquire(req(h))));
    const winners = new Set(results.map((l) => l.holder));
    expect(winners.size).toBe(1);
    expect(holders).toContain([...winners][0]);
  });

  it("keepLease heartbeats until release, and says so when the lease is taken away", async () => {
    const store = new InMemoryLeaseStore();
    const lease = await store.acquire(req("orc_a", "run:run_1", 60));
    let lost = false;
    const held = keepLease(store, lease, { renewMs: 2, onLost: () => (lost = true) });

    await new Promise((r) => setTimeout(r, 30));
    expect(held.held).toBe(true);
    expect(Date.parse(held.lease.renewedAt)).toBeGreaterThanOrEqual(Date.parse(lease.renewedAt));

    await store.forceRelease("run:run_1");
    await new Promise((r) => setTimeout(r, 30));
    expect(lost).toBe(true);
    expect(held.held).toBe(false);

    // Release after the lease is gone must not evict whoever holds it now.
    await store.acquire(req("orc_b"));
    await held.release();
    expect((await store.get("run:run_1"))?.holder).toBe("orc_b");
  });

  it("keepLease releases the lease it holds, once", async () => {
    const store = new InMemoryLeaseStore();
    const held = keepLease(store, await store.acquire(req("orc_a")), { renewMs: 5 });
    await held.release();
    expect(await store.get("run:run_1")).toBeUndefined();
    await held.release();
    expect(ownsLease(await store.acquire(req("orc_b")), "orc_b")).toBe(true);
  });
});

describe("file lease compatibility and renewal fencing", () => {
  const fileOf = (dir: string, resource = "run:run_1") => join(dir, "leases", `${encodeURIComponent(resource)}.json`);

  it("keeps the legacy-visible TTL non-expiring while upgraded readers enforce the actual deadline", async () => {
    const dir = await tmp();
    const clock = new FakeClock();
    const store = new FileLeaseStore(dir, clock);
    const first = await store.acquire(req("a", "run:run_1", 10));
    const raw = JSON.parse(await readFile(fileOf(dir), "utf8")) as Lease;
    expect(raw.ttlMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(raw.host).not.toBe(first.host);
    expect(raw.guardedHost).toBe(first.host);
    expect(lapsed({ ...raw, pid: 0x7ffffff0 }, clock.now())).toBe(false);
    expect(raw.guardedTtlMs).toBe(10);
    expect(raw.guardedId).toBe(first.guardedId);
    clock.advance(11);
    // This is the old binary's exact heartbeat calculation, which ignores the extension.
    expect(clock.now() - Date.parse(raw.renewedAt) >= raw.ttlMs).toBe(false);
    expect(lapsed((await store.get(first.resource))!, clock.now())).toBe(true);
    expect((await store.acquire(req("b", first.resource, 10))).holder).toBe("b");
    const replacement = JSON.parse(await readFile(fileOf(dir), "utf8")) as Lease;
    expect(replacement.ttlMs).toBe(Number.MAX_SAFE_INTEGER);
    clock.advance(1);
    await store.renew((await store.get(first.resource))!);
    expect((JSON.parse(await readFile(fileOf(dir), "utf8")) as Lease).ttlMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["live-local", "remote", "dead-local"])(
    "refuses %s legacy leases even after expiry, same-holder reacquisition, and force",
    async (kind) => {
      const dir = await tmp();
      const clock = new FakeClock();
      const store = new FileLeaseStore(dir, clock);
      const created = await store.acquire(req("legacy", "run:run_1", 10));
      const { guardedTtlMs: _guard, guardedId: _id, guardedHost: _host, ...legacy } = created;
      if (kind === "remote") legacy.host = "unobservable-host";
      if (kind === "dead-local") legacy.pid = 0x7ffffff0;
      const contents = JSON.stringify(legacy);
      await writeFile(fileOf(dir), contents);
      await expect(store.renew(created)).rejects.toMatchObject({ code: "RUN_LEASED" });
      clock.advance(100);
      await expect(store.acquire(req("new"))).rejects.toMatchObject({ code: "RUN_LEASED" });
      await expect(store.acquire(req("legacy"))).rejects.toMatchObject({ code: "RUN_LEASED" });
      await expect(store.forceRelease(created.resource)).rejects.toMatchObject({ code: "RUN_LEASED" });
      await expect(store.withOwnership(created, async () => "unsafe")).rejects.toMatchObject({ code: "RUN_LEASED" });
      expect(await readFile(fileOf(dir), "utf8")).toBe(contents);
    },
  );

  it.each(["pid", "host"])("refuses an active same-holder acquisition from a different %s", async (field) => {
    const dir = await tmp();
    const store = new FileLeaseStore(dir);
    await store.acquire(req("same"));
    const raw = JSON.parse(await readFile(fileOf(dir), "utf8")) as Lease;
    if (field === "pid") raw.pid = 0;
    else raw.guardedHost = "other-host";
    const contents = JSON.stringify(raw);
    await writeFile(fileOf(dir), contents);
    await expect(store.acquire(req("same"))).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await readFile(fileOf(dir), "utf8")).toBe(contents);
  });

  it("preserves an unreadable record on force-release too", async () => {
    const dir = await tmp();
    const store = new FileLeaseStore(dir);
    await store.acquire(req("a"));
    await writeFile(fileOf(dir), "{torn");
    await expect(store.forceRelease("run:run_1")).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await readFile(fileOf(dir), "utf8")).toBe("{torn");
  });

  it("linearizes a renewal paused after ownership validation before its successor", async () => {
    const dir = await tmp();
    const clock = new FakeClock();
    const first = new FileLeaseStore(dir, clock);
    const second = new FileLeaseStore(dir, clock);
    const lease = await first.acquire(req("a", "run:run_1", 10));
    // Pause the filesystem replacement, after renew has read and validated its owner.
    const io = first as unknown as { overwrite(file: string, lease: Lease): Promise<void> };
    const overwrite = io.overwrite.bind(first);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(io, "overwrite").mockImplementationOnce(async (file, next) => {
      enter();
      await barrier;
      await overwrite(file, next);
    });
    clock.advance(1);
    const renewing = first.renew(lease);
    await entered;
    clock.advance(11);
    const acquiring = second.acquire(req("b", "run:run_1", 10));
    release();
    await renewing;
    const successor = await acquiring;
    expect(successor.holder).toBe("b");
    expect(await first.renew(lease)).toBeUndefined();
    expect(await second.get(lease.resource)).toEqual(successor);
  });

  it("fences immediate same-holder reuse even when acquisition timestamps are identical", async () => {
    const dir = await tmp();
    const clock = new FakeClock();
    const store = new FileLeaseStore(dir, clock);
    const obsolete = await store.acquire(req("same"));
    await store.forceRelease(obsolete.resource);
    const successor = await store.acquire(req("same"));
    expect(successor.acquiredAt).toBe(obsolete.acquiredAt);
    expect(successor.guardedId).not.toBe(obsolete.guardedId);
    expect(await store.renew(obsolete)).toBeUndefined();
    await expect(store.withOwnership(obsolete, async () => "obsolete")).rejects.toMatchObject({ code: "RUN_LEASED" });
    await store.release(obsolete);
    expect(await store.get(obsolete.resource)).toEqual(successor);
  });

  it("refuses an obsolete incarnation after the same holder reacquires an expired lease", async () => {
    const dir = await tmp();
    const clock = new FakeClock();
    const store = new FileLeaseStore(dir, clock);
    const obsolete = await store.acquire(req("same", "run:run_1", 10));
    clock.advance(11);
    const current = await store.acquire(req("same", "run:run_1", 10));
    expect(current.acquiredAt).not.toBe(obsolete.acquiredAt);
    expect(await store.renew(obsolete)).toBeUndefined();
    await expect(store.withOwnership(obsolete, async () => "obsolete")).rejects.toMatchObject({ code: "RUN_LEASED" });
    await store.release(obsolete);
    expect(await store.get(obsolete.resource)).toEqual(current);
  });
});
