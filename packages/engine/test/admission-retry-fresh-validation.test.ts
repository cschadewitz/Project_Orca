import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import type { RetryContext, RetryOperation } from "../../core/src/model/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims, canonicalJson } from "../src/admission-retry.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "Limit"),
};
const authority = { principalId: "alice", workspaceId: "workspace", authorize: async (_command: unknown) => {} };
type Command = { value: string; payload: { note: string } };
const command = (value = "original"): Command => ({ value, payload: { note: "original note" } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-fresh-engine-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  const store = new FileRetryClaimStore({ storeDir: dir, execution, faults, lockTimeoutMs: 2_000 });
  return { dir, execution, store, claims: new RegisteredRetryClaims(store, faults) };
}
function operation(validateFresh: (command: Command) => Promise<void>) {
  const prepare = vi.fn(async (value: Command, context: RetryContext) => {
    await context.bind({ revisionId: "revision" });
    return { value: value.value, note: value.payload.note };
  });
  const recover = vi.fn(async (_value: Command, context: RetryContext) => ({
    value: (await context.readBinding())!.revisionId as string,
    note: "recovered",
  }));
  const op: RetryOperation<Command, { value: string; note: string }> = {
    kind: "revision.submit",
    canonicalize: (value) => value,
    validateFresh,
    prepare,
    recover,
  };
  return { op, prepare, recover };
}

describe("registered fresh retry validation", () => {
  it("rejects fresh invalid input without consuming its key, then accepts corrected input", async () => {
    const { claims, store, dir } = await fixture();
    const validate = vi.fn(async (value: Command) => {
      if (value.value === "invalid") throw new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid fresh input");
    });
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    await expect(
      claims.execute(registered, command("invalid"), { idempotencyKey: "same-key" }, authority),
    ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(await readdir(join(dir, "admission-retries"))).toEqual([]);
    expect(await store.batch()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    const corrected = await claims.execute(registered, command("corrected"), { idempotencyKey: "same-key" }, authority);
    expect(corrected).toMatchObject({ state: "resolved", replayed: false, result: { value: "corrected" } });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await store.batch()).toEqual([corrected.operationId]);
  });

  it("preserves accepted replay and conflict semantics without rerunning fresh validation", async () => {
    const { claims } = await fixture();
    const validate = vi.fn(async (_value: Command) => {});
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    const first = await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority);
    validate.mockImplementation(async () => {
      throw new OrcaError("RUN_STATE", "Boundary has moved");
    });
    expect(await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority)).toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      claims.execute(registered, command("changed"), { idempotencyKey: "same-key" }, authority),
    ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it("leaves existing unbound claims blocked and never validates, rebinds or autoreplays them", async () => {
    const { claims, store } = await fixture();
    const validate = vi.fn(async (_value: Command) => {
      throw new Error("Existing unbound claim must bypass validation");
    });
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    const input = command();
    const first = await store.claim(
      { principalId: authority.principalId, workspaceId: authority.workspaceId, kind: op.kind },
      "same-key",
      input,
      canonicalJson(input),
    );
    const pending = { state: "in-progress", operationId: first.record.operationId, recovery: "inspect-or-retry" };
    expect(await claims.execute(registered, input, { idempotencyKey: "same-key" }, authority)).toEqual(pending);
    expect(await claims.reconcile(first.record.operationId, authority)).toEqual(pending);
    expect(await store.read(first.record.operationId)).toEqual(first.record);
    expect(validate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("isolates fresh validation and its authority checks from the sealed canonical intent", async () => {
    const { claims, store } = await fixture();
    let validated!: Command;
    const { op, prepare } = operation(async (value) => {
      validated = value;
      value.value = "validator mutation";
      value.payload.note = "validator nested mutation";
    });
    let checks = 0;
    const registered = claims.register(op, async (value) => {
      if (++checks <= 2) value.payload.note = "fresh authority mutation";
    });
    const input = command();
    const result = await claims.execute(registered, input, { idempotencyKey: "same-key" }, authority);
    validated.payload.note = "late mutation";
    expect(input).toEqual(command());
    expect(result).toMatchObject({ state: "resolved", result: { value: "original", note: "original note" } });
    expect(prepare.mock.calls[0]![0]).toEqual(command());
    expect(await store.read(result.operationId)).toMatchObject({ command: input, canonical: canonicalJson(input) });
  });

  it.each(["caller", "registered"])("checks %s authority again after validation before publishing", async (kind) => {
    const { claims, store } = await fixture();
    let revoked = false;
    const authorize = vi.fn(async (_value: unknown) => {
      if (revoked) throw new OrcaError("RUN_STATE", "Authority revoked");
    });
    const validate = vi.fn(async (_value: Command) => {
      revoked = true;
    });
    const { op, prepare } = operation(validate);
    const registered = claims.register(op, kind === "registered" ? authorize : undefined);
    await expect(
      claims.execute(
        registered,
        command(),
        { idempotencyKey: "same-key" },
        {
          ...authority,
          ...(kind === "caller" ? { authorize } : {}),
        },
      ),
    ).rejects.toThrow("Authority revoked");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(await store.batch()).toEqual([]);
    expect(authorize).toHaveBeenCalledTimes(kind === "caller" ? 3 : 2);
    revoked = false;
    validate.mockImplementation(async () => {});
    expect(await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority)).toMatchObject({
      state: "resolved",
      replayed: false,
    });
  });

  it("checks authority after waiting for the catalog mutex and before calling the validator", async () => {
    const { claims, store } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = store.claim(
      { principalId: authority.principalId, workspaceId: authority.workspaceId, kind: "run.admit" },
      "blocker",
      {},
      "{}",
      async () => {
        entered();
        await waiting;
      },
    );
    await ready;

    const validate = vi.fn(async (_value: Command) => {});
    const { op, prepare } = operation(validate);
    const registered = claims.register(op);
    let revoked = false;
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      requested();
      return claim(...args);
    });
    const result = claims.execute(
      registered,
      command(),
      { idempotencyKey: "same-key" },
      {
        ...authority,
        authorize: async () => {
          if (revoked) throw new OrcaError("RUN_STATE", "Authority revoked while waiting");
        },
      },
    );
    const refusal = expect(result).rejects.toThrow("Authority revoked while waiting");
    await requestStarted;
    revoked = true;
    release();
    const existing = await blocker;
    await refusal;
    expect(validate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(await store.batch()).toEqual([existing.record.operationId]);
  });
});
