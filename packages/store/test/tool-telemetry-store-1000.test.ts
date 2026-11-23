/**
 * Tool-call telemetry records (#1000): per run and session, beside the store's other data,
 * with export, deletion and expiry, and no change to the store's format.
 */
import { appendFile, chmod, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallTelemetry } from "@orca/core";
import {
  fileStores,
  FileToolTelemetryStore,
  fileToolTelemetryStore,
  InMemoryToolTelemetryStore,
  memoryStores,
  sqliteStores,
  TOOL_TELEMETRY_DIR,
  toolTelemetrySegment,
  type ToolTelemetryStore,
} from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-telemetry-"));
  dirs.push(dir);
  return dir;
}

function record(
  runId: string,
  sessionId: string,
  seq: number,
  expiresAt = "2030-01-01T00:00:00.000Z",
): ToolCallTelemetry {
  return {
    v: 1,
    id: `${sessionId}:${seq}`,
    runId,
    sessionId,
    stepRunId: "step_1",
    agentId: "claude",
    seq,
    source: "hook-reported",
    receivedAt: "2026-11-23T10:00:00.000Z",
    expiresAt,
    reportedAt: "2026-11-23T10:00:00.000Z",
    tool: { text: "Bash", length: 4 },
    title: { text: "npm test", length: 8 },
    decision: "allow",
    latencyMs: 3,
  };
}

const backends: [string, () => Promise<{ store: ToolTelemetryStore; dir?: string }>][] = [
  ["memory", async () => ({ store: new InMemoryToolTelemetryStore() })],
  [
    "files",
    async () => {
      const dir = await tmp();
      return { store: new FileToolTelemetryStore(dir), dir };
    },
  ],
];

describe.each(backends)("tool telemetry store (%s)", (_name, make) => {
  it("keeps records per run and session, in order, and exports them", async () => {
    const { store } = await make();
    await store.append([record("run_a", "sess_1", 0), record("run_a", "sess_1", 1)]);
    await store.append([record("run_a", "sess_2", 0)]);
    await store.append([record("run_b", "sess_3", 0)]);
    expect((await store.list({ runId: "run_a" })).map((r) => r.id)).toEqual(["sess_1:0", "sess_1:1", "sess_2:0"]);
    expect((await store.list({ runId: "run_a", sessionId: "sess_2" })).map((r) => r.id)).toEqual(["sess_2:0"]);
    expect(await store.list({ runId: "run_none" })).toEqual([]);
    expect(await store.runs()).toEqual(["run_a", "run_b"]);
  });

  it("refuses a batch that mixes runs or sessions", async () => {
    const { store } = await make();
    await expect(store.append([record("run_a", "sess_1", 0), record("run_a", "sess_2", 0)])).rejects.toThrow(
      /one run and session/,
    );
    expect(await store.list({ runId: "run_a" })).toEqual([]);
  });

  it("deletes one session's records, or a whole run's", async () => {
    const { store } = await make();
    await store.append([record("run_a", "sess_1", 0), record("run_a", "sess_1", 1)]);
    await store.append([record("run_a", "sess_2", 0)]);
    await store.append([record("run_b", "sess_3", 0)]);
    expect(await store.delete({ runId: "run_a", sessionId: "sess_1" })).toBe(2);
    expect((await store.list({ runId: "run_a" })).map((r) => r.id)).toEqual(["sess_2:0"]);
    expect(await store.delete({ runId: "run_a" })).toBe(1);
    expect(await store.list({ runId: "run_a" })).toEqual([]);
    expect(await store.runs()).toEqual(["run_b"]);
    expect(await store.delete({ runId: "run_a" })).toBe(0);
  });

  it("refuses records that arrive for a run or session after it was deleted", async () => {
    const { store } = await make();
    expect(await store.append([record("run_a", "sess_1", 0)])).toBe(1);
    await store.delete({ runId: "run_a", sessionId: "sess_1" });
    // A live session's late records do not bring deleted diagnostics back.
    expect(await store.append([record("run_a", "sess_1", 1)])).toBe(0);
    expect(await store.append([record("run_a", "sess_2", 0)])).toBe(1);
    await store.delete({ runId: "run_a" });
    expect(await store.append([record("run_a", "sess_3", 0)])).toBe(0);
    expect(await store.list({ runId: "run_a" })).toEqual([]);
    expect(await store.runs()).toEqual([]);
  });

  it("never lists or exports an expired record, swept or not", async () => {
    const { store } = await make();
    await store.append([
      record("run_a", "sess_1", 0, "2026-11-01T00:00:00.000Z"),
      record("run_a", "sess_1", 1, "2026-12-01T00:00:00.000Z"),
    ]);
    await store.append([record("run_b", "sess_2", 0, "2026-11-01T00:00:00.000Z")]);
    const now = new Date("2026-11-23T00:00:00.000Z");
    expect((await store.list({ runId: "run_a" }, { now })).map((r) => r.id)).toEqual(["sess_1:1"]);
    expect(await store.list({ runId: "run_b" }, { now })).toEqual([]);
    expect(await store.runs({ now })).toEqual(["run_a"]);
    expect(await store.list({ runId: "run_a" }, { now: new Date("2026-12-02T00:00:00.000Z") })).toEqual([]);
  });

  it("expires records past their retention, keeping the rest", async () => {
    const { store } = await make();
    await store.append([
      record("run_a", "sess_1", 0, "2026-11-01T00:00:00.000Z"),
      record("run_a", "sess_1", 1, "2026-12-01T00:00:00.000Z"),
    ]);
    await store.append([record("run_b", "sess_2", 0, "2026-11-01T00:00:00.000Z")]);
    expect(await store.prune(new Date("2026-11-23T00:00:00.000Z"))).toBe(2);
    expect((await store.list({ runId: "run_a" })).map((r) => r.id)).toEqual(["sess_1:1"]);
    expect(await store.runs()).toEqual(["run_a"]);
    expect(await store.prune(new Date("2026-11-23T00:00:00.000Z"))).toBe(0);
    expect(await store.prune(new Date("2026-12-02T00:00:00.000Z"))).toBe(1);
    expect(await store.runs()).toEqual([]);
  });
});

describe("tool telemetry files", () => {
  it("lives under diagnostics/tool-calls, owner-only, and leaves only a marker once deleted", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    const file = join(dir, TOOL_TELEMETRY_DIR, "run_a", "sess_1.jsonl");
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({ id: "sess_1:0" });
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect((await stat(join(dir, TOOL_TELEMETRY_DIR, "run_a"))).mode & 0o077).toBe(0);
    }
    await store.delete({ runId: "run_a", sessionId: "sess_1" });
    // Only the marker that refuses the session's late records is left.
    expect(await readdir(join(dir, TOOL_TELEMETRY_DIR, "run_a"))).toEqual(["sess_1.deleted"]);
  });

  it("skips a torn or foreign line and keeps reading", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    const file = join(dir, TOOL_TELEMETRY_DIR, "run_a", "sess_1.jsonl");
    await appendFile(
      file,
      `{"v":1,"id":"half\nnot json\n${JSON.stringify({ ...record("run_a", "sess_1", 1), source: "orca-observed" })}\n`,
    );
    await store.append([record("run_a", "sess_1", 2)]);
    expect((await store.list({ runId: "run_a" })).map((r) => r.id)).toEqual(["sess_1:0", "sess_1:2"]);
    // Expiry rewrites the file with only what it can read and keep.
    expect(await store.prune(new Date("2026-11-23T00:00:00.000Z"))).toBe(0);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("never lets an id name a path outside its directory", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    const runId = "../../escape";
    const sessionId = "a/b\\..";
    await store.append([record(runId, sessionId, 0)]);
    expect(toolTelemetrySegment(runId)).toMatch(/^x-[0-9a-f]{40}$/);
    expect(await readdir(dir)).toEqual(["diagnostics"]);
    expect(await readdir(join(dir, TOOL_TELEMETRY_DIR))).toEqual([".deleted", ".locks", toolTelemetrySegment(runId)]);
    expect((await store.list({ runId, sessionId })).map((r) => r.runId)).toEqual([runId]);
    expect(await store.runs()).toEqual([runId]);
  });

  it("is part of every backend's stores, and changes nothing else in the store", async () => {
    expect(memoryStores().toolTelemetry).toBeInstanceOf(InMemoryToolTelemetryStore);
    const dir = await tmp();
    const stores = fileStores(dir);
    expect(stores.toolTelemetry).toBeInstanceOf(FileToolTelemetryStore);
    await writeFile(join(dir, "marker"), "");
    const before = (await readdir(dir)).sort();
    await stores.toolTelemetry!.append([record("run_a", "sess_1", 0)]);
    expect((await readdir(dir)).sort()).toEqual([...before, "diagnostics"].sort());
    const sqliteDir = await tmp();
    const sqlite = sqliteStores(sqliteDir);
    try {
      expect(sqlite.toolTelemetry).toBeInstanceOf(FileToolTelemetryStore);
    } finally {
      sqlite.close?.();
    }
  });

  it("keeps run locks outside the run's directory, and deleting a run never removes one", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    const root = join(dir, TOOL_TELEMETRY_DIR);
    expect((await readdir(root)).sort()).toEqual([".deleted", ".locks", "run_a"]);
    // Appends, deletes and sweeps of one run take turns.
    await Promise.all([
      store.append([record("run_a", "sess_1", 1)]),
      store.delete({ runId: "run_a" }),
      store.append([record("run_a", "sess_2", 0)]),
      store.prune(new Date()),
    ]);
    expect(await readdir(join(root, ".locks"))).toEqual([]);
    expect(await store.list({ runId: "run_a" })).toEqual([]);
    expect(await readdir(root)).not.toContain("run_a");
  });

  it("keeps deletion markers for good: a run's later sessions stay refused", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.delete({ runId: "run_a" });
    await store.prune(new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000));
    expect(await store.append([record("run_a", "sess_9", 0)])).toBe(0);
  });

  it("hides a scope as soon as its marker is down, and prune finishes an interrupted deletion", async () => {
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    await store.append([record("run_a", "sess_2", 0)]);
    await store.append([record("run_b", "sess_3", 0)]);
    const root = join(dir, TOOL_TELEMETRY_DIR);
    // Deletions that stopped right after their markers: the records are still on disk.
    await writeFile(join(root, "run_a", "sess_1.deleted"), "{}\n", { mode: 0o600 });
    await writeFile(join(root, ".deleted", "run_b"), "{}\n", { mode: 0o600 });
    expect((await store.list({ runId: "run_a" })).map((r) => r.id)).toEqual(["sess_2:0"]);
    expect(await store.list({ runId: "run_a", sessionId: "sess_1" })).toEqual([]);
    expect(await store.list({ runId: "run_b" })).toEqual([]);
    expect(await store.runs()).toEqual(["run_a"]);
    expect(await store.append([record("run_a", "sess_1", 1)])).toBe(0);
    expect(await store.append([record("run_b", "sess_3", 1)])).toBe(0);
    await store.prune(new Date());
    expect((await readdir(join(root, "run_a"))).sort()).toEqual(["sess_1.deleted", "sess_2.jsonl"]);
    expect(await readdir(root)).not.toContain("run_b");
    expect(await readdir(join(root, ".deleted"))).toEqual(["run_b"]);
  });

  it("lists runs without opening what a marker hides, so a leftover cannot block the listing", async () => {
    if (process.platform === "win32") return;
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    await store.append([record("run_a", "sess_2", 0)]);
    await store.append([record("run_b", "sess_3", 0)]);
    await store.append([record("run_c", "sess_4", 0)]);
    const root = join(dir, TOOL_TELEMETRY_DIR);
    // Interrupted deletions whose leftovers can no longer be read: one shared, one a FIFO.
    await writeFile(join(root, ".deleted", "run_b"), "{}\n", { mode: 0o600 });
    await chmod(join(root, "run_b", "sess_3.jsonl"), 0o644);
    await writeFile(join(root, "run_a", "sess_1.deleted"), "{}\n", { mode: 0o600 });
    await rm(join(root, "run_a", "sess_1.jsonl"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", ["-m", "600", join(root, "run_a", "sess_1.jsonl")]);
    expect(await store.runs()).toEqual(["run_a", "run_c"]);
    // A record filed where it does not belong does not name its run.
    await writeFile(join(root, "run_c", "sess_9.jsonl"), `${JSON.stringify(record("run_z", "sess_9", 0))}\n`, {
      mode: 0o600,
    });
    expect(await store.runs()).toEqual(["run_a", "run_c"]);
    // prune finishes both and the listing stays the same.
    await store.prune(new Date());
    expect(await store.runs()).toEqual(["run_a", "run_c"]);
  });

  it("refuses to read or write through a link, a shared mode, a foreign file or a second name", async () => {
    if (process.platform === "win32") return;
    const dir = await tmp();
    const store = new FileToolTelemetryStore(dir);
    await store.append([record("run_a", "sess_1", 0)]);
    const root = join(dir, TOOL_TELEMETRY_DIR);
    const file = join(root, "run_a", "sess_1.jsonl");

    await chmod(file, 0o644);
    await expect(store.list({ runId: "run_a" })).rejects.toThrow(/open to group or others/);
    await expect(store.append([record("run_a", "sess_1", 1)])).rejects.toThrow(/open to group or others/);
    await chmod(file, 0o600);

    await link(file, join(dir, "alias"));
    await expect(store.list({ runId: "run_a" })).rejects.toThrow(/another name/);
    await rm(join(dir, "alias"));

    // A session file replaced by a link to somewhere else is not followed, for reads or writes.
    const outside = join(dir, "outside.jsonl");
    await writeFile(outside, `${JSON.stringify(record("run_a", "sess_1", 9))}\n`, { mode: 0o600 });
    await rm(file);
    await symlink(outside, file);
    await expect(store.list({ runId: "run_a" })).rejects.toThrow();
    await expect(store.append([record("run_a", "sess_1", 1)])).rejects.toThrow();
    expect((await readFile(outside, "utf8")).trim().split("\n")).toHaveLength(1);

    // A FIFO in the file's place neither holds a reader or writer nor is used.
    await rm(file);
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", ["-m", "600", file]);
    await expect(store.list({ runId: "run_a" })).rejects.toThrow(/not a regular file/);
    await expect(store.append([record("run_a", "sess_1", 1)])).rejects.toThrow();
    await rm(file);

    // The run's directory itself replaced by a link.
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await rm(join(root, "run_a"), { recursive: true });
    await symlink(elsewhere, join(root, "run_a"));
    await expect(store.append([record("run_a", "sess_1", 1)])).rejects.toThrow(/not a directory/);
    expect(await readdir(elsewhere)).toEqual([]);

    // The diagnostics directory opened up to others.
    await chmod(join(dir, "diagnostics"), 0o755);
    await expect(store.runs()).rejects.toThrow(/open to group or others/);
  });
});

describe("on Windows", () => {
  it("keeps no telemetry store, and the file store refuses every operation", async () => {
    const dir = await tmp();
    expect(fileToolTelemetryStore(dir, "win32")).toBeUndefined();
    expect(fileToolTelemetryStore(dir, "linux")).toBeInstanceOf(FileToolTelemetryStore);
    const store = new FileToolTelemetryStore(dir, { platform: "win32" });
    const refused = { code: "NOT_SUPPORTED", message: expect.stringContaining("not supported on Windows") };
    await expect(store.append([record("run_a", "sess_1", 0)])).rejects.toMatchObject(refused);
    await expect(store.list({ runId: "run_a" })).rejects.toMatchObject(refused);
    await expect(store.runs()).rejects.toMatchObject(refused);
    await expect(store.delete({ runId: "run_a" })).rejects.toMatchObject(refused);
    await expect(store.prune(new Date())).rejects.toMatchObject(refused);
    expect(await readdir(dir)).toEqual([]);
  });
});
