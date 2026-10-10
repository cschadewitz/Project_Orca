/** Real candidate-session/guard composition over owned source fixtures; no native install or recovery claim. */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createMacCandidateSession } from "../src/main/mac-candidate-controller.js";
import type { MacCandidatePrepared } from "../src/main/mac-update-candidates.js";
import { macUpdateRehearsal, barrier, type ProofFault } from "./mac-update-rehearsal-fixture.js";

const closers: (() => Promise<void>)[] = [];
async function reached(checkpoint: ReturnType<typeof barrier>, operation: Promise<unknown>) {
  await Promise.race([
    checkpoint.promise,
    operation.then((state) => {
      throw new Error(`Candidate session settled before checkpoint: ${JSON.stringify(state)}`);
    }),
  ]);
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await macUpdateRehearsal();
  const root = await mkdtemp(join(tmpdir(), "orca-candidate-composition-"));
  const check = vi.fn(async (_prepared: MacCandidatePrepared): Promise<"refused" | "unknown"> => "unknown");
  const session = createMacCandidateSession({
    workspace: f.workspace,
    captureDrain: (target) => f.workspace.captureMacUpdateDrainTarget(target),
    windows: f.windows,
    download: {
      root,
      limits: { fileBytes: 100_000, totalBytes: 1_000_000, operationMs: 10_000 },
      trust: { catalog: f.catalog, inspect: f.inspect },
      fetch: f.downloadFetch,
    },
    checkPrepared: check,
  });
  closers.push(async () => {
    try {
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.activate).not.toHaveBeenCalled();
      expect(await f.statePreserved()).toBe(true);
    } finally {
      // Close the owned disposable daemon before removing retained fixture-only bytes.
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  const input = { ...f.binding.candidate, manifestBytes: f.bytes, source: f.binding.source };
  const offer = async () => {
    const result = await session.offer(input, f.target, new AbortController().signal);
    if (result.outcome !== "available") throw new Error(`Fixture offer ${result.outcome}`);
    return result.offerId;
  };
  const directory = async () => {
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    return join(root, entries[0]!);
  };
  return { f, root, check, session, input, offer, directory };
}

it("never downloads or prepares on activity notifications without this exact candidate's approval", async () => {
  const h = await fixture();
  const id = await h.offer();
  await h.session.reconsider();
  await h.session.approve("replayed-other-offer");
  expect(h.session.state).toEqual({ phase: "available", offerId: id });
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.f.runtimeEvents).toEqual([]);
  expect(h.f.windows.active).toBe(false);
});

it("waits for actual runtime work, reuses approved owned bytes and reaches only a closed preparation checkpoint", async () => {
  const h = await fixture();
  const done = h.f.runtime.activity.enter("dispatch");
  h.f.ownRelease(done);
  const id = await h.offer();
  expect((await h.session.approve(id)).blocker).toBe("activity");
  expect(h.f.windows.active).toBe(false);
  expect(h.f.inspect).toHaveBeenCalledOnce();
  const path = await h.directory();
  expect(await readFile(join(path, "native-mac-artifact.json"))).toEqual(h.f.bytes);
  const entered = barrier();
  const release = barrier();
  h.f.ownRelease(release.release);
  h.check.mockImplementation(async () => {
    entered.release();
    await release.promise;
    return "unknown";
  });
  done();
  const pending = h.session.reconsider();
  await reached(entered, pending);
  expect(h.check.mock.calls[0]![0]).toEqual({
    binding: h.f.binding,
    directory: path,
    target: h.f.target,
    scope: "preparation-only",
  });
  expect(Object.isFrozen(h.check.mock.calls[0]![0])).toBe(true);
  expect(h.f.windows.active).toBe(true);
  expect(h.f.a.frozen()).toBe(true);
  expect(h.f.windows.requestCreation()).toBe(false);
  expect(await h.f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  await expect(h.f.workspace.prepareConnection("http://localhost:7890")).rejects.toThrow("busy");
  release.release();
  expect((await pending).phase).toBe("recovery-required");
  expect(h.session.verification).toBe("verified");
  expect(h.f.inspect).toHaveBeenCalledOnce();
  expect(h.session.defer(id)).toBe(false);
  await h.session.reconsider();
  await h.session.approve(id);
  expect(h.f.runtimeEvents).toEqual([
    { action: "drain", outcome: "draining" },
    { action: "drain", outcome: "draining" },
    { action: "drain", outcome: "held" },
    { action: "prepare", outcome: "held" },
    { action: "drain", outcome: "held" },
  ]);
  expect(await h.session.offer(h.input, h.f.target, new AbortController().signal)).toEqual({ outcome: "unknown" });
});

it("defers a busy session, discards only after settlement and requires a fresh offer, approval and inspection", async () => {
  const h = await fixture();
  const done = h.f.runtime.activity.enter("dispatch");
  h.f.ownRelease(done);
  const first = await h.offer();
  await h.session.approve(first);
  expect(h.session.defer(first)).toBe(true);
  await h.session.settled();
  expect(await readdir(h.root)).toEqual([]);
  const second = await h.offer();
  expect(second).not.toBe(first);
  await h.session.approve(first);
  await h.session.reconsider();
  expect(h.f.inspect).toHaveBeenCalledOnce();
  done();
  expect((await h.session.approve(second)).phase).toBe("recovery-required");
  expect(h.f.inspect).toHaveBeenCalledTimes(2);
});

it("does not resurrect approval when defer arrives before a reserved operation starts", async () => {
  const h = await fixture();
  const id = await h.offer();
  const pending = h.session.approve(id);
  expect(h.session.defer(id)).toBe(true);
  expect((await pending).phase).toBe("deferred");
  await h.session.settled();
  await h.session.approve(id);
  expect(h.f.downloadFetch).not.toHaveBeenCalled();
  expect(h.f.runtimeEvents).toEqual([]);
});

it.each<ProofFault>(["lost", "proof", "pid", "instance", "active"])(
  "retains all owned candidate evidence after %s authenticated admission evidence becomes unknown",
  async (fault) => {
    const h = await fixture();
    h.f.fault(fault);
    const id = await h.offer();
    expect((await h.session.approve(id)).phase).toBe("recovery-required");
    expect(h.check).not.toHaveBeenCalled();
    expect(h.f.windows.active).toBe(true);
    expect(await readFile(join(await h.directory(), "native-mac-artifact.json"))).toEqual(h.f.bytes);
    await h.session.reconsider();
    expect(h.session.defer(id)).toBe(false);
    expect(h.f.runtimeEvents).toEqual([
      { action: "drain", outcome: "held" },
      { action: "drain", outcome: "held" },
      { action: "prepare", outcome: "held" },
    ]);
  },
);

it("deferral during held admission preserves candidate bytes until uncertain release settles and then retains them", async () => {
  const h = await fixture();
  const entered = barrier();
  const release = barrier();
  h.f.ownRelease(release.release);
  h.f.afterPrepare(async () => {
    entered.release();
    await release.promise;
  });
  h.f.failRelease();
  const id = await h.offer();
  const pending = h.session.approve(id);
  await reached(entered, pending);
  const path = await h.directory();
  expect(h.session.defer(id)).toBe(true);
  await nextTurn();
  expect(await readFile(join(path, "native-mac-artifact.json"))).toEqual(h.f.bytes);
  release.release();
  expect((await pending).phase).toBe("recovery-required");
  await h.session.settled();
  expect(await readFile(join(path, "native-mac-artifact.json"))).toEqual(h.f.bytes);
  expect(h.f.windows.active).toBe(true);
  expect(h.f.runtimeEvents.map((event) => event.action)).toEqual(["drain", "drain", "prepare", "resume"]);
  expect(h.check).not.toHaveBeenCalled();
});

it.each(["valid", "committed", undefined])(
  "never treats unsupported checkpoint output %s as native/recovery eligibility",
  async (outcome) => {
    const h = await fixture();
    h.check.mockResolvedValue(outcome as "unknown");
    expect((await h.session.approve(await h.offer())).phase).toBe("recovery-required");
    expect(h.f.windows.active).toBe(true);
    expect(await h.f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  },
);

it("refusing checkpoint evidence retains owners when authentic release cannot be established", async () => {
  const h = await fixture();
  h.check.mockResolvedValue("refused");
  h.f.failRelease();
  expect((await h.session.approve(await h.offer())).phase).toBe("recovery-required");
  expect(h.f.windows.active).toBe(true);
  expect(h.f.runtimeEvents).toEqual([
    { action: "drain", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "prepare", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "resume" },
  ]);
  expect(await readdir(h.root)).toHaveLength(1);
  expect(h.session.defer(h.session.state.offerId!)).toBe(false);
  expect(await h.f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
});

it("a known checkpoint refusal releases the authentic owner and permits explicit candidate cleanup", async () => {
  const h = await fixture();
  h.check.mockResolvedValue("refused");
  const id = await h.offer();
  expect(await h.session.approve(id)).toMatchObject({ phase: "failed", blocker: "candidate" });
  expect(h.f.runtimeEvents).toEqual([
    { action: "drain", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "prepare", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "resume", outcome: "released" },
  ]);
  expect(h.f.windows.active).toBe(false);
  expect(h.f.a.frozen()).toBe(false);
  expect(await readdir(h.root)).toHaveLength(1);
  expect(h.session.defer(id)).toBe(true);
  await h.session.settled();
  expect(await readdir(h.root)).toEqual([]);
  expect(await h.offer()).not.toBe(id);
  expect(h.f.inspect).toHaveBeenCalledOnce();
});

it("a document change during a refusing checkpoint stays unknown without requesting admission resume", async () => {
  const h = await fixture();
  h.check.mockImplementation(async () => {
    h.f.a.replace();
    return "refused";
  });
  expect((await h.session.approve(await h.offer())).phase).toBe("recovery-required");
  expect(h.f.runtimeEvents).toEqual([
    { action: "drain", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "prepare", outcome: "held" },
    { action: "drain", outcome: "held" },
  ]);
  expect(h.f.windows.active).toBe(true);
  expect(await readFile(join(await h.directory(), "native-mac-artifact.json"))).toEqual(h.f.bytes);
});

it("a throwing checkpoint is unknown while verified download authenticity remains separately reported", async () => {
  const h = await fixture();
  h.check.mockRejectedValue(new Error("Synthetic lost preparation observation"));
  const id = await h.offer();
  expect((await h.session.approve(id)).phase).toBe("recovery-required");
  expect(h.session.verification).toBe("verified");
  expect(h.f.runtimeEvents).toEqual([
    { action: "drain", outcome: "held" },
    { action: "drain", outcome: "held" },
    { action: "prepare", outcome: "held" },
    { action: "drain", outcome: "held" },
  ]);
  expect(h.session.defer(id)).toBe(false);
  expect(await readdir(h.root)).toHaveLength(1);
});
