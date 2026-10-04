import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import type { RetryScope } from "../../core/src/model/admission-retry.js";
import { FileRetryClaimStore } from "../src/admission-retry-store.js";
import { FileExecutionStore } from "../src/execution-store.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "Limit"),
};
const scope: RetryScope = { principalId: "alice", workspaceId: "workspace", kind: "revision.submit" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-fresh-store-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  const options = {
    storeDir: dir,
    execution,
    faults,
    limits: { maxClaimsPerPrincipal: 1 },
    lockTimeoutMs: 2_000,
  };
  return { dir, execution, options, store: new FileRetryClaimStore(options) };
}

describe("fresh retry claim validation", () => {
  it.each([undefined, "same-key"])("a rejection publishes no claim and releases the mutex (key: %s)", async (key) => {
    const { dir, store, execution } = await fixture();
    const writes = vi.spyOn(execution, "putGeneration");
    const refusal = new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid fresh input");
    const validate = vi.fn(async () => {
      throw refusal;
    });
    await expect(store.claim(scope, key, { value: "invalid" }, "invalid", validate)).rejects.toBe(refusal);
    expect(validate).toHaveBeenCalledTimes(1);
    // Initial salt creation is metadata only; no protected claim or keyed lookup is written.
    expect(writes.mock.calls.map(([id]) => id)).toEqual(["admission-retry-lookup"]);
    expect(await readdir(join(dir, "admission-retries"))).toEqual([]);
    expect(await store.batch()).toEqual([]);

    const corrected = await store.claim(scope, key, { value: "corrected" }, "corrected", async () => {});
    expect(corrected).toMatchObject({ fresh: true, record: { command: { value: "corrected" }, phase: "claimed" } });
    expect(await store.batch()).toEqual([corrected.record.operationId]);
    await expect(store.claim(scope, "another-key", {}, "different")).rejects.toMatchObject({ code: "RETRY_LIMIT" });
  });

  it.each(["claimed", "bound", "accepted"] as const)(
    "returns existing %s material without fresh validation, even for changed intent",
    async (phase) => {
      const { store } = await fixture();
      const first = await store.claim(scope, "same-key", { value: "original" }, "original");
      const record = {
        ...first.record,
        phase,
        ...(phase !== "claimed" ? { binding: { revisionId: "revision" } } : {}),
        ...(phase === "accepted" ? { result: { revisionId: "revision" } } : {}),
      };
      await store.lock(record.operationId, () => store.write(record));
      const validate = vi.fn(async () => {
        throw new Error("Moving validation must not run for existing keys");
      });
      expect(await store.claim(scope, "same-key", { value: "original" }, "original", validate)).toEqual({
        fresh: false,
        record,
      });
      expect(await store.claim(scope, "same-key", { value: "changed" }, "changed", validate)).toEqual({
        fresh: false,
        record,
      });
      expect(validate).not.toHaveBeenCalled();
      expect(await store.batch()).toEqual([record.operationId]);
    },
  );

  it("serializes same-key contenders through one validator and one claim publication", async () => {
    const { store, options, execution } = await fixture();
    const other = new FileRetryClaimStore(options);
    const writes = vi.spyOn(execution, "putGeneration");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validate = vi.fn(async () => {
      entered();
      await waiting;
    });
    const first = store.claim(scope, "same-key", { value: "same" }, "same", validate);
    await ready;
    const second = other.claim(scope, "same-key", { value: "same" }, "same", validate);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.fresh).toBe(true);
    expect(two).toEqual({ record: one.record, fresh: false });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls.filter(([id]) => /^admission-retry-[a-f0-9-]{36}$/.test(id))).toHaveLength(1);
    expect(writes.mock.calls.filter(([id]) => id.startsWith("admission-retry-key-"))).toHaveLength(1);
    expect(await store.batch()).toEqual([one.record.operationId]);
  });
});
