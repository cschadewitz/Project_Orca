/**
 * What a caller is told when the file-backed document store fails around its commit point
 * (#338): before the rename nothing is committed and retrying is safe; a failed rename is
 * reported as an uncertain outcome; a failure after the rename (cache fingerprint, lock
 * release) does not turn a committed write into an error.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isOrcaError } from "@orca/core";
import { documentVersion, JsonFileDocumentStore } from "@orca/store";

type Fault = { op: "open" | "rename" | "stat" | "unlink"; when: (path: string) => boolean; after?: boolean };
const faults: Fault[] = [];

/** Fail the next matching call once; `after` performs the real call first, then fails. */
function wrap<F extends (...args: never[]) => Promise<unknown>>(op: Fault["op"], real: F): F {
  return (async (...args: Parameters<F>) => {
    const path = String(args[0]);
    const i = faults.findIndex((f) => f.op === op && f.when(path));
    if (i === -1) return real(...args);
    const [fault] = faults.splice(i, 1);
    if (fault!.after) await real(...args);
    throw Object.assign(new Error(`injected ${op} fault`), { code: "EIO" });
  }) as F;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: wrap("open", real.open),
    rename: wrap("rename", real.rename),
    stat: wrap("stat", real.stat),
    unlink: wrap("unlink", real.unlink),
  };
});

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

const dirs: string[] = [];
afterEach(async () => {
  faults.length = 0;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function store(): Promise<{ store: JsonFileDocumentStore<Doc>; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-commit-"));
  dirs.push(dir);
  const file = join(dir, "docs.json");
  const s = new JsonFileDocumentStore<Doc>(file, DocSchema);
  await s.put({ id: "x", n: 0 });
  return { store: s, file };
}

const onDisk = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Doc[];
const isTmp = (path: string) => path.endsWith(".tmp");
const isLockToken = (path: string) => /\.lock[\\/]owner\.[^\\/]+\.json$/.test(path);
const v0 = documentVersion({ id: "x", n: 0 });

describe("file document store: outcome around the commit point", () => {
  it("a failure before the rename is the plain error, nothing is committed, and a retry succeeds", async () => {
    const { store: s, file } = await store();
    faults.push({ op: "open", when: isTmp });
    const error = await s.putIfVersion({ id: "x", n: 1 }, v0).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: "injected open fault" });
    expect(isOrcaError(error, "STORE_WRITE")).toBe(false);
    expect(onDisk(file)).toEqual([{ id: "x", n: 0 }]);
    expect(await s.putIfVersion({ id: "x", n: 1 }, v0)).toMatchObject({ ok: true });
  });

  it("a rename that fails without renaming is reported as uncertain", async () => {
    const { store: s, file } = await store();
    faults.push({ op: "rename", when: isTmp });
    const error = await s.put({ id: "x", n: 1 }).catch((e: unknown) => e);
    expect(isOrcaError(error, "STORE_WRITE")).toBe(true);
    expect((error as { details?: unknown }).details).toEqual({ file, outcome: "uncertain" });
    expect(onDisk(file)).toEqual([{ id: "x", n: 0 }]);
    expect(await s.get("x")).toEqual({ id: "x", n: 0 });
  });

  it("a rename that lands and then errors is uncertain too, and a re-read shows what landed", async () => {
    const { store: s, file } = await store();
    faults.push({ op: "rename", when: isTmp, after: true });
    const error = await s.putIfVersion({ id: "x", n: 1 }, v0).catch((e: unknown) => e);
    expect((error as { details?: unknown }).details).toEqual({ file, outcome: "uncertain" });
    // Re-reading before retrying is what makes the retry safe: the CAS did land.
    expect(await s.getVersioned("x")).toEqual({ doc: { id: "x", n: 1 }, version: documentVersion({ id: "x", n: 1 }) });
    expect((await s.putIfVersion({ id: "x", n: 1 }, v0)).ok).toBe(false);
  });

  it("a fingerprint refresh failing after the rename keeps the committed result", async () => {
    const { store: s, file } = await store();
    // Only the stat taken once the new content is in place fails.
    faults.push({ op: "stat", when: (path) => path === file && onDiskHasN(file, 1) });
    const result = await s.putIfVersion({ id: "x", n: 1 }, v0);
    expect(result).toEqual({ ok: true, version: documentVersion({ id: "x", n: 1 }) });
    expect(faults.some((f) => f.op === "stat")).toBe(false);
    expect(onDisk(file)).toEqual([{ id: "x", n: 1 }]);
    expect(await s.get("x")).toEqual({ id: "x", n: 1 });
  });

  it("a lock release failing after the rename keeps the committed result", async () => {
    const { store: s, file } = await store();
    faults.push({ op: "unlink", when: isLockToken });
    const result = await s.putIfVersion({ id: "x", n: 1 }, v0);
    expect(result).toEqual({ ok: true, version: documentVersion({ id: "x", n: 1 }) });
    expect(faults).toHaveLength(0);
    expect(onDisk(file)).toEqual([{ id: "x", n: 1 }]);
    // The lock this process could not release is left for the operator, as any stale lock is.
    await rm(`${file}.lock`, { recursive: true, force: true });
    expect(await s.get("x")).toEqual({ id: "x", n: 1 });
  });
});

function onDiskHasN(file: string, n: number): boolean {
  try {
    return onDisk(file).some((d) => d.n === n);
  } catch {
    return false;
  }
}
