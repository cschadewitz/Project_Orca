import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, type Artifact } from "@orca/core";
import { FileArtifactStore, InMemoryEventStore, JsonlEventStore } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("event stores", () => {
  for (const [name, make] of [
    ["memory", async () => new InMemoryEventStore(new FakeClock())],
    ["jsonl", async () => {
      const d = await mkdtemp(join(tmpdir(), "orca-store-"));
      dirs.push(d);
      return new JsonlEventStore(d, new FakeClock());
    }],
  ] as const) {
    it(`${name}: assigns gap-free seq per run and notifies subscribers`, async () => {
      const store = await make();
      const seen: number[] = [];
      store.subscribe((e) => seen.push(e.seq), { runId: "run_a" });
      await Promise.all([
        store.append({ type: "run.created", runId: "run_a", payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} } }),
        store.append({ type: "run.started", runId: "run_a", payload: {} }),
        store.append({ type: "run.created", runId: "run_b", payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} } }),
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
    ["jsonl", async () => {
      const d = await mkdtemp(join(tmpdir(), "orca-store-"));
      dirs.push(d);
      return new JsonlEventStore(d, new FakeClock());
    }],
  ] as const) {
    it(`${name}: readTypes returns only the requested types, in order`, async () => {
      const store = await make();
      await store.append({ type: "run.created", runId: "run_a", payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} } });
      await store.append({ type: "run.started", runId: "run_a", payload: {} });
      // A payload that quotes an event type must not be mistaken for one.
      await store.append({ type: "agent.update", runId: "run_a", payload: { stepRunId: "step_1", sessionId: "s", update: { kind: "agent_message_chunk", text: '"type":"run.completed"' } } });
      await store.append({ type: "run.completed", runId: "run_a", payload: { outcome: "success" } });
      const got = await store.readTypes("run_a", ["run.created", "run.completed"]);
      expect(got.map((e) => [e.type, e.seq])).toEqual([["run.created", 0], ["run.completed", 3]]);
      expect(await store.readTypes("run_missing", ["run.created"])).toEqual([]);
    });
  }
  it("jsonl store survives a restart", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-store-"));
    dirs.push(d);
    const first = new JsonlEventStore(d);
    await first.append({ type: "run.created", runId: "run_x", payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} } });
    const second = new JsonlEventStore(d);
    const e = await second.append({ type: "run.started", runId: "run_x", payload: {} });
    expect(e.seq).toBe(1);
  });
});

describe("file artifact store", () => {
  it("persists content by hash and lists by query", async () => {
    const d = await mkdtemp(join(tmpdir(), "orca-art-"));
    dirs.push(d);
    const store = new FileArtifactStore(d);
    const a: Artifact = { id: "art_1", kind: "spec", name: "spec", mediaType: "text/markdown", contentHash: "abc", size: 5, version: 1, producedBy: { runId: "run_1" }, parents: [], data: {}, createdAt: "t" };
    await store.put(a, "hello");
    expect(await new FileArtifactStore(d).content("art_1")).toBe("hello");
    expect((await store.list({ kind: "spec" })).map((x) => x.id)).toEqual(["art_1"]);
    expect(await store.list({ kind: "plan" })).toEqual([]);
  });
});
