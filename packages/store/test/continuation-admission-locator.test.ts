import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "../src/execution-store.js";
import { FileRetryClaimStore } from "../src/admission-retry-store.js";
import { FileContinuationLocatorStore, type ContinuationLocator } from "../src/continuation-admission-store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "Limit"),
};
function stores(dir: string) {
  const execution = new FileExecutionStore(dir);
  const retries = new FileRetryClaimStore({ storeDir: dir, execution, faults });
  const locator = new FileContinuationLocatorStore({ storeDir: dir, execution, retries, lockTimeoutMs: 5_000 });
  return { execution, retries, locator };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-locator-"));
  dirs.push(dir);
  return { dir, ...stores(dir) };
}
function material(): ContinuationLocator {
  return {
    schemaVersion: 1,
    continuationId: `ct_${randomUUID()}`,
    operationId: `retry_${randomUUID()}`,
    runId: "private-run-target",
    workspaceId: "private-workspace",
    principalId: "private-principal",
  };
}
async function claim(retries: FileRetryClaimStore, value = material(), bind = true) {
  const { record } = await retries.claim(
    { workspaceId: value.workspaceId, principalId: value.principalId, kind: "run.continue" },
    undefined,
    { runId: value.runId, expectedBoundary: "private-boundary", decision: { note: "private-note" } },
    "private-canonical",
  );
  value.operationId = record.operationId;
  if (bind)
    await retries.lock(record.operationId, () =>
      retries.write({
        ...record,
        phase: "bound",
        binding: {
          continuationId: value.continuationId,
          workspaceId: value.workspaceId,
          principalId: value.principalId,
        },
      }),
    );
  return value;
}

it("reconstructs private immutable locators from disk without creating acceptance", async () => {
  const { dir, locator, retries } = await fixture();
  const value = await claim(retries);
  await locator.bind(value);
  expect(await stores(dir).locator.read(value.continuationId)).toEqual(value);
  expect(await stores(dir).locator.batch()).toEqual([value]);
  expect(await retries.read(value.operationId)).toMatchObject({ phase: "bound" });
  expect(await readdir(dir)).not.toContain("runs");
  const files = await readdir(join(dir, "private-execution"));
  for (const file of files) {
    const bytes = await readFile(join(dir, "private-execution", file), "utf8");
    for (const secret of [value.runId, value.workspaceId, value.principalId, "private-note", "private-canonical"])
      expect(bytes).not.toContain(secret);
  }
  expect(await readdir(join(dir, "continuation-locators"))).toEqual([]);
});

it("serializes concurrent identical binders and refuses a different immutable binding", async () => {
  const { dir, locator } = await fixture();
  const value = material();
  await Promise.all(Array.from({ length: 8 }, () => stores(dir).locator.bind(value)));
  const outcomes = await Promise.allSettled([
    locator.bind(value),
    stores(dir).locator.bind({ ...value, principalId: "other-owner" }),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(await locator.read(value.continuationId)).toEqual(value);
});

it("only one different concurrent first binder wins", async () => {
  const { dir, locator } = await fixture();
  const first = material(),
    second = { ...first, runId: "other-run" };
  const outcomes = await Promise.allSettled([locator.bind(first), stores(dir).locator.bind(second)]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect([first, second]).toContainEqual(await locator.read(first.continuationId));
});

it("rejects unsafe IDs, unsupported schema, unknown fields and empty scope", async () => {
  const { locator } = await fixture();
  for (const id of ["../escape", "ct_------------------------------------", `ct_${"a".repeat(36)}`, "ct_test"])
    await expect(locator.read(id)).rejects.toMatchObject({ code: "RUN_STATE" });
  for (const patch of [
    { schemaVersion: 2 },
    { principalId: "" },
    { workspaceId: "" },
    { runId: "" },
    { state: "accepted" },
    { operationId: "retry_invalid" },
  ])
    await expect(locator.bind({ ...material(), ...patch } as ContinuationLocator)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
});

it.each(["schema", "identity", "scope"])("rejects protected but malformed %s material", async (kind) => {
  const { execution, locator } = await fixture();
  const value = material();
  const patch =
    kind === "schema"
      ? { schemaVersion: 2 }
      : kind === "identity"
        ? { continuationId: material().continuationId }
        : { workspaceId: "" };
  await execution.putGeneration(`continuation-locator-${value.continuationId}`, { ...value, ...patch });
  await expect(locator.read(value.continuationId)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("returns only candidates for missing locators regardless of cached acceptance, without writing", async () => {
  const { dir, execution, retries, locator } = await fixture();
  await retries.claim(
    { workspaceId: "workspace", principalId: "principal", kind: "request.submit" },
    undefined,
    {},
    "other",
  );
  await claim(retries, material(), false);
  const missing = await claim(retries);
  const record = (await retries.read(missing.operationId))!;
  await retries.lock(record.operationId, () =>
    retries.write({ ...record, phase: "accepted", result: { state: "accepted" } }),
  );
  const uncommitted = await claim(retries);
  const writes = vi.spyOn(execution, "putGeneration");
  const files = await readdir(join(dir, "private-execution"));
  expect(await locator.read(missing.continuationId)).toBeUndefined();
  expect(await locator.batch()).toEqual([missing, uncommitted]);
  expect(await locator.read(missing.continuationId)).toBeUndefined();
  expect(await locator.read(uncommitted.continuationId)).toBeUndefined();
  expect(await retries.read(uncommitted.operationId)).toMatchObject({ phase: "bound" });
  expect(await readdir(join(dir, "private-execution"))).toEqual(files);
  expect(await readdir(dir)).not.toContain("runs");
  expect(writes).not.toHaveBeenCalled();
  await locator.bind(missing);
  expect(await locator.batch()).toEqual([missing, uncommitted]);
});

it("uses one bounded persisted retry page and preserves the existing claim quota", async () => {
  const { dir, retries, locator, execution } = await fixture();
  for (let i = 0; i < 101; i++)
    await retries.claim(
      { workspaceId: "workspace", principalId: "principal", kind: "request.submit" },
      undefined,
      {},
      String(i),
    );
  const reads = vi.spyOn(retries, "read");
  expect(await locator.batch()).toEqual([]);
  expect(reads).toHaveBeenCalledTimes(100);
  reads.mockClear();
  const restarted = stores(dir);
  const restartedReads = vi.spyOn(restarted.retries, "read");
  expect(await restarted.locator.batch()).toEqual([]);
  expect(restartedReads).toHaveBeenCalledTimes(1);
  expect(await readFile(join(dir, "admission-retries", "cursor.json"), "utf8")).toBe("101");
  expect(await stores(dir).locator.batch()).toEqual([]);
  expect(await readFile(join(dir, "admission-retries", "cursor.json"), "utf8")).toBe("100");
  const limited = new FileRetryClaimStore({ storeDir: dir, execution, faults, limits: { maxClaimsPerWorkspace: 101 } });
  await expect(
    limited.claim({ workspaceId: "workspace", principalId: "principal", kind: "run.continue" }, undefined, {}, "extra"),
  ).rejects.toMatchObject({ code: "RETRY_LIMIT" });
});

it("fails closed on missing indexed claims or mismatched locator correlations", async () => {
  const { dir, locator, retries } = await fixture();
  const value = await claim(retries);
  await locator.bind({ ...value, runId: "wrong-run" });
  await expect(locator.batch()).rejects.toMatchObject({ code: "RUN_STATE" });
  await unlink(join(dir, "admission-retries", `${value.operationId}.json`));
  await expect(stores(dir).locator.batch()).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("refuses batch scope mismatch and overlarge provider pages", async () => {
  const { locator, retries } = await fixture();
  const value = await claim(retries);
  const record = (await retries.read(value.operationId))!;
  vi.spyOn(retries, "read").mockResolvedValue({ ...record, workspaceId: "wrong-scope" });
  await expect(locator.batch()).rejects.toMatchObject({ code: "RUN_STATE" });
  const reads = vi.spyOn(retries, "read").mockClear();
  vi.spyOn(retries, "batch").mockResolvedValue(Array<string>(101).fill(value.operationId));
  await expect(locator.batch()).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(reads).not.toHaveBeenCalled();
});

it("fails closed after key loss and does not infer acceptance after locator rewind", async () => {
  const { dir, locator, retries } = await fixture();
  const value = await claim(retries);
  await locator.bind(value);
  const path = join(dir, "private-execution", `continuation-locator-${value.continuationId}.generation.json`);
  await unlink(path);
  expect(await stores(dir).locator.read(value.continuationId)).toBeUndefined();
  const restarted = stores(dir);
  const writes = vi.spyOn(restarted.execution, "putGeneration");
  expect(await restarted.locator.batch()).toEqual([value]);
  expect(await restarted.locator.read(value.continuationId)).toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
  await locator.bind(value);
  await unlink(join(dir, "private-execution", ".execution-key"));
  await expect(stores(dir).locator.read(value.continuationId)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(stores(dir).locator.bind(value)).rejects.toMatchObject({ code: "RUN_STATE" });
});
