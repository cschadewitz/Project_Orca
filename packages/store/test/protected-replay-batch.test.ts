/** Replay authority is local to one call and checked again before any plaintext leaves it. */
import { chmod, cp, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileExecutionStore, InMemoryEventStore, executionEvents } from "@orca/store";
import { writePrivateJson } from "../src/protected-file.js";

const io = vi.hoisted(() => ({
  opens: [] as string[],
  frozenTimes: new Map<string, { mtimeNs: bigint; ctimeNs: bigint }>(),
  denied: new Set<string>(),
  beforeStat: undefined as ((path: string) => Promise<void>) | undefined,
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      await io.beforeStat?.(path);
      const info = await actual.lstat(...args);
      const times = io.frozenTimes.get(path);
      if (times) Object.assign(info, times);
      return info;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      io.opens.push(path);
      await io.beforeOpen?.(path);
      if (io.denied.has(path)) throw Object.assign(new Error("test unreadable"), { code: "EACCES" });
      const handle = await actual.open(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
        const info = await originalStat(...statArgs);
        const times = io.frozenTimes.get(path);
        if (times) Object.assign(info, times);
        return info;
      }) as typeof handle.stat;
      const originalRead = handle.readFile.bind(handle);
      handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
        const bytes = await originalRead(...readArgs);
        await io.afterRead?.(path);
        return bytes;
      }) as typeof handle.readFile;
      return handle;
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  io.beforeStat = io.beforeOpen = io.afterRead = undefined;
  io.frozenTimes.clear();
  io.denied.clear();
  io.opens = [];
  vi.restoreAllMocks();
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

function barrier() {
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    pause: async () => {
      reached();
      await released;
    },
  };
}

async function fixture(count = 2, overlay = false) {
  const directory = await mkdtemp(join(tmpdir(), "orca-replay-batch-"));
  dirs.push(directory);
  const store = new FileExecutionStore(directory);
  const privateDir = join(directory, "private-execution");
  const path = (name: string) => join(privateDir, name);
  await store.putInputs({
    runId: "run",
    workflowId: "workflow",
    workflowVersion: "1",
    vars: { secret: "replay-secret" },
    sensitiveNames: ["secret"],
    secrets: ["replay-secret"],
  });
  if (overlay) await store.addSensitivity("run", { sensitiveNames: ["late"], secrets: ["late-secret"] });
  const references = Array.from({ length: count }, (_, index) => ({
    runId: "run",
    ref: `event-${index}`,
    type: "vars.set",
  }));
  for (const { ref } of references)
    await store.putPayload(ref, {
      type: "vars.set",
      runId: "run",
      payload: { vars: { ref, secret: "replay-secret" } },
    });
  const read = () => store.getPayloads(references);
  const expected = references.map(({ ref }) => ({ vars: { ref, secret: "replay-secret" } }));
  return { directory, privateDir, store, path, references, read, expected };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function freezeKeyTimes(f: Fixture) {
  const key = f.path(".execution-key");
  const info = await stat(key, { bigint: true });
  io.frozenTimes.set(key, { mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });
}

async function overwriteKey(f: Fixture) {
  const key = f.path(".execution-key");
  const bytes = await readFile(key);
  bytes[0] = bytes[0]! ^ 1;
  await writeFile(key, bytes);
}

function pauseBeforeTerminal(f: Fixture) {
  const gate = barrier();
  const getInputs = f.store.getInputs.bind(f.store);
  vi.spyOn(f.store, "getInputs").mockImplementationOnce(async (runId) => {
    const result = await getInputs(runId);
    await gate.pause();
    return result;
  });
  return gate;
}

it("reads a fresh entry/terminal key per multi-record call, authenticates every record and isolates results", async () => {
  const f = await fixture(12);
  await f.read();
  io.opens = [];
  const result = await f.read();
  expect(result).toEqual(f.expected);
  // Entry + one fresh input read + terminal, rather than one key read per payload.
  expect(io.opens.filter((path) => path.endsWith(".execution-key"))).toEqual(
    Array<string>(3).fill(f.path(".execution-key")),
  );
  // Every ciphertext record is read from disk again; nothing is reused across calls.
  expect(io.opens.filter((path) => path.endsWith(".payload.json"))).toHaveLength(12);
  (result[0] as { vars: { secret: string } }).vars.secret = "caller mutation";
  expect(await f.read()).toEqual(f.expected);
  expect(io.opens.filter((path) => path.endsWith(".execution-key"))).toHaveLength(6);
});

it("keeps empty, single-record and unprotected legacy histories on their existing paths", async () => {
  const f = await fixture();
  io.opens = [];
  expect(await f.store.getPayloads([])).toEqual([]);
  expect(io.opens).toEqual([]);
  expect(await f.store.getPayload("run", "event-0", "vars.set")).toEqual(f.expected[0]);
  expect(io.opens.filter((path) => path.endsWith(".execution-key"))).toHaveLength(2);
  const events = new InMemoryEventStore();
  await events.append({ type: "run.started", runId: "legacy", payload: {} });
  const history = await events.read("legacy");
  io.opens = [];
  await rm(f.path(".execution-key"));
  expect(await executionEvents(history, f.store)).toEqual(history);
  expect(await f.store.getPayloads([])).toEqual([]);
  expect(io.opens).toEqual([]);
});

it("fresh-reads key bytes on a second batch even with identical inode, size and nanosecond timestamps", async () => {
  const f = await fixture();
  await freezeKeyTimes(f);
  expect(await f.read()).toEqual(f.expected);
  await overwriteKey(f);
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(new FileExecutionStore(f.directory).getPayloads(f.references)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  await expect(f.store.putGeneration("later", {})).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("rejects a key changed while payload reads are paused without exposing partial plaintext", async () => {
  const f = await fixture();
  await freezeKeyTimes(f);
  const gate = barrier();
  io.beforeStat = async (path) => {
    if (path === f.path("event-0.payload.json")) {
      io.beforeStat = undefined;
      await gate.pause();
    }
  };
  const observed = vi.fn();
  const pending = f.read().then((result) => {
    observed(result);
    return result;
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "RUN_STATE" });
  await gate.entered;
  await overwriteKey(f);
  expect(observed).not.toHaveBeenCalled();
  gate.release();
  await rejected;
  expect(observed).not.toHaveBeenCalled();
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(
    f.store.putPayload("later", { type: "vars.set", runId: "run", payload: { vars: {} } }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
});

const mutations = [
  "same-tick bytes",
  "deleted",
  "unreadable",
  "unsafe key mode",
  "key symlink",
  "key inode",
  "directory mode",
  "directory symlink",
  "directory inode",
] as const;
it.each(mutations)("rejects %s after all payload/input reads, before any plaintext resolves", async (kind) => {
  if (
    process.platform === "win32" &&
    ["unsafe key mode", "key symlink", "directory mode", "directory symlink"].includes(kind)
  )
    return;
  const f = await fixture();
  await freezeKeyTimes(f);
  const gate = pauseBeforeTerminal(f);
  const observed = vi.fn();
  const pending = f.read().then((result) => {
    observed(result);
    return result;
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "RUN_STATE" });
  await gate.entered;
  const key = f.path(".execution-key");
  if (kind === "same-tick bytes") await overwriteKey(f);
  if (kind === "deleted") await rm(key);
  if (kind === "unreadable") io.denied.add(key);
  if (kind === "unsafe key mode") await chmod(key, 0o644);
  if (kind === "key symlink") {
    const saved = join(f.directory, "saved-key");
    await rename(key, saved);
    await symlink(saved, key);
  }
  if (kind === "key inode") {
    const saved = join(f.directory, "replacement-key");
    await writeFile(saved, await readFile(key), { mode: 0o600 });
    await rename(saved, key);
  }
  if (kind === "directory mode") await chmod(f.privateDir, 0o755);
  if (kind === "directory symlink" || kind === "directory inode") {
    const saved = join(f.directory, "saved-directory");
    await rename(f.privateDir, saved);
    if (kind === "directory symlink") await symlink(saved, f.privateDir);
    else await cp(saved, f.privateDir, { recursive: true });
  }
  expect(observed).not.toHaveBeenCalled();
  gate.release();
  await rejected;
  expect(observed).not.toHaveBeenCalled();
  if (kind !== "key inode" && kind !== "directory inode") {
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(f.store.putGeneration("later", {})).rejects.toMatchObject({ code: "RUN_STATE" });
  } else {
    // Replacement with intact material is valid for a NEW call, never the interrupted one.
    io.frozenTimes.clear();
    expect(await f.read()).toEqual(f.expected);
  }
});

it("rechecks the key path/open identity even if replacement bytes are unchanged", async () => {
  const f = await fixture();
  const key = f.path(".execution-key");
  io.beforeOpen = async (path) => {
    if (path !== key) return;
    io.beforeOpen = undefined;
    const replacement = join(f.directory, "replacement");
    await writeFile(replacement, await readFile(key), { mode: 0o600 });
    await rename(replacement, key);
  };
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("rejects a terminal key replacement after reading its bytes but before checking the open handle/path", async () => {
  const f = await fixture();
  const key = f.path(".execution-key");
  let reads = 0;
  io.afterRead = async (path) => {
    if (path !== key || ++reads !== 3) return;
    io.afterRead = undefined;
    const replacement = join(f.directory, "replacement");
    await writeFile(replacement, await readFile(key), { mode: 0o600 });
    await rename(replacement, key);
  };
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(reads).toBe(3);
});

it("documents entry/terminal semantics for a same-tick transient A -> B -> A key rewrite", async () => {
  const f = await fixture();
  await freezeKeyTimes(f);
  const original = await readFile(f.path(".execution-key"));
  const gate = pauseBeforeTerminal(f);
  const pending = f.read();
  await gate.entered;
  await overwriteKey(f);
  await writeFile(f.path(".execution-key"), original);
  gate.release();
  // The same key material and identity are observed at both boundaries. No claim of
  // detecting every unobserved transient edit is made by this reader or per-record reads.
  expect(await pending).toEqual(f.expected);
});

it.each(["inputs", "sensitivity"] as const)(
  "freshly validates %s removed after the last payload read",
  async (kind) => {
    const f = await fixture(2, true);
    await f.read();
    const getInputs = f.store.getInputs.bind(f.store);
    vi.spyOn(f.store, "getInputs").mockImplementationOnce(async (runId) => {
      const name =
        kind === "inputs"
          ? "run.inputs.json"
          : (await readdir(f.privateDir)).find((name) => name.includes(".sensitivity."))!;
      await rm(f.path(name));
      return getInputs(runId);
    });
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  },
);

it.each(["ciphertext", "filename", "malformed", "schema", "run", "type", "missing overlay"] as const)(
  "authenticates and validates every payload: %s",
  async (kind) => {
    const f = await fixture();
    await f.read();
    const file = f.path("event-1.payload.json");
    if (kind === "ciphertext") {
      const envelope = JSON.parse(await readFile(file, "utf8")) as { ciphertext: string };
      const bytes = Buffer.from(envelope.ciphertext, "base64");
      bytes[0] = bytes[0]! ^ 1;
      envelope.ciphertext = bytes.toString("base64");
      await writeFile(file, JSON.stringify(envelope));
    } else if (kind === "filename") await writeFile(file, await readFile(f.path("event-0.payload.json")));
    else if (kind === "malformed") await writeFile(file, "malformed replay-secret");
    else {
      await rm(file);
      await writePrivateJson(f.privateDir, "event-1.payload.json", {
        runId: kind === "run" ? "wrong" : "run",
        type: kind === "type" ? "run.started" : "vars.set",
        payload: kind === "schema" ? [] : { vars: {} },
        sensitivityRefs: kind === "missing overlay" ? ["absent"] : [],
      });
    }
    const observed = vi.fn();
    const error: unknown = await f
      .read()
      .then(observed)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "RUN_STATE" });
    expect(String(error)).not.toContain("replay-secret");
    expect(observed).not.toHaveBeenCalled();
  },
);

it("keeps concurrent batches independent and does not inherit another call's successful validation", async () => {
  const f = await fixture();
  const independent = new FileExecutionStore(f.directory);
  const gate = pauseBeforeTerminal(f);
  const pending = f.read();
  const rejected = expect(pending).rejects.toMatchObject({ code: "RUN_STATE" });
  await gate.entered;
  expect(await independent.getPayloads(f.references)).toEqual(f.expected);
  await overwriteKey(f);
  gate.release();
  await rejected;
  await expect(independent.getPayloads(f.references)).rejects.toMatchObject({ code: "RUN_STATE" });
  const other = await fixture();
  expect(await other.read()).toEqual(other.expected);
});

it("does not let caller reference mutation alter a replay already in progress", async () => {
  const f = await fixture();
  const gate = barrier();
  io.beforeOpen = async (path) => {
    if (path !== f.path(".execution-key")) return;
    io.beforeOpen = undefined;
    await gate.pause();
  };
  const pending = f.read();
  await gate.entered;
  f.references[0]!.runId = "different";
  gate.release();
  expect(await pending).toEqual(f.expected);
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
});
