/**
 * Tool-call telemetry records (#1000): per run and session, beside the store's other data,
 * with export, deletion and expiry, and no change to the store's format.
 */
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallTelemetry } from "@orca/core";
import {
  fileStores,
  FileToolTelemetryStore,
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
  it("lives under diagnostics/tool-calls, owner-only, and leaves nothing behind once deleted", async () => {
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
    expect(await readdir(join(dir, TOOL_TELEMETRY_DIR))).toEqual([]);
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
    expect(await readdir(join(dir, TOOL_TELEMETRY_DIR))).toEqual([toolTelemetrySegment(runId)]);
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
});
