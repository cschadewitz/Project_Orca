/** Failed document batches must disappear without discarding later mutations (C3-04). */
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: vi.fn(real.mkdir),
    open: vi.fn(real.open),
    rename: vi.fn(real.rename),
    writeFile: vi.fn(real.writeFile),
  };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { JsonFileDocumentStore } = await import("@orca/store");
const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;
const dirs: string[] = [];

afterEach(async () => {
  vi.mocked(mkdir).mockReset().mockImplementation(real.mkdir);
  vi.mocked(open).mockReset().mockImplementation(real.open);
  vi.mocked(rename).mockReset().mockImplementation(real.rename);
  vi.mocked(writeFile).mockReset().mockImplementation(real.writeFile);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-doc-errors-"));
  dirs.push(dir);
  const file = join(dir, "docs.json");
  const store = new JsonFileDocumentStore<Doc>(file, DocSchema);
  const onDisk = async () => JSON.parse(await readFile(file, "utf8")) as Doc[];
  return { file, store, onDisk };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("JsonFileDocumentStore failed batches", () => {
  it.each(["directory setup", "lock acquisition", "lock publication"] as const)(
    "discards coalesced puts and deletes after %s fails before callback entry",
    async (stage) => {
      const { file, store, onDisk } = await fixture();
      const original = [
        { id: "shared", n: 1 },
        { id: "keep", n: 2 },
      ];
      await store.putMany(original);
      const error = Object.assign(new Error(stage), { code: "ENOSPC" });
      if (stage === "directory setup") vi.mocked(mkdir).mockRejectedValueOnce(error);
      else if (stage === "lock acquisition")
        vi.mocked(mkdir).mockImplementationOnce(real.mkdir).mockRejectedValueOnce(error);
      else vi.mocked(writeFile).mockRejectedValueOnce(error);
      vi.mocked(open).mockClear();

      const results = await Promise.allSettled([
        store.putMany([
          { id: "shared", n: 99 },
          { id: "ghost", n: 3 },
        ]),
        store.delete("keep"),
        store.put({ id: "also-ghost", n: 4 }),
      ]);
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: "rejected", reason: error })));
      // No document temp file was opened: the locked callback never ran.
      expect(open).not.toHaveBeenCalled();
      expect(await store.get("ghost")).toBeUndefined();
      expect(await store.get("shared")).toEqual(original[0]);
      expect(await store.get("keep")).toEqual(original[1]);
      expect(await store.list()).toEqual(original);
      expect(await onDisk()).toEqual(original);

      // Failed owner publication intentionally leaves an unknown lock, which the
      // lock helper fails closed on. Recover only this test's synthetic directory.
      if (stage === "lock publication") await rm(`${file}.lock`, { recursive: true });
      await store.put({ id: "later", n: 5 });
      expect(await store.list()).toEqual([...original, { id: "later", n: 5 }]);
      expect(await onDisk()).toEqual([...original, { id: "later", n: 5 }]);
    },
  );

  it("preserves mutations appended while a failed batch is waiting for its lock", async () => {
    const { file, store, onDisk } = await fixture();
    await store.putMany([
      { id: "shared", n: 1 },
      { id: "remove", n: 2 },
    ]);
    const failedLock = signal();
    const lockEntered = signal();
    const laterLock = signal();
    const laterEntered = signal();
    const error = new Error("lock acquisition failed");
    vi.mocked(mkdir)
      .mockImplementationOnce(real.mkdir)
      .mockImplementationOnce(async () => {
        lockEntered.resolve();
        await failedLock.promise;
        throw error;
      })
      .mockImplementationOnce(real.mkdir)
      .mockImplementationOnce(async (...args) => {
        laterEntered.resolve();
        await laterLock.promise;
        return real.mkdir(...args);
      });

    const rejected = expect(
      store.putMany([
        { id: "shared", n: 99 },
        { id: "ghost", n: 3 },
      ]),
    ).rejects.toBe(error);
    await lockEntered.promise;
    const accepted = Promise.all([
      store.put({ id: "shared", n: 4 }),
      store.delete("remove"),
      store.putMany([
        { id: "later-a", n: 5 },
        { id: "later-b", n: 6 },
      ]),
    ]);
    let settled = false;
    void accepted.then(
      () => {
        settled = true;
      },
      () => {},
    );
    failedLock.resolve();
    try {
      await rejected;
      await laterEntered.promise;
      expect(settled).toBe(false);
      expect(await store.get("ghost")).toBeUndefined();
      expect(await store.list()).toEqual([
        { id: "shared", n: 4 },
        { id: "later-a", n: 5 },
        { id: "later-b", n: 6 },
      ]);
      expect(await onDisk()).toEqual([
        { id: "shared", n: 1 },
        { id: "remove", n: 2 },
      ]);
    } finally {
      laterLock.resolve();
      await accepted;
    }
    expect(await new JsonFileDocumentStore<Doc>(file, DocSchema).list()).toEqual([
      { id: "shared", n: 4 },
      { id: "later-a", n: 5 },
      { id: "later-b", n: 6 },
    ]);
  });

  it("keeps a successful put pending until the temp file is synced and renamed", async () => {
    const { store, onDisk } = await fixture();
    await store.put({ id: "shared", n: 1 });
    const syncing = signal();
    const release = signal();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await real.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
        syncing.resolve();
        await release.promise;
        await sync();
      });
      return handle;
    });
    vi.mocked(rename).mockClear();
    let settled = false;
    const writing = store.put({ id: "shared", n: 2 }).then(() => {
      settled = true;
    });
    try {
      await syncing.promise;
      expect(settled).toBe(false);
      expect(rename).not.toHaveBeenCalled();
      expect(await onDisk()).toEqual([{ id: "shared", n: 1 }]);
      expect(await store.get("shared")).toEqual({ id: "shared", n: 2 });
    } finally {
      release.resolve();
      await writing;
    }
    expect(rename).toHaveBeenCalledOnce();
    expect(await onDisk()).toEqual([{ id: "shared", n: 2 }]);
  });

  it.each(["sync", "rename"] as const)(
    "discards a batch after a %s failure and permits an unrelated write",
    async (stage) => {
      const { store, onDisk } = await fixture();
      await store.put({ id: "shared", n: 1 });
      const error = new Error(`${stage} failed`);
      if (stage === "rename") vi.mocked(rename).mockRejectedValueOnce(error);
      else
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const handle = await real.open(...args);
          vi.spyOn(handle, "sync").mockRejectedValueOnce(error);
          return handle;
        });
      const rejected = await store.delete("shared").catch((e: unknown) => e);
      // Before the rename nothing was committed: the plain error. A failed rename is the commit
      // point itself, so it is reported as an uncertain outcome carrying the cause (#338).
      if (stage === "rename")
        expect(rejected).toMatchObject({ code: "STORE_WRITE", details: { outcome: "uncertain" }, cause: error });
      else expect(rejected).toBe(error);
      expect(await store.get("shared")).toEqual({ id: "shared", n: 1 });
      expect(await onDisk()).toEqual([{ id: "shared", n: 1 }]);
      await store.put({ id: "later", n: 2 });
      expect(await onDisk()).toEqual([
        { id: "shared", n: 1 },
        { id: "later", n: 2 },
      ]);
    },
  );
});
