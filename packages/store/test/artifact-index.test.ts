/** Artifact index writes are shared across instances and survive a torn tail (#102). */
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256, silentLogger, type Artifact } from "@orca/core";
import { FileArtifactStore } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const artifact = (id: string): Artifact => ({
  id,
  kind: "report",
  name: id,
  version: 1,
  mediaType: "text/markdown",
  contentHash: sha256(id),
  size: id.length,
  data: {},
  parents: [],
  producedBy: { runId: "run_test" },
  createdAt: new Date().toISOString(),
});

it("independent readers see all concurrent writes, recover torn bytes, and preserve the old index schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-artifact-index-"));
  dirs.push(dir);
  const warnings: string[] = [];
  const logger = {
    ...silentLogger,
    warn: (message: string) => {
      warnings.push(message);
    },
  };
  const first = new FileArtifactStore(dir, logger);
  const second = new FileArtifactStore(dir, logger);
  expect(await first.list()).toEqual([]);
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).put(artifact(`art_${i}`), `art_${i}`)),
  );
  expect(await first.list()).toHaveLength(30);
  expect(await second.list()).toHaveLength(30);
  const file = join(dir, "artifacts", "index.jsonl");
  await appendFile(file, '{"id":"torn');
  expect(await first.list()).toHaveLength(30);
  await second.put(artifact("art_after"), "art_after");
  expect(await first.list()).toHaveLength(31);
  expect(await first.content("art_after")).toBe("art_after");
  const rows = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows).toHaveLength(31);
  expect(rows.every((row) => !("seq" in row))).toBe(true);
  expect(warnings.length).toBeGreaterThan(0);
});

it("never exposes valid JSON from an append missing its commit newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-artifact-index-"));
  dirs.push(dir);
  const store = new FileArtifactStore(dir);
  await store.put(artifact("art_before"), "art_before");
  await appendFile(join(dir, "artifacts", "index.jsonl"), JSON.stringify(artifact("art_uncommitted")));
  expect(await store.get("art_uncommitted")).toBeUndefined();
  expect((await store.list()).map((entry) => entry.id)).toEqual(["art_before"]);
  await store.put(artifact("art_after"), "art_after");
  expect(await store.get("art_uncommitted")).toBeUndefined();
  expect((await store.list()).map((entry) => entry.id)).toEqual(["art_before", "art_after"]);
});
