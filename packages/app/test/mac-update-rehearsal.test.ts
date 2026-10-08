/** Coherent pre-restart rehearsal; faults cross real consent, preload, window and runtime ownership. */
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { MacNativeInspection } from "../src/main/mac-candidate-download.js";
import { macUpdateRehearsal, barrier, type ProofFault } from "./mac-update-rehearsal-fixture.js";

const fixtures: Awaited<ReturnType<typeof macUpdateRehearsal>>[] = [];
async function fixture() {
  const f = await macUpdateRehearsal();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) {
    try {
      expect(f.activate).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(await f.statePreserved()).toBe(true);
      await f.discard();
      expect(await f.downloadEntries()).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

it("waits for a real pending live callback before reaching pre-restart validation without cancelling it", async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.ownRelease(() => abort.abort());
  const identity = {
    runId: "synthetic-run",
    stepRunId: "step",
    requestId: "permission",
    instanceId: f.target.instanceId,
    sessionId: "session",
    turnId: "turn",
    invocationId: "invocation",
  };
  // A disposable callback source enters the actual serving LiveInput port.
  // No work registry, input implementation or runtime proof is replaced.
  const ask = f.runtime.port.ask({
    ...identity,
    kind: "permission",
    question: "Synthetic callback",
    context: {},
    options: [{ id: "allow", label: "Allow" }],
    live: { identity, signal: abort.signal, withOwnership: (operation) => operation(), emitOwned: async () => {} },
  });
  try {
    const id = f.present();
    expect((await f.updates.approve(id)).blocker).toBe("activity");
    expect(f.runtime.activity.snapshot().active).toContain("callback");
    expect(f.runtime.port.pendingCount).toBe(1);
    expect(abort.signal.aborted).toBe(false);
    expect(f.revalidate).not.toHaveBeenCalled();
    expect(f.windows.active).toBe(false);
  } finally {
    // The source finishes its own callback; the updater never cancels or answers it.
    abort.abort();
    await ask;
  }
  const pending = f.updates.reconsider();
  await f.validated.promise;
  expect(f.runtimeEvents.map((event) => event.outcome)).toEqual(["blocked", "held"]);
  f.finishValidation.release();
  expect((await pending).phase).toBe("recovery-required");
});

it.each(["prepare", "release"] as const)("retains the composed window owner after a lost %s ACK", async (phase) => {
  const f = await fixture();
  if (phase === "prepare") f.a.auto(false);
  else {
    f.a.dirty(true);
    f.a.dropRelease();
  }
  const entered = barrier();
  f.prepareDrafts.mockImplementationOnce(() => {
    vi.useFakeTimers();
    const pending = f.guards.prepareDrafts();
    entered.release();
    return pending;
  });
  const pending = f.updates.approve(f.present());
  await entered.promise;
  await vi.advanceTimersByTimeAsync(5000);
  if (phase === "prepare") await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).phase).toBe("recovery-required");
  vi.useRealTimers();
  expect(f.windows.active).toBe(true);
  expect(f.a.enabled()).toBe(false);
  expect(f.runtimeEvents).toEqual([]);
  expect(f.revalidate).not.toHaveBeenCalled();
  // Late ACKs cannot let a sealed coordinator retry or silently release the held boundary.
  f.a.ack({ ...f.a.messages[0], ready: true });
  expect(f.windows.active).toBe(true);
  await f.updates.reconsider();
  expect(f.prepareDrafts).toHaveBeenCalledOnce();
});

it("binds approval to bytes, waits for real producer work, then acquires both leases and stops before restart", async () => {
  const f = await fixture();
  const id = f.present();
  expect(f.updates.state).toEqual({ phase: "available", offerId: id });
  await f.updates.approve("stale-offer");
  expect(f.downloadFetch).not.toHaveBeenCalled();
  const finish = f.runtime.activity.enter("dispatch");
  f.ownRelease(finish);
  const approval = f.updates.approve(id);
  await f.updates.approve(id);
  expect(await approval).toEqual({ phase: "waiting", offerId: id, blocker: "activity" });
  expect(f.download).toHaveBeenCalledOnce();
  expect(f.revalidate).not.toHaveBeenCalled();
  expect(f.runtimeEvents).toEqual([{ action: "prepare", outcome: "blocked" }]);
  expect(f.windows.active).toBe(false);
  expect(f.a.enabled()).toBe(true);
  expect(f.b.enabled()).toBe(false);
  expect(f.owned).toHaveLength(1);
  expect(await readFile(`${f.owned[0]!.directory}/native-mac-artifact.json`)).toEqual(f.bytes);
  finish();
  const preparing = f.updates.reconsider();
  await f.validated.promise;
  expect(f.updates.state.phase).toBe("preparing");
  expect(f.revalidate).toHaveBeenCalledWith(f.binding.candidate, f.target);
  expect(f.guards.draftsValid()).toBe(true);
  expect(f.a.frozen()).toBe(true);
  expect(f.b.frozen()).toBe(true);
  expect(f.a.freezeOrder.every(Boolean)).toBe(true);
  expect(f.b.freezeOrder.every(Boolean)).toBe(true);
  expect(() => f.runtime.activity.enter("dispatch")).toThrow();
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  expect(f.windows.requestCreation()).toBe(false);
  expect(f.created).not.toHaveBeenCalled();
  f.finishValidation.release();
  expect((await preparing).phase).toBe("recovery-required");
  expect(f.runtimeEvents).toEqual([
    { action: "prepare", outcome: "blocked" },
    { action: "prepare", outcome: "held" },
  ]);
  expect(f.windows.active).toBe(true);
  expect(f.updates.defer(id)).toBe(false);
  expect((await f.updates.approve(id)).phase).toBe("recovery-required");
});

it("observes work entering after the window ACKs but before runtime acquisition and safely defers/reapproves", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  f.beforePrepare(() => {
    expect(f.a.frozen()).toBe(true);
    finish = f.runtime.activity.enter("dispatch");
    f.ownRelease(finish);
  });
  const old = f.present();
  expect((await f.updates.approve(old)).blocker).toBe("activity");
  expect(f.updates.defer(old)).toBe(true);
  await f.discard();
  expect(await f.downloadEntries()).toEqual([]);
  const fresh = f.present();
  expect(fresh).not.toBe(old);
  await f.updates.approve(old);
  expect(f.download).toHaveBeenCalledOnce();
  finish!();
  f.beforePrepare(() => {});
  const pending = f.updates.approve(fresh);
  await f.validated.promise;
  expect(f.download).toHaveBeenCalledTimes(2);
  expect(f.catalog).toHaveBeenCalledTimes(4);
  expect(f.inspect).toHaveBeenCalledTimes(2);
  f.finishValidation.release();
  expect((await pending).phase).toBe("recovery-required");
});

it("ignores stale nonce, phase, generation and frame ACKs across approval, then cancels before admission", async () => {
  const f = await fixture();
  f.a.auto(false);
  const id = f.present();
  const entered = barrier();
  let preparationSettled = false;
  f.prepareDrafts.mockImplementationOnce(() => {
    const result = f.guards.prepareDrafts().then((value) => {
      preparationSettled = true;
      return value;
    });
    entered.release();
    return result;
  });
  const pending = f.updates.approve(id);
  await entered.promise;
  const message = f.a.messages[0]!;
  const invalid = [
    ["nonce", () => f.a.ack({ ...message, nonce: "stale", ready: true })],
    ["generation", () => f.a.ack({ ...message, generation: message.generation + 1, ready: true })],
    ["phase", () => f.a.ack({ ...message, phase: "release", ready: true })],
    ["frame", () => f.a.ack({ ...message, ready: true }, {})],
  ] as const;
  for (const [kind, acknowledge] of invalid) {
    acknowledge();
    // An accepted ACK resolves the guard through promise continuations. One event-loop
    // turn drains those microtasks before observing it; cancellation must not mask ready.
    await nextTurn();
    expect(preparationSettled, `Invalid ${kind} ACK settled preparation`).toBe(false);
    expect(f.guards.draftsValid()).toBe(false);
    expect(f.updates.state.phase).toBe("preparing");
    expect(f.runtimeEvents).toEqual([]);
  }
  expect(f.updates.defer(id)).toBe(true);
  f.a.auto(true);
  f.a.forward();
  expect((await pending).phase).toBe("deferred");
  expect(preparationSettled).toBe(true);
  expect(f.a.frozen()).toBe(false);
  expect(f.a.enabled()).toBe(true);
  expect(f.b.enabled()).toBe(false);
  expect(f.ipc.listenerCount("orca:macUpdate.prepared")).toBe(0);
  expect(f.runtimeEvents).toEqual([]);
});

it("retains window and target ownership when a document is replaced during actual runtime acquisition", async () => {
  const f = await fixture();
  f.afterPrepare(async () => {
    f.a.replace();
  });
  expect((await f.updates.approve(f.present())).phase).toBe("recovery-required");
  f.a.ack({ ...f.a.messages[0], ready: true });
  expect(f.guards.draftsValid()).toBe(false);
  expect(f.windows.active).toBe(true);
  expect(f.a.enabled()).toBe(false);
  expect(f.runtimeEvents).toEqual([{ action: "prepare", outcome: "held" }]);
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  expect(f.revalidate).not.toHaveBeenCalled();
});

it.each<ProofFault>(["lost", "proof", "pid", "instance", "active"])(
  "seals the composed coordinator on a %s runtime response after the authentic daemon acquires",
  async (fault) => {
    const f = await fixture();
    f.fault(fault);
    const id = f.present();
    expect((await f.updates.approve(id)).phase).toBe("recovery-required");
    expect(f.windows.active).toBe(true);
    expect(f.a.frozen()).toBe(true);
    expect(f.runtimeEvents).toEqual([{ action: "prepare", outcome: "held" }]);
    expect(f.revalidate).not.toHaveBeenCalled();
    expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
    await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
    await f.updates.reconsider();
    expect(f.runtimeEvents).toHaveLength(1);
    expect(f.updates.defer(id)).toBe(false);
  },
);

it("cancellation after acquisition retains both owners when release fails, without retry or reopening", async () => {
  const f = await fixture();
  const held = barrier();
  const deliver = barrier();
  f.ownRelease(deliver.release);
  f.afterPrepare(async () => {
    held.release();
    await deliver.promise;
  });
  f.failRelease();
  const id = f.present();
  const pending = f.updates.approve(id);
  await held.promise;
  expect(f.updates.defer(id)).toBe(true);
  deliver.release();
  expect((await pending).phase).toBe("recovery-required");
  expect(f.runtimeEvents.map((event) => event.action)).toEqual(["prepare", "resume"]);
  expect(f.windows.active).toBe(true);
  expect(f.a.frozen()).toBe(true);
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  await expect(f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  await f.updates.reconsider();
  expect(f.runtimeEvents).toHaveLength(2);
  expect(f.revalidate).not.toHaveBeenCalled();
});

it("keeps native/user draft state on draft refusal, then rejects download failure before acquiring guards", async () => {
  const f = await fixture();
  f.a.dirty(true);
  const id = f.present();
  expect((await f.updates.approve(id)).blocker).toBe("drafts");
  expect(f.a.frozen()).toBe(false);
  expect(f.a.enabled()).toBe(true);
  expect(f.runtimeEvents).toEqual([]);
  f.updates.defer(id);
  await f.discard();
  f.a.dirty(false);
  f.downloadFetch.mockImplementationOnce(async (url) => {
    const response = new Response("broken payload");
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  expect((await f.updates.approve(f.present())).phase).toBe("failed");
  expect(f.verification).toEqual(["verified", "failed"]);
  expect(await f.downloadEntries()).toEqual([]);
  expect(f.prepareDrafts).toHaveBeenCalledOnce();
  expect(f.windows.active).toBe(false);
});

it("cancels a stalled real download before freeze and rejects its late transport result", async () => {
  const f = await fixture();
  const entered = barrier();
  const deliver = barrier();
  const cancelled = barrier();
  f.ownRelease(deliver.release);
  const original = f.downloadFetch.getMockImplementation()!;
  f.downloadFetch.mockImplementationOnce(async (url) => {
    entered.release();
    await deliver.promise;
    const response = await original(url);
    const late = new Response(
      new ReadableStream({
        cancel: () => {
          cancelled.release();
        },
      }),
    );
    Object.defineProperty(late, "url", { value: response.url });
    return late;
  });
  const id = f.present();
  const pending = f.updates.approve(id);
  await entered.promise;
  expect(f.updates.defer(id)).toBe(true);
  expect((await pending).phase).toBe("deferred");
  expect(await f.downloadEntries()).toEqual([]);
  deliver.release();
  await cancelled.promise;
  expect(f.prepareDrafts).not.toHaveBeenCalled();
  expect(f.runtimeEvents).toEqual([]);
  expect(f.windows.active).toBe(false);
});

it("uses the real candidate session for disposed-offer and malformed native-proof gates while its guard seam stays disabled", async () => {
  const f = await fixture();
  const input = { manifestBytes: f.bytes, source: f.binding.source, ...f.binding.candidate };
  const signal = new AbortController().signal;
  const offered = await f.session.offer(input, f.target, signal);
  if (offered.outcome !== "available") throw new Error("Expected available synthetic offer");
  expect((await f.session.approve(offered.offerId)).blocker).toBe("candidate");
  expect(f.session.verification).toBe("verified");
  expect(f.session.defer(offered.offerId)).toBe(true);
  // Session cleanup is asynchronous; bounded observation, with no timeout increase.
  await vi.waitFor(async () => expect(await f.downloadEntries()).toEqual([]));
  await f.session.approve(offered.offerId);
  expect(f.inspect).toHaveBeenCalledOnce();
  const fresh = await f.session.offer(input, f.target, signal);
  if (fresh.outcome !== "available") throw new Error("Expected fresh synthetic offer");
  expect(fresh.offerId).not.toBe(offered.offerId);
  f.inspect.mockResolvedValueOnce({ outcome: "verified" } as MacNativeInspection);
  expect((await f.session.approve(fresh.offerId)).phase).toBe("failed");
  expect(f.session.verification).toBe("unknown");
  expect(await f.session.offer(input, f.target, signal)).toEqual({ outcome: "unknown" });
  expect(f.runtimeEvents).toEqual([]);
  expect(f.windows.active).toBe(false);
});
