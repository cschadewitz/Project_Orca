/** Actual #568 owner RPC and file-backed gated runs; window/native ports remain synthetic. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeMaintenanceFixture, barrier } from "../../daemon/test/runtime-maintenance-fixture.js";
import { captureMacDrain, prepareMacDrain, type MacDrainOwner } from "../src/main/mac-update-drain.js";
import { MacUpdates, type MacUpdatePorts } from "../src/main/mac-updates.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(gated = false) {
  const f = await runtimeMaintenanceFixture({ gated });
  closers.push(f.close);
  const target = { ...f.identity, epoch: 1 };
  const calls: { action: string; token: string }[] = [];
  let owned = true,
    frozen = false,
    drafts = false;
  const owner: MacDrainOwner = {
    target,
    runtimeTarget: f.target,
    check: () => owned,
    release: vi.fn(() => {
      owned = false;
      frozen = false;
    }),
    freeze: vi.fn(() => {
      frozen = true;
      return owned;
    }),
    runtime: vi.fn(async (action, token) => {
      calls.push({ action, token });
      const response = await f.call("maintenance.runtime", { action, token, target: f.target });
      if (!response.ok) throw new Error("RPC refused");
      return response.result;
    }),
  };
  const ports: MacUpdatePorts = {
    download: vi.fn(async () => "verified" as const),
    drainAdmission: (expected, token) => captureMacDrain(async () => owner, expected, token),
    prepareDrafts: vi.fn(async () => {
      drafts = true;
      return {
        outcome: "ready" as const,
        lease: {
          release: async () => {
            drafts = false;
            return "released" as const;
          },
        },
      };
    }),
    prepareAdmission: (expected, token, drain) =>
      drain ? prepareMacDrain(drain, expected, token, () => drafts) : Promise.resolve({ outcome: "unknown" }),
    revalidate: vi.fn(async () => "valid" as const),
    activate: vi.fn(async (_candidate, admission) => {
      expect(admission.token).toBe(calls[0]!.token);
      return "committed" as const;
    }),
  };
  const updates = new MacUpdates(ports);
  const candidate = {
    manifestSha256: "a".repeat(64),
    channel: "test",
    compatibilityPlanId: "test",
    recoveryPlanId: "test",
  };
  const id = updates.present(candidate, target)!;
  return {
    ...f,
    owner,
    calls,
    ports,
    updates,
    target,
    candidate,
    id,
    frozen: () => frozen,
    drafts: () => drafts,
    lose: () => {
      owned = false;
    },
    clearDrafts: () => {
      drafts = false;
    },
  };
}
it("retains one approval/target/token through parked answer, drain held, full freeze and prepare", async () => {
  const f = await fixture(true);
  const started = await f.call("runs.start", { workflowId: "flow" });
  if (!started.ok) throw new Error("Start refused");
  const runId = (started.result as { runId: string }).runId;
  expect((await f.orc.getState(runId)).run.status).toBe("paused");
  expect(await f.updates.approve(f.id)).toMatchObject({ phase: "waiting", blocker: "activity" });
  await f.updates.approve(f.id);
  expect(f.frozen()).toBe(false);
  expect(f.drafts()).toBe(false);
  expect(f.ports.prepareDrafts).not.toHaveBeenCalled();
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  expect(await f.call("requests.submit", { title: "new", body: "new" })).toMatchObject({ ok: false });
  expect(await f.call("runs.list")).toMatchObject({ ok: true });
  const [input] = await f.orc.pendingInputs(runId);
  expect(await f.call("inputs.answer", { runId, requestId: input!.id, optionId: "finish" })).toMatchObject({
    ok: true,
  });
  expect((await f.orc.getState(runId)).run.status).toBe("completed");
  await f.updates.reconsider();
  expect(f.updates.state.phase).toBe("awaiting-restart");
  expect(f.frozen()).toBe(true);
  expect(f.drafts()).toBe(true);
  expect(new Set(f.calls.map((call) => call.token)).size).toBe(1);
  expect(f.calls.map((call) => call.action)).toEqual(["drain", "drain", "drain", "prepare", "drain"]);
  expect(f.owner.freeze).toHaveBeenCalledOnce();
  expect(f.ports.activate).toHaveBeenCalledOnce();
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
});
it("defers busy work through the same token without freezing or cancelling it", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  try {
    await f.updates.approve(f.id);
    expect(f.updates.defer("foreign")).toBe(false);
    expect(f.updates.defer(f.id)).toBe(true);
    await f.updates.settled();
    expect(f.updates.state.phase).toBe("deferred");
    expect(f.calls.map((call) => call.action)).toEqual(["drain", "drain", "defer"]);
    expect(f.calls[0]!.token).toBe(f.calls[2]!.token);
    expect(f.runtime.activity.snapshot().active).toEqual(["execution"]);
    expect(f.drafts()).toBe(false);
    expect(f.owner.release).toHaveBeenCalledOnce();
  } finally {
    finish();
  }
});
it("holds the same idle fence through unsaved drafts and only resumes it on explicit defer", async () => {
  const f = await fixture();
  vi.mocked(f.ports.prepareDrafts).mockResolvedValue({ outcome: "blocked", blocker: "drafts" });
  await f.updates.approve(f.id);
  expect(f.updates.state).toMatchObject({ phase: "waiting", blocker: "drafts" });
  expect(f.updates.present(f.candidate, f.target)).toBeUndefined();
  expect(f.frozen()).toBe(false);
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  f.updates.defer(f.id);
  await f.updates.settled();
  expect(f.calls.map((call) => call.action)).toEqual(["drain", "drain", "resume"]);
});
it.each(["legacy", "wrong-process", "lost", "blocked"] as const)(
  "keeps uncertain %s proof closed and never prepares",
  async (failure) => {
    const f = await fixture();
    const runtime = vi.mocked(f.owner.runtime).getMockImplementation()!;
    vi.mocked(f.owner.runtime).mockImplementation(async (action, token) => {
      const value = await runtime(action, token);
      if (failure === "lost") throw new Error("Lost response");
      const result = value as Record<string, unknown>;
      if (failure === "legacy") return { ...result, proof: "runtime-v1" };
      if (failure === "wrong-process") return { ...result, target: { ...f.target, processId: process.pid + 1 } };
      return { ...result, outcome: "blocked", active: ["unavailable"] };
    });
    await f.updates.approve(f.id);
    expect(f.updates.state.phase).toBe("recovery-required");
    expect(f.ports.prepareDrafts).not.toHaveBeenCalled();
    expect(f.owner.release).not.toHaveBeenCalled();
    expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  },
);
it("refuses a missing drain interface without any prepare-only request", async () => {
  const f = await fixture();
  delete f.ports.drainAdmission;
  await f.updates.approve(f.id);
  expect(f.updates.state).toMatchObject({ phase: "failed", blocker: "activity" });
  expect(f.calls).toEqual([]);
  expect(f.ports.prepareDrafts).not.toHaveBeenCalled();
});
it("rejects foreign token or target at preparation without releasing the actual held owner", async () => {
  const f = await fixture();
  const lease = await captureMacDrain(async () => f.owner, f.target, randomUUID());
  if (lease.outcome !== "ready") throw new Error("Capture failed");
  expect(await lease.lease.observe()).toBe("held");
  expect(await prepareMacDrain(lease.lease, f.target, randomUUID(), () => true)).toMatchObject({ outcome: "unknown" });
  expect(await prepareMacDrain(lease.lease, { ...f.target, epoch: 2 }, lease.lease.token, () => true)).toMatchObject({
    outcome: "unknown",
  });
  expect(f.owner.freeze).not.toHaveBeenCalled();
  expect(f.owner.release).not.toHaveBeenCalled();
});
it("rejects late held proof after owner/target loss", async () => {
  const f = await fixture();
  const gate = barrier(),
    entered = barrier();
  const runtime = vi.mocked(f.owner.runtime).getMockImplementation()!;
  vi.mocked(f.owner.runtime).mockImplementation(async (action, token) => {
    const result = await runtime(action, token);
    entered.release();
    await gate.promise;
    return result;
  });
  const operation = f.updates.approve(f.id);
  await entered.promise;
  f.lose();
  gate.release();
  await operation;
  expect(f.updates.state.phase).toBe("recovery-required");
  expect(f.owner.freeze).not.toHaveBeenCalled();
});
it("requires fresh consent after expiry/revocation and owner-bound cleanup", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  f.ports.approvalCurrent = vi.fn(async () => "valid" as const);
  try {
    await f.updates.approve(f.id);
    vi.mocked(f.ports.approvalCurrent).mockResolvedValue("refused");
    await f.updates.reconsider();
    expect(f.updates.state).toMatchObject({ phase: "failed", blocker: "candidate" });
    expect(f.calls.map((call) => call.action)).toEqual(["drain", "drain", "defer"]);
    expect(f.ports.activate).not.toHaveBeenCalled();
  } finally {
    finish();
  }
});
it("retains ownership on a lost defer response even when the server may have released", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  const runtime = vi.mocked(f.owner.runtime).getMockImplementation()!;
  vi.mocked(f.owner.runtime).mockImplementation(async (action, token) => {
    const value = await runtime(action, token);
    if (action === "defer") throw new Error("Lost");
    return value;
  });
  try {
    await f.updates.approve(f.id);
    f.updates.defer(f.id);
    await f.updates.settled();
    expect(f.updates.state.phase).toBe("recovery-required");
    expect(f.owner.release).not.toHaveBeenCalled();
  } finally {
    finish();
  }
});
