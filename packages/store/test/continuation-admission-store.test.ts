/** Durable continuation/revision journal seam: no production activation or new authority file. */
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childBundle } from "../../testing/src/child-bundle.js";
import { JsonlLogDir } from "../src/jsonl-log.js";
import { JsonlEventStore } from "../src/jsonl-event-store.js";
import { ProtectedEventStore } from "../src/protected-event-store.js";
import { FileExecutionStore } from "../src/execution-store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-journal-"));
  dirs.push(dir);
  return { dir, log: new JsonlLogDir(dir), file: join(dir, "run.jsonl") };
}
type Record = { seq: number; correlation: string; value: string };
function append(log: JsonlLogDir, expectedSeq = 0, correlation = "continuation-1", value = "accepted") {
  return log.appendDurableUnique<Record>("run", {
    expectedSeq,
    findExisting(raw) {
      const record = raw as Record;
      if (record.correlation !== correlation) return undefined;
      if (record.value !== value) throw new Error("correlation conflict");
      return record;
    },
    build: (seq) => ({ seq, correlation, value }),
  });
}
async function handlePrototype(file: string) {
  const handle = await open(file, "a+");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  return prototype;
}

describe("durable unique journal append", () => {
  it("replays one marker across instances and ignores obsolete CAS only for that exact marker", async () => {
    const { dir, log, file } = await fixture();
    const first = await append(log);
    expect(first.fresh).toBe(true);
    const replay = await append(new JsonlLogDir(dir));
    expect(replay).toEqual({ record: first.record, fresh: false });
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(append(log, 0, "another")).rejects.toThrow("boundary changed");
    await expect(append(log, 0, "continuation-1", "different")).rejects.toThrow("correlation conflict");
  });

  it("does not acknowledge a file fsync failure and re-syncs the same marker on retry", async () => {
    const { dir, log, file } = await fixture();
    const prototype = await handlePrototype(file);
    const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fsync failed"));
    await expect(append(log)).rejects.toThrow("fsync failed");
    sync.mockRestore();
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(false);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not acknowledge first-creation directory sync failure", async () => {
    if (process.platform === "win32") return;
    const { dir, log, file } = await fixture();
    const prototype = await handlePrototype(join(dir, "probe"));
    // Preserve the implementation and explicitly bind each receiver below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const actual = prototype.sync;
    let syncs = 0;
    const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof prototype) {
      if (++syncs === 2) throw new Error("directory sync failed");
      await actual.call(this);
    });
    await expect(append(log)).rejects.toThrow("directory sync failed");
    sync.mockRestore();
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(false);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("recovers a partial append after reopening without duplicating its correlation", async () => {
    const { dir, log, file } = await fixture();
    await append(log);
    const handle = await open(file, "a");
    await handle.writeFile('{"seq":1,"correlation":"continuation-2"');
    await handle.close();
    const recovered = await append(new JsonlLogDir(dir), 1, "continuation-2");
    expect(recovered.record.seq).toBe(1);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(recovered.record);
  });

  it("recovers after a writer process exits during the actual append", async () => {
    const { dir, file } = await fixture();
    // The writer is a real process that really exits mid-append. Under the test runner it starts
    // from the run's prebuilt bundle with plain node, not from sources transpiled by tsx.
    const writerSource = fileURLToPath(new URL("./fixtures/continuation-append-writer.ts", import.meta.url));
    const bundle = childBundle("continuation-append-writer", { entries: { writer: writerSource } })?.writer;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [...(bundle ? [bundle] : ["--import", "tsx", writerSource]), dir, file], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (status) => (status === 87 ? resolve(status) : reject(new Error(errors))));
    });
    expect(code).toBe(87);
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(false);
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(true);
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(false);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("preserves a complete matching marker missing only its newline", async () => {
    const { dir, file } = await fixture();
    const bytes = JSON.stringify({ seq: 0, correlation: "continuation-1", value: "accepted" });
    await writeFile(file, bytes);
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(false);
    expect(await readFile(file, "utf8")).toBe(bytes + "\n");
    await writeFile(file, bytes);
    await expect(append(new JsonlLogDir(dir), 0, "continuation-1", "different")).rejects.toThrow(
      "correlation conflict",
    );
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("never truncates a complete unrelated record that lacks its newline", async () => {
    const { log, file } = await fixture();
    const bytes = JSON.stringify({ seq: 0, correlation: "other", value: "accepted" });
    await writeFile(file, bytes);
    await expect(append(log)).rejects.toThrow("explicit recovery");
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("recovers a complete append with a lost process acknowledgement", async () => {
    const { dir, file } = await fixture();
    // Complete bytes may survive process death before sync or delivery. Recovery must
    // sync them, then return exactly this marker without executing the build again.
    await writeFile(file, JSON.stringify({ seq: 0, correlation: "continuation-1", value: "accepted" }) + "\n");
    const prototype = await handlePrototype(file);
    const sync = vi.spyOn(prototype, "sync");
    expect((await append(new JsonlLogDir(dir))).fresh).toBe(false);
    expect(sync).toHaveBeenCalled();
  });

  it("refuses complete corruption, sequence rewind, and duplicate correlation without repairing history", async () => {
    for (const contents of [
      '{"seq":0}\nnot-json\n',
      '{"seq":0}\n{"seq":0}\n',
      '{"seq":0,"correlation":"continuation-1","value":"accepted"}\n' +
        '{"seq":1,"correlation":"continuation-1","value":"accepted"}\n',
    ]) {
      const { log, file } = await fixture();
      await writeFile(file, contents);
      await expect(append(log)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  });

  it("leaves a partial tail untouched when the CAS is stale", async () => {
    const { log, file } = await fixture();
    const contents = '{"seq":0,"correlation":"old","value":"accepted"}\n{"seq":';
    await writeFile(file, contents);
    await expect(append(log)).rejects.toThrow("boundary changed");
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("shares lock/sequence with ordinary appends and concurrent store instances", async () => {
    const { dir, log, file } = await fixture();
    await log.append("run", (seq) => ({ seq, correlation: "ordinary", value: "event" }));
    const results = await Promise.all([append(log, 1), append(new JsonlLogDir(dir), 1)]);
    expect(results.map((result) => result.fresh).sort()).toEqual([false, true]);
    const next = await log.append("run", (seq) => ({ seq }));
    expect(next.seq).toBe(2);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("does not modify history when preparation of private material fails", async () => {
    const { log, file } = await fixture();
    await writeFile(file, '{"seq":');
    await expect(
      log.appendDurableUnique("run", {
        expectedSeq: 0,
        findExisting: () => undefined,
        build: () => {
          throw new Error("private material unavailable");
        },
      }),
    ).rejects.toThrow("private material unavailable");
    expect(await readFile(file, "utf8")).toBe('{"seq":');
  });
});

describe("durable event facade", () => {
  it("notifies only after successful sync and never on duplicate replay", async () => {
    const { dir } = await fixture();
    const events = new JsonlEventStore(dir);
    const listener = vi.fn();
    events.subscribe(listener);
    const options = {
      expectedSeq: -1,
      correlation: { kind: "continuation" as const, id: "c1", revision: 1 },
      equivalent: () => true,
    };
    const first = await events.appendDurableUnique({ runId: "run", type: "run.started", payload: {} }, options);
    expect(first.journal).toEqual(options.correlation);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await events.appendDurableUnique({ runId: "run", type: "run.started", payload: {} }, options)).toEqual(
      first,
    );
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(
      events.appendDurableUnique(
        { runId: "run", type: "run.started", payload: {} },
        {
          ...options,
          equivalent: () => false,
        },
      ),
    ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
    await expect(
      events.appendDurableUnique(
        { runId: "run", type: "run.started", payload: {} },
        {
          ...options,
          correlation: { ...options.correlation, id: "c2" },
        },
      ),
    ).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
  });
});

describe("read-only journal synchronization", () => {
  const correlation = { kind: "continuation" as const, id: "inspect-c1", revision: 1 };
  const input = { runId: "run", type: "run.started" as const, payload: {} };

  it("reconfirms an fsync-failed marker after reconstruction without writing or notifying", async () => {
    const { dir } = await fixture();
    const original = new JsonlEventStore(dir);
    const prototype = await handlePrototype(join(dir, "probe"));
    const failure = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("publication fsync failed"));
    await expect(
      original.appendDurableUnique(input, {
        expectedSeq: -1,
        correlation,
        equivalent: () => true,
      }),
    ).rejects.toThrow("publication fsync failed");
    failure.mockRestore();
    const file = join(dir, "runs", "run.jsonl");
    const contents = await readFile(file, "utf8");
    const reopened = new JsonlEventStore(dir);
    const listener = vi.fn();
    reopened.subscribe(listener);
    const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("inspection fsync failed"));
    await expect(reopened.synchronizeJournal("run", correlation)).rejects.toThrow("inspection fsync failed");
    sync.mockRestore();
    const write = vi.spyOn(prototype, "writeFile");
    await reopened.synchronizeJournal("run", correlation);
    expect(write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("refuses missing or rewound markers, missing files and incomplete tails without reconstruction", async () => {
    const { dir } = await fixture();
    const events = new JsonlEventStore(dir);
    await events.appendDurableUnique(input, { expectedSeq: -1, correlation, equivalent: () => true });
    const file = join(dir, "runs", "run.jsonl");
    const marker = await readFile(file, "utf8");
    await expect(events.synchronizeJournal("run", { ...correlation, revision: 2 })).rejects.toThrow("missing");
    expect(await readFile(file, "utf8")).toBe(marker);
    for (const bytes of ["", marker.trimEnd(), marker + '{"seq":']) {
      await writeFile(file, bytes);
      await expect(events.synchronizeJournal("run", correlation)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(bytes);
    }
    await rm(file);
    await expect(events.synchronizeJournal("run", correlation)).rejects.toThrow();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate correlation and wrong-run history during synchronization", async () => {
    const { dir } = await fixture();
    const events = new JsonlEventStore(dir);
    const marker = await events.appendDurableUnique(input, { expectedSeq: -1, correlation, equivalent: () => true });
    const file = join(dir, "runs", "run.jsonl");
    const duplicate = JSON.stringify(marker) + "\n" + JSON.stringify({ ...marker, seq: 1 }) + "\n";
    await writeFile(file, duplicate);
    await expect(events.synchronizeJournal("run", correlation)).rejects.toThrow("duplicate correlations");
    expect(await readFile(file, "utf8")).toBe(duplicate);
    const foreign = JSON.stringify({ ...marker, runId: "foreign" }) + "\n";
    await writeFile(file, foreign);
    await expect(events.synchronizeJournal("run", correlation)).rejects.toThrow("run identity");
    expect(await readFile(file, "utf8")).toBe(foreign);
  });

  it("authenticates protected material without new private writes or subscriber effects", async () => {
    const { dir } = await fixture();
    const execution = new FileExecutionStore(dir);
    await execution.putInputs({
      runId: "run",
      workflowId: "workflow",
      workflowVersion: "1",
      vars: {},
      sensitiveNames: [],
      secrets: [],
    });
    const events = new ProtectedEventStore(new JsonlEventStore(dir), execution);
    await events.appendDurableUnique(
      {
        runId: "run",
        type: "continuation.recorded",
        payload: { continuationId: correlation.id, state: "accepted", entry: { schemaVersion: 1, secret: "private" } },
      },
      { expectedSeq: -1, correlation, equivalent: () => true },
    );
    const writes = vi.spyOn(execution, "putPayload");
    const listener = vi.fn();
    events.subscribe(listener);
    const contents = await readFile(join(dir, "runs", "run.jsonl"), "utf8");
    await events.synchronizeJournal("run", correlation);
    expect(writes).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "runs", "run.jsonl"), "utf8")).toBe(contents);
    const marker = (await events.read("run"))[0]!;
    await rm(join(dir, "private-execution", `${encodeURIComponent(marker.executionPayloadRef!)}.payload.json`));
    await expect(events.synchronizeJournal("run", correlation)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });

  it("fails closed when protected synchronization is unsupported", async () => {
    const { dir } = await fixture();
    const publicEvents = new JsonlEventStore(dir);
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
      new FileExecutionStore(dir),
    );
    await expect(events.synchronizeJournal("run", correlation)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
