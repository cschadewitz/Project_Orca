/**
 * Converting a file store into a SQLite store of its own (#339, store-convert.ts): the source is
 * left byte for byte as it was, the new store is fenced against released ORCA and runs on SQLite
 * with everything in it, nothing is published unless the source stayed unchanged, and an
 * interrupted or unpublished conversion is finished or redone without ever discarding a store
 * that may have been in use. The released binaries themselves run in `tools/legacy-fence`.
 */
import { appendFile, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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
  SQLITE_METADATA_FILE,
  SQLITE_STORE_FORMAT_EPOCH,
  SQLITE_SWITCH_DIR,
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

  it("publishes nothing when the source changes while it is copied, and keeps a promoted store when it changes after", async () => {
    const dir = await populated();
    const published: string[] = [];
    const write = async () => {
      await appendFile(join(dir, "runs", "run_a.jsonl"), "");
      await writeFile(join(dir, "requests.json"), "[]\n");
    };
    await expect(
      convertStoreToSqlite(dir, {
        appVersion: "0.8.0",
        publish: async (t) => void published.push(t),
        afterCopy: write,
      }),
    ).rejects.toMatchObject(refusal("BUSY"));
    expect(published).toEqual([]);
    expect(await siblings(dir)).toEqual([".orca"]);

    // After the converted store takes its final name it is never removed: the change is refused
    // and the store left for the operator.
    const after = await populated();
    await expect(
      convertStoreToSqlite(after, {
        appVersion: "0.8.0",
        publish: async (t) => void published.push(t),
        beforePublish: async () => {
          await appendFile(join(after, "runs", "run_a.jsonl"), "");
          await writeFile(join(after, "decisions.json"), "[]\n");
        },
      }),
    ).rejects.toMatchObject(refusal("SOURCE_CHANGED"));
    expect(published).toEqual([]);
    expect(await siblings(after)).toEqual([".orca", ".orca-sqlite"]);
    await expect(convert(after)).rejects.toMatchObject(refusal("SOURCE_CHANGED"));
    expect(await readStoreFormat(convertedStoreDir(after))).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
  });

  it("finishes a conversion stopped after promotion or whose publication failed, once it checks out", async () => {
    for (const stop of ["beforePublish", "publish"] as const) {
      const dir = await populated();
      await expect(
        convertStoreToSqlite(dir, {
          appVersion: "0.8.0",
          publish: async () => {
            if (stop === "publish") throw new Error("EACCES: config not writable");
          },
          ...(stop === "beforePublish"
            ? {
                beforePublish: async () => {
                  throw new Error("killed");
                },
              }
            : {}),
        }),
      ).rejects.toThrow(stop === "publish" ? "EACCES" : "killed");
      const target = convertedStoreDir(dir);
      expect(await readStoreFormat(target), stop).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
      const again = await convert(dir);
      expect(again.outcome, stop).toEqual({ status: "finished", convertedDir: target });
      expect(again.published, stop).toEqual([target]);
    }
  });

  it("never publishes a converted store that does not check out, and leaves it as it is", async () => {
    const broken: Record<string, (target: string) => Promise<void>> = {
      "database missing": async (target) => {
        for (const name of await readdir(target))
          if (name.startsWith(SQLITE_METADATA_FILE)) await rm(join(target, name));
      },
      "database of another store": async (target) => {
        const other = await populated();
        const otherTarget = (await convert(other)).published[0]!;
        for (const name of await readdir(target))
          if (name.startsWith(SQLITE_METADATA_FILE)) await rm(join(target, name));
        await copyFile(join(otherTarget, SQLITE_METADATA_FILE), join(target, SQLITE_METADATA_FILE));
      },
      "fence incomplete": async (target) => {
        await rm(join(target, "requests.json"));
        await writeFile(join(target, "requests.json"), "[]\n");
      },
      "switch half done": async (target) => {
        await mkdir(join(target, SQLITE_SWITCH_DIR), { recursive: true });
        await writeFile(join(target, SQLITE_SWITCH_DIR, "journal.json"), "{}");
      },
    };
    for (const [what, breakIt] of Object.entries(broken)) {
      const dir = await populated();
      await expect(
        convertStoreToSqlite(dir, {
          appVersion: "0.8.0",
          publish: async () => {
            throw new Error("not published");
          },
        }),
      ).rejects.toThrow("not published");
      const target = convertedStoreDir(dir);
      await breakIt(target);
      const before = await contents(target);
      const again = await convertStoreToSqlite(dir, {
        appVersion: "0.8.0",
        publish: async () => {
          throw new Error(`${what}: published`);
        },
      }).catch((error: unknown) => error);
      expect(again, what).toMatchObject(refusal("SWITCH_REFUSED"));
      expect(await contents(target), what).toEqual(before);
    }
  });

  it("reclaims only staging it can prove is an interrupted conversion of this store, and refuses a foreign target", async () => {
    const dir = await populated();
    const staging = (id: string) => `${convertedStoreDir(dir)}.staging-${id}`;
    // Ours, from a process that is gone: reclaimed.
    await mkdir(join(staging("dead"), "store", "runs"), { recursive: true });
    await writeFile(
      join(staging("dead"), "staging.json"),
      JSON.stringify({ source: dir, pid: 2 ** 22 + 7, host: hostname() }),
    );
    // Not provably ours, or still at work: left alone.
    await mkdir(join(staging("unrelated"), "data"), { recursive: true });
    await mkdir(staging("live"), { recursive: true });
    await writeFile(
      join(staging("live"), "staging.json"),
      JSON.stringify({ source: dir, pid: process.pid, host: hostname() }),
    );
    await mkdir(staging("other-store"), { recursive: true });
    await writeFile(
      join(staging("other-store"), "staging.json"),
      JSON.stringify({ source: "/elsewhere/.orca", pid: 2 ** 22 + 7, host: hostname() }),
    );
    expect((await convert(dir)).outcome).toMatchObject({ status: "converted" });
    expect(await siblings(dir)).toEqual([
      ".orca",
      ".orca-sqlite",
      ".orca-sqlite.staging-live",
      ".orca-sqlite.staging-other-store",
      ".orca-sqlite.staging-unrelated",
    ]);
    expect(await readdir(join(staging("unrelated"), "data"))).toEqual([]);

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
