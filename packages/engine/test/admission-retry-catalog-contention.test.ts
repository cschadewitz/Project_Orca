/** Real retry-store catalog fsync contention: accepted replay retains every engine safety check. */
import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import type { RetryContext, RetryScope } from "../../core/src/model/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { FileExecutionStore } from "../../store/src/execution-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const faults = {
  conflict: () => new OrcaError("RUN_STATE", "conflict", { retryReason: "conflict" }),
  limit: () => new OrcaError("RUN_STATE", "limit"),
};
const scope: RetryScope = { principalId: "alice", workspaceId: "workspace", kind: "run.admit" };
const authority = { ...scope, authorize: async (_command: unknown) => {} };
const command = { value: "original" };
const retry = { idempotencyKey: "same" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-catalog-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  // Production default: neither catalog nor operation timeout is increased.
  const store = new FileRetryClaimStore({ storeDir: dir, execution, faults });
  const claims = new RegisteredRetryClaims(store, faults);
  const prepare = vi.fn(async (_command: typeof command, context: RetryContext) => {
    await context.bind({ admissionId: context.operationId });
    return { admissionId: context.operationId };
  });
  const recover = vi.fn(async () => {
    throw new Error("Recovery must not run in accepted fallback");
  });
  const authorize = vi.fn(async () => {});
  const verify = vi.fn(async () => {});
  const operation = claims.register(
    { kind: "run.admit", canonicalize: (c: typeof command) => c, prepare, recover },
    authorize,
    verify,
  );
  const execute = (value = command, auth = authority) => claims.execute(operation, value, retry, auth);
  return { dir, execution, store, claims, prepare, recover, authorize, verify, operation, execute };
}
async function snapshot(dir: string) {
  const records: Record<string, string> = {};
  for (const folder of ["admission-retries", "private-execution"])
    for (const name of await readdir(join(dir, folder)))
      if (name.endsWith(".json")) records[`${folder}/${name}`] = await readFile(join(dir, folder, name), "utf8");
  return records;
}

/** Latch the real cursor temporary file's sync, while batch owns the real catalog mutex. */
async function withCursorBarrier(f: Awaited<ReturnType<typeof fixture>>, check: () => Promise<void>) {
  const handle = await open(join(f.dir, "probe"), "a+");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const actualWrite = prototype.writeFile;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const actualSync = prototype.sync;
  const cursorHandles = new Set<typeof handle>();
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi.spyOn(prototype, "writeFile").mockImplementation(async function (this: typeof handle, ...args) {
    if (args[0] === "1") cursorHandles.add(this);
    await actualWrite.apply(this, args);
  });
  const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof handle) {
    if (cursorHandles.has(this)) {
      enter();
      await waiting;
    }
    await actualSync.call(this);
  });
  const batch = f.store.batch();
  // Attach rejection immediately, including if readiness fails.
  const settled = batch.then(
    (ids) => ({ ids }),
    (error: unknown) => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<typeof settled>;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cursor sync barrier was not reached")), 2_000);
      }),
    ]);
    clearTimeout(timer);
    expect(await readdir(join(f.dir, "admission-retries", "catalog.lock"))).toHaveLength(1);
    const before = await snapshot(f.dir);
    const sealedWrites = vi.spyOn(f.execution, "putGeneration");
    write.mockClear();
    await check();
    expect(sealedWrites).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await snapshot(f.dir)).toEqual(before);
    expect(f.recover).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    release();
    result = await settled;
    sync.mockRestore();
    write.mockRestore();
  }
  if ("error" in result) throw result.error;
  expect(result.ids).toHaveLength(1);
  expect(
    (await readdir(join(f.dir, "admission-retries"))).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
  ).toEqual([]);
}

describe("accepted retry catalog contention", () => {
  it("returns the original receipt across store instances during real batch cursor fsync", async () => {
    const f = await fixture();
    const first = await f.execute();
    const other = new FileRetryClaimStore({ storeDir: f.dir, execution: new FileExecutionStore(f.dir), faults });
    const reader = new RegisteredRetryClaims(other, faults);
    const operation = reader.register(f.operation, f.authorize, f.verify);
    await withCursorBarrier(f, async () => {
      expect(await reader.execute(operation, command, retry, authority)).toEqual({ ...first, replayed: true });
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.verify).toHaveBeenCalledTimes(1);
      expect(f.authorize).toHaveBeenCalledTimes(4);
    });
    expect(await f.execute()).toEqual({ ...first, replayed: true });
    expect(await f.store.batch()).toEqual([first.operationId]);
  });
  it("preserves canonical intent conflict without preparing or recovering", async () => {
    const f = await fixture();
    await f.execute();
    await withCursorBarrier(f, async () => {
      await expect(f.execute({ value: "changed" })).rejects.toMatchObject({ details: { retryReason: "conflict" } });
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.verify).not.toHaveBeenCalled();
    });
  });
  it("rechecks authority revoked while catalog acquisition waits", async () => {
    const f = await fixture();
    await f.execute();
    const authorize = vi.fn(async () => {});
    authorize
      .mockImplementationOnce(async () => {})
      .mockImplementation(async () => {
        throw new OrcaError("RUN_STATE", "revoked");
      });
    await withCursorBarrier(f, async () => {
      await expect(f.execute(command, { ...authority, authorize })).rejects.toThrow("revoked");
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.verify).not.toHaveBeenCalled();
    });
  });
  it("retains registered authorization and authoritative receipt verification", async () => {
    const f = await fixture();
    await f.execute();
    await withCursorBarrier(f, async () => {
      f.authorize.mockRejectedValueOnce(new OrcaError("RUN_STATE", "operation revoked"));
      await expect(f.execute()).rejects.toThrow("operation revoked");
      f.verify.mockRejectedValueOnce(new OrcaError("RUN_STATE", "receipt missing"));
      await expect(f.execute()).rejects.toThrow("receipt missing");
      expect(f.verify).toHaveBeenCalledTimes(1);
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });
  });
  it("retains existing in-progress result when the original operation mutex is held", async () => {
    const f = await fixture();
    const first = await f.execute();
    await withCursorBarrier(f, async () => {
      await f.store.lock(first.operationId, async () => {
        expect(await f.execute()).toEqual({
          state: "in-progress",
          operationId: first.operationId,
          recovery: "inspect-or-retry",
        });
      });
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });
  });
  it.each(["fresh", "no-key", "principal", "workspace", "kind"])(
    "retains catalog timeout for %s lookup",
    async (variant) => {
      const f = await fixture();
      await f.execute();
      await withCursorBarrier(f, async () => {
        const changedScope = {
          ...scope,
          ...(variant === "principal" ? { principalId: "bob" } : {}),
          ...(variant === "workspace" ? { workspaceId: "other" } : {}),
          ...(variant === "kind" ? { kind: "request.submit" as const } : {}),
        };
        await expect(
          f.store.claim(
            changedScope,
            variant === "no-key" ? undefined : variant === "fresh" ? "new" : "same",
            command,
            JSON.stringify(command),
          ),
        ).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT", details: { timeoutMs: 100 } });
        expect(f.prepare).toHaveBeenCalledTimes(1);
      });
    },
  );
  it.each(["claimed", "bound"] as const)("retains catalog timeout for unfinished %s record", async (phase) => {
    const f = await fixture();
    const first = await f.store.claim(scope, "same", command, JSON.stringify(command));
    if (phase === "bound")
      await f.store.lock(first.record.operationId, () =>
        f.store.write({ ...first.record, phase, binding: { admissionId: first.record.operationId } }),
      );
    await withCursorBarrier(f, async () => {
      await expect(f.execute()).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
      expect(f.prepare).not.toHaveBeenCalled();
    });
  });
  it.each([
    "salt-missing",
    "salt-invalid",
    "mapping-missing",
    "mapping-invalid",
    "scope-mismatch",
    "material-missing",
    "material-invalid",
    "pointer-missing",
    "pointer-invalid",
  ])("fails closed for %s", async (variant) => {
    const f = await fixture();
    const first = await f.execute();
    if (variant.startsWith("pointer-")) {
      const path = join(f.dir, "admission-retries", `${first.operationId}.json`);
      if (variant === "pointer-missing") await rm(path);
      else await writeFile(path, '{"operationId":"invalid"}');
    } else {
      const get = f.execution.getGeneration.bind(f.execution);
      vi.spyOn(f.execution, "getGeneration").mockImplementation(async (id) => {
        const value = await get(id);
        if (id === "admission-retry-lookup" && variant.startsWith("salt-"))
          return variant === "salt-missing" ? undefined : { salt: "invalid" };
        if (id.startsWith("admission-retry-key-") && variant.startsWith("mapping-"))
          return variant === "mapping-missing" ? undefined : { operationId: "invalid" };
        if (/^admission-retry-[a-f0-9-]{36}$/.test(id)) {
          if (variant === "material-missing") return undefined;
          if (variant === "material-invalid") return { invalid: true };
          if (variant === "scope-mismatch") return { ...(value as object), principalId: "bob" };
        }
        return value;
      });
    }
    await withCursorBarrier(f, async () => {
      await expect(f.execute()).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });
  });
  it("refuses actual protected ciphertext corruption without repairing it", async () => {
    const f = await fixture();
    const first = await f.execute();
    const pointer = JSON.parse(
      await readFile(join(f.dir, "admission-retries", `${first.operationId}.json`), "utf8"),
    ) as { ref: string };
    await writeFile(
      join(f.dir, "private-execution", `admission-retry-${pointer.ref}.generation.json`),
      '{"corrupt":true}',
    );
    await withCursorBarrier(f, async () => {
      await expect(f.execute()).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });
  });
  it("reloads the record under its operation mutex after fallback lookup", async () => {
    const f = await fixture();
    await f.execute();
    await withCursorBarrier(f, async () => {
      const read = f.store.read.bind(f.store);
      const reads = vi.spyOn(f.store, "read");
      reads.mockImplementationOnce(read).mockResolvedValueOnce(undefined);
      await expect(f.execute()).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(reads).toHaveBeenCalledTimes(2);
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.prepare).toHaveBeenCalledTimes(1);
    });
  });
  it("does not fall back for a timeout thrown inside catalog fresh validation", async () => {
    const f = await fixture();
    const refusal = new OrcaError("STORE_LOCK_TIMEOUT", "validator timeout");
    const reads = vi.spyOn(f.execution, "getGeneration");
    await expect(
      f.store.claim(scope, "same", command, JSON.stringify(command), async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    // Initial salt creation/reread and one scoped lookup only; no fallback reads.
    expect(reads).toHaveBeenCalledTimes(3);
    expect(await f.store.batch()).toEqual([]);
  });
});
