import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  it("finds a claimed key without ever claiming one (#883)", async () => {
    const { dir, store, options } = await fixture();
    // No claim yet: nothing is found, and nothing (not even the lookup salt) is created.
    expect(await store.find(scope, "same-key")).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    const { record } = await store.claim(scope, "same-key", {}, "same");
    for (const reader of [store, new FileRetryClaimStore(options)])
      expect(await reader.find(scope, "same-key")).toMatchObject({ operationId: record.operationId });
    expect(await store.find(scope, "other-key")).toBeUndefined();
    expect(await store.find({ ...scope, principalId: "bob" }, "same-key")).toBeUndefined();
  });
  it.each([undefined, "0\n"])("empty recovery batches do not publish an unchanged cursor (%s)", async (stored) => {
    const { dir, store } = await fixture();
    const journal = join(dir, "admission-retries");
    await mkdir(journal, { mode: 0o700 });
    if (stored !== undefined) await writeFile(join(journal, "cursor.json"), stored, { mode: 0o600 });
    for (let i = 0; i < 2; i++) {
      expect(await store.batch()).toEqual([]);
      expect(await readdir(journal)).toEqual(stored === undefined ? [] : ["cursor.json"]);
      if (stored !== undefined) expect(await readFile(join(journal, "cursor.json"), "utf8")).toBe(stored);
    }
  });
  it("repeated full-page recovery preserves the settled cursor without rewriting it", async () => {
    const { dir, store, options } = await fixture();
    const { record } = await store.claim(scope, "same-key", {}, "same");
    const cursor = join(dir, "admission-retries", "cursor.json");
    expect(await store.batch()).toEqual([record.operationId]);
    expect(await readFile(cursor, "utf8")).toBe("1");
    // Equivalent noncanonical JSON makes any redundant publication observable without timing assumptions.
    await writeFile(cursor, "1\n", { mode: 0o600 });
    for (const reader of [store, new FileRetryClaimStore(options)]) {
      expect(await reader.batch()).toEqual([record.operationId]);
      expect(await readFile(cursor, "utf8")).toBe("1\n");
    }
  });
  it("closed observation neither creates a journal nor advances an empty existing cursor", async () => {
    const { dir, store } = await fixture();
    expect(await store.closedWorkState()).toBe("empty");
    expect(await readdir(dir)).toEqual([]);
    const journal = join(dir, "admission-retries");
    await mkdir(journal, { mode: 0o700 });
    await writeFile(join(journal, "cursor.json"), "0", { mode: 0o600 });
    expect(await store.closedWorkState()).toBe("empty");
    expect(await readFile(join(journal, "cursor.json"), "utf8")).toBe("0");
    expect(await readdir(journal)).toEqual(["cursor.json"]);
  });
  it.each(["retained", "pending", "orphan", "corrupt", "inconsistent-counter"])(
    "closed observation retains %s state without repairing it",
    async (kind) => {
      const { dir, store } = await fixture(),
        journal = join(dir, "admission-retries");
      await mkdir(journal, { mode: 0o700 });
      const body =
        kind === "corrupt"
          ? "{"
          : JSON.stringify({
              total: kind === "retained" ? 1 : 0,
              workspaces: kind === "inconsistent-counter" ? { workspace: 1 } : {},
              principals: {},
              ...(kind === "pending"
                ? {
                    pending: {
                      operationId: "retry_00000000-0000-4000-8000-000000000001",
                      ref: "00000000-0000-4000-8000-000000000002",
                      ordinal: 1,
                    },
                  }
                : {}),
            });
      const name = kind === "orphan" ? "entry-1.json" : "catalog.json";
      await writeFile(join(journal, name), body, { mode: 0o600 });
      expect(await store.closedWorkState()).toBe(
        ["retained", "pending"].includes(kind) ? "parked" : "unsupported-generation",
      );
      expect(await readFile(join(journal, name), "utf8")).toBe(body);
      expect(await readdir(journal)).toEqual([name]);
    },
  );
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
