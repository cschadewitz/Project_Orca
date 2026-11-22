/**
 * Commit boundaries of compare-and-swap in the file-backed document store (#338): a
 * conditional write's outcome must describe state the file actually committed, even when it is
 * queued between unconditional writes on the same handle, and a failed write must reject every
 * mutation it carried without resurrecting any of them later.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { documentVersion, JsonFileDocumentStore, withFileLock, type ConditionalWriteResult } from "@orca/store";

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function store(): Promise<{ store: JsonFileDocumentStore<Doc>; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-cas-"));
  dirs.push(dir);
  const file = join(dir, "docs.json");
  return { store: new JsonFileDocumentStore<Doc>(file, DocSchema), file };
}

/** The version of `id` in the file right now, read synchronously so no later write can land first. */
function committedVersion(file: string, id: string): string | undefined {
  const doc = (JSON.parse(readFileSync(file, "utf8")) as Doc[]).find((d) => d.id === id);
  return doc && documentVersion(DocSchema.parse(doc));
}

const v = (doc: Doc) => documentVersion(doc);

describe("file document store: conditional commit boundaries", () => {
  it("a successful CAS reports the version its own write committed, not one a later queued put replaced", async () => {
    const { store: s, file } = await store();
    await s.put({ id: "x", n: 0 });
    let atResolution: string | undefined;
    const first = s.put({ id: "x", n: 1 });
    const cas = s.putIfVersion({ id: "x", n: 2 }, v({ id: "x", n: 1 })).then((r) => {
      atResolution = committedVersion(file, "x");
      return r;
    });
    const last = s.put({ id: "x", n: 3 });
    const [, result] = await Promise.all([first, cas, last]);
    expect(result).toEqual({ ok: true, version: v({ id: "x", n: 2 }) });
    expect(atResolution).toBe(v({ id: "x", n: 2 }));
    expect(await s.get("x")).toEqual({ id: "x", n: 3 });
  });

  it("a conflict reports the committed current document, not an intermediate one", async () => {
    const { store: s, file } = await store();
    await s.put({ id: "x", n: 0 });
    let atResolution: string | undefined;
    const first = s.put({ id: "x", n: 1 });
    const cas = s.putIfVersion({ id: "x", n: 5 }, v({ id: "x", n: 0 })).then((r) => {
      atResolution = committedVersion(file, "x");
      return r;
    });
    const last = s.put({ id: "x", n: 3 });
    const [, result] = await Promise.all([first, cas, last]);
    expect(result.ok).toBe(false);
    expect((result as Extract<ConditionalWriteResult<Doc>, { ok: false }>).current).toEqual({
      doc: { id: "x", n: 1 },
      version: atResolution,
    });
    expect(await s.get("x")).toEqual({ id: "x", n: 3 });
  });

  it("a conditional delete between queued puts commits at its own boundary", async () => {
    const { store: s, file } = await store();
    await s.put({ id: "x", n: 0 });
    let presentAtResolution: boolean | undefined;
    const del = s.deleteIfVersion("x", v({ id: "x", n: 0 })).then((r) => {
      presentAtResolution = committedVersion(file, "x") !== undefined;
      return r;
    });
    const after = s.put({ id: "x", n: 7 });
    expect(await del).toEqual({ ok: true, version: undefined });
    await after;
    expect(presentAtResolution).toBe(false);
    expect(await s.get("x")).toEqual({ id: "x", n: 7 });
  });

  it("getVersioned reads committed state while get still shows this process's queued write", async () => {
    const { store: s, file } = await store();
    await s.put({ id: "x", n: 0 });
    let queued: Promise<void> | undefined;
    await withFileLock(`${file}.lock`, async () => {
      queued = s.put({ id: "x", n: 9 });
      // Let the write reach the lock it is now blocked on.
      await new Promise((r) => setTimeout(r, 20));
      expect(await s.get("x")).toEqual({ id: "x", n: 9 });
      expect(await s.getVersioned("x")).toEqual({ doc: { id: "x", n: 0 }, version: v({ id: "x", n: 0 }) });
    });
    await queued;
    expect(await s.getVersioned("x")).toEqual({ doc: { id: "x", n: 9 }, version: v({ id: "x", n: 9 }) });
  });

  it("a failed write rejects every queued put, CAS and delete it carried, and none of them comes back", async () => {
    const { store: s, file } = await store();
    await s.put({ id: "keep", n: 0 });
    const keepVersion = v({ id: "keep", n: 0 });
    // The collection path becomes a non-empty directory: every read and rename of it fails.
    await rm(file);
    await mkdir(join(file, "blocker"), { recursive: true });
    const outcomes = await Promise.allSettled([
      s.put({ id: "a", n: 1 }),
      s.putIfVersion({ id: "keep", n: 1 }, keepVersion),
      s.delete("keep"),
      s.deleteIfVersion("keep", keepVersion),
      s.putMany([
        { id: "b", n: 1 },
        { id: "c", n: 1 },
      ]),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected"]);
    await rm(file, { recursive: true });
    await s.put({ id: "fresh", n: 1 });
    expect(await s.list()).toEqual([{ id: "fresh", n: 1 }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ id: "fresh", n: 1 }]);
  });
});
