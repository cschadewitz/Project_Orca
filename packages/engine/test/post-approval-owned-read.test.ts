/** Real owned file and lease/delivery integration; controlled installation and policy are explicit synthetic assumptions. */
import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { memoryStores } from "@orca/store";
import type { ExecutionReceiptV1, PendingReviewV1 } from "@orca/core";
import { askHumanInput, type HumanInputQuery } from "../src/human-input.js";
import { LiveHumanInput } from "../src/live-input.js";
import {
  createOwnedFileReadServiceForTest,
  type PrepareHumanRead,
  type OwnedReadCurrentCapture,
} from "../src/owned-file-read-service.js";
import { deferred, syntheticReadFixture } from "./fixtures/synthetic-read-fence.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
async function fixture(register?: (capture: OwnedReadCurrentCapture) => undefined) {
  const base = await syntheticReadFixture(300000);
  const stores = memoryStores(base.clock);
  const id = base.state.snapshot.invocation;
  const live = new LiveHumanInput(id.instanceId);
  const ack = { barrier: undefined as ReturnType<typeof deferred> | undefined, fail: false };
  let query!: HumanInputQuery;
  const emit = (event: Parameters<Parameters<typeof askHumanInput>[0]["emit"]>[0]) =>
    stores.events.append({ ...event, runId: id.runId } as Parameters<typeof stores.events.append>[0]);
  const answerResult = askHumanInput({
    port: live,
    emit,
    clock: base.clock,
    runId: id.runId,
    stepRunId: id.stepRunId,
    kind: "permission",
    question: "Read exactly these disposable bytes?",
    options: ["once", "deny"],
    live: {
      identity: {
        instanceId: id.instanceId,
        sessionId: id.sessionId,
        turnId: id.turnId,
        invocationId: id.invocationId,
      },
      signal: base.abort.signal,
      withOwnership: async (work) => {
        const result = await base.owner.withOwnership(work);
        await ack.barrier?.promise;
        if (ack.fail) throw new Error("Lost final lease acknowledgement");
        return result;
      },
      emitOwned: emit,
    },
    onRequested: (value) => {
      query = value;
    },
  });
  void answerResult.catch(() => undefined);
  await vi.waitFor(() => expect(query).toBeDefined());
  const outputs: string[] = [];
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: base.owner,
    content: "synthetic private content",
    maximumInvocations: 4,
    // Declared test assumption, never independent installed-effect acceptance.
    controlledSupervisor: {
      installedEvidenceRef: "test:synthetic-controlled-assumption",
      assertCurrent: () => {
        base.abort.signal.throwIfAborted();
        return undefined;
      },
      assertInterval: (offset, length) => {
        expect([offset, length]).toEqual([0, 9]);
        return undefined;
      },
    },
    observed: async () => {},
    respond: async (bytes) => {
      outputs.push(Buffer.from(bytes).toString());
    },
  });
  cleanup.push(async () => {
    live.close();
    service.close();
    base.abort.abort();
    ack.barrier?.resolve(undefined);
    await answerResult.catch(() => undefined);
  });
  const actor = { principalId: id.principalRef, credentialId: "test:credential" };
  const target = { ...query.live!.identity, runId: id.runId, stepRunId: id.stepRunId, requestId: query.requestId };
  const answer = (optionId = "once") =>
    live.answer(
      { target, optionId },
      {
        actor,
        authorize: async () => {
          if (base.state.revoked) throw new Error("Current responder revoked");
        },
      },
    );
  const { expiresAt: _expiresAt, ...intent } = structuredClone(base.state.snapshot);
  const factory = vi.fn(async () => {
    if (base.state.revoked || base.state.authorityUnavailable) throw new Error("Current authority unavailable");
    const { expiresAt: _old, ...snapshot } = structuredClone(base.state.snapshot);
    return {
      authority: {
        ...base.owner,
        snapshot: () => snapshot,
        leaseExpiresAt: Date.parse(base.lease.renewedAt) + base.lease.guardedTtlMs!,
      },
      policy: base.policy,
      evidence: base.evidence,
    };
  });
  const invocations: OwnedReadCurrentCapture[] = [];
  const input: PrepareHumanRead = {
    intent,
    parameters: { resourceRef: service.resourceRef, offset: 0, length: 9 },
    delivery: live.retainOriginalDelivery(query),
    query,
    actor,
    onceOptionId: "once",
    executionWindowMs: 55000,
    authorizeExecution: factory,
    registerInvocation: (invocation) => {
      invocations.push(invocation);
      return register?.(invocation);
    },
  };
  const pending = service.prepareHumanRead(input);
  const reads = vi.spyOn(fs, "readSync");
  return { base, service, input, pending, reads, outputs, factory, invocations, answer, answerResult, live, ack };
}

it("waits beyond the old action window and only captures a fresh action after acknowledged approval", async () => {
  const f = await fixture();
  f.base.clock.advance(120000);
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
  await Promise.resolve();
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.base.state.captureWrites).toBe(0);
  expect(f.reads).not.toHaveBeenCalled();
  await f.answer();
  const receipt = await execution;
  expect(receipt.state).toBe("completed");
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.invocations[0]!.action.expiresAt).toBe(new Date(f.base.clock.now() + 55000).toISOString());
  expect(f.base.state.captureWrites).toBe(1);
  expect(f.reads).toHaveBeenCalledTimes(1);
  expect(f.outputs).toEqual(["synthetic"]);
  expect(await f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(receipt);
});

it.each([false, true])("waits for the final lease acknowledgement (lost=%s)", async (lost) => {
  const f = await fixture();
  f.ack.barrier = deferred();
  f.ack.fail = lost;
  const answer = f.answer();
  void answer.catch(() => undefined);
  expect(await f.answerResult).toBe("once");
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  void execution.catch(() => undefined);
  await Promise.resolve();
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.base.state.captureWrites).toBe(0);
  f.ack.barrier.resolve(undefined);
  if (lost) {
    await expect(answer).rejects.toThrow();
    await expect(execution).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  } else {
    await answer;
    expect((await execution).state).toBe("completed");
  }
});

it.each(["deny", "cancel", "revoked", "lease-expired", "policy-deny", "policy-unavailable", "action-expired"] as const)(
  "%s cannot create a successful fresh execution or retry its attempt",
  async (reason) => {
    const f = await fixture();
    if (reason === "deny") await f.answer("deny");
    else if (reason === "cancel") f.base.abort.abort("run cancelled");
    else if (reason === "lease-expired") {
      f.base.clock.advance(300000);
      await expect(f.answer()).rejects.toThrow();
    } else {
      await f.answer();
      if (reason === "revoked") f.base.state.revoked = true;
      if (reason === "policy-deny") f.base.policy.outcome = "deny";
      if (reason === "policy-unavailable") f.base.policy.unavailable = true;
      if (reason === "action-expired") Object.assign(f.input, { registerInvocation: () => undefined });
    }
    if (reason === "action-expired") {
      // The original registered callback is retained; inject expiry in the actual
      // fresh policy boundary instead of replacing a caller-owned composition.
      f.base.policy.beforeEvaluate = async () => {
        f.base.clock.advance(55000);
      };
    }
    const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
    await expect(execution).rejects.toThrow();
    expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
    expect(f.reads).not.toHaveBeenCalled();
  },
);

it("cancels an unacknowledged wait without creating authority, even after a late answer", async () => {
  const f = await fixture();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  f.base.caller.abort();
  await expect(execution).rejects.toThrow();
  await f.answer();
  expect(f.service.executePreparedHumanRead(f.pending, new AbortController().signal)).toBe(execution);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

it("refuses a changed intent from the fresh authority factory", async () => {
  const f = await fixture();
  await f.answer();
  f.base.state.snapshot = { ...f.base.state.snapshot, cwd: "/different-workspace" };
  await expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).rejects.toThrow();
  expect(f.reads).not.toHaveBeenCalled();
});

it("retains returned capabilities before snapshot or clock callbacks can replace them", async () => {
  const f = await fixture();
  const original = f.factory.getMockImplementation()!;
  const replacement = vi.fn((): never => {
    throw new Error("Replacement capability selected");
  });
  f.factory.mockImplementationOnce(async () => {
    const fresh = await original();
    const snapshot = fresh.authority.snapshot.bind(fresh.authority);
    Object.assign(fresh.authority, {
      snapshot: () => {
        Object.assign(fresh.authority, {
          signal: AbortSignal.abort(),
          leaseExpiresAt: Infinity,
          authorize: replacement,
          assertCurrent: replacement,
          withOwnership: replacement,
          clock: { now: replacement, isoNow: replacement },
        });
        Object.assign(fresh, {
          policy: { version: 1, evaluate: replacement, bindReview: replacement, completeReview: replacement },
          evidence: { recordCapture: replacement, recordAuthorization: replacement, read: replacement },
        });
        return snapshot();
      },
    });
    return fresh;
  });
  await f.answer();
  expect((await f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).state).toBe("completed");
  expect(replacement).not.toHaveBeenCalled();
  expect(f.reads).toHaveBeenCalledTimes(1);
});

it("a fresh required-review result is not bypassed by the historical human answer", async () => {
  const f = await fixture();
  vi.spyOn(f.base.policy, "evaluate").mockImplementation(async (action) => ({
    phase: "needs-review",
    pending: Object.freeze({}) as PendingReviewV1,
    review: {
      version: 1,
      actionBindingRef: action.bindingRef,
      authority: action.authority,
      coverageId: action.coverage.coverageId,
      reviewId: "synthetic-review",
      delegation: { ruleId: "synthetic-rule", ruleRevision: "revision" },
      requirement: "required",
      projectionPolicyRevision: "projection",
      destinationPolicyRef: "destination",
      judgeConfigRef: "judge",
      deadlineAt: action.expiresAt,
    },
  }));
  await f.answer();
  await expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).rejects.toThrow();
  expect(f.base.state.authWrites).toBe(0);
  expect(f.reads).not.toHaveBeenCalled();
});

it("caps a fresh execution deadline at the remaining real lease lifetime", async () => {
  const f = await fixture();
  f.base.clock.advance(270000);
  await f.answer();
  expect((await f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).state).toBe("completed");
  expect(f.invocations[0]!.action.expiresAt).toBe(
    new Date(Date.parse(f.base.lease.renewedAt) + f.base.lease.guardedTtlMs!).toISOString(),
  );
  expect(Date.parse(f.invocations[0]!.action.expiresAt) - f.base.clock.now()).toBe(30000);
});

it("refuses exact equality with the fresh owner's declared lease end", async () => {
  const f = await fixture();
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementationOnce(async () => {
    const fresh = await original();
    fresh.authority.leaseExpiresAt = f.base.clock.now();
    return fresh;
  });
  await f.answer();
  await expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).rejects.toThrow();
  expect(f.base.state.captureWrites).toBe(0);
  expect(f.reads).not.toHaveBeenCalled();
});

it("registration gets no enforcement capability and reentry shares the original execution", async () => {
  let reentered: Promise<ExecutionReceiptV1> | undefined;
  const f: Awaited<ReturnType<typeof fixture>> = await fixture((capture) => {
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.keys(capture).sort()).toEqual(["action", "assertCurrent", "reviewProvenance"]);
    reentered = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
    return undefined;
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  expect((await execution).state).toBe("completed");
  expect(reentered).toBe(execution);
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.reads).toHaveBeenCalledTimes(1);
});
