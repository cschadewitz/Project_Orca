/** Original callback capability tests. Real registry/lease/event algorithms; no build qualification or execution. */
import { expect, it } from "vitest";
import { systemClock } from "@orca/core";
import { memoryStores } from "@orca/store";
import { askHumanInput, type HumanInputQuery } from "../src/human-input.js";
import {
  bindOriginalDelivery,
  claimOriginalDelivery,
  LiveHumanInput,
  readOriginalDelivery,
} from "../src/live-input.js";

async function fixture() {
  const stores = memoryStores();
  const lease = await stores.leases.acquire({ resource: "run:run", holder: "original" });
  const live = new LiveHumanInput("boot");
  const abort = new AbortController();
  const actor = { principalId: "synthetic-alice", credentialId: "synthetic-credential" };
  let query!: HumanInputQuery;
  const result = askHumanInput({
    port: live,
    clock: systemClock,
    runId: "run",
    stepRunId: "step",
    kind: "permission",
    question: "Read the owned disposable bytes once?",
    options: ["once", "deny"],
    emit: (event) => stores.events.append({ ...event, runId: "run" }),
    live: {
      identity: { instanceId: "boot", sessionId: "session", turnId: "turn", invocationId: "invocation" },
      signal: abort.signal,
      withOwnership: (work) => stores.leases.withOwnership(lease, work),
      emitOwned: (event) => stores.events.append({ ...event, runId: "run" }),
    },
    onRequested: (value) => {
      query = value;
    },
  });
  await expect.poll(() => Boolean(query)).toBe(true);
  const handle = live.retainOriginalDelivery(query),
    scope = Object.freeze({}),
    action = Object.freeze({});
  bindOriginalDelivery(handle, query, scope);
  const target = {
    ...query.live!.identity,
    runId: query.runId,
    stepRunId: query.stepRunId,
    requestId: query.requestId,
  };
  return {
    live,
    stores,
    abort,
    actor,
    query,
    handle,
    scope,
    action,
    result,
    answer: () => live.answer({ target, optionId: "once" }, { actor, authorize: async () => {} }),
    close: async () => {
      live.close();
      await result;
    },
  };
}
it("only the prebound lineage can claim actual delivery once for its exact action", async () => {
  const f = await fixture();
  try {
    expect(() => bindOriginalDelivery(f.handle, f.query, {})).toThrow();
    await f.answer();
    expect(await f.result).toBe("once");
    const first = await claimOriginalDelivery(f.handle, f.query, f.actor, "once", f.action, f.scope);
    expect(await claimOriginalDelivery(f.handle, f.query, f.actor, "once", f.action, f.scope)).toEqual(first);
    const event = (await f.stores.events.readTypes("run", ["human.answered"]))[0]!;
    expect(first.acceptedAnswerRef).toBe(JSON.stringify(["run", event.id]));
    await expect(claimOriginalDelivery(f.handle, f.query, f.actor, "once", {}, f.scope)).rejects.toThrow();
    await expect(claimOriginalDelivery(f.handle, f.query, f.actor, "once", f.action, {})).rejects.toThrow();
    expect(() => bindOriginalDelivery(f.handle, f.query, f.scope)).toThrow(); // No late binding after delivery.
    const restarted = new LiveHumanInput("boot");
    expect(() => restarted.retainOriginalDelivery(f.query)).toThrow();
    expect(restarted.pendingCount).toBe(0);
  } finally {
    await f.close();
  }
});
it.each(["signal", "target", "identity", "close"] as const)(
  "original %s changes invalidate settled delivery",
  async (reason) => {
    const f = await fixture();
    try {
      await f.answer();
      expect(await f.result).toBe("once");
      if (reason === "signal") f.abort.abort();
      if (reason === "target") f.query.requestId = "replacement";
      if (reason === "identity") f.query.live!.identity.turnId = "replacement";
      if (reason === "close") f.live.close();
      await expect(readOriginalDelivery(f.handle, f.query, f.actor, "once")).rejects.toThrow();
      await expect(claimOriginalDelivery(f.handle, f.query, f.actor, "once", f.action, f.scope)).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);
