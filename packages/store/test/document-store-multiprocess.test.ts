/** Two writers over one collection file: the interleavings that used to lose a document (#196). */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonFileDocumentStore } from "@orca/store";
import { childBundle } from "@orca/testing/child-bundle";

const run = promisify(execFile);

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const makeFile = async () => {
  const d = await mkdtemp(join(tmpdir(), "orca-docs-mp-"));
  dirs.push(d);
  return join(d, "docs.json");
};

const open = (file: string) => new JsonFileDocumentStore<Doc>(file, DocSchema);
const onDisk = async (file: string) => (JSON.parse(await readFile(file, "utf8")) as Doc[]).map((d) => d.id).sort();
const ids = async (store: JsonFileDocumentStore<Doc>) => (await store.list()).map((d) => d.id).sort();

describe("JsonFileDocumentStore across processes", () => {
  it("keeps both documents when two instances load, then each puts", async () => {
    const file = await makeFile();
    const a = open(file);
    const b = open(file);
    // Both instances read the (empty) collection before either writes: the interleaving
    // that used to leave whichever wrote second holding a 'collection' of one document.
    expect(await a.list()).toEqual([]);
    expect(await b.list()).toEqual([]);

    await a.put({ id: "a", n: 1 });
    await b.put({ id: "b", n: 2 });

    expect(await onDisk(file)).toEqual(["a", "b"]);
    expect(await ids(open(file))).toEqual(["a", "b"]);
  });

  it("loses nothing across putMany from both sides, and the last writer wins on one id", async () => {
    const file = await makeFile();
    const a = open(file);
    const b = open(file);
    await a.putMany([
      { id: "a1", n: 1 },
      { id: "shared", n: 1 },
    ]);
    await b.putMany([
      { id: "b1", n: 2 },
      { id: "b2", n: 2 },
    ]);
    await a.putMany([{ id: "a2", n: 3 }]);
    await b.put({ id: "shared", n: 99 });

    expect(await onDisk(file)).toEqual(["a1", "a2", "b1", "b2", "shared"]);
    const third = open(file);
    expect(await third.get("shared")).toEqual({ id: "shared", n: 99 });
    expect(await a.get("shared")).toEqual({ id: "shared", n: 99 });
  });

  it("sees another instance's document on a read, without being reconstructed", async () => {
    const file = await makeFile();
    const a = open(file);
    const b = open(file);
    await b.put({ id: "b", n: 0 });
    expect(await b.get("a")).toBeUndefined();

    await a.put({ id: "a", n: 1 });

    expect(await b.get("a")).toEqual({ id: "a", n: 1 });
    expect(await ids(b)).toEqual(["a", "b"]);

    await a.delete("a");
    expect(await b.get("a")).toBeUndefined();
  });

  it("keeps every document two real child processes write", async () => {
    const file = await makeFile();
    const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "document-store-writer.ts");
    // Both writers are still real processes racing on one file. Under the test runner they start
    // from the run's prebuilt bundle with plain node, not from sources transpiled through tsx.
    const bundle = childBundle("document-store-writer", { entries: { writer: script } })?.writer;
    const child = (prefix: string) =>
      run(process.execPath, bundle ? [bundle, file, prefix, "15"] : ["--import", "tsx", script, file, prefix, "15"]);
    await Promise.all([child("a"), child("b")]);

    const written = await onDisk(file);
    expect(written.length).toBe(30);
    expect(written).toEqual(
      [...Array.from({ length: 15 }, (_, i) => `a${i}`), ...Array.from({ length: 15 }, (_, i) => `b${i}`)].sort(),
    );
  });

  it("ignores a tmp file a crashed writer left behind", async () => {
    const file = await makeFile();
    const a = open(file);
    await a.put({ id: "a", n: 1 });
    await writeFile(`${file}.4242.tmp`, JSON.stringify([{ id: "ghost", n: 0 }]), "utf8");

    expect(await ids(open(file))).toEqual(["a"]);
    await open(file).put({ id: "b", n: 2 });
    expect(await onDisk(file)).toEqual(["a", "b"]);
    expect(await ids(a)).toEqual(["a", "b"]);
  });
});
