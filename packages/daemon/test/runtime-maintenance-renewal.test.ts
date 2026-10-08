/** A bounded keeper release is not proof that its owned renewal write has settled. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { RunState } from "@orca/core";
import type { FileLeaseStore, Lease } from "@orca/store";
import type { RunContext } from "@orca/engine";
import { barrier, runtimeMaintenanceFixture } from "./runtime-maintenance-fixture.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([false, true])(
  "keeps idle blocked until a post-TTL renewal settles without extending shutdown (close=%s)",
  async (close) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = await runtimeMaintenanceFixture({ lease: { ttlMs: 20, renewMs: 5 } });
    const executed = barrier(),
      finishExecution = barrier(),
      renewing = barrier(),
      finishRenewal = barrier(),
      renewed = barrier();
    // Hold only after real interpreter writes are complete and outside its mutation fence.
    const engine = f.orc as unknown as { execute(rc: RunContext): Promise<RunState> };
    const execute = engine.execute.bind(f.orc);
    vi.spyOn(engine, "execute").mockImplementation(async (rc) => {
      const result = await execute(rc);
      executed.release();
      await finishExecution.promise;
      return result;
    });
    const leases = f.orc.stores.leases as FileLeaseStore;
    const io = leases as unknown as { overwrite(file: string, lease: Lease): Promise<void> };
    const overwrite = io.overwrite.bind(leases);
    vi.spyOn(io, "overwrite").mockImplementationOnce(async (file, lease) => {
      renewing.release();
      await finishRenewal.promise;
      await overwrite(file, lease);
    });
    const renew = leases.renew.bind(leases);
    vi.spyOn(leases, "renew").mockImplementation(async (lease) => {
      try {
        return await renew(lease);
      } finally {
        renewed.release();
      }
    });
    const runId = await f.orc.startRun({ workflowId: "flow" });
    const file = join(f.dir, ".orca", "leases", `${encodeURIComponent(`run:${runId}`)}.json`);
    const lock = `${file}.mutation.lock`;
    const running = f.orc.run(runId);
    try {
      await executed.promise;
      await vi.advanceTimersByTimeAsync(5);
      await renewing.promise;
      const before = await readFile(file, "utf8");
      expect((await stat(lock)).isDirectory()).toBe(true);
      finishExecution.release();
      await nextTurn();
      await vi.advanceTimersByTimeAsync(15);
      expect((await running).run.status).toBe("completed");
      expect(f.orc.attachedExecutionCount).toBe(0);
      expect(f.runtime.originCount).toBe(0);
      expect(await readFile(file, "utf8")).toBe(before);
      // The original bug returned held/active:[] while this real store mutation was owned.
      expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["renewal"] } });
      if (close) {
        await f.daemon.close();
        expect((await stat(lock)).isDirectory()).toBe(true);
        expect(f.runtime.activity.snapshot().active).toContain("renewal");
      }
      finishRenewal.release();
      await renewed.promise;
      await nextTurn();
      expect(await readFile(file, "utf8")).not.toBe(before);
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.runtime.activity.snapshot().active).toEqual([]);
      if (!close) {
        expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held", active: [] } });
        expect(await f.resume()).toMatchObject({ ok: true, result: { outcome: "released" } });
      }
    } finally {
      finishExecution.release();
      finishRenewal.release();
      await running;
      await renewed.promise;
      await f.close();
    }
  },
);
