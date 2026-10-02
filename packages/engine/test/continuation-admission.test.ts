import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaError } from "@orca/core";
import { FileExecutionStore } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import type { RetryAuthority } from "../../core/src/model/admission-retry.js";
import type { ContinuationCommand, ContinuationReceipt } from "../../core/src/model/continuation-admission.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import {
  ContinuationAdmissionService,
  type ContinuationEntry,
  type ContinuationJournal,
  type ContinuationRuntime,
} from "../src/continuation-admission.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const command: ContinuationCommand = {
  runId: "run",
  expectedBoundary: "server-issued-boundary",
  decision: { requestId: "request", optionId: "retry", note: "private rationale" },
};
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};
const authority: RetryAuthority<ContinuationCommand> = {
  principalId: "alice",
  workspaceId: "workspace",
  authorize: async () => {},
};

/**
 * TEST FIXTURE ONLY: a single file simulates one protected atomic continuation event.
 * It does not implement production encryption, writer leases or boundary issuance.
 * The actual registered retry store is used to exercise persisted claim recovery.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-fixture-"));
  directories.push(dir);
  const file = join(dir, "fixture-event.json");
  let beforeCommit: (() => Promise<void>) | undefined;
  let failAfterAppend = false;
  let answers = 0;
  let appends = 0;
  let readAllowed = true;
  let blocked: ContinuationReceipt["blockedReason"];
  let runtimeCalls = 0;
  const read = async (): Promise<ContinuationEntry | undefined> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as ContinuationEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const save = async (entry: ContinuationEntry) => {
    await writeFile(`${file}.tmp`, JSON.stringify(entry));
    await rename(`${file}.tmp`, file);
  };
  const journal: ContinuationJournal = {
    read: async (id) => {
      const entry = await read();
      return entry?.receipt.continuationId === id ? entry : undefined;
    },
    commit: async (input, reauthorize) => {
      const prior = await read();
      if (prior) {
        if (prior.receipt.continuationId !== input.continuationId) throw new OrcaError("RUN_STATE", "stale");
        return prior;
      }
      if (input.command.expectedBoundary !== command.expectedBoundary) throw new OrcaError("RUN_STATE", "stale");
      await beforeCommit?.();
      await reauthorize();
      const entry: ContinuationEntry = {
        schemaVersion: 1,
        kind: "continuation",
        revision: 0,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        command: input.command,
        receipt: {
          operationId: input.operationId,
          continuationId: input.continuationId,
          runId: input.command.runId,
          expectedBoundary: input.command.expectedBoundary,
          state: "accepted",
        },
        boundary: {
          eventId: "event",
          eventSeq: 12,
          workflowId: "wf",
          workflowVersion: "v1",
          workflowRevision: "revision",
          configGeneration: "generation",
          stepRunId: "step",
          attemptId: "attempt",
          requestId: "request",
        },
        dispatch: "needed",
      };
      await save(entry);
      appends++;
      if (input.command.decision) answers++;
      if (failAfterAppend) throw new Error("fixture crash after append");
      return entry;
    },
  };
  const runtime: ContinuationRuntime = {
    authorizeRead: async () => {
      if (!readAllowed) throw new OrcaError("RUN_STATE", "denied");
    },
    reconcile: async (entry, current) => {
      runtimeCalls++;
      await current.authorize(entry.command);
      const receipt: ContinuationReceipt = blocked
        ? { ...entry.receipt, state: "blocked", blockedReason: blocked }
        : { ...entry.receipt, state: "accepted" };
      await save({ ...entry, receipt, revision: entry.revision + 1, dispatch: blocked ? entry.dispatch : "attached" });
      return receipt;
    },
  };
  const boot = () => {
    const execution = new FileExecutionStore(dir);
    const claimStore = new FileRetryClaimStore({ storeDir: dir, execution, faults, lockTimeoutMs: 200 });
    const claims = new RegisteredRetryClaims(claimStore, faults);
    return { claimStore, claims, service: new ContinuationAdmissionService({ retries: claims, journal, runtime }) };
  };
  return {
    boot,
    read,
    save,
    rewind: () => rm(file),
    journal,
    runtime,
    counts: () => ({ answers, appends, runtimeCalls }),
    beforeCommit: (hook?: () => Promise<void>) => {
      beforeCommit = hook;
    },
    crashAfterAppend: (value: boolean) => {
      failAfterAppend = value;
    },
    allowRead: (value: boolean) => {
      readAllowed = value;
    },
    block: (value: ContinuationReceipt["blockedReason"]) => {
      blocked = value;
    },
  };
}
async function admit(service: ContinuationAdmissionService, value = command) {
  const result = await service.admit(value, { idempotencyKey: "intent" }, authority);
  if (result.state !== "resolved") throw new Error("expected resolved fixture receipt");
  return result;
}

describe("continuation service with explicitly simulated journal/runtime adapters", () => {
  it("returns durable accepted intent without waiting for or starting execution", async () => {
    const f = await fixture();
    const { service } = f.boot();
    const result = await admit(service);
    expect(result.result.state).toBe("accepted");
    expect(await f.read()).toMatchObject({ receipt: result.result, dispatch: "needed", command });
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 0 });
    expect(await admit(service)).toEqual({ ...result, replayed: true });
    expect(f.counts().answers).toBe(1);
  });
  it("refuses a replay after the authoritative marker is rewound without recreating it", async () => {
    const f = await fixture();
    const first = await admit(f.boot().service);
    const original = (await f.read())!;
    const commit = vi.spyOn(f.journal, "commit");
    await f.rewind();
    const { service, claimStore } = f.boot();
    const before = await claimStore.read(first.operationId);
    await expect(admit(service)).rejects.toThrow("Continuation is unavailable");
    expect(await f.read()).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(await claimStore.read(first.operationId)).toEqual(before);
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 0 });
    await f.save(original);
    expect(await admit(service)).toEqual({ ...first, replayed: true });
  });
  it.each([
    "principalId",
    "workspaceId",
    "operationId",
    "continuationId",
    "runId",
    "expectedBoundary",
    "command",
  ] as const)("refuses replay with changed sealed %s without another commit or binding", async (field) => {
    const f = await fixture();
    const { service, claimStore } = f.boot();
    const first = await admit(service);
    const original = (await f.read())!;
    const changed = structuredClone(original);
    if (field === "principalId" || field === "workspaceId") changed[field] = "other";
    else if (field === "command") changed.command.decision!.optionId = "other";
    else changed.receipt[field] = "other";
    await f.save(changed);
    const commit = vi.spyOn(f.journal, "commit");
    const before = await claimStore.read(first.operationId);
    await expect(admit(service)).rejects.toThrow("Continuation is unavailable");
    expect(commit).not.toHaveBeenCalled();
    expect(await claimStore.read(first.operationId)).toEqual(before);
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 0 });
    await f.save(original);
    expect(await admit(service)).toEqual({ ...first, replayed: true });
  });
  it("reauthorizes after verifying the durable marker before acknowledging replay", async () => {
    const f = await fixture();
    const { service } = f.boot();
    await admit(service);
    let allowed = true;
    const current = {
      ...authority,
      authorize: async () => {
        if (!allowed) throw new Error("revoked after read");
      },
    };
    const read = f.journal.read.bind(f.journal);
    f.journal.read = async (id) => {
      const entry = await read(id);
      allowed = false;
      return entry;
    };
    await expect(service.admit(command, { idempotencyKey: "intent" }, current)).rejects.toThrow("revoked after read");
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 0 });
  });
  it("recovers the same claim and continuation after an append-before-ack crash and restart", async () => {
    const f = await fixture();
    f.crashAfterAppend(true);
    await expect(admit(f.boot().service)).rejects.toThrow("fixture crash");
    const original = await f.read();
    f.crashAfterAppend(false);
    const retry = await admit(f.boot().service);
    expect(retry.result).toEqual(original?.receipt);
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 0 });
  });
  it("retains bound IDs across a crash before the authoritative append", async () => {
    const f = await fixture();
    let firstId = "";
    const commit = f.journal.commit.bind(f.journal);
    f.journal.commit = async (input, check) => {
      if (!firstId) {
        firstId = input.continuationId;
        throw new Error("fixture crash before append");
      }
      expect(input.continuationId).toBe(firstId);
      return commit(input, check);
    };
    await expect(admit(f.boot().service)).rejects.toThrow("before append");
    expect(await f.read()).toBeUndefined();
    expect((await admit(f.boot().service)).result.continuationId).toBe(firstId);
    expect(f.counts().answers).toBe(1);
  });
  it("rejects changed intent and a stale boundary without another answer", async () => {
    const f = await fixture();
    const { service } = f.boot();
    await expect(admit(service, { ...command, expectedBoundary: "old" })).rejects.toThrow("stale");
    expect(f.counts().appends).toBe(0);
    await expect(admit(service)).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
    const result = await service.admit(command, { idempotencyKey: "new" }, authority);
    expect(result.state).toBe("resolved");
    expect(f.counts().answers).toBe(1);
  });
  it("reauthorizes immediately before commit and refuses revoked replay", async () => {
    const f = await fixture();
    const { service } = f.boot();
    let allowed = true;
    const current = {
      ...authority,
      authorize: async () => {
        if (!allowed) throw new Error("revoked");
      },
    };
    f.beforeCommit(async () => {
      allowed = false;
    });
    await expect(service.admit(command, { idempotencyKey: "intent" }, current)).rejects.toThrow("revoked");
    expect(f.counts().appends).toBe(0);
    f.beforeCommit();
    allowed = true;
    await service.admit(command, { idempotencyKey: "intent" }, current);
    allowed = false;
    await expect(service.admit(command, { idempotencyKey: "intent" }, current)).rejects.toThrow("revoked");
    expect(f.counts().answers).toBe(1);
  });
  it("checks live read authority and returns only a detached safe receipt", async () => {
    const f = await fixture();
    const { service } = f.boot();
    const { result } = await admit(service);
    const receipt = await service.inspect(result.continuationId);
    expect(receipt).toEqual(result);
    expect(JSON.stringify(receipt)).not.toContain("private rationale");
    receipt.state = "settled";
    expect((await service.inspect(result.continuationId)).state).toBe("accepted");
    f.allowRead(false);
    await expect(service.inspect(result.continuationId)).rejects.toThrow("denied");
    await expect(service.inspect("unknown")).rejects.toThrow("unavailable");
  });
  it("reconcile seals owner/workspace and authorizes the original exact decision", async () => {
    const f = await fixture();
    const { service } = f.boot();
    const { result } = await admit(service);
    for (const other of [
      { ...authority, principalId: "bob" },
      { ...authority, workspaceId: "other" },
    ])
      await expect(service.reconcile(result.continuationId, other)).rejects.toThrow("unavailable");
    const authorize = vi.fn(async (_value: ContinuationCommand) => {});
    await service.reconcile(result.continuationId, { ...authority, authorize });
    expect(authorize).toHaveBeenCalledWith(command);
    expect(f.counts()).toEqual({ appends: 1, answers: 1, runtimeCalls: 1 });
  });
  it.each(["authority-unavailable", "leased", "unsafe-boundary", "generation-unavailable"] as const)(
    "preserves the runtime's durable %s refusal without answering again",
    async (reason) => {
      const f = await fixture();
      const { service } = f.boot();
      const { result } = await admit(service);
      f.block(reason);
      expect(await service.reconcile(result.continuationId, authority)).toMatchObject({
        state: "blocked",
        blockedReason: reason,
      });
      expect(await service.inspect(result.continuationId)).toMatchObject({ state: "blocked", blockedReason: reason });
      expect(f.counts().answers).toBe(1);
    },
  );
  it("does not invoke runtime for settled work, but still rechecks authority", async () => {
    const f = await fixture();
    const { service } = f.boot();
    const { result } = await admit(service);
    const entry = (await f.read())!;
    await f.save({ ...entry, dispatch: "settled", receipt: { ...entry.receipt, state: "settled" } });
    expect((await service.reconcile(result.continuationId, authority)).state).toBe("settled");
    await expect(
      service.reconcile(result.continuationId, {
        ...authority,
        authorize: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.counts().runtimeCalls).toBe(0);
  });
  it("rejects callback/grant extras and overlarge unkeyed intent before effects", async () => {
    const f = await fixture();
    const { service } = f.boot();
    for (const value of [
      { ...command, decision: { ...command.decision!, always: true } },
      { ...command, callback: "live-target" },
      { ...command, decision: { ...command.decision!, note: "x".repeat(270_000) } },
    ])
      await expect(service.admit(value, {}, authority)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(f.counts().appends).toBe(0);
  });
  it("supports decision-free continuation and canonical optional fields", async () => {
    const f = await fixture();
    const { service } = f.boot();
    const value = { runId: command.runId, expectedBoundary: command.expectedBoundary };
    await admit(service, value);
    expect(f.counts().answers).toBe(0);
    expect((await admit(service, { ...value, decision: undefined } as unknown as ContinuationCommand)).replayed).toBe(
      true,
    );
  });
});
