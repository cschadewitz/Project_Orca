/**
 * A populated file store for the SQLite switch and conversion tests (#339): something at every
 * path the legacy fence covers, with what each test checks about it.
 */
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { parseWorkflow, RequestSchema, sha256 } from "@orca/core";
import {
  enterStoreFormat,
  fileStores,
  LEGACY_FENCE_MARKER,
  LEGACY_FENCES,
  SQLITE_METADATA_FILE,
  SQLITE_SWITCH_DIR,
  sqliteStores,
} from "@orca/store";
import { readPrivateJson, writePrivateJson } from "../../src/protected-file.js";

export const store = async () => join(await mkdtemp(join(tmpdir(), "orca-legacy-fence-")), ".orca");
export const refusal = (reason: string) => ({ code: "STORE_FORMAT", details: expect.objectContaining({ reason }) });

export const workflow = parseWorkflow(`id: pinned\nname: Pinned\nstart: e\nnodes: { e: { type: end } }\nedges: []`);
export const oldWorkflow = parseWorkflow(`id: old\nname: Old\nstart: e\nnodes: { e: { type: end } }\nedges: []`);

/** A store on files with something at every path the fence covers (at `at`, or a new one). */
export async function populated(at?: string): Promise<string> {
  const dir = at ?? (await store());
  await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" });
  const files = fileStores(dir);
  await files.events.append({
    type: "run.created",
    runId: "run_a",
    payload: { workflowId: "pinned", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
  });
  await files.events.append({ type: "run.started", runId: "run_a", payload: {} });
  await files.requests.put(
    RequestSchema.parse({
      id: "req_1",
      title: "A request",
      body: "",
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
    }),
  );
  await files.plan.journal.append({
    type: "request.linked",
    planId: "plan_a",
    origin: { kind: "api" },
    payload: { requestId: "req_1" },
  });
  await files.artifacts.put(
    {
      id: "art_1",
      kind: "spec",
      name: "note",
      mediaType: "text/plain",
      contentHash: sha256("hello"),
      size: 5,
      version: 1,
      producedBy: { runId: "run_a" },
      createdAt: "t",
    } as never,
    "hello",
  );
  await files.workflows.put(workflow);
  await writePrivateJson(join(dir, "private-execution"), "record.json", { secret: 1 });
  // A plain snapshot an ORCA before 0.7 pinned.
  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(join(dir, "workflows", "old@v1.json"), JSON.stringify(oldWorkflow));
  return dir;
}

/** Every file's bytes, leaving out what a refused switch may leave (backups, the inert database). */
export async function contents(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const name of (await readdir(path)).sort()) {
      const relative = `${prefix}${name}`;
      if (name.endsWith(".lock") || relative.startsWith("format-backups") || name.startsWith(SQLITE_METADATA_FILE))
        continue;
      const info = await lstat(join(path, name));
      if (info.isDirectory()) await walk(join(path, name), `${relative}/`);
      else out[relative] = (await readFile(join(path, name))).toString("base64");
    }
  };
  await walk(dir, "");
  return out;
}

export async function isMarker(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return false;
  const file = info.isDirectory() ? join(path, "ORCA-SQLITE-STORE.json") : path; // rename-keep: the fence marker name existing stores hold
  return (await readFile(file, "utf8").catch(() => "")) === LEGACY_FENCE_MARKER;
}

export async function expectFenced(dir: string): Promise<void> {
  for (const fence of LEGACY_FENCES) expect(await isMarker(join(dir, fence.path)), fence.path).toBe(true);
  expect(await readdir(dir)).not.toContain(SQLITE_SWITCH_DIR);
}

export async function expectReadsOnSqlite(dir: string): Promise<void> {
  const sqlite = sqliteStores(dir);
  try {
    expect((await sqlite.events.read("run_a")).map((e) => e.type)).toEqual(["run.created", "run.started"]);
    expect((await sqlite.requests.list()).map((r) => r.id)).toEqual(["req_1"]);
    expect((await sqlite.plan.journal.read("plan_a")).length).toBe(1);
    expect((await sqlite.artifacts.list()).map((a) => a.id)).toEqual(["art_1"]);
    expect(await sqlite.workflows.get("pinned", workflow.version)).toEqual(workflow);
    expect(await sqlite.workflows.get("old", oldWorkflow.version)).toEqual(oldWorkflow);
    expect(await readPrivateJson(join(dir, "private-execution"), "record.json")).toEqual({ secret: 1 });
  } finally {
    sqlite.close?.();
  }
}
