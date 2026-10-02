/** Owner-local decisions: exact identities, lease fencing, authority, and durable-gate fallback. */
import { expect, it, vi } from "vitest";
import { FakeClock, type OrcaEventInput } from "@orca/core";
import { memoryStores } from "@orca/store";
import { askHumanInput, HumanInputPending, type HumanInputQuery } from "../src/human-input.js";
import {
  LiveHumanInput,
  type LiveAnswerAuthority,
  type LiveDecisionTarget,
  type LiveInputBinding,
} from "../src/live-input.js";

async function fixture() {
  const stores = memoryStores();
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const port = new LiveHumanInput("boot");
  const abort = new AbortController();
  const writes: Omit<OrcaEventInput, "runId">[] = [];
  const emit = vi.fn(async (event: Omit<OrcaEventInput, "runId">) => {
    writes.push(event);
  });
  const live: LiveInputBinding = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: abort.signal,
    withOwnership: (write) => stores.leases.withOwnership(lease, write),
    emitOwned: emit,
  };
  let query!: HumanInputQuery;
  const result = askHumanInput({
    port,
    emit,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Execute?",
    options: ["yes", "no"],
    live,
    onRequested: (q) => {
      query = q;
    },
  });
  // Observe rejections from parking even before the test starts awaiting the result.
  void result.catch(() => undefined);
  await vi.waitFor(() => expect(query).toBeDefined());
  const target: LiveDecisionTarget = { ...live.identity, runId: "run", stepRunId: "step", requestId: query.requestId };
  await vi.waitFor(() => expect(port.inspect(target)).toBe("pending"));
  const authority: LiveAnswerAuthority = {
    actor: { principalId: "alice", credentialId: "credential" },
    authorize: vi.fn(async () => {}),
  };
  const answer = (optionId = "yes", who = authority) => port.answer({ target, optionId }, who);
  return { port, abort, writes, result, target, authority, answer, stores, live, query, lease };
}

it("accepts once under the original lease, attributes the actor and does not append a second answer", async () => {
  const f = await fixture();
  const answers = await Promise.allSettled([f.answer("yes"), f.answer("no")]);
  expect(answers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await f.result).toBe("yes");
  expect(f.writes.filter((e) => e.type === "human.answered")).toEqual([
    {
      type: "human.answered",
      payload: { stepRunId: "step", requestId: f.target.requestId, answer: "yes", actor: f.authority.actor },
    },
  ]);
  await expect(f.answer()).rejects.toMatchObject({ details: { liveInputState: "expired" } });
});

it.each(["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId", "requestId"] as const)(
  "rejects mismatched %s without consuming the callback",
  async (key) => {
    const f = await fixture();
    await expect(
      f.port.answer({ target: { ...f.target, [key]: "stale" }, optionId: "yes" }, f.authority),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(0);
    await f.answer();
    expect(await f.result).toBe("yes");
  },
);

it("checks authority before revealing owner state and rechecks it after waiting for the lease mutex", async () => {
  const f = await fixture();
  const forbidden = new Error("revoked");
  const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(forbidden);
  await expect(f.answer("yes", { actor: { principalId: "revoked" }, authorize })).rejects.toBe(forbidden);
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(0);
  await expect(
    f.port.answer(
      { target: { ...f.target, instanceId: "elsewhere" }, optionId: "yes" },
      {
        actor: f.authority.actor,
        authorize: async () => {
          throw forbidden;
        },
      },
    ),
  ).rejects.toBe(forbidden);
  await f.answer();
  expect(await f.result).toBe("yes");
});

it("does not let an invalid option consume the ask", async () => {
  const f = await fixture();
  await expect(f.answer("maybe")).rejects.toMatchObject({ code: "RUN_STATE" });
  await f.answer("no");
  expect(await f.result).toBe("no");
});

it("losing the owner's lease refuses the answer before any event or standing write", async () => {
  const f = await fixture();
  await f.stores.leases.release(f.lease);
  await f.stores.leases.acquire({ resource: "run:run", holder: "new-owner" });
  const write = vi.fn(async () => {});
  await expect(
    f.port.answer({ target: f.target, optionId: "yes", standing: true }, f.authority, write),
  ).rejects.toMatchObject({ code: "RUN_LEASED" });
  expect(write).not.toHaveBeenCalled();
  expect(await f.result).toBeUndefined();
  expect(f.port.inspect(f.target)).toBe("expired");
});

it.each(["owner died", "agent died", "lease lost", "cancelled", "timeout", "execution authority revoked"])(
  "expires without approval when %s",
  async (reason) => {
    const f = await fixture();
    const invalidated = vi.fn();
    f.port.onInvalidated(invalidated);
    f.abort.abort(reason);
    expect(await f.result).toBeUndefined();
    expect(invalidated).toHaveBeenCalledExactlyOnceWith(f.target);
    f.port.close();
    expect(invalidated).toHaveBeenCalledTimes(1);
    await expect(f.answer()).rejects.toMatchObject({ details: { liveInputState: "expired" } });
    expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(0);
  },
);

it("checks cancellation again after asynchronous authorization", async () => {
  const f = await fixture();
  const authorize = vi.fn(async () => {
    f.abort.abort();
  });
  await expect(f.answer("yes", { ...f.authority, authorize })).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await f.result).toBeUndefined();
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(0);
});

it("a second process/restarted daemon cannot deliver or replay an old approval", async () => {
  const f = await fixture();
  const restarted = new LiveHumanInput("next-boot");
  await expect(restarted.answer({ target: f.target, optionId: "yes" }, f.authority)).rejects.toMatchObject({
    details: { liveInputState: "owner-unavailable" },
  });
  f.port.close();
  expect(await f.result).toBeUndefined();
  await expect(f.answer()).rejects.toMatchObject({ details: { liveInputState: "expired" } });
});

it("reconnect reads do not settle the callback, and a retry has a new identity", async () => {
  const f = await fixture();
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(f.port.inspect(f.target)).toBe("pending");
  const retry = await fixture();
  expect(retry.target.requestId).not.toBe(f.target.requestId);
  await expect(retry.port.answer({ target: f.target, optionId: "yes" }, retry.authority)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  await retry.answer();
  await f.answer();
});

it("writes standing policy after acceptance and before releasing the original callback", async () => {
  const f = await fixture();
  const order: string[] = [];
  void f.result.then(() => order.push("delivered"));
  const write = vi.fn(async () => {
    expect(f.writes.at(-1)?.type).toBe("human.answered");
    order.push("policy");
  });
  await f.port.answer({ target: f.target, optionId: "yes", standing: true }, f.authority, write);
  await f.result;
  expect(order).toEqual(["policy", "delivered"]);
  expect(f.authority.authorize).toHaveBeenCalledWith(f.target, true);
});

it("standing write failure preserves accepted audit, parks the prompt and never delivers approval", async () => {
  const f = await fixture();
  await expect(
    f.port.answer({ target: f.target, optionId: "yes", standing: true }, f.authority, async () => {
      throw new Error("disk full");
    }),
  ).rejects.toMatchObject({ details: { answerRecorded: true } });
  await expect(f.result).rejects.toBeInstanceOf(HumanInputPending);
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(1);
  await expect(f.answer()).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("still parks durable workflow gates and cancels unsupported permission transports", async () => {
  const f = await fixture();
  const { live: _live, ...query } = f.query;
  await expect(f.port.ask({ ...query, kind: "decision" })).rejects.toBeInstanceOf(HumanInputPending);
  expect(await f.port.ask(query)).toBeUndefined();
  f.port.close();
  await f.result;
});

it("publishes a registered callback, but waits for durable opening before accepting", async () => {
  const f = await fixture();
  await f.answer();
  await f.result;
  const writes: string[] = [];
  let acceptance: Promise<unknown> | undefined;
  let target: LiveDecisionTarget | undefined;
  const result = askHumanInput({
    port: f.port,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Again?",
    options: ["yes"],
    live: f.live,
    emit: async (event) => {
      writes.push(event.type);
      if (event.type === "human.requested") {
        const payload = event.payload as { requestId: string };
        target = { ...f.live.identity, runId: "run", stepRunId: "step", requestId: payload.requestId };
        expect(f.port.inspect(target)).toBe("pending");
        acceptance = f.port.answer({ target, optionId: "yes" }, f.authority);
        await Promise.resolve();
        expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(1);
      }
    },
  });
  expect(await result).toBe("yes");
  await acceptance;
  expect(writes).toEqual(["human.requested", "step.waiting"]);
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(2);
  expect(f.port.inspect(target!)).toBe("expired");
});

it("failed publication removes its callback without recording an answer", async () => {
  const f = await fixture();
  await f.answer();
  let target: LiveDecisionTarget | undefined;
  const result = askHumanInput({
    port: f.port,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Again?",
    options: ["yes"],
    live: f.live,
    emit: async (event) => {
      if (event.type === "human.requested")
        target = {
          ...f.live.identity,
          runId: "run",
          stepRunId: "step",
          requestId: (event.payload as { requestId: string }).requestId,
        };
      throw new Error("disk full");
    },
  });
  await expect(result).rejects.toThrow("disk full");
  expect(f.port.inspect(target!)).toBe("expired");
  expect(f.writes.filter((e) => e.type === "human.answered")).toHaveLength(1);
});

it("does not retry an identity when its answer append reports an uncertain failure", async () => {
  const f = await fixture();
  const original = f.live.emitOwned.bind(f.live);
  f.live.emitOwned = async (event) => {
    await original(event);
    throw new Error("append completion unknown");
  };
  // Publication copied the binding to fence acceptance, so use a fresh ask with this writer.
  f.port.close();
  await f.result;
  const port = new LiveHumanInput("boot");
  let target!: LiveDecisionTarget;
  const result = askHumanInput({
    port,
    clock: new FakeClock(),
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Again?",
    options: ["yes"],
    live: f.live,
    emit: async () => {},
    onRequested: (q) => {
      target = { ...f.live.identity, runId: q.runId, stepRunId: q.stepRunId, requestId: q.requestId };
    },
  });
  void result.catch(() => undefined);
  await vi.waitFor(() => expect(target).toBeDefined());
  const write = vi.fn(async () => {});
  await expect(port.answer({ target, optionId: "yes", standing: true }, f.authority, write)).rejects.toThrow(
    "append completion unknown",
  );
  await expect(result).rejects.toThrow("append completion unknown");
  expect(write).not.toHaveBeenCalled();
  await expect(port.answer({ target, optionId: "yes" }, f.authority)).rejects.toMatchObject({
    details: { liveInputState: "expired" },
  });
});

it("notifies lease-fenced refusal without appending an expiry or answer event", async () => {
  const f = await fixture();
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  const before = [...f.writes];
  await f.stores.leases.release(f.lease);
  await expect(f.answer()).rejects.toMatchObject({ code: "RUN_LEASED" });
  expect(await f.result).toBeUndefined();
  expect(invalidated).toHaveBeenCalledExactlyOnceWith(f.target);
  expect(f.writes).toEqual(before);
});
it("unsubscribing an observer cannot expire a callback or a durable workflow gate", async () => {
  const f = await fixture();
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated)();
  expect(f.port.inspect(f.target)).toBe("pending");
  await expect(f.port.ask({ ...f.query, kind: "decision" })).rejects.toBeInstanceOf(HumanInputPending);
  f.port.close();
  expect(await f.result).toBeUndefined();
  expect(invalidated).not.toHaveBeenCalled();
  expect(f.writes.filter((event) => event.type === "human.answered")).toHaveLength(0);
});
it("observer failures or mutations cannot keep an expired callback alive or corrupt another observer", async () => {
  const f = await fixture();
  f.port.onInvalidated((target) => {
    target.runId = "other";
    throw new Error("observer failed");
  });
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  f.abort.abort("timeout");
  expect(await f.result).toBeUndefined();
  expect(invalidated).toHaveBeenCalledExactlyOnceWith(f.target);
  expect(f.port.inspect(f.target)).toBe("expired");
});
it("successful answers use input.answered, without also announcing expiration", async () => {
  const f = await fixture();
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  await f.answer();
  expect(await f.result).toBe("yes");
  f.port.close();
  expect(invalidated).not.toHaveBeenCalled();
});
