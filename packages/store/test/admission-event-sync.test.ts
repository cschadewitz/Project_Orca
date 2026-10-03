/** Exact existing-event admission evidence, without publication, repair or private allocation. */
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrcaEvent, OrcaEventInput } from "@orca/core";
import { InMemoryEventStore } from "../src/event-store.js";
import { FileExecutionStore } from "../src/execution-store.js";
import { JsonlEventStore } from "../src/jsonl-event-store.js";
import { ProtectedEventStore } from "../src/protected-event-store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const createdInput = {
  runId: "run",
  type: "run.created",
  payload: {
    workflowId: "workflow",
    workflowVersion: "1",
    directAdmissionId: "admission-1",
    workspace: { hostId: "host", cwd: "/workspace" },
    vars: { secret: "synthetic-private-value" },
  },
} satisfies OrcaEventInput;

async function fixture(protectedRun = false) {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-sync-"));
  dirs.push(dir);
  const publicEvents = new JsonlEventStore(dir);
  const execution = new FileExecutionStore(dir);
  if (protectedRun)
    await execution.putInputs({
      runId: createdInput.runId,
      workflowId: createdInput.payload.workflowId,
      workflowVersion: createdInput.payload.workflowVersion,
      vars: createdInput.payload.vars,
      sensitiveNames: ["secret"],
      secrets: [createdInput.payload.vars.secret],
    });
  const events = protectedRun ? new ProtectedEventStore(publicEvents, execution) : publicEvents;
  const created = await events.append(createdInput);
  const started = await events.append({ runId: "run", type: "run.started", payload: {} });
  if (created.type !== "run.created" || started.type !== "run.started") throw new Error("Unexpected event type");
  return { dir, file: join(dir, "runs", "run.jsonl"), publicEvents, execution, events, created, started };
}

async function snapshot(file: string) {
  const { dev, ino, size, mode, mtimeMs } = await stat(file);
  return { bytes: await readFile(file), dev, ino, size, mode, mtimeMs };
}

async function handlePrototype(file: string) {
  const handle = await open(file, "r");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  return prototype;
}

describe("exact existing-event synchronization", () => {
  it("returns exact existing creation and start events after syncing without changing history or notifying", async () => {
    const { dir, file, created, started } = await fixture();
    const before = await snapshot(file);
    const reopened = new JsonlEventStore(dir);
    const listener = vi.fn();
    reopened.subscribe(listener);
    const prototype = await handlePrototype(file);
    const sync = vi.spyOn(prototype, "sync");
    const write = vi.spyOn(prototype, "writeFile");
    expect(await reopened.synchronizeEvent(created)).toEqual(created);
    expect(await reopened.synchronizeEvent(started)).toEqual(started);
    expect(sync).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(join(dir, "runs"))).toEqual(["run.jsonl"]);
  });

  it.each([
    ["id", { id: "another-event" }],
    ["sequence", { seq: 2 }],
    ["timestamp", { at: "changed" }],
    ["type", { type: "run.resumed" }],
    ["private reference", { executionPayloadRef: "another-private-ref" }],
    ["journal", { journal: { kind: "continuation", id: "unrelated", revision: 1 } }],
  ])("refuses a different %s without changing history", async (_label, change) => {
    const { events, file, started } = await fixture();
    const before = await snapshot(file);
    await expect(events.synchronizeEvent({ ...started, ...change } as OrcaEvent)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(await snapshot(file)).toEqual(before);
  });

  it("refuses changed creation material", async () => {
    const { events, file, created } = await fixture();
    const before = await snapshot(file);
    await expect(
      events.synchronizeEvent({ ...created, payload: { ...createdInput.payload, directAdmissionId: "another" } }),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await snapshot(file)).toEqual(before);
  });

  it("refuses missing, rewound, torn and inconsistent histories without reconstruction", async () => {
    const { events, file, created, started } = await fixture();
    const creation = JSON.stringify(created) + "\n";
    const complete = await readFile(file, "utf8");
    for (const bytes of [
      "",
      creation,
      complete.trimEnd(),
      complete + '{"seq":',
      complete + "invalid\n",
      creation + JSON.stringify({ ...started, seq: 3 }) + "\n",
      creation + JSON.stringify({ ...started, runId: "foreign" }) + "\n",
      complete + JSON.stringify({ ...started, seq: 2 }) + "\n",
    ]) {
      await writeFile(file, bytes);
      await expect(events.synchronizeEvent(started)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(bytes);
    }
    await rm(file);
    await expect(events.synchronizeEvent(started)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(file, ".."))).toEqual([]);
  });

  it("does not initialize a missing store directory", async () => {
    const { dir, created } = await fixture();
    const missing = join(dir, "missing");
    await expect(new JsonlEventStore(missing).synchronizeEvent(created)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "directory"])("refuses %s sync failure and retries only the existing record", async (kind) => {
    if (kind === "directory" && process.platform === "win32") return;
    const { dir, events, file, started } = await fixture();
    const before = await snapshot(file);
    const prototype = await handlePrototype(file);
    const failure = new Error(`${kind} sync failed`);
    const sync = vi.spyOn(prototype, "sync");
    if (kind === "directory") sync.mockResolvedValueOnce(undefined);
    sync.mockRejectedValueOnce(failure);
    await expect(events.synchronizeEvent(started)).rejects.toBe(failure);
    sync.mockRestore();
    expect(await new JsonlEventStore(dir).synchronizeEvent(started)).toEqual(started);
    expect(await snapshot(file)).toEqual(before);
  });

  it("snapshots caller-owned expected evidence before asynchronous work", async () => {
    const { events, started } = await fixture();
    const expected = structuredClone(started);
    const synchronization = events.synchronizeEvent(expected);
    expected.id = "changed-after-call";
    expect(await synchronization).toEqual(started);
  });
});

describe("protected existing-event synchronization", () => {
  it("returns authenticated originals and leaves public/private bytes and subscribers unchanged", async () => {
    const { dir, events, execution, file, created, started } = await fixture(true);
    const privateDir = join(dir, "private-execution");
    const files = [file, ...(await readdir(privateDir)).map((name) => join(privateDir, name))];
    const before = await Promise.all(files.map(snapshot));
    const writes = vi.spyOn(execution, "putPayload");
    const inputs = vi.spyOn(execution, "putInputs");
    const listener = vi.fn();
    events.subscribe(listener);
    const original = await events.synchronizeEvent(created);
    expect(original).toEqual({ ...created, payload: createdInput.payload });
    expect(original).not.toEqual(created);
    expect(await events.synchronizeEvent(started)).toEqual(started);
    expect((await events.read("run"))[0]).toEqual(created);
    expect(await Promise.all(files.map(snapshot))).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(inputs).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["payload", "inputs", "key"])("refuses tampered %s before synchronization", async (kind) => {
    const { dir, events, publicEvents, file, created } = await fixture(true);
    const name =
      kind === "payload"
        ? `${encodeURIComponent(created.executionPayloadRef!)}.payload.json`
        : kind === "inputs"
          ? "run.inputs.json"
          : ".execution-key";
    const target = join(dir, "private-execution", name);
    const bytes = await readFile(target);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(target, bytes);
    const before = await snapshot(file);
    const sync = vi.spyOn(publicEvents, "synchronizeEvent");
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(sync).not.toHaveBeenCalled();
    expect(await snapshot(file)).toEqual(before);
  });

  it("refuses a missing original payload even when a later event still authenticates", async () => {
    const { dir, events, publicEvents, created } = await fixture(true);
    await rm(join(dir, "private-execution", `${encodeURIComponent(created.executionPayloadRef!)}.payload.json`));
    const sync = vi.spyOn(publicEvents, "synchronizeEvent");
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("refuses changed public evidence and a removed protected reference", async () => {
    const { events, file, created, started } = await fixture(true);
    const changed = { ...created, at: "changed-public-marker" };
    await writeFile(file, [changed, started].map((event) => JSON.stringify(event) + "\n").join(""));
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
    const { executionPayloadRef: _ref, ...unprotected } = created;
    await writeFile(file, [unprotected, started].map((event) => JSON.stringify(event) + "\n").join(""));
    await expect(events.synchronizeEvent(unprotected)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it.each(["public", "private", "key"])("reauthenticates %s evidence after synchronization", async (kind) => {
    const { dir, events, publicEvents, execution, file, created, started } = await fixture(true);
    const synchronize = publicEvents.synchronizeEvent.bind(publicEvents);
    vi.spyOn(publicEvents, "synchronizeEvent").mockImplementationOnce(async (expected) => {
      const result = await synchronize(expected);
      if (kind === "public") {
        const changed = { ...created, at: "changed-during-sync" };
        await writeFile(file, [changed, started].map((event) => JSON.stringify(event) + "\n").join(""));
      } else if (kind === "private") {
        // A different valid authenticated original still cannot replace entry evidence.
        await rm(join(dir, "private-execution", `${encodeURIComponent(created.executionPayloadRef!)}.payload.json`));
        await execution.putPayload(created.executionPayloadRef!, {
          ...createdInput,
          payload: { ...createdInput.payload, directAdmissionId: "changed-during-sync" },
        });
      } else {
        const key = join(dir, "private-execution", ".execution-key");
        const bytes = await readFile(key);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(key, bytes);
      }
      return result;
    });
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("does not return authenticated evidence when public synchronization fails", async () => {
    const { events, publicEvents, execution, file, created } = await fixture(true);
    const before = await snapshot(file);
    const failure = new Error("existing-event sync failed");
    vi.spyOn(publicEvents, "synchronizeEvent").mockRejectedValueOnce(failure);
    const writes = vi.spyOn(execution, "putPayload");
    await expect(events.synchronizeEvent(created)).rejects.toBe(failure);
    expect(writes).not.toHaveBeenCalled();
    expect(await snapshot(file)).toEqual(before);
  });

  it("supports public-only histories without creating private state", async () => {
    const { dir, publicEvents, execution, created } = await fixture();
    const events = new ProtectedEventStore(publicEvents, execution);
    expect(await events.synchronizeEvent(created)).toEqual(created);
    await expect(stat(join(dir, "private-execution"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unsupported stores rather than substituting a read or append", async () => {
    const { execution, created } = await fixture();
    const publicEvents = new InMemoryEventStore();
    const read = vi.spyOn(publicEvents, "read");
    const append = vi.spyOn(publicEvents, "append");
    const events = new ProtectedEventStore(
      {
        append: publicEvents.append.bind(publicEvents),
        read: publicEvents.read.bind(publicEvents),
        readTypes: publicEvents.readTypes.bind(publicEvents),
        readRange: publicEvents.readRange.bind(publicEvents),
        lastSeq: publicEvents.lastSeq.bind(publicEvents),
        listRuns: publicEvents.listRuns.bind(publicEvents),
        subscribe: publicEvents.subscribe.bind(publicEvents),
      },
      execution,
    );
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe("in-memory exact existing-event verification", () => {
  it("returns isolated exact evidence without appending or notifying", async () => {
    const events = new InMemoryEventStore();
    const created = await events.append(createdInput);
    const before = structuredClone(await events.read("run"));
    const append = vi.spyOn(events, "append");
    const listener = vi.fn();
    events.subscribe(listener);
    const verified = await events.synchronizeEvent(created);
    expect(verified).toEqual(created);
    expect(verified).not.toBe(created);
    if (verified.type !== "run.created") throw new Error("Unexpected event type");
    verified.payload.vars.secret = "changed-return-value";
    expect(await events.read("run")).toEqual(before);
    expect(append).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses absent events and runs without creating or reconstructing them", async () => {
    const events = new InMemoryEventStore();
    const created = await events.append(createdInput);
    const append = vi.spyOn(events, "append");
    await expect(events.synchronizeEvent({ ...created, runId: "missing" })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await expect(events.synchronizeEvent({ ...created, id: "missing", seq: 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(await events.listRuns()).toEqual(["run"]);
    expect(await events.read("run")).toEqual([created]);
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses changed material, inconsistent sequence and duplicate identity", async () => {
    const events = new InMemoryEventStore();
    const created = await events.append(createdInput);
    const started = await events.append({ runId: "run", type: "run.started", payload: {} });
    const before = structuredClone(await events.read("run"));
    await expect(events.synchronizeEvent({ ...created, at: "changed" })).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await events.read("run")).toEqual(before);
    started.id = created.id;
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
    started.seq = 4;
    await expect(events.synchronizeEvent(created)).rejects.toMatchObject({ code: "RUN_STATE" });
  });
});
