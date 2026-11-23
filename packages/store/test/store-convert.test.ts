/**
 * Converting a file store into a SQLite store of its own (#339, store-convert.ts): the source is
 * left byte for byte as it was, the new store is fenced against released ORCA and runs on SQLite
 * with everything in it, nothing is published unless the source stayed unchanged, and an
 * interrupted or unpublished conversion is finished or redone without ever discarding a store
 * that may have been in use. The released binaries themselves run in `tools/legacy-fence`.
 */
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertedSourceChanged,
  convertedStoreDir,
  convertStoreToSqlite,
  enterStoreFormat,
  FileLeaseStore,
  holdStoreWriter,
  readStoreFormat,
  recordedStoreBackend,
  SQLITE_STORE_FORMAT_EPOCH,
  STORE_FORMAT_EPOCH,
} from "@orca/store";
import {
  contents,
  expectFenced,
  expectReadsOnSqlite,
  populated,
  refusal,
  store,
} from "./fixtures/sqlite-store-fixture.js";

/** Convert, recording what was published. */
async function convert(dir: string, hooks: Partial<Parameters<typeof convertStoreToSqlite>[1]> = {}) {
  const published: string[] = [];
  const outcome = await convertStoreToSqlite(dir, {
    appVersion: "0.8.0",
    publish: async (target) => {
      published.push(target);
    },
    ...hooks,
  });
  return { outcome, published };
}

const siblings = async (dir: string) => (await readdir(dirname(dir))).sort();

describe("converting a file store into a SQLite store of its own (#339)", () => {
  it("leaves the source exactly as it was, and the new store runs on SQLite, fenced, with everything", async () => {
    const dir = await populated();
    const before = await contents(dir);
    const marker = await readStoreFormat(dir);
    const { outcome, published } = await convert(dir);
    const target = convertedStoreDir(dir);
    expect(outcome).toEqual({ status: "converted", convertedDir: target });
    expect(basename(target)).toBe(".orca-sqlite");
    expect(published).toEqual([target]);
    // The source: every byte, and its marker, as before.
    expect(await contents(dir)).toEqual(before);
    expect(await readStoreFormat(dir)).toEqual(marker);
    expect(recordedStoreBackend(dir)).toBe("file");
    // The new store.
    expect(await readStoreFormat(target)).toMatchObject({
      epoch: SQLITE_STORE_FORMAT_EPOCH,
      convertedFrom: { store: dir, signature: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect((await readStoreFormat(target))?.backup).toBeUndefined();
    await expectFenced(target);
    await expectReadsOnSqlite(target);
    expect(await enterStoreFormat(target, { appVersion: "0.8.0", mode: "write" })).toMatchObject({
      backend: "sqlite",
    });
    expect(await siblings(dir)).toEqual([".orca", ".orca-sqlite"]);
    expect(await convertedSourceChanged(target)).toEqual({ source: dir, changed: false, present: true });
  });

  it("reports a write that reached the source after the conversion (a released ORCA still running there)", async () => {
    const dir = await populated();
    const { published } = await convert(dir);
    await appendFile(
      join(dir, "runs", "run_a.jsonl"),
      JSON.stringify({ seq: 2, type: "run.completed", runId: "run_a", payload: {} }) + "\n",
    );
    expect(await convertedSourceChanged(published[0]!)).toEqual({ source: dir, changed: true, present: true });
    await rm(dir, { recursive: true });
    expect(await convertedSourceChanged(published[0]!)).toEqual({ source: dir, changed: false, present: false });
    expect(await convertedSourceChanged(dir.replace(/\.orca$/, ".none"))).toBeUndefined();
  });

  it("publishes nothing when the source changes while it is copied, or before it is published", async () => {
    for (const hook of ["afterCopy", "beforePublish"] as const) {
      const dir = await populated();
      const published: string[] = [];
      await expect(
        convertStoreToSqlite(dir, {
          appVersion: "0.8.0",
          publish: async (target) => {
            published.push(target);
          },
          [hook]: async () => {
            await appendFile(join(dir, "runs", "run_a.jsonl"), "");
            await writeFile(join(dir, "requests.json"), "[]\n");
          },
        }),
      ).rejects.toMatchObject(refusal("BUSY"));
      expect(published, hook).toEqual([]);
      expect(await siblings(dir), hook).toEqual([".orca"]);
    }
  });

  it("finishes a conversion whose publication failed, and refuses to once the source has changed", async () => {
    const dir = await populated();
    await expect(
      convertStoreToSqlite(dir, {
        appVersion: "0.8.0",
        publish: async () => {
          throw new Error("EACCES: config not writable");
        },
      }),
    ).rejects.toThrow("EACCES");
    const target = convertedStoreDir(dir);
    // Left in place: it may already have been opened, so it is never removed.
    expect(await readStoreFormat(target)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
    const again = await convert(dir);
    expect(again.outcome).toEqual({ status: "finished", convertedDir: target });
    expect(again.published).toEqual([target]);

    await appendFile(join(dir, "runs", "run_a.jsonl"), "");
    await writeFile(join(dir, "decisions.json"), "[]\n");
    await expect(convert(dir)).rejects.toMatchObject(refusal("SOURCE_CHANGED"));
    expect(await readStoreFormat(target)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
  });

  it("removes what an interrupted conversion left, and refuses a target that is not this store's conversion", async () => {
    const dir = await populated();
    const partial = `${convertedStoreDir(dir)}.partial-0000`;
    await mkdir(join(partial, "runs"), { recursive: true });
    expect((await convert(dir)).outcome).toMatchObject({ status: "converted" });
    expect(await siblings(dir)).toEqual([".orca", ".orca-sqlite"]);

    const other = await populated();
    await mkdir(convertedStoreDir(other));
    await expect(convert(other)).rejects.toMatchObject(refusal("SWITCH_REFUSED"));
    expect(await siblings(other)).toEqual([".orca", ".orca-sqlite"]);
    expect(await readdir(convertedStoreDir(other))).toEqual([]);
  });

  it("refuses while this ORCA has the store open or a run is active, and changes nothing", async () => {
    const dir = await populated();
    const before = await contents(dir);
    const hold = holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "daemon" });
    try {
      await expect(convert(dir)).rejects.toMatchObject(refusal("BUSY"));
    } finally {
      hold.release();
    }
    const leases = new FileLeaseStore(dir);
    const lease = await leases.acquire({ resource: "run_a", holder: "test" });
    await expect(convert(dir)).rejects.toMatchObject(refusal("BUSY"));
    await leases.release(lease);
    expect(await siblings(dir)).toEqual([".orca"]);
    expect((await contents(dir))["requests.json"]).toEqual(before["requests.json"]);
  });

  it("refuses on Windows, an unmarked or older store, and leaves a SQLite store as it is", async () => {
    const dir = await populated();
    await expect(convert(dir, { platform: "win32" })).rejects.toMatchObject(refusal("UNDURABLE"));
    const unmarked = await store();
    await mkdir(join(unmarked, "runs"), { recursive: true });
    await expect(convert(unmarked)).rejects.toMatchObject(refusal("SWITCH_REFUSED"));
    const target = (await convert(dir)).published[0]!;
    expect((await convert(target)).outcome).toEqual({ status: "current", epoch: SQLITE_STORE_FORMAT_EPOCH });
    expect(await siblings(dir)).toEqual([".orca", ".orca-sqlite"]);
    expect(STORE_FORMAT_EPOCH).not.toBe(SQLITE_STORE_FORMAT_EPOCH);
  });
});
