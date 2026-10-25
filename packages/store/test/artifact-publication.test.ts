/** Immutable blob publication: repeat writes cannot expose partial bytes or destroy shared content. */
import { execFile } from "node:child_process";
import { link, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendJsonl, sha256, type Artifact } from "@orca/core";
import { childBundle } from "@orca/testing/child-bundle";
import { FileArtifactStore } from "../src/artifact-store.js";
import { JsonlLogDir } from "../src/jsonl-log.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link), writeFile: vi.fn(actual.writeFile) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const dirs: string[] = [];
beforeEach(() => {
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(link).mockReset().mockImplementation(actual.link);
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const body = Buffer.from("A shared résumé — complete bytes\n");
function artifact(id: string, bytes = body): Artifact {
  return {
    id,
    kind: "report",
    name: id,
    version: 1,
    mediaType: "text/markdown",
    contentHash: sha256(bytes),
    size: bytes.length,
    data: {},
    parents: [],
    producedBy: { runId: "run_test" },
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-artifact-publication-"));
  dirs.push(dir);
  const blobs = join(dir, "artifacts", "blobs");
  const file = join(blobs, sha256(body));
  const store = new FileArtifactStore(dir);
  return { dir, blobs, file, store };
}
async function snapshot(file: string) {
  const { dev, ino, size, mode, mtimeMs } = await stat(file);
  return { bytes: await readFile(file), dev, ino, size, mode, mtimeMs };
}

it("a reader sees complete shared bytes during repeat publication, without rewriting the blob", async () => {
  const { dir, file, store } = await fixture();
  await store.put(artifact("first"), body);
  const before = await snapshot(file);
  const reader = new FileArtifactStore(dir);
  const observed: Uint8Array[] = [];
  // Deterministically expose the old O_TRUNC window, without a timer or a large-file race.
  vi.mocked(writeFile).mockImplementation(async (path, bytes, options) => {
    if (path === file) {
      await actual.writeFile(path, "");
      observed.push(await reader.bytes("first"));
    }
    return actual.writeFile(path, bytes, options);
  });
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (path === file) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        observed.push(await reader.bytes("first"));
        await sync();
      });
    }
    return handle;
  });
  await store.put(artifact("repeat"), body);
  expect(observed).toEqual([body]);
  expect(await snapshot(file)).toEqual(before);
});

it("an injected interruption of a destructive repeat write cannot damage an earlier artifact", async () => {
  const { file, store } = await fixture();
  await store.put(artifact("first"), body);
  const before = await snapshot(file);
  vi.mocked(writeFile).mockImplementation(async (path, bytes, options) => {
    if (path === file) {
      await actual.writeFile(path, "");
      throw new Error("interrupted after truncate");
    }
    return actual.writeFile(path, bytes, options);
  });
  await store.put(artifact("repeat"), body);
  expect(await store.bytes("first")).toEqual(body);
  expect(await snapshot(file)).toEqual(before);
});

it.each([Buffer.alloc(0), Buffer.concat([Buffer.from("B"), body.subarray(1)])])(
  "rejects corrupted reads and reuse without repairing or indexing the damaged blob (%j)",
  async (damaged) => {
    const { file, store } = await fixture();
    await store.put(artifact("first"), body);
    await actual.writeFile(file, damaged);
    await expect(store.bytes("first")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await expect(store.content("first")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    await expect(store.put(artifact("repeat"), body)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(await store.get("repeat")).toBeUndefined();
    expect(await readFile(file)).toEqual(damaged);
  },
);

it("rejects an input/hash mismatch before touching shared blobs or metadata", async () => {
  const { file, store } = await fixture();
  await store.put(artifact("first"), body);
  const before = await snapshot(file);
  await expect(store.put(artifact("wrong"), "wrong body")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(await store.get("wrong")).toBeUndefined();
  expect(await snapshot(file)).toEqual(before);
});

it("concurrent identical first publications choose one immutable winner and retain every index row", async () => {
  const { dir, blobs, file } = await fixture();
  const count = 12;
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let winners = 0;
  vi.mocked(link).mockImplementation(async (source, destination) => {
    if (destination === file) {
      if (++arrivals === count) release();
      await ready;
    }
    await actual.link(source, destination);
    winners++;
  });
  await Promise.all(
    Array.from({ length: count }, (_, i) => new FileArtifactStore(dir).put(artifact(`concurrent-${i}`), body)),
  );
  expect(arrivals).toBe(count);
  expect(winners).toBe(1);
  expect(await readdir(blobs)).toEqual([sha256(body)]);
  const reopened = new FileArtifactStore(dir);
  expect(await reopened.list()).toHaveLength(count);
  for (let i = 0; i < count; i++) expect(await reopened.bytes(`concurrent-${i}`)).toEqual(body);
});

it.each([false, true])(
  "two real publishers retain shared bytes and every index row (existing blob: %s)",
  async (seed) => {
    const { dir, file, blobs, store } = await fixture();
    if (seed) await store.put(artifact("first"), body);
    const before = seed ? await snapshot(file) : undefined;
    const script = fileURLToPath(new URL("./fixtures/artifact-publisher.ts", import.meta.url));
    const bundle = childBundle("artifact-publisher", { entries: { writer: script } })?.writer;
    const run = promisify(execFile);
    const child = (prefix: string) =>
      run(
        process.execPath,
        [...(bundle ? [bundle] : ["--import", "tsx", script]), dir, prefix, body.toString("base64")],
        { timeout: 20_000 },
      );
    await Promise.all([child("a"), child("b")]);
    expect(await store.list()).toHaveLength(seed ? 21 : 20);
    for (const record of await store.list()) expect(await store.bytes(record.id)).toEqual(body);
    expect(await readdir(blobs)).toEqual([sha256(body)]);
    if (seed) expect(await snapshot(file)).toEqual(before);
  },
);

it.each(["write", "file-sync", "link", "after-link", ...(process.platform === "win32" ? [] : ["directory-sync"])])(
  "a %s failure leaves no new metadata and preserves previous good blobs; retry is safe",
  async (phase) => {
    const { dir, blobs, file, store } = await fixture();
    await store.put(artifact("first"), body);
    const before = await snapshot(file);
    const nextBody = Buffer.from("A different artifact\n");
    const next = artifact("next", nextBody);
    const nextFile = join(blobs, next.contentHash);
    const failure = new Error(`injected ${phase} failure`);
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      handles.push(handle);
      if (String(path).endsWith(".tmp")) {
        if (phase === "write")
          vi.spyOn(handle, "writeFile").mockImplementation(async () => {
            await handle.write(nextBody.subarray(0, 4));
            throw failure;
          });
        if (phase === "file-sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
      }
      if (path === blobs && phase === "directory-sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
      return handle;
    });
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (phase === "link") throw failure;
      await actual.link(source, destination);
      if (phase === "after-link") throw failure;
    });
    await expect(store.put(next, nextBody)).rejects.toBe(failure);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    expect(await store.get("next")).toBeUndefined();
    expect(await new FileArtifactStore(dir).bytes("first")).toEqual(body);
    expect(await snapshot(file)).toEqual(before);
    expect((await readdir(blobs)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (["after-link", "directory-sync"].includes(phase)) expect(await readFile(nextFile)).toEqual(nextBody);
    else await expect(stat(nextFile)).rejects.toMatchObject({ code: "ENOENT" });
    vi.mocked(open).mockImplementation(actual.open);
    vi.mocked(link).mockImplementation(actual.link);
    await store.put(next, nextBody);
    expect(await store.bytes("next")).toEqual(nextBody);
    expect(await snapshot(file)).toEqual(before);
  },
);

it("verifies an EEXIST winner instead of indexing corrupt bytes", async () => {
  const { file, store } = await fixture();
  const damaged = Buffer.from("bad winner");
  vi.mocked(link).mockImplementation(async (source, destination) => {
    await actual.writeFile(destination, damaged);
    await actual.link(source, destination);
  });
  await expect(store.put(artifact("first"), body)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(await store.get("first")).toBeUndefined();
  expect(await readFile(file)).toEqual(damaged);
});

it("refuses existing-file sync failure without changing shared bytes or adding metadata", async () => {
  const { file, store } = await fixture();
  await store.put(artifact("first"), body);
  const before = await snapshot(file);
  const failure = new Error("existing blob sync failed");
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (path === file) vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
    return handle;
  });
  await expect(store.put(artifact("repeat"), body)).rejects.toBe(failure);
  expect(await store.get("repeat")).toBeUndefined();
  expect(await snapshot(file)).toEqual(before);
});

it("index failure leaves a reusable complete blob and retry never rewrites it", async () => {
  const { file, store } = await fixture();
  const failure = new Error("index append failed");
  const append = vi.spyOn(JsonlLogDir.prototype, "append").mockRejectedValueOnce(failure);
  await expect(store.put(artifact("first"), body)).rejects.toBe(failure);
  expect(await store.get("first")).toBeUndefined();
  const before = await snapshot(file);
  append.mockRestore();
  await store.put(artifact("first"), body);
  expect(await store.bytes("first")).toEqual(body);
  expect(await snapshot(file)).toEqual(before);
});

it("copies caller-owned metadata and bytes before the first asynchronous boundary", async () => {
  const { store } = await fixture();
  const input = Buffer.from(body);
  const record = artifact("first");
  const putting = store.put(record, input);
  input.fill(0);
  record.contentHash = sha256("other");
  record.id = "mutated";
  await putting;
  expect(await store.bytes("first")).toEqual(body);
  expect(await store.get("mutated")).toBeUndefined();
});

it("reports a missing indexed blob explicitly without substituting empty content", async () => {
  const { file, store } = await fixture();
  await store.put(artifact("first"), body);
  await rm(file);
  for (const read of [() => store.bytes("first"), () => store.content("first")])
    await expect(read()).rejects.toMatchObject({
      code: "ARTIFACT_MISSING",
      details: { id: "first", contentHash: sha256(body) },
    });
});

it("syncs staged bytes before linking and all POSIX ancestors before indexing", async () => {
  const { blobs, file, store } = await fixture();
  const events: string[] = [];
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      await sync();
      events.push(String(path).endsWith(".tmp") ? "bytes" : String(path));
    });
    return handle;
  });
  vi.mocked(link).mockImplementation(async (source, destination) => {
    expect(events).toEqual(["bytes"]);
    await actual.link(source, destination);
    events.push("link");
    // Readers cannot resolve the new artifact before its metadata is appended.
    expect(await new FileArtifactStore(join(blobs, "..", "..")).get("first")).toBeUndefined();
    expect(await readFile(file)).toEqual(body);
  });
  vi.spyOn(JsonlLogDir.prototype, "append").mockImplementation(async (_key, build) => {
    const expected = ["bytes", "link"];
    if (process.platform !== "win32") {
      for (let path = resolve(blobs); ; path = dirname(path)) {
        expected.push(path);
        if (dirname(path) === path) break;
      }
    }
    expect(events).toEqual(expected);
    return build(0);
  });
  await store.put(artifact("first"), body);
});

it("refuses malformed hashes in existing index records before reading a path", async () => {
  const { dir, store } = await fixture();
  await store.put(artifact("first"), body);
  await appendJsonl(join(dir, "artifacts", "index.jsonl"), {
    ...artifact("unsafe"),
    contentHash: "../../outside",
  });
  await expect(store.content("unsafe")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(await store.bytes("first")).toEqual(body);
});

it("simulates Windows reuse with a non-truncating writable sync handle and no directory fsync", async () => {
  const { blobs, file, store } = await fixture();
  await store.put(artifact("first"), body);
  const before = await snapshot(file);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.mocked(open).mockClear();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    await store.put(artifact("repeat"), body);
    expect(open).toHaveBeenCalledWith(file, "r+");
    expect(vi.mocked(open).mock.calls.some(([path]) => path === blobs)).toBe(false);
    expect(await store.bytes("repeat")).toEqual(body);
    expect(await snapshot(file)).toEqual(before);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
