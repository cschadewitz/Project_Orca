/** Complete public observations share the append mutex, never execution authority or recovery. */
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger, parseWorkflow, type OrcaEvent, type OrcaEventInput } from "@orca/core";
import { InMemoryEventStore } from "../src/event-store.js";
import { FileExecutionStore } from "../src/execution-store.js";
import { JsonlEventStore } from "../src/jsonl-event-store.js";
import { ProtectedEventStore } from "../src/protected-event-store.js";
import { InMemoryWorkflowVersionStore } from "../src/workflow-store.js";

const limits = { maxEvents: 100_000, maxBytes: 64 * 1024 * 1024 };
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
    workspace: { hostId: "host", cwd: "/workspace" },
    vars: { secret: "private-observation-value" },
  },
} satisfies OrcaEventInput;
const startedInput = { runId: "run", type: "run.started", payload: {} } satisfies OrcaEventInput;
const serialize = (events: unknown[]) => events.map((event) => JSON.stringify(event) + "\n").join("");

async function fixture(protectedRun = false) {
  const dir = await mkdtemp(join(tmpdir(), "orca-event-observation-"));
  dirs.push(dir);
  const messages: string[] = [];
  const raw = new JsonlEventStore(
    dir,
    undefined,
    consoleLogger("warn", {}, (message) => messages.push(message)),
  );
  const execution = new FileExecutionStore(dir);
  if (protectedRun)
    await execution.putInputs({
      runId: "run",
      workflowId: "workflow",
      workflowVersion: "1",
      vars: createdInput.payload.vars,
      sensitiveNames: ["secret"],
      secrets: [createdInput.payload.vars.secret],
    });
  const events = protectedRun ? new ProtectedEventStore(raw, execution) : raw;
  const created = await events.append(createdInput);
  const started = await events.append(startedInput);
  return { dir, file: join(dir, "runs", "run.jsonl"), raw, events, execution, created, started, messages };
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("complete existing event observations", () => {
  it("syncs existing bytes without rewriting, publishing, logging or allocating persistence", async () => {
    const { dir, file, events, created, started, messages } = await fixture();
    const before = await snapshot(file);
    const listener = vi.fn();
    events.subscribe(listener);
    const prototype = await handlePrototype(file);
    const sync = vi.spyOn(prototype, "sync");
    const wholeFileRead = vi.spyOn(prototype, "readFile");
    const writes = vi.spyOn(prototype, "writeFile");
    const observation = await events.readObservation("run", limits);
    expect(observation.events).toEqual([created, started]);
    await observation.verifyUnchanged();
    expect(sync).toHaveBeenCalled();
    expect(wholeFileRead).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["runs"]);
    expect(await readdir(join(dir, "runs"))).toEqual(["run.jsonl"]);
  });

  it("fails closed on missing files and directories without creating them", async () => {
    const { dir, file, execution, events: existing } = await fixture();
    const observation = await existing.readObservation("run", limits);
    const missing = join(dir, "missing");
    for (const target of [dir, missing]) {
      const raw = new JsonlEventStore(target);
      const events = new ProtectedEventStore(raw, execution);
      const readRange = vi.spyOn(raw, "readRange");
      await expect(events.readObservation("absent", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(readRange).not.toHaveBeenCalled();
    }
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(file);
    await expect(observation.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(new JsonlEventStore(dir).readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await readdir(join(dir, "runs"))).toEqual([]);
  });

  it("verifies the captured digest independently of caller mutation and rejects changed valid public material", async () => {
    const { events, file, created, started } = await fixture();
    const observation = await events.readObservation("run", limits);
    observation.events[0]!.id = "caller-change";
    observation.events.pop();
    await observation.verifyUnchanged();
    for (const changed of [
      { ...started, id: "different-id" },
      { ...started, at: "different-time" },
      { ...started, executionPayloadRef: "different-private-reference" },
    ]) {
      await writeFile(file, serialize([created, changed]));
      const before = await snapshot(file);
      await expect(observation.verifyUnchanged()).rejects.toMatchObject({
        code: "RUN_STATE",
        message: "Event observation history changed",
      });
      expect(await snapshot(file)).toEqual(before);
    }
  });

  it("refuses empty, torn, malformed, foreign, duplicate and gapped history without repair or warnings", async () => {
    const { file, events, created, started, messages } = await fixture();
    const observation = await events.readObservation("run", limits);
    for (const bytes of [
      "",
      "\n",
      serialize([created, started]).trimEnd(),
      serialize([created]) + '{"seq":',
      serialize([created]) + "invalid\n",
      serialize([created, { ...started, type: "invalid" }]),
      serialize([created, { ...started, runId: "foreign" }]),
      serialize([created, { ...started, id: created.id }]),
      serialize([created, { ...started, seq: 0 }]),
      serialize([created, { ...started, seq: 2 }]),
      serialize([{ ...created, seq: 1 }, started]),
      Buffer.from(serialize([{ ...created, id: "invalid-byte" }])).map((byte, index, bytes) =>
        index === bytes.indexOf("invalid-byte") ? 0xff : byte,
      ),
    ]) {
      await writeFile(file, bytes);
      const before = await snapshot(file);
      await expect(events.readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
      await expect(observation.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(await snapshot(file)).toEqual(before);
    }
    expect(messages).toEqual([]);
  });

  it("supports exactly 100,000 events and refuses one extra without clipping", async () => {
    const { events, file, started } = await fixture();
    const rows = Array.from({ length: limits.maxEvents }, (_, seq) => ({ ...started, seq, id: `event-${seq}` }));
    await writeFile(file, serialize(rows));
    const observed = await events.readObservation("run", limits);
    expect(observed.events).toHaveLength(limits.maxEvents);
    expect(observed.events.at(-1)?.seq).toBe(limits.maxEvents - 1);
    await observed.verifyUnchanged();
    await writeFile(file, serialize([{ ...started, seq: limits.maxEvents, id: "overflow" }]), { flag: "a" });
    await expect(events.readObservation("run", limits)).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "Event observation exceeds its event limit",
    });
    await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("bounds reads in bytes, including a multibyte record larger than one chunk", async () => {
    const { events, file, created, started } = await fixture();
    if (created.type !== "run.created") throw new Error("Unexpected event type");
    const large = { ...created, payload: { ...created.payload, vars: { text: "🐳".repeat(40_000) } } };
    const bytes = Buffer.from(serialize([large, started]));
    await writeFile(file, bytes);
    const prototype = await handlePrototype(file);
    const read = vi.spyOn(prototype, "read");
    const observation = await events.readObservation("run", { maxEvents: 2, maxBytes: bytes.length });
    expect(observation.events).toEqual([large, started]);
    await observation.verifyUnchanged();
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(
      read.mock.calls.every((call: readonly unknown[]) => typeof call[2] === "number" && call[2] <= 64 * 1024),
    ).toBe(true);
    read.mockClear();
    await expect(events.readObservation("run", { maxEvents: 2, maxBytes: bytes.length - 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "Event observation exceeds its byte limit",
    });
    expect(read).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(bytes);
  });

  it.each([0, -1, 1.5, Infinity, Number.NaN])(
    "rejects invalid limits (%s) before opening persistence",
    async (limit) => {
      const { dir } = await fixture();
      const missing = join(dir, "missing");
      const events = new JsonlEventStore(missing);
      for (const bounds of [
        { maxEvents: limit, maxBytes: 100 },
        { maxEvents: 100, maxBytes: limit },
      ])
        await expect(events.readObservation("run", bounds)).rejects.toMatchObject({ code: "RUN_STATE" });
      await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["file", "directory"])(
    "refuses a %s fsync failure, leaves history intact and permits the existing writer afterward",
    async (kind) => {
      if (kind === "directory" && process.platform === "win32") return;
      const { events, file, created, started } = await fixture();
      const observation = await events.readObservation("run", limits);
      const before = await snapshot(file);
      const prototype = await handlePrototype(file);
      const sync = vi.spyOn(prototype, "sync");
      if (kind === "directory") sync.mockResolvedValueOnce(undefined);
      sync.mockRejectedValueOnce(new Error("sync failed"));
      await expect(events.readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
      if (kind === "directory") sync.mockResolvedValueOnce(undefined);
      sync.mockRejectedValueOnce(new Error("verify sync failed"));
      await expect(observation.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
      sync.mockRestore();
      expect(await snapshot(file)).toEqual(before);
      const next = await events.append(startedInput);
      expect(next.seq).toBe(2);
      expect((await events.readObservation("run", limits)).events).toEqual([created, started, next]);
    },
  );

  it("orders observations with the same instance's pending appends", async () => {
    const { events, created, started } = await fixture();
    const first = events.append(startedInput);
    const observation = events.readObservation("run", limits);
    const second = events.append(startedInput);
    expect((await observation).events).toEqual([created, started, await first]);
    expect((await second).seq).toBe(3);
  });

  it("holds the shared append mutex until synchronization finishes across two instances", async () => {
    const { dir, file, events, created, started } = await fixture();
    const entered = deferred();
    const release = deferred();
    const prototype = await handlePrototype(file);
    // Preserve the original receiver when the mock invokes the real file sync.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const actual = prototype.sync;
    vi.spyOn(prototype, "sync").mockImplementationOnce(async function (this: typeof prototype) {
      entered.resolve();
      await release.promise;
      await actual.call(this);
    });
    const observation = events.readObservation("run", limits);
    await entered.promise;
    let appended = false;
    const writer = new JsonlEventStore(dir).append(startedInput).then((event) => {
      appended = true;
      return event;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(appended).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await observation).events).toEqual([created, started]);
    expect((await writer).seq).toBe(2);
    await expect((await observation).verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    expect((await events.readObservation("run", limits)).events).toHaveLength(3);
  });

  it("waits for another process to finish a partial append and lets its store continue writing", async () => {
    const { dir, file, events, created, started } = await fixture();
    const next = { ...started, seq: 2, id: "process-event" };
    const lockSource = new URL("../src/file-lock.ts", import.meta.url).href;
    const storeSource = new URL("../src/jsonl-event-store.ts", import.meta.url).href;
    const script = `
      import { appendFile } from 'node:fs/promises';
      import { withFileLock } from ${JSON.stringify(lockSource)};
      import { JsonlEventStore } from ${JSON.stringify(storeSource)};
      await withFileLock(${JSON.stringify(`${file}.lock`)}, async () => {
        const bytes = ${JSON.stringify(serialize([next]))};
        const middle = Math.floor(bytes.length / 2);
        await appendFile(${JSON.stringify(file)}, bytes.slice(0, middle));
        process.send('partial');
        await new Promise(resolve => process.once('message', resolve));
        await appendFile(${JSON.stringify(file)}, bytes.slice(middle));
      });
      await new Promise(resolve => process.once('message', resolve));
      await new JsonlEventStore(${JSON.stringify(dir)}).append(${JSON.stringify(startedInput)});
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors || `Writer exited ${code}`))));
    });
    // Always consume a failed child's completion while waiting for its first message.
    const ready = Promise.race([new Promise<void>((resolve) => child.once("message", () => resolve())), done]);
    try {
      await ready;
      let observed = false;
      const observation = events.readObservation("run", limits).then((value) => {
        observed = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observed).toBe(false);
      child.send("finish");
      expect((await observation).events).toEqual([created, started, next]);
      await (await observation).verifyUnchanged();
      child.send("append");
      await done;
      expect((await events.readObservation("run", limits)).events).toHaveLength(4);
      expect(await readdir(join(dir, "runs"))).toEqual(["run.jsonl"]);
    } finally {
      if (child.exitCode === null) child.kill();
      await done.catch(() => undefined);
    }
  });
});

describe("protected public observations", () => {
  it("authenticates existing guards after releasing the append lock and returns only public payloads", async () => {
    const { dir, file, raw, events, execution, created, started } = await fixture(true);
    const privateDir = join(dir, "private-execution");
    const files = [file, ...(await readdir(privateDir)).sort().map((name) => join(privateDir, name))];
    const before = await Promise.all(files.map(snapshot));
    const writes = vi.spyOn(execution, "putPayload");
    const inputs = vi.spyOn(execution, "putInputs");
    const readRange = vi.spyOn(raw, "readRange");
    const getPayload = execution.getPayload.bind(execution);
    const payloadRead = vi.spyOn(execution, "getPayload").mockImplementation(async (...args) => {
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      return getPayload(...args);
    });
    const observed = await events.readObservation("run", limits);
    expect(observed.events).toEqual([created, started]);
    const payloadReads = payloadRead.mock.calls.length;
    payloadRead.mockRejectedValue(new Error("Private material must not be decrypted twice"));
    vi.spyOn(events, "readObservation").mockRejectedValue(new Error("Protected reader must not be called twice"));
    await observed.verifyUnchanged();
    expect(payloadRead).toHaveBeenCalledTimes(payloadReads);
    expect(JSON.stringify(observed)).not.toContain(createdInput.payload.vars.secret);
    expect(readRange).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(inputs).not.toHaveBeenCalled();
    expect(await Promise.all(files.map(snapshot))).toEqual(before);
  });

  it.each(["payload", "inputs", "key"])("refuses tampered private %s without recovery", async (kind) => {
    const { dir, file, events, started } = await fixture(true);
    const name =
      kind === "payload"
        ? `${encodeURIComponent(started.executionPayloadRef!)}.payload.json`
        : kind === "inputs"
          ? "run.inputs.json"
          : ".execution-key";
    const target = join(dir, "private-execution", name);
    const bytes = await readFile(target);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(target, bytes);
    const before = await snapshot(file);
    await expect(events.readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await readFile(target)).toEqual(bytes);
    expect(await snapshot(file)).toEqual(before);
  });

  it("rejects known sensitive legacy ancestors using strict reads without migration", async () => {
    const { dir, raw, execution, created, file } = await fixture();
    const workflows = new InMemoryWorkflowVersionStore();
    const definition = parseWorkflow(
      "id: secret\nname: Secret\ninputSchema:\n  fields:\n    token: { type: string, sensitive: true }\nstart: end\nnodes: { end: { type: end } }\nedges: []",
    );
    await workflows.put(definition);
    await raw.append({
      ...createdInput,
      runId: "parent",
      payload: {
        ...createdInput.payload,
        workflowId: definition.id,
        workflowVersion: definition.version,
      },
    });
    if (created.type !== "run.created") throw new Error("Unexpected event type");
    await writeFile(file, serialize([{ ...created, payload: { ...created.payload, parentRunId: "parent" } }]));
    const before = await snapshot(file);
    const readRange = vi.spyOn(raw, "readRange");
    const events = new ProtectedEventStore(raw, execution, workflows);
    await expect(events.readObservation("run", limits)).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "legacy sensitive execution requires explicit migration before reading or resuming",
    });
    expect(readRange).not.toHaveBeenCalled();
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["runs"]);
  });

  it("allows ordinary histories without creating private state", async () => {
    const { dir, raw, execution, created, started } = await fixture();
    const events = new ProtectedEventStore(raw, execution, new InMemoryWorkflowVersionStore());
    const observation = await events.readObservation("run", limits);
    expect(observation.events).toEqual([created, started]);
    await observation.verifyUnchanged();
    expect(await readdir(dir)).toEqual(["runs"]);
  });

  it("shares the event budget across legacy ancestors and caps their depth", async () => {
    const raw = new InMemoryEventStore();
    const { execution } = await fixture();
    const events = new ProtectedEventStore(raw, execution, new InMemoryWorkflowVersionStore());
    for (let index = 0; index < 35; index++)
      await raw.append({
        ...createdInput,
        runId: `ancestor-${index}`,
        payload: {
          ...createdInput.payload,
          ...(index < 34 ? { parentRunId: `ancestor-${index + 1}` } : {}),
        },
      });
    expect((await events.readObservation("ancestor-34", { ...limits, maxEvents: 1 })).events).toHaveLength(1);
    const observation = await events.readObservation("ancestor-33", { ...limits, maxEvents: 2 });
    expect(observation.events).toHaveLength(1);
    await observation.verifyUnchanged();
    await expect(events.readObservation("ancestor-33", { ...limits, maxEvents: 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "Event observation ancestry exceeds its read limit",
    });
    expect((await events.readObservation("ancestor-2", limits)).events).toHaveLength(1);
    await expect(events.readObservation("ancestor-1", limits)).rejects.toMatchObject({
      code: "RUN_STATE",
      message: "Event observation ancestry exceeds its read limit",
    });
    await raw.append({ ...startedInput, runId: "ancestor-34" });
    await expect(observation.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
  });
});

describe("in-memory complete observations", () => {
  it("isolates returned evidence and applies complete-history limits", async () => {
    const events = new InMemoryEventStore();
    await expect(events.readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
    const created = await events.append(createdInput);
    const observed = await events.readObservation("run", limits);
    expect(observed.events).toEqual([created]);
    (observed.events[0] as OrcaEvent).id = "mutated";
    await observed.verifyUnchanged();
    expect((await events.readObservation("run", limits)).events[0]?.id).toBe(created.id);
    await events.append(startedInput);
    await expect(observed.verifyUnchanged()).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(events.readObservation("run", { ...limits, maxEvents: 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await expect(events.readObservation("run", { ...limits, maxBytes: 1 })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    created.seq = 8;
    await expect(events.readObservation("run", limits)).rejects.toMatchObject({ code: "RUN_STATE" });
  });
});
