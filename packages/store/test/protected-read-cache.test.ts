/** Read reuse must never turn missing, replaced, unsafe or modified private files into valid authority. */
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileExecutionStore } from "@orca/store";

const calls = vi.hoisted(() => ({
  open: [] as string[],
  frozenTimes: new Map<string, { mtimeNs: bigint; ctimeNs: bigint }>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      const times = calls.frozenTimes.get(String(args[0]));
      if (times) Object.assign(info, times);
      return info;
    },
    open: (...args: Parameters<typeof actual.open>) => {
      calls.open.push(String(args[0]));
      return actual.open(...args);
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  calls.frozenTimes.clear();
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orca-private-cache-"));
  dirs.push(directory);
  const store = new FileExecutionStore(directory);
  await store.putInputs({
    runId: "run",
    workflowId: "workflow",
    workflowVersion: "1",
    vars: { secret: "secret-value" },
    sensitiveNames: ["secret"],
    secrets: ["secret-value"],
  });
  await store.putPayload("payload", { type: "vars.set", runId: "run", payload: { vars: { secret: "secret-value" } } });
  const read = () => store.getPayload("run", "payload", "vars.set");
  await read();
  return { directory, store, read, path: (name: string) => join(directory, "private-execution", name) };
}

it("reuses unchanged ciphertext bytes while rereading the key and returns isolated decoded values", async () => {
  const f = await fixture();
  calls.open = [];
  for (let index = 0; index < 8; index++) {
    const payload = (await f.read()) as { vars: Record<string, unknown> };
    expect(payload.vars.secret).toBe("secret-value");
    payload.vars.secret = "caller mutation";
  }
  expect(calls.open.length).toBeGreaterThan(0);
  expect(calls.open.every((path) => path.endsWith(".execution-key"))).toBe(true);
});

it.each([".execution-key", "run.inputs.json", "payload.payload.json"])(
  "does not reuse cached %s after deletion",
  async (name) => {
    const f = await fixture();
    await rm(f.path(name));
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  },
);

it.each([".execution-key", "run.inputs.json", "payload.payload.json"])(
  "does not reuse cached %s after same-size edits and restored mtime",
  async (name) => {
    const f = await fixture();
    const path = f.path(name);
    const before = await stat(path);
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(path, bytes);
    await utimes(path, before.atime, before.mtime);
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
    if (name === ".execution-key")
      await expect(f.store.putGeneration("later", {})).rejects.toMatchObject({ code: "RUN_STATE" });
  },
);

it("does not reuse cached bytes for a replacement inode even with matching size and mtime", async () => {
  const f = await fixture();
  const path = f.path(".execution-key");
  const before = await stat(path);
  const replacement = join(f.directory, "replacement");
  await writeFile(replacement, Buffer.alloc(32, 2), { mode: 0o600 });
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
});

it.each(["", ".execution-key", "run.inputs.json", "payload.payload.json"])(
  "does not reuse cached bytes after unsafe permissions on %s",
  async (name) => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const path = f.path(name);
    await chmod(path, name ? 0o644 : 0o755);
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
    expect((await stat(path)).mode & 0o777).toBe(name ? 0o644 : 0o755);
  },
);

it.each(["", ".execution-key", "run.inputs.json", "payload.payload.json"])(
  "does not reuse cached bytes after a symlink replaces %s",
  async (name) => {
    if (process.platform === "win32") return;
    const f = await fixture();
    const path = f.path(name);
    const replacement = join(f.directory, "saved-original");
    await rename(path, replacement);
    await symlink(replacement, path);
    await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  },
);

it("rejects an in-place key rewrite when the filesystem reports identical nanosecond timestamps", async () => {
  const f = await fixture();
  const path = f.path(".execution-key");
  const before = await stat(path, { bigint: true });
  // Model a coarse kernel timestamp tick deterministically, without utimes (which
  // itself changes ctime). Keep real inode, size, permissions and actual disk I/O.
  calls.frozenTimes.set(path, { mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
  await f.read();
  const key = await readFile(path);
  key[0] = key[0]! ^ 1;
  await writeFile(path, key);
  expect((await stat(path, { bigint: true })).ino).toBe(before.ino);
  expect((await stat(path, { bigint: true })).size).toBe(before.size);
  await expect(f.read()).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(f.store.putGeneration("after-rewrite", {})).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await readFile(path)).toEqual(key);
});
