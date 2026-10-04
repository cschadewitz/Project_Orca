/** Request-local protected reads retain opaque fingerprints and verify without rehydration. */
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileExecutionStore, InMemoryExecutionStore, type ExecutionInputs, type ExecutionStore } from "@orca/store";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createDecipheriv: vi.fn(actual.createDecipheriv) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const SECRET = "observation-private-synthetic-value";
const dirs: string[] = [];
const inputs = (runId = "run"): ExecutionInputs => ({
  runId,
  workflowId: "workflow",
  workflowVersion: "1",
  vars: { secret: SECRET },
  sensitiveNames: ["secret"],
  secrets: [SECRET],
});
const references = ["first", "second"].map((ref) => ({ runId: "run", ref, type: "vars.set" }));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-private-observation-"));
  dirs.push(root);
  const store = new FileExecutionStore(root);
  await store.putInputs(inputs());
  await store.putGeneration("generation", { secret: SECRET });
  for (const { ref } of references)
    await store.putPayload(ref, { runId: "run", type: "vars.set", payload: { vars: { ref, secret: SECRET } } });
  return { root, store, dir: join(root, "private-execution") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  vi.mocked(lstat).mockReset();
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(fs.open);
  vi.mocked(lstat).mockImplementation(fs.lstat);
  vi.mocked(createDecipheriv).mockClear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function observeAll(store: FileExecutionStore) {
  return store.observe(
    async () => {
      await store.getGeneration("generation");
      return store.getPayloads(references);
    },
    { maxRecords: 100 },
  );
}

for (const backend of ["memory", "file"] as const) {
  describe(`${backend} observation`, () => {
    const makeStore = async (): Promise<ExecutionStore> =>
      backend === "memory" ? new InMemoryExecutionStore() : (await fixture()).store;
    it("returns isolated values and an opaque verifier with no captured secrets", async () => {
      const store = await makeStore();
      if (backend === "memory") await store.putInputs(inputs());
      const observation = await store.observe!(
        async () => {
          const value = await store.getInputs("run");
          value!.vars.secret = "caller changed its copy";
          return "public-result";
        },
        { maxRecords: 100 },
      );
      expect(Object.keys(observation)).toEqual(["value", "verifyUnchanged"]);
      expect(Object.getOwnPropertySymbols(observation)).toEqual([]);
      expect(JSON.stringify(observation)).toBe('{"value":"public-result"}');
      expect(observation.verifyUnchanged.toString()).not.toContain(SECRET);
      await expect(observation.verifyUnchanged()).resolves.toBeUndefined();
      expect((await store.getInputs("run"))?.vars.secret).toBe(SECRET);
    });
    it("observes a missing record and missing input/overlay membership", async () => {
      const store = await makeStore();
      const observed = await store.observe!(
        async () => {
          expect(await store.getGeneration("absent")).toBeUndefined();
          expect(await store.getInputs("absent")).toBeUndefined();
        },
        { maxRecords: 100 },
      );
      await store.putGeneration("absent", { value: "new" });
      await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
      const missingInputs = await store.observe!(() => store.getInputs("absent"), { maxRecords: 100 });
      await store.putInputs(inputs("absent"));
      await expect(missingInputs.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    });
    it("rejects overbudget observations explicitly and cannot swallow the limit", async () => {
      const store = await makeStore();
      await expect(
        store.observe!(
          async () => {
            try {
              await store.getInputs("run");
            } catch {
              /* The scope remains invalid. */
            }
          },
          { maxRecords: 0 },
        ),
      ).rejects.toMatchObject({ code: "RUN_STATE", message: expect.stringContaining("limit") });
      await expect(store.observe!(async () => undefined, { maxRecords: -1 })).rejects.toMatchObject({
        code: "RUN_STATE",
      });
    });
    it("preserves caller errors and correlation details unchanged", async () => {
      const store = await makeStore();
      const error = Object.assign(new Error("revision-publication-uncertain"), { operationId: "stable-operation" });
      await expect(
        store.observe!(
          async () => {
            throw error;
          },
          { maxRecords: 100 },
        ),
      ).rejects.toBe(error);
    });
    it("blocks all writes in scope, even when their error is swallowed", async () => {
      const store = await makeStore();
      if (backend === "memory") await store.putInputs(inputs());
      const writes = [
        () => store.putGeneration("new", {}),
        () => store.putInputs(inputs("new")),
        () => store.addSensitivity("run", { sensitiveNames: [], secrets: ["new"] }),
        () => store.putPayload("new", { runId: "run", type: "vars.set", payload: { vars: {} } }),
      ];
      for (const write of writes) {
        await expect(
          store.observe!(
            async () => {
              await expect(write()).rejects.toMatchObject({ code: "RUN_STATE" });
            },
            { maxRecords: 100 },
          ),
        ).rejects.toMatchObject({ code: "RUN_STATE" });
      }
      expect(await store.getGeneration("new")).toBeUndefined();
      expect(await store.getInputs("new")).toBeUndefined();
      expect((await store.getInputs("run"))?.secrets).toEqual([SECRET]);
    });
    it("isolates concurrent scopes and unrelated writes", async () => {
      const store = await makeStore();
      if (backend === "memory") await store.putInputs(inputs());
      let firstReady!: () => void;
      let releaseFirst!: () => void;
      const ready = new Promise<void>((resolve) => {
        firstReady = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = store.observe!(
        async () => {
          await store.getInputs("run");
          firstReady();
          await release;
        },
        { maxRecords: 100 },
      );
      await ready;
      const second = await store.observe!(() => store.getGeneration("independent"), { maxRecords: 1 });
      await store.putGeneration("independent", {});
      releaseFirst();
      await expect((await first).verifyUnchanged()).resolves.toBeUndefined();
      await expect(second.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    });
    it("detects added overlays and ignores other runs' membership", async () => {
      const store = await makeStore();
      if (backend === "memory") await store.putInputs(inputs());
      await store.putInputs(inputs("other"));
      const observed = await store.observe!(() => store.getInputs("run"), { maxRecords: 100 });
      await store.addSensitivity("other", { sensitiveNames: [], secrets: ["other-secret"] });
      await expect(observed.verifyUnchanged()).resolves.toBeUndefined();
      await store.addSensitivity("run", { sensitiveNames: [], secrets: ["new-secret"] });
      await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    });
  });
}

describe("file observation verification", () => {
  it("uses the existing single hydration batch then hashes ciphertext with no decryption or JSON parsing", async () => {
    const { store } = await fixture();
    const getPayloads = vi.spyOn(store, "getPayloads");
    const getInputs = vi.spyOn(store, "getInputs");
    const observed = await observeAll(store);
    expect(getPayloads).toHaveBeenCalledTimes(1);
    expect(getInputs).toHaveBeenCalledTimes(1);
    expect(createDecipheriv).toHaveBeenCalled();
    vi.mocked(createDecipheriv).mockClear();
    const parse = vi.spyOn(JSON, "parse");
    await observed.verifyUnchanged();
    expect(createDecipheriv).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(getPayloads).toHaveBeenCalledTimes(1);
    expect(getInputs).toHaveBeenCalledTimes(1);
  });

  it("streams verification with bounded reads instead of retaining another ciphertext copy", async () => {
    const { store } = await fixture();
    await store.putGeneration("large", { secret: SECRET.repeat(10_000) });
    const observed = await store.observe(() => store.getGeneration("large"), { maxRecords: 100 });
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let chunks = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      vi.spyOn(handle, "readFile").mockRejectedValue(new Error("verification must not read a whole file"));
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        chunks++;
        return read(...readArgs);
      });
      return handle;
    });
    await expect(observed.verifyUnchanged()).resolves.toBeUndefined();
    expect(chunks).toBeGreaterThan(3);
  });

  it("rejects same-size rewrites even when file identity metadata is indistinguishable", async () => {
    const { store, dir } = await fixture();
    const observed = await observeAll(store);
    const target = join(dir, "first.payload.json");
    const before = await lstat(target, { bigint: true });
    const original = await readFile(target);
    const changed = Buffer.from(original);
    const offset = changed.indexOf(Buffer.from('"ciphertext":"')) + 14;
    changed[offset] = changed[offset]! ^ 1;
    await writeFile(target, changed);
    await utimes(target, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const result = await fs.lstat(...args);
      return String(args[0]) === target ? Object.assign(result, before) : result;
    });
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === target) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) =>
          Object.assign(await stat(...statArgs), before),
        );
      }
      return handle;
    });
    vi.mocked(createDecipheriv).mockClear();
    await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(createDecipheriv).not.toHaveBeenCalled();
  });

  it.each([
    "key rotation",
    "key removal",
    "key truncation",
    "key mode",
    "record mode",
    "directory mode",
    "record replacement",
    "directory replacement",
    "record symlink",
    "key symlink",
    "directory symlink",
    "corrupt ciphertext",
  ])("fails closed after %s", async (change) => {
    const { store, dir, root } = await fixture();
    const observed = await observeAll(store);
    const key = join(dir, ".execution-key");
    const record = join(dir, "first.payload.json");
    if (change === "key rotation") await writeFile(key, Buffer.alloc(32, 2));
    if (change === "key removal") await rm(key);
    if (change === "key truncation") await writeFile(key, Buffer.alloc(3));
    if (change.endsWith("mode")) {
      if (process.platform === "win32") return;
      await chmod(change === "key mode" ? key : change === "record mode" ? record : dir, 0o777);
    }
    if (change === "record replacement") {
      await cp(record, `${record}.copy`);
      await rename(`${record}.copy`, record);
    }
    if (change === "directory replacement") {
      await rename(dir, `${dir}.old`);
      await cp(`${dir}.old`, dir, { recursive: true });
    }
    if (change.endsWith("symlink")) {
      if (process.platform === "win32") return;
      const target = change === "record symlink" ? record : change === "key symlink" ? key : dir;
      const other = join(root, "symlink-target");
      await rename(target, other);
      await symlink(other, target);
    }
    if (change === "corrupt ciphertext") await writeFile(record, `invalid-${SECRET}`);
    const error: unknown = await observed.verifyUnchanged().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "RUN_STATE" });
    expect(String(error)).not.toContain(SECRET);
  });

  it("rejects removed sensitivity records and new files in an initially absent directory", async () => {
    const { store, dir, root } = await fixture();
    await store.addSensitivity("run", { sensitiveNames: [], secrets: ["overlay-secret"] });
    const observed = await store.observe(() => store.getInputs("run"), { maxRecords: 100 });
    const overlay = (await readdir(dir)).find((name) => name.includes(".sensitivity."))!;
    await rm(join(dir, overlay));
    await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    const empty = new FileExecutionStore(join(root, "empty"));
    const missing = await empty.observe(() => empty.getInputs("new"), { maxRecords: 100 });
    await empty.putInputs(inputs("new"));
    await expect(missing.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("bounds enumeration members and rejects corrupt first-pass ciphertext", async () => {
    const { store, dir } = await fixture();
    await store.addSensitivity("run", { sensitiveNames: [], secrets: [] });
    await expect(store.observe(() => store.getInputs("run"), { maxRecords: 3 })).rejects.toMatchObject({
      code: "RUN_STATE",
      message: expect.stringContaining("limit"),
    });
    await writeFile(join(dir, "first.payload.json"), `corrupt-${SECRET}`);
    await expect(observeAll(store)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("fails closed on verification I/O errors and never uses an earlier cache", async () => {
    const { store } = await fixture();
    await store.getPayloads(references);
    const observed = await observeAll(store);
    vi.mocked(open).mockRejectedValueOnce(new Error(`I/O error with ${SECRET}`));
    const error: unknown = await observed.verifyUnchanged().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "RUN_STATE" });
    expect(String(error)).not.toContain(SECRET);
  });
});

it("memory fingerprints do not share mutable references with their original records", async () => {
  const store = new InMemoryExecutionStore();
  await store.putInputs(inputs());
  const observation = await store.observe(() => store.getInputs("run"), { maxRecords: 100 });
  const records = (store as unknown as { inputs: Map<string, ExecutionInputs> }).inputs;
  records.get("run")!.vars.secret = "changed in place";
  await expect(observation.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
});
