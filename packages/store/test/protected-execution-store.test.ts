/** Encrypted private records survive restart/restore and fail closed on missing keys, tampering and unsafe files. */
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkflow } from "@orca/core";
import {
  FileExecutionStore,
  FileWorkflowVersionStore,
  InMemoryEventStore,
  InMemoryExecutionStore,
  executionEvents,
  type ExecutionInputs,
} from "@orca/store";

const SECRET = "synthetic-only-private-value-7187";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dir() {
  const value = await mkdtemp(join(tmpdir(), "orca-private-store-"));
  dirs.push(value);
  return value;
}
const inputs = (runId = "run-1"): ExecutionInputs => ({
  runId,
  workflowId: "private",
  workflowVersion: "1",
  vars: { secret: SECRET, nested: { count: 2 } },
  sensitiveNames: ["secret"],
  secrets: [SECRET],
});
const privatePath = (directory: string, file: string) => join(directory, "private-execution", file);

for (const backend of ["memory", "file"] as const) {
  it(`${backend}: clones authoritative inputs and never overwrites them`, async () => {
    const store = backend === "memory" ? new InMemoryExecutionStore() : new FileExecutionStore(await dir());
    const value = inputs();
    await store.putInputs(value);
    value.vars.secret = "mutated";
    const read = await store.getInputs("run-1");
    expect(read?.vars.secret).toBe(SECRET);
    read!.vars.secret = "changed after read";
    expect((await store.getInputs("run-1"))?.vars.secret).toBe(SECRET);
    await expect(store.putInputs(inputs())).rejects.toMatchObject({ code: "RUN_STATE" });
  });
}

describe("authenticated private storage", () => {
  it("authenticates replay inputs once per run and refreshes them for every batch", async () => {
    const directory = await dir();
    const store = new FileExecutionStore(directory);
    const publicEvents = new InMemoryEventStore();
    await store.putInputs(inputs());
    await store.putInputs(inputs("run-2"));
    await publicEvents.append({ type: "run.started", runId: "run-1", payload: {} });
    for (let index = 0; index < 12; index++) {
      const input = {
        type: "vars.set" as const,
        runId: index % 2 ? "run-1" : "run-2",
        payload: { vars: { echoed: SECRET, index } },
      };
      const ref = `event-${index}`;
      await store.putPayload(ref, input);
      await publicEvents.append({ ...input, payload: { vars: {} }, executionPayloadRef: ref });
    }
    const events = [...(await publicEvents.read("run-1")), ...(await publicEvents.read("run-2"))];
    const getInputs = vi.spyOn(store, "getInputs");
    const restored = await executionEvents(events, store);
    expect(getInputs).toHaveBeenCalledTimes(2);
    expect(restored[0]).toEqual(events[0]);
    expect(restored.filter((event) => event.type === "vars.set").map((event) => event.payload.vars.echoed)).toEqual(
      Array<string>(12).fill(SECRET),
    );
    await executionEvents(events, store);
    expect(getInputs).toHaveBeenCalledTimes(4);
    await rm(privatePath(directory, "run-1.inputs.json"));
    await expect(executionEvents(events, store)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("checks every batched payload identity, type and sealed sensitivity overlay", async () => {
    const directory = await dir();
    const store = new FileExecutionStore(directory);
    await store.putInputs(inputs());
    await store.addSensitivity("run-1", { sensitiveNames: ["next"], secrets: ["next-secret"] });
    for (const ref of ["first", "second"])
      await store.putPayload(ref, { type: "vars.set", runId: "run-1", payload: { vars: { ref } } });
    const references = ["first", "second"].map((ref) => ({ runId: "run-1", ref, type: "vars.set" }));
    expect(await store.getPayloads(references)).toEqual([{ vars: { ref: "first" } }, { vars: { ref: "second" } }]);
    for (const invalid of [{ runId: "wrong" }, { type: "run.started" }, { ref: "missing" }])
      await expect(store.getPayloads([references[0]!, { ...references[1]!, ...invalid }])).rejects.toMatchObject({
        code: "RUN_STATE",
      });
    // Remove a previously authenticated overlay during the batch, before the fresh
    // input/sensitivity read. A previous call's success must not authorize this one.
    const getInputs = store.getInputs.bind(store);
    vi.spyOn(store, "getInputs").mockImplementationOnce(async (runId) => {
      const overlay = (await readdir(privatePath(directory, ""))).find((name) => name.includes(".sensitivity."))!;
      await rm(privatePath(directory, overlay));
      return getInputs(runId);
    });
    await expect(store.getPayloads(references)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("encrypts inputs and payloads, with owner-only records/key and fresh-store restart", async () => {
    const directory = await dir();
    const store = new FileExecutionStore(directory);
    await store.putInputs(inputs());
    await store.putPayload("event-ref", { type: "vars.set", runId: "run-1", payload: { vars: { echoed: SECRET } } });
    for (const name of await readdir(privatePath(directory, ""))) {
      const file = privatePath(directory, name);
      expect((await readFile(file)).includes(Buffer.from(SECRET))).toBe(false);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") expect((await stat(privatePath(directory, ""))).mode & 0o777).toBe(0o700);
    const restored = new FileExecutionStore(directory);
    expect(await restored.getInputs("run-1")).toEqual(inputs());
    expect(await restored.getPayload("run-1", "event-ref", "vars.set")).toEqual({ vars: { echoed: SECRET } });
    await expect(restored.getPayload("run-other", "event-ref", "vars.set")).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await expect(restored.getPayload("run-1", "event-ref", "run.created")).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("creates one key safely for concurrent first writes across independent stores", async () => {
    const directory = await dir();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => new FileExecutionStore(directory).putInputs(inputs(`run-${index}`))),
    );
    expect((await readFile(privatePath(directory, ".execution-key"))).length).toBe(32);
    const restored = new FileExecutionStore(directory);
    for (let index = 0; index < 12; index++)
      expect((await restored.getInputs(`run-${index}`))?.vars.secret).toBe(SECRET);
    expect((await readdir(privatePath(directory, ""))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["missing", "truncated", "wrong"] as const)(
    "fails closed with a %s key and never replaces it",
    async (kind) => {
      const directory = await dir();
      const store = new FileExecutionStore(directory);
      await store.putInputs(inputs());
      const keyPath = privatePath(directory, ".execution-key");
      if (kind === "missing") await rm(keyPath);
      else await writeFile(keyPath, Buffer.alloc(kind === "truncated" ? 7 : 32, 1));
      await expect(new FileExecutionStore(directory).getInputs("run-1")).rejects.toMatchObject({ code: "RUN_STATE" });
      await expect(new FileExecutionStore(directory).putInputs(inputs("run-2"))).rejects.toMatchObject({
        code: "RUN_STATE",
      });
      if (kind === "missing") await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(keyPath)).toEqual(Buffer.alloc(kind === "truncated" ? 7 : 32, 1));
    },
  );

  it("authenticates ciphertext and its filename, without echoing corrupt bytes", async () => {
    const directory = await dir();
    const store = new FileExecutionStore(directory);
    await store.putInputs(inputs());
    const first = privatePath(directory, "run-1.inputs.json");
    const encrypted = await readFile(first);
    await writeFile(privatePath(directory, "run-2.inputs.json"), encrypted, { mode: 0o600 });
    await expect(store.getInputs("run-2")).rejects.toMatchObject({ code: "RUN_STATE" });
    const envelope = JSON.parse(encrypted.toString()) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    envelope.ciphertext = bytes.toString("base64");
    await writeFile(first, JSON.stringify(envelope));
    await expect(store.getInputs("run-1")).rejects.toMatchObject({ code: "RUN_STATE" });
    await writeFile(first, `malformed ${SECRET}`);
    const error: unknown = await store.getInputs("run-1").catch((value: unknown) => value);
    expect(String(error)).not.toContain(SECRET);
  });

  it("restores from an encrypted records-plus-key backup at a new root", async () => {
    const original = await dir();
    const backup = await dir();
    await new FileExecutionStore(original).putInputs(inputs());
    await cp(privatePath(original, ""), privatePath(backup, ""), { recursive: true });
    expect(await new FileExecutionStore(backup).getInputs("run-1")).toEqual(inputs());
  });

  it("does not follow key/record symlinks or relax existing filesystem permissions", async () => {
    if (process.platform === "win32") return;
    const directory = await dir();
    const store = new FileExecutionStore(directory);
    await store.putInputs(inputs());
    const key = privatePath(directory, ".execution-key");
    const saved = await readFile(key);
    await rm(key);
    const other = join(directory, "outside-key");
    await writeFile(other, saved, { mode: 0o600 });
    await symlink(other, key);
    await expect(store.getInputs("run-1")).rejects.toMatchObject({ code: "RUN_STATE" });
    await rm(key);
    await writeFile(key, saved, { mode: 0o600 });
    await chmod(privatePath(directory, "run-1.inputs.json"), 0o644);
    await expect(store.getInputs("run-1")).rejects.toMatchObject({ code: "RUN_STATE" });
    expect((await stat(privatePath(directory, "run-1.inputs.json"))).mode & 0o777).toBe(0o644);
  });

  it("keeps legacy workflow snapshots readable and encrypts only newly recorded snapshots", async () => {
    const directory = await dir();
    const legacy = parseWorkflow(
      "id: legacy\nname: Legacy\nversion: '1'\nstart: e\nnodes: { e: { type: end } }\nedges: []",
    );
    await mkdir(join(directory, "workflows"), { mode: 0o755 });
    await writeFile(join(directory, "workflows", "legacy@v1.json"), JSON.stringify(legacy), { mode: 0o644 });
    const store = new FileWorkflowVersionStore(directory);
    expect(await store.get("legacy", "1")).toEqual(legacy);
    const next = { ...legacy, version: "2", vars: { secret: SECRET } };
    expect(await store.put(next)).toBe(true);
    expect(await store.versions("legacy")).toEqual(["1", "2"]);
    expect(await readFile(join(directory, "private-workflows", "legacy@v2.json"), "utf8")).not.toContain(SECRET);
    expect(await new FileWorkflowVersionStore(directory).get("legacy", "2")).toEqual(next);
    if (process.platform !== "win32") expect((await stat(join(directory, "workflows"))).mode & 0o777).toBe(0o755);
  });
});
