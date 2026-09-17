/** Verifies the write-coalescing of JsonFileDocumentStore by counting real file rewrites. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let renames = 0;
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      renames++;
      return real.rename(...args);
    },
  };
});

const { JsonFileDocumentStore } = await import("@orca/store");

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const makeStore = async () => {
  const d = await mkdtemp(join(tmpdir(), "orca-batch-"));
  dirs.push(d);
  renames = 0;
  return new JsonFileDocumentStore<Doc>(join(d, "docs.json"), DocSchema);
};

describe("JsonFileDocumentStore write batching", () => {
  it("writes the file once for a putMany", async () => {
    const store = await makeStore();
    await store.putMany(Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, n: i })));
    expect(renames).toBe(1);
    expect((await store.list()).length).toBe(50);
  });

  it("coalesces concurrent puts into at most two writes", async () => {
    const store = await makeStore();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.put({ id: `d${i}`, n: i })));
    expect(renames).toBeLessThanOrEqual(2);
    expect((await store.list()).length).toBe(50);
  });

  it("still writes once per sequential put", async () => {
    const store = await makeStore();
    await store.put({ id: "a", n: 1 });
    await store.put({ id: "b", n: 2 });
    expect(renames).toBe(2);
  });
});
