import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { consoleLogger, FakeClock, sha256, type Artifact } from "@orca/core";
import {
  FileArtifactStore,
  InMemoryDocumentStore,
  InMemoryEventStore,
  JsonFileDocumentStore,
  JsonlEventStore,
} from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("event stores", () => {
  for (const [name, make] of [
    ["memory", async () => new InMemoryEventStore(new FakeClock())],
    [
      "jsonl",
      async () => {
        const d = await mkdtemp(join(tmpdir(), "orca-store-"));
        dirs.push(d);
        return new JsonlEventStore(d, new FakeClock());
      },
    ],
  ] as const) {
    it(`${name}: assigns gap-free seq per run and notifies subscribers`, async () => {
      const store = await make();
      const seen: number[] = [];
      store.subscribe((e) => seen.push(e.seq), { runId: "run_a" });
      await Promise.all([
        store.append({
          type: "run.created",
          runId: "run_a",
          payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
        }),
        store.append({ type: "run.started", runId: "run_a", payload: {} }),
        store.append({
          type: "run.created",
          runId: "run_b",
          payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
        }),
      ]);
      const a = await store.read("run_a");
      expect(a.map((e) => e.seq)).toEqual([0, 1]);
      expect((await store.read("run_b")).map((e) => e.seq)).toEqual([0]);
      expect(seen).toEqual([0, 1]);
      expect(await store.listRuns()).toEqual(["run_a", "run_b"]);
    });
  }
  for (const [name, make] of [
    ["memory", async () => new InMemoryEventStore(new FakeClock())],
    [
      "jsonl",
      async () => {
        const d = await mkdtemp(join(tmpdir(), "orca-store-"));
        dirs.push(d);
        return new JsonlEventStore(d, new FakeClock());
      },
    ],
  ] as const) {
    it(`${name}: readTypes returns only the requested types, in order`, async () => {
      const store = await make();
      await store.append({
        type: "run.created",
        runId: "run_a",
        payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
      });
      await store.append({ type: "run.started", runId: "run_a", payload: {} });
      // A payload that quotes an event type must not be mistaken for one.
      await store.append({
        type: "agent.update",
        runId: "run_a",
        payload: {
          stepRunId: "step_1",
          sessionId: "s",
          update: { kind: "agent_message_chunk", text: '"type":"run.completed"' },
        },
      });
      await store.append({ type: "run.completed", runId: "run_a", payload: { outcome: "success" } });
      const got = await store.readTypes("run_a", ["run.created", "run.completed"]);
      expect(got.map((e) => [e.type, e.seq])).toEqual([
        ["run.created", 0],
        ["run.completed", 3],
      ]);
      expect(await store.readTypes("run_missing", ["run.created"])).toEqual([]);
    });
  }
  it("jsonl store survives a restart", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-store-"));
    dirs.push(d);
    const first = new JsonlEventStore(d);
    await first.append({
      type: "run.created",
      runId: "run_x",
      payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
    });
    const second = new JsonlEventStore(d);
    const e = await second.append({ type: "run.started", runId: "run_x", payload: {} });
    expect(e.seq).toBe(1);
  });
  it("two jsonl stores over one directory number one run consistently", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-store-"));
    dirs.push(d);
    // Two processes over one store: an ACP facade beside a resume, or two CLI invocations.
    const a = new JsonlEventStore(d);
    const b = new JsonlEventStore(d);
    await a.append({
      type: "run.created",
      runId: "run_x",
      payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
    });
    await b.append({ type: "run.started", runId: "run_x", payload: {} });
    await a.append({ type: "run.completed", runId: "run_x", payload: { outcome: "success" } });
    expect((await a.read("run_x")).map((e) => [e.type, e.seq])).toEqual([
      ["run.created", 0],
      ["run.started", 1],
      ["run.completed", 2],
    ]);
    await Promise.all([
      ...Array.from({ length: 8 }, () =>
        a.append({
          type: "agent.update",
          runId: "run_x",
          payload: { stepRunId: "s", sessionId: "s", update: { kind: "agent_message_chunk", text: "a" } },
        }),
      ),
      ...Array.from({ length: 8 }, () =>
        b.append({
          type: "agent.update",
          runId: "run_x",
          payload: { stepRunId: "s", sessionId: "s", update: { kind: "agent_message_chunk", text: "b" } },
        }),
      ),
    ]);
    expect((await b.read("run_x")).map((e) => e.seq)).toEqual(Array.from({ length: 19 }, (_, i) => i));
    expect(await a.listRuns()).toEqual(["run_x"]);
  });
  it("jsonl store reads past a torn line and keeps appending after it", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-store-"));
    dirs.push(d);
    const warnings: string[] = [];
    const store = new JsonlEventStore(
      d,
      new FakeClock(),
      consoleLogger("warn", {}, (l) => warnings.push(l)),
    );
    await store.append({
      type: "run.created",
      runId: "run_x",
      payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
    });
    await writeFile(
      join(d, "runs", "run_x.jsonl"),
      '{"type":"run.started","runId":"run_x","payload":{},"id":"evt_1","seq":1,"at":"2',
      { flag: "a" },
    );
    expect((await store.read("run_x")).map((e) => e.seq)).toEqual([0]);
    expect((await store.readTypes("run_x", ["run.started"])).length).toBe(0);
    expect((await store.append({ type: "run.started", runId: "run_x", payload: {} })).seq).toBe(1);
    expect((await store.readTypes("run_x", ["run.started"])).map((e) => e.seq)).toEqual([1]);
    expect(warnings.some((l) => l.includes("torn tail"))).toBe(true);
  });
});

describe("file artifact store", () => {
  it("persists content by hash and lists by query", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-art-"));
    dirs.push(d);
    const store = new FileArtifactStore(d);
    const a: Artifact = {
      id: "art_1",
      kind: "spec",
      name: "spec",
      mediaType: "text/markdown",
      contentHash: sha256("hello"),
      size: 5,
      version: 1,
      producedBy: { runId: "run_1" },
      parents: [],
      data: {},
      createdAt: "t",
    };
    await store.put(a, "hello");
    expect(await new FileArtifactStore(d).content("art_1")).toBe("hello");
    expect((await store.list({ kind: "spec" })).map((x) => x.id)).toEqual(["art_1"]);
    expect(await store.list({ kind: "plan" })).toEqual([]);
  });
});

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

describe("document stores", () => {
  const makeFile = async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-doc-"));
    dirs.push(d);
    return join(d, "nested", "docs.json");
  };

  for (const [name, make] of [
    ["memory", async () => new InMemoryDocumentStore<Doc>()],
    ["file", async () => new JsonFileDocumentStore<Doc>(await makeFile(), DocSchema)],
  ] as const) {
    it(`${name}: putMany writes every doc and put/delete round-trip`, async () => {
      const store = await make();
      await store.putMany([
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "c", n: 3 },
      ]);
      await store.put({ id: "b", n: 20 });
      await store.delete("c");
      await store.putMany([]);
      expect((await store.list()).map((d) => d.id).sort()).toEqual(["a", "b"]);
      expect(await store.get("b")).toEqual({ id: "b", n: 20 });
      expect(await store.get("c")).toBeUndefined();
      expect(await store.list((d) => d.n > 10)).toEqual([{ id: "b", n: 20 }]);
    });
  }

  it("file store persists across instances and coalesces concurrent writes", async () => {
    const file = await makeFile();
    const first = new JsonFileDocumentStore<Doc>(file, DocSchema);
    // Concurrent puts share one in-flight write plus one coalesced follow-up,
    // but each must still be durable once its own promise resolves.
    await Promise.all(Array.from({ length: 25 }, (_, i) => first.put({ id: `d${i}`, n: i })));
    const reopened = new JsonFileDocumentStore<Doc>(file, DocSchema);
    expect((await reopened.list()).length).toBe(25);
    expect(await reopened.get("d24")).toEqual({ id: "d24", n: 24 });

    await first.delete("d0");
    expect(await new JsonFileDocumentStore<Doc>(file, DocSchema).get("d0")).toBeUndefined();
  });

  it("file store reads an empty collection when the file is missing", async () => {
    const store = new JsonFileDocumentStore<Doc>(await makeFile(), DocSchema);
    expect(await store.list()).toEqual([]);
    expect(await store.get("nope")).toBeUndefined();
  });
});
