/**
 * The workflow-version store (#179): one file per `(id, version)` under `workflows/`, written
 * once - the first definition kept for a version is the one every later reader sees.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkflow, type WorkflowDefinition } from "@orca/core";
import { FileWorkflowVersionStore, InMemoryWorkflowVersionStore, type WorkflowVersionStore } from "@orca/store";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const def = (version: string, name = "flow"): WorkflowDefinition =>
  parseWorkflow(
    `
id: flow
name: ${name}
version: "${version}"
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges: [{ from: s, to: e }]
`,
  );

describe("workflow-version store", () => {
  for (const kind of ["memory", "file"] as const) {
    it(`${kind}: keeps each version once and lists them`, async () => {
      let store: WorkflowVersionStore;
      let dir: string | undefined;
      if (kind === "file") {
        dir = await mkdtemp(join(tmpdir(), "orca-wf-"));
        dirs.push(dir);
        store = new FileWorkflowVersionStore(dir);
      } else store = new InMemoryWorkflowVersionStore();

      expect(await store.get("flow", "1")).toBeUndefined();
      expect(await store.versions("flow")).toEqual([]);
      expect(await store.put(def("1"))).toBe(true);
      // Same version again, different content: the first one stays.
      expect(await store.put(def("1", "renamed"))).toBe(false);
      expect(await store.put(def("2"))).toBe(true);
      expect((await store.get("flow", "1"))?.name).toBe("flow");
      expect(await store.versions("flow")).toEqual(["1", "2"]);
      expect(await store.versions("other")).toEqual([]);
      if (dir)
        expect((await readdir(join(dir, "private-workflows"))).sort()).toEqual([
          ".execution-key",
          "flow@v1.json",
          "flow@v2.json",
        ]);
    });
  }

  it("file: two concurrent puts of a new version write it exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-wf-"));
    dirs.push(dir);
    const a = new FileWorkflowVersionStore(dir);
    const b = new FileWorkflowVersionStore(dir);
    const results = await Promise.all([a.put(def("3", "a")), b.put(def("3", "b"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readdir(join(dir, "private-workflows"))).toEqual([".execution-key", "flow@v3.json"]);
  });
});
