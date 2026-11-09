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
  const ack = {
    barrier: undefined as ReturnType<typeof deferred> | undefined,
    fail: false,
    cleanupFailure: undefined as unknown,
  };
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
  const hooks: { observed?: () => Promise<void>; respond?: () => Promise<void> } = {};
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
    observed: async () => {
      await hooks.observed?.();
    },
    respond: async (bytes) => {
      await hooks.respond?.();
      outputs.push(Buffer.from(bytes).toString());
    },
  });
  cleanup.push(async () => {
    live.close();
    try {
      await service.closeAndDrain();
    } catch (error) {
      if (error !== ack.cleanupFailure) throw error;
    }
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
  return {
    base,
    service,
    input,
    pending,
    reads,
    outputs,
    factory,
    invocations,
    answer,
    answerResult,
    live,
    ack,
    hooks,
  };
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

it("the initial preview exposes review only and never calls execution authorization", async () => {
  const f = await fixture();
  const authorization = vi.spyOn(f.base.owner, "authorize");
  const preview = f.service.reviewPreparedHumanRead(f.pending, f.base.owner, f.base.policy, f.base.evidence);
  expect(Object.keys(preview).sort()).toEqual(["action", "assertCurrent", "evaluate", "reviewProvenance"]);
  await preview.evaluate(f.base.caller.signal);
  expect(preview.reviewProvenance().result).toBe("unavailable");
  expect(authorization).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
  expect(() => f.service.capture(f.base.owner, f.input.parameters, f.base.policy, f.base.evidence)).toThrow();
  f.base.clock.advance(120000);
  expect(() => preview.assertCurrent()).toThrow();
  await expect(preview.evaluate(f.base.caller.signal)).rejects.toThrow();
  expect(() => f.service.capture(f.base.owner, f.input.parameters, f.base.policy, f.base.evidence)).toThrow();
  await f.answer();
  expect((await f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).state).toBe("completed");
  expect(f.invocations[0]!.action.actionId).not.toBe(preview.action.actionId);
  expect(f.invocations[0]!.action.invocation).toEqual(preview.action.invocation);
  expect(f.invocations[0]!.action.resources).toEqual(preview.action.resources);
  expect(() => f.service.capture(f.base.owner, f.input.parameters, f.base.policy, f.base.evidence)).toThrow();
  expect(f.reads).toHaveBeenCalledTimes(1);
});

it("retirement invalidates retained preview methods and the reserved execution", async () => {
  const f = await fixture();
  const preview = f.service.reviewPreparedHumanRead(f.pending, f.base.owner, f.base.policy, f.base.evidence);
  await preview.evaluate(f.base.caller.signal);
  f.service.retirePreparedHumanRead(f.pending);
  expect(() => preview.assertCurrent()).toThrow();
  expect(() => preview.reviewProvenance()).toThrow();
  await expect(preview.evaluate(f.base.caller.signal)).rejects.toThrow();
  expect(() => f.service.reviewPreparedHumanRead(f.pending, f.base.owner, f.base.policy, f.base.evidence)).toThrow();
  expect(() => f.service.capture(f.base.owner, f.input.parameters, f.base.policy, f.base.evidence)).toThrow();
  await expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).rejects.toThrow();
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

it("private prepared redemption does not allow a factory snapshot hook to reenter public capture", async () => {
  const f = await fixture();
  f.service.reviewPreparedHumanRead(f.pending, f.base.owner, f.base.policy, f.base.evidence);
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementationOnce(async () => {
    const fresh = await original();
    const snapshot = fresh.authority.snapshot;
    fresh.authority.snapshot = () => {
      expect(() => f.service.capture(f.base.owner, f.input.parameters, f.base.policy, f.base.evidence)).toThrow();
      return snapshot();
    };
    return fresh;
  });
  await f.answer();
  expect((await f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).state).toBe("completed");
  expect(f.reads).toHaveBeenCalledTimes(1);
});

it("cancellation joins started authority work before closing its physical fixture", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementationOnce(async () => {
    entered.resolve(undefined);
    await release.promise;
    return original();
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  void execution.catch(() => undefined);
  await entered.promise;
  f.base.caller.abort();
  let drained = false;
  const draining = f.service.closeAndDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(fs.existsSync(f.service.root)).toBe(true);
  release.resolve(undefined);
  await expect(execution).rejects.toThrow();
  await draining;
  expect(fs.existsSync(f.service.root)).toBe(false);
  expect(f.reads).not.toHaveBeenCalled();
});

it("reentrant close from an authority factory joins its already-published work", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let closing: Promise<void> | undefined,
    drained = false;
  f.factory.mockImplementationOnce(async () => {
    closing = f.service.closeAndDrain().then(() => {
      drained = true;
    });
    entered.resolve(undefined);
    await release.promise;
    throw new Error("Cancelled authority work settled");
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  void execution.catch(() => undefined);
  await entered.promise;
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(fs.existsSync(f.service.root)).toBe(true);
  release.resolve(undefined);
  await expect(execution).rejects.toThrow();
  await closing;
  expect(fs.existsSync(f.service.root)).toBe(false);
  expect(f.reads).not.toHaveBeenCalled();
});

it("preview evidence reentry cannot duplicate work and cleanup joins its append", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  const record = f.base.evidence.recordCapture.bind(f.base.evidence);
  let calls = 0,
    reentered: Promise<unknown> | undefined,
    closing: Promise<void> | undefined,
    drained = false;
  const evidence = {
    ...f.base.evidence,
    recordCapture: async (...args: Parameters<typeof record>) => {
      calls++;
      reentered = preview.evaluate(f.base.caller.signal);
      void reentered.catch(() => undefined);
      closing = f.service.closeAndDrain().then(() => {
        drained = true;
      });
      entered.resolve(undefined);
      await release.promise;
      return record(...args);
    },
  };
  const preview = f.service.reviewPreparedHumanRead(f.pending, f.base.owner, f.base.policy, evidence);
  const evaluating = preview.evaluate(f.base.caller.signal);
  void evaluating.catch(() => undefined);
  await entered.promise;
  expect(calls).toBe(1);
  expect(drained).toBe(false);
  expect(fs.existsSync(f.service.root)).toBe(true);
  release.resolve(undefined);
  await expect(evaluating).rejects.toThrow();
  await expect(reentered).rejects.toThrow();
  await closing;
  expect(calls).toBe(1);
  expect(fs.existsSync(f.service.root)).toBe(false);
});

it("retirement inside fresh registration prevents every resource effect", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(() => f.service.retirePreparedHumanRead(f.pending));
  await f.answer();
  await expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).rejects.toThrow();
  expect(f.reads).not.toHaveBeenCalled();
  expect(f.base.state.authWrites).toBe(0);
});

it("reentrant abort-listener cleanup joins the same closing operation", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let nested: Promise<void> | undefined,
    nestedDone = false,
    outerDone = false;
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementationOnce(async () => {
    entered.resolve(undefined);
    await release.promise;
    return original();
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  void execution.catch(() => undefined);
  await entered.promise;
  f.service.lifetimeSignal.addEventListener(
    "abort",
    () => {
      nested = f.service.closeAndDrain().then(() => {
        nestedDone = true;
      });
    },
    { once: true },
  );
  const outer = f.service.closeAndDrain().then(() => {
    outerDone = true;
  });
  await Promise.resolve();
  expect(nestedDone).toBe(false);
  expect(outerDone).toBe(false);
  expect(fs.existsSync(f.service.root)).toBe(true);
  release.resolve(undefined);
  await expect(execution).rejects.toThrow();
  await Promise.all([outer, nested]);
  expect(nestedDone).toBe(true);
  expect(outerDone).toBe(true);
  expect(fs.existsSync(f.service.root)).toBe(false);
});

it("retirement releases a waiting prepared continuation without answering its query", async () => {
  const f = await fixture();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  await Promise.resolve();
  f.service.retirePreparedHumanRead(f.pending);
  await expect(execution).rejects.toThrow();
  expect(f.live.pendingCount).toBe(1);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.reads).not.toHaveBeenCalled();
});

it("a synchronous cleanup failure is reported by both legacy close and the shared drain", async () => {
  const f = await fixture();
  const failure = new Error("Controlled fixture removal failed");
  const remove = fs.rmSync;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
    if (args[0] === f.service.root) throw failure;
    return remove(...args);
  });
  try {
    expect(() => f.service.close()).toThrow(failure);
    await expect(f.service.closeAndDrain()).rejects.toBe(failure);
    expect(fs.existsSync(f.service.root)).toBe(true);
  } finally {
    spy.mockRestore();
    f.ack.cleanupFailure = failure; // The fixture cleanup permits only this exact expected failure.
    fs.rmSync(f.service.root, { recursive: true, force: true });
  }
});

it.each(
  (["capture", "authorization", "policy", "authority", "observed", "response"] as const).flatMap((stage) =>
    [false, true].map((reject) => ({ stage, reject })),
  ),
)(
  "prepared cleanup drains started fresh $stage work (reject=$reject) without early lease release or retry",
  async ({ stage, reject }) => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    let ownership = 0,
      drained = false,
      executionSettled = false;
    const gate = async () => {
      entered.resolve(undefined);
      await release.promise;
      if (reject) throw new Error("Started owned operation rejected after cancellation");
    };
    const original = f.factory.getMockImplementation()!;
    f.factory.mockImplementationOnce(async () => {
      const fresh = await original();
      const own = fresh.authority.withOwnership.bind(fresh.authority);
      fresh.authority.withOwnership = (work) =>
        own(async () => {
          ownership++;
          try {
            return await work();
          } finally {
            ownership--;
          }
        });
      if (stage === "authority") {
        const authorize = fresh.authority.authorize.bind(fresh.authority);
        fresh.authority.authorize = async (...args) => {
          await gate();
          return authorize(...args);
        };
      }
      if (stage === "policy") {
        const evaluate = fresh.policy.evaluate.bind(fresh.policy);
        fresh.policy.evaluate = async (...args) => {
          await gate();
          return evaluate(...args);
        };
      }
      if (stage === "capture") {
        const record = fresh.evidence.recordCapture.bind(fresh.evidence);
        fresh.evidence = {
          ...fresh.evidence,
          recordCapture: async (...args) => {
            await gate();
            return record(...args);
          },
        };
      }
      if (stage === "authorization") {
        const record = fresh.evidence.recordAuthorization.bind(fresh.evidence);
        fresh.evidence = {
          ...fresh.evidence,
          recordAuthorization: async (...args) => {
            await gate();
            return record(...args);
          },
        };
      }
      return fresh;
    });
    if (stage === "observed") f.hooks.observed = gate;
    if (stage === "response") f.hooks.respond = gate;
    await f.answer();
    const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
    void execution.then(
      () => {
        executionSettled = true;
      },
      () => {
        executionSettled = true;
      },
    );
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        execution.then(() => {
          throw new Error("Expected owned operation was not reached");
        }),
      ]);
      const afterRead = stage === "observed" || stage === "response";
      expect(f.reads.mock.calls.length).toBe(afterRead ? 1 : 0);
      if (stage !== "policy") expect(ownership).toBeGreaterThan(0);
      f.base.caller.abort();
      closing = f.service.closeAndDrain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(executionSettled).toBe(false);
      expect(fs.existsSync(f.service.root)).toBe(true);
      if (stage !== "policy") expect(ownership).toBeGreaterThan(0);
      release.resolve(undefined);
      const result: unknown = await execution.catch((error: unknown) => error);
      if (afterRead) expect(result).toMatchObject({ state: "execution-unknown" });
      else expect(result).not.toMatchObject({ state: "completed" });
      await closing;
      expect(ownership).toBe(0);
      expect(fs.existsSync(f.service.root)).toBe(false);
      expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
      expect(f.reads.mock.calls.length).toBe(afterRead ? 1 : 0);
      expect(f.outputs.length).toBeLessThanOrEqual(stage === "response" ? 1 : 0);
    } finally {
      release.resolve(undefined);
      await execution.catch(() => undefined);
      await closing;
    }
  },
);

it.each(
  (["capture", "authorization"] as const).flatMap((stage) =>
    (["expiry", "authority-abort"] as const).map((mutation) => ({ stage, mutation })),
  ),
)("queued $stage evidence does not start after fresh $mutation", async ({ stage, mutation }) => {
  const f = await fixture();
  const freshAbort = new AbortController();
  let authorizations = 0,
    evaluations = 0,
    queued = false,
    rawCaptures = 0,
    rawAuthorizations = 0;
  const original = f.factory.getMockImplementation()!;
  f.factory.mockImplementationOnce(async () => {
    const fresh = await original();
    fresh.authority.signal = freshAbort.signal;
    const assert = fresh.authority.assertCurrent.bind(fresh.authority);
    fresh.authority.assertCurrent = (action) => {
      assert(action);
      // Schedule between the fence's synchronous admission check and the
      // newly queued raw hook. Mutation is not visible until the microtask.
      if (!queued && (stage === "capture" ? authorizations >= 1 : evaluations >= 4)) {
        queued = true;
        queueMicrotask(() => {
          if (mutation === "expiry") f.base.clock.advance(55000);
          else freshAbort.abort("Fresh authority independently revoked");
        });
      }
    };
    const authorize = fresh.authority.authorize.bind(fresh.authority);
    fresh.authority.authorize = async (...args) => {
      authorizations++;
      return authorize(...args);
    };
    const evaluate = fresh.policy.evaluate.bind(fresh.policy);
    fresh.policy.evaluate = async (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    const capture = fresh.evidence.recordCapture.bind(fresh.evidence);
    const record = fresh.evidence.recordAuthorization.bind(fresh.evidence);
    fresh.evidence = {
      ...fresh.evidence,
      recordCapture: async (...args) => {
        rawCaptures++;
        return capture(...args);
      },
      recordAuthorization: async (...args) => {
        rawAuthorizations++;
        return record(...args);
      },
    };
    return fresh;
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  const result: unknown = await execution.catch((error: unknown) => error);
  expect(queued).toBe(true);
  expect(f.base.caller.signal.aborted).toBe(false);
  expect(f.base.abort.signal.aborted).toBe(false);
  expect(result).not.toMatchObject({ state: "completed" });
  expect(rawCaptures).toBe(stage === "capture" ? 0 : 1);
  expect(rawAuthorizations).toBe(0);
  expect(f.reads).not.toHaveBeenCalled();
  expect(f.outputs).toEqual([]);
  expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
});

it.each(["authority-abort", "retire", "nan"] as const)(
  "the final queued-hook clock cannot admit evidence after %s",
  async (mutation) => {
    const f = await fixture();
    const freshAbort = new AbortController();
    let authorizations = 0,
      queued = false,
      armed = false,
      mutateNext = false,
      mutated = false,
      rawCaptures = 0;
    const original = f.factory.getMockImplementation()!;
    f.factory.mockImplementationOnce(async () => {
      const fresh = await original();
      fresh.authority.signal = freshAbort.signal;
      const now = fresh.authority.clock.now.bind(fresh.authority.clock);
      fresh.authority.clock = {
        isoNow: fresh.authority.clock.isoNow.bind(fresh.authority.clock),
        now: () => {
          const value = now();
          if (mutateNext && !mutated) {
            mutated = true;
            if (mutation === "authority-abort") freshAbort.abort("Revoked in final clock callback");
            if (mutation === "retire") f.service.retirePreparedHumanRead(f.pending);
            if (mutation === "nan") return Number.NaN;
          }
          return value;
        },
      };
      const assert = fresh.authority.assertCurrent.bind(fresh.authority);
      fresh.authority.assertCurrent = (action) => {
        assert(action);
        if (armed) {
          armed = false;
          mutateNext = true;
        }
        if (!queued && authorizations >= 1) {
          queued = true;
          queueMicrotask(() => {
            armed = true;
          });
        }
      };
      const authorize = fresh.authority.authorize.bind(fresh.authority);
      fresh.authority.authorize = async (...args) => {
        authorizations++;
        return authorize(...args);
      };
      const record = fresh.evidence.recordCapture.bind(fresh.evidence);
      fresh.evidence = {
        ...fresh.evidence,
        recordCapture: async (...args) => {
          rawCaptures++;
          return record(...args);
        },
      };
      return fresh;
    });
    await f.answer();
    const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
    const result: unknown = await execution.catch((error: unknown) => error);
    expect(mutated).toBe(true);
    expect(rawCaptures).toBe(0);
    expect(f.reads).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ state: "completed" });
    expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
  },
);

it("expiry queued by the physical read refuses observation publication and preserves an unknown effect", async () => {
  const physicalRead = fs.readSync;
  const f = await fixture();
  let observations = 0,
    responses = 0;
  f.hooks.observed = async () => {
    observations++;
  };
  f.hooks.respond = async () => {
    responses++;
  };
  f.reads.mockImplementation((...args) => {
    const count = Reflect.apply<unknown, Parameters<typeof physicalRead>, number>(physicalRead, fs, args);
    queueMicrotask(() => f.base.clock.advance(55000));
    return count;
  });
  await f.answer();
  const execution = f.service.executePreparedHumanRead(f.pending, f.base.caller.signal);
  expect(await execution).toMatchObject({ state: "execution-unknown" });
  expect(f.reads).toHaveBeenCalledTimes(1);
  expect(observations).toBe(0);
  expect(responses).toBe(0);
  expect(f.outputs).toEqual([]);
  expect(f.base.caller.signal.aborted).toBe(false);
  expect(f.service.executePreparedHumanRead(f.pending, f.base.caller.signal)).toBe(execution);
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
