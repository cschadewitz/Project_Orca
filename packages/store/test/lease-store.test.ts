/** The single-writer lease: who may drive a run, and when that may be taken away. */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-leases-"));
  dirs.push(dir);
  return dir;
}

const req = (holder: string, resource = "run:run_1", ttlMs = 60_000) => ({ resource, holder, ttlMs });

describe("lease stores", () => {
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

  it("file: an unreadable lease record is treated as lapsed rather than wedging the run forever", async () => {
    const dir = await tmp();
    const store = new FileLeaseStore(dir);
    await store.acquire(req("orc_a"));
    const [file] = await readdir(join(dir, "leases"));
    await writeFile(join(dir, "leases", file!), '{"resource":"run:run_1"', "utf8");

    const taken = await store.acquire(req("orc_b"));
    expect(ownsLease(taken, "orc_b")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "leases", file!), "utf8")).holder).toBe("orc_b");
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
