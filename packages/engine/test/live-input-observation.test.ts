/** Observation revisions fence snapshots without acquiring any answer authority. */
import { expect, it, vi } from "vitest";
import { memoryStores } from "@orca/store";
import { HumanInputPending, type HumanInputQuery } from "../src/human-input.js";
import {
  LiveHumanInput,
  type LiveAnswerAuthority,
  type LiveDecisionTarget,
  type LiveInputBinding,
} from "../src/live-input.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const stores = memoryStores();
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "owner" });
  const port = new LiveHumanInput("boot");
  const owner = new AbortController();
  const queryAbort = new AbortController();
  const emitOwned = vi.fn(async () => {});
  const live: LiveInputBinding = {
    identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    signal: owner.signal,
    withOwnership: (operation) => stores.leases.withOwnership(lease, operation),
    emitOwned,
  };
  const query: HumanInputQuery = {
    runId: "run",
    stepRunId: "step",
    requestId: "request",
    kind: "permission",
    question: "Execute?",
    options: [{ id: "yes", label: "Yes" }],
    context: {},
    signal: queryAbort.signal,
    live,
  };
  const target: LiveDecisionTarget = { ...live.identity, runId: "run", stepRunId: "step", requestId: "request" };
  const authority: LiveAnswerAuthority = {
    actor: { principalId: "alice", credentialId: "credential" },
    authorize: vi.fn(async () => {}),
  };
  const emptyRevision = port.observationRevision;
  const result = port.ask(query);
  void result.catch(() => undefined);
  const answer = () => port.answer({ target, optionId: "yes" }, authority);
  return {
    port,
    owner,
    queryAbort,
    query,
    target,
    authority,
    result,
    answer,
    emptyRevision,
    stores,
    lease,
    live,
    emitOwned,
  };
}

it("changes on registration and distinguishes replacement ports with the same instance and pending identities", async () => {
  const first = await fixture();
  const replacement = await fixture();
  expect(first.port.observationRevision).not.toBe(first.emptyRevision);
  expect(first.port.observationRevision).toContain(first.port.instanceId);
  expect(first.emptyRevision).not.toBe(replacement.emptyRevision);
  expect(first.port.observationRevision).not.toBe(replacement.port.observationRevision);
  const revision = first.port.observationRevision;
  expect(first.port.inspect(first.target)).toBe("pending");
  expect(first.port.recordsAnswer(first.query)).toBe(true);
  expect(first.port.observationRevision).toBe(revision);
  first.port.close();
  replacement.port.close();
  await Promise.all([first.result, replacement.result]);
});

it("changes before accepting becomes observable and again on successful removal without invalidating", async () => {
  const f = await fixture();
  const entered = latch();
  const resume = latch();
  let calls = 0;
  f.authority.authorize = async () => {
    if (++calls === 2) {
      entered.release();
      await resume.promise;
    }
  };
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  const pendingRevision = f.port.observationRevision;
  const answer = f.answer();
  await entered.promise;
  const acceptingRevision = f.port.observationRevision;
  expect(f.port.inspect(f.target)).toBe("accepting");
  expect(acceptingRevision).not.toBe(pendingRevision);
  expect(f.emitOwned).not.toHaveBeenCalled();
  await expect(f.answer()).rejects.toMatchObject({ details: { liveInputState: "accepting" } });
  expect(f.port.observationRevision).toBe(acceptingRevision);
  resume.release();
  await expect(answer).resolves.toEqual({ answerRecorded: true, delivered: true });
  expect(await f.result).toBe("yes");
  expect(f.port.inspect(f.target)).toBe("expired");
  expect(f.port.observationRevision).not.toBe(acceptingRevision);
  expect(f.port.observationRevision).not.toBe(pendingRevision);
  expect(invalidated).not.toHaveBeenCalled();
  const expiredRevision = f.port.observationRevision;
  await expect(f.answer()).rejects.toMatchObject({ details: { liveInputState: "expired" } });
  expect(f.port.observationRevision).toBe(expiredRevision);
});

it("does not reuse a pending revision after a safely refused responder releases its claim", async () => {
  const f = await fixture();
  const entered = latch();
  const resume = latch();
  const refused = new Error("authority revoked while waiting");
  let calls = 0;
  f.authority.authorize = async () => {
    if (++calls === 2) {
      entered.release();
      await resume.promise;
      throw refused;
    }
  };
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  const pendingRevision = f.port.observationRevision;
  const answer = f.answer();
  const rejected = expect(answer).rejects.toBe(refused);
  await entered.promise;
  const acceptingRevision = f.port.observationRevision;
  expect(acceptingRevision).not.toBe(pendingRevision);
  resume.release();
  await rejected;
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(f.port.observationRevision).not.toBe(pendingRevision);
  expect(f.port.observationRevision).not.toBe(acceptingRevision);
  expect(invalidated).not.toHaveBeenCalled();
  expect(f.emitOwned).not.toHaveBeenCalled();
  await f.answer();
  expect(await f.result).toBe("yes");
});

it.each(["owner", "queryAbort"] as const)("changes before %s abort observers run, once per removal", async (source) => {
  const f = await fixture();
  const pendingRevision = f.port.observationRevision;
  const observations: string[] = [];
  f.port.onInvalidated((target) => {
    expect(target).toEqual(f.target);
    expect(f.port.inspect(target)).toBe("expired");
    observations.push(f.port.observationRevision);
  });
  f[source].abort();
  expect(await f.result).toBeUndefined();
  expect(observations).toEqual([f.port.observationRevision]);
  expect(f.port.observationRevision).not.toBe(pendingRevision);
  const removedRevision = f.port.observationRevision;
  f.owner.abort();
  f.queryAbort.abort();
  expect(f.port.observationRevision).toBe(removedRevision);
  expect(f.emitOwned).not.toHaveBeenCalled();
});

it("changes for lease loss without reopening the pending identity or writing an answer", async () => {
  const f = await fixture();
  const pendingRevision = f.port.observationRevision;
  const invalidated = vi.fn();
  f.port.onInvalidated(invalidated);
  await f.stores.leases.release(f.lease);
  await expect(f.answer()).rejects.toMatchObject({ code: "RUN_LEASED" });
  expect(await f.result).toBeUndefined();
  expect(f.port.observationRevision).not.toBe(pendingRevision);
  expect(f.port.inspect(f.target)).toBe("expired");
  expect(invalidated).toHaveBeenCalledExactlyOnceWith(f.target);
  expect(f.emitOwned).not.toHaveBeenCalled();
});

it("does not advance again when an accepting answer unwinds after its callback was invalidated", async () => {
  const f = await fixture();
  const entered = latch();
  const resume = latch();
  let calls = 0;
  f.authority.authorize = async () => {
    if (++calls === 2) {
      entered.release();
      await resume.promise;
    }
  };
  const answer = f.answer();
  const rejected = expect(answer).rejects.toMatchObject({ details: { liveInputState: "expired" } });
  await entered.promise;
  const acceptingRevision = f.port.observationRevision;
  f.owner.abort();
  expect(await f.result).toBeUndefined();
  const removedRevision = f.port.observationRevision;
  expect(removedRevision).not.toBe(acceptingRevision);
  resume.release();
  await rejected;
  expect(f.port.observationRevision).toBe(removedRevision);
  expect(f.emitOwned).not.toHaveBeenCalled();
});

it("changes on shutdown and each removed callback, but repeated shutdown is a no-op", async () => {
  const f = await fixture();
  const second = f.port.ask({ ...f.query, requestId: "second" });
  const before = f.port.observationRevision;
  const observations: string[] = [];
  f.port.onInvalidated(() => observations.push(f.port.observationRevision));
  f.port.close();
  expect(await Promise.all([f.result, second])).toEqual([undefined, undefined]);
  expect(observations).toHaveLength(2);
  expect(new Set([before, ...observations]).size).toBe(3);
  const closedRevision = f.port.observationRevision;
  f.port.close();
  f.owner.abort();
  expect(await f.port.ask({ ...f.query, requestId: "after-close" })).toBeUndefined();
  expect(f.port.observationRevision).toBe(closedRevision);
  expect(observations).toHaveLength(2);
});

it("observes the first close even without pending callbacks", () => {
  const port = new LiveHumanInput("boot");
  const openRevision = port.observationRevision;
  port.close();
  expect(port.observationRevision).not.toBe(openRevision);
  const closedRevision = port.observationRevision;
  port.close();
  expect(port.observationRevision).toBe(closedRevision);
});

it.each(["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId", "requestId"] as const)(
  "does not change for a wrong %s read or answer",
  async (key) => {
    const f = await fixture();
    const revision = f.port.observationRevision;
    const target = { ...f.target, [key]: "wrong-target" };
    expect(f.port.inspect(target)).toBe(key === "instanceId" ? "owner-unavailable" : "expired");
    await expect(f.port.answer({ target, optionId: "yes" }, f.authority)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.port.observationRevision).toBe(revision);
    expect(f.emitOwned).not.toHaveBeenCalled();
    f.port.close();
    await f.result;
  },
);

it("does not change for rejected registration, option, standing writer, initial authority, or observer changes", async () => {
  const f = await fixture();
  const revision = f.port.observationRevision;
  f.port.onInvalidated(() => {})();
  await expect(f.port.ask(f.query)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(f.port.ask({ ...f.query, kind: "decision" })).rejects.toBeInstanceOf(HumanInputPending);
  const { live: _live, ...unsupported } = f.query;
  expect(await f.port.ask(unsupported)).toBeUndefined();
  expect(await f.port.ask({ ...f.query, signal: AbortSignal.abort() })).toBeUndefined();
  await expect(
    f.port.ask({ ...f.query, live: { ...f.live, identity: { ...f.live.identity, instanceId: "elsewhere" } } }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(f.port.answer({ target: f.target, optionId: "unknown" }, f.authority)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  await expect(f.port.answer({ target: f.target, optionId: "yes", standing: true }, f.authority)).rejects.toMatchObject(
    { code: "NOT_SUPPORTED" },
  );
  const refused = new Error("not authorized");
  f.authority.authorize = async () => {
    throw refused;
  };
  await expect(f.answer()).rejects.toBe(refused);
  expect(f.port.observationRevision).toBe(revision);
  expect(f.port.inspect(f.target)).toBe("pending");
  expect(f.emitOwned).not.toHaveBeenCalled();
  f.port.close();
  await f.result;
});

it.each(["append", "standing"] as const)(
  "changes on terminal %s failure without a second invalidation",
  async (failure) => {
    const f = await fixture();
    const failed = new Error(`${failure} failed`);
    const pendingRevision = f.port.observationRevision;
    let acceptingRevision: string | undefined;
    f.live.emitOwned = async () => {
      acceptingRevision = f.port.observationRevision;
      if (failure === "append") throw failed;
    };
    const invalidated = vi.fn();
    f.port.onInvalidated(invalidated);
    const afterAnswer = async () => {
      throw failed;
    };
    await expect(
      f.port.answer({ target: f.target, optionId: "yes", standing: true }, f.authority, afterAnswer),
    ).rejects.toThrow(failure === "append" ? failed.message : "standing permission failed");
    await expect(f.result).rejects.toBeInstanceOf(failure === "append" ? Error : HumanInputPending);
    expect(acceptingRevision).toBeDefined();
    expect(acceptingRevision).not.toBe(pendingRevision);
    const removedRevision = f.port.observationRevision;
    expect(removedRevision).not.toBe(acceptingRevision);
    expect(f.port.inspect(f.target)).toBe("expired");
    expect(invalidated).toHaveBeenCalledExactlyOnceWith(f.target);
    f.owner.abort();
    expect(f.port.observationRevision).toBe(removedRevision);
    expect(invalidated).toHaveBeenCalledTimes(1);
  },
);
