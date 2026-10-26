/** Closed service acceptance. Private disposable Linux files; actual readSync observed independently. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createOwnedFileReadServiceForTest } from "../src/owned-file-read-service.js";
import { ownedServiceFixture } from "./fixtures/owned-file-service.js";
import { barrier } from "./fixtures/composed-memory-guard.js";
const fixtures: Awaited<ReturnType<typeof ownedServiceFixture>>[] = [];
async function fixture(maximum = 8) {
  const value = await ownedServiceFixture(maximum);
  fixtures.push(value);
  return value;
}
let reads: MockInstance<typeof fs.readSync>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  reads = vi.spyOn(fs, "readSync");
});
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function prepared(delegated = false, maximum = 8) {
  const f = await fixture(maximum);
  const first = (await f.binding()).capture();
  await f.save(first.action, delegated);
  const bound = await f.binding();
  return { f, first, bound, invocation: bound.capture() };
}

describe.skipIf(process.platform !== "linux")("stable owned file read service", () => {
  it.each([false, true])(
    "one exact persisted rule matches separate invocations (required judge=%s)",
    async (delegated) => {
      const { f, first, invocation } = await prepared(delegated);
      const oldAction = structuredClone(first.action);
      const second = (await f.binding()).capture();
      expect(invocation.action.resources).toEqual(first.action.resources);
      expect(invocation.action.coverage).toEqual(first.action.coverage);
      expect(invocation.action.workspaceRef).toEqual(first.action.workspaceRef);
      expect(invocation.action.profileRef).toBe(first.action.profileRef);
      expect(invocation.action.authority.capturedGeneration).toBe(first.action.authority.capturedGeneration);
      expect(invocation.action.authority.currentPolicyRevision).not.toBe(first.action.authority.currentPolicyRevision);
      expect(invocation.action.invocation.invocationId).not.toBe(second.action.invocation.invocationId);
      expect(reads).not.toHaveBeenCalled();
      expect((await f.run(invocation)).state).toBe("completed");
      expect((await f.run(second)).state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(2);
      expect(reads.mock.results.map((r) => r.value)).toEqual([9, 9]);
      expect(reads.mock.calls.map((c) => c.slice(2))).toEqual([
        [0, 9, 0],
        [0, 9, 0],
      ]);
      expect(f.outputs.map((bytes) => Buffer.from(bytes).toString())).toEqual(["synthetic", "synthetic"]);
      expect((await f.store.read()).document.scopedRules.records).toHaveLength(1);
      expect(first.action).toEqual(oldAction); // New policy never mutates old captured evidence.
      const stale = await first.evaluate(f.base.caller.signal);
      expect(stale.phase === "final" && stale.verdict.outcome).toBe("indeterminate");
      expect(
        (await invocation.inspect(await f.run(invocation), f.base.reader, f.base.caller.signal)).effect.state,
      ).toBe("observed");
      expect(reads).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "policy revision refresh preserves the original ask and ceilings (required judge=%s)",
    async (delegated) => {
      const f = await fixture();
      const binding = await f.binding();
      const old = binding.capture();
      const before = structuredClone(old.action);
      const ask = await old.evaluate(f.base.caller.signal);
      expect(ask.phase === "final" && ask.verdict.outcome).toBe("require-human");
      await f.save(old.action, delegated);
      binding.snapshot.authority.currentPolicyRevision = (await f.store.read()).revision;
      const fresh = f.service.refreshPolicyRevision(old);
      expect(fresh.action.actionId).not.toBe(old.action.actionId);
      expect(fresh.action.invocation).toEqual(old.action.invocation);
      expect(fresh.action.resources).toEqual(old.action.resources);
      expect(fresh.action.authority.capturedGeneration).toBe(old.action.authority.capturedGeneration);
      expect(fresh.action.expiresAt).toBe(old.action.expiresAt);
      expect(old.action).toEqual(before);
      expect(binding.capture()).toBe(fresh);
      expect(() => f.service.refreshPolicyRevision(old)).toThrow();
      expect(() => f.service.refreshPolicyRevision(fresh)).toThrow();
      expect((await f.run(fresh)).state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(1);
      const separate = (await f.binding()).capture();
      expect((await f.run(separate)).state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(2);
      if (ask.phase === "final")
        await expect(old.authorize(old.action, ask.verdict as never, f.base.caller.signal)).rejects.toThrow();
    },
  );

  it.each(["ceiling", "cancel", "expiry", "request-change"] as const)(
    "refresh cannot replace original %s",
    async (change) => {
      const f = await fixture();
      const b = await f.binding(change !== "ceiling");
      const old = b.capture();
      await old.evaluate(f.base.caller.signal);
      await f.save(old.action);
      b.snapshot.authority.currentPolicyRevision = (await f.store.read()).revision;
      f.controls.ceiling = true;
      if (change === "cancel") f.base.caller.abort();
      if (change === "expiry") f.base.clock.advance(60_001);
      if (change === "request-change") b.snapshot.invocation = { ...b.snapshot.invocation, turnId: "changed" };
      expect(() => f.service.refreshPolicyRevision(old)).toThrow();
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("revision refresh retains the original policy and record methods despite injection mutation", async () => {
    const f = await fixture();
    const b = await f.binding();
    const old = b.capture();
    await old.evaluate(f.base.caller.signal);
    await f.save(old.action);
    b.snapshot.authority.currentPolicyRevision = (await f.store.read()).revision;
    const policy = vi.spyOn(b.policy, "evaluate").mockRejectedValue(new Error("replacement policy"));
    const writer = vi.spyOn(f.base.evidence, "recordAuthorization").mockRejectedValue(new Error("replacement writer"));
    f.parameters.length = 1;
    const fresh = f.service.refreshPolicyRevision(old);
    expect((await f.run(fresh)).state).toBe("completed");
    expect(reads.mock.results[0]?.value).toBe(9);
    const retainedBefore = await f.base.store.getPayload(
      old.action.invocation.runId,
      old.action.original.privateRef,
      "agent.update",
    );
    const retainedAfter = await f.base.store.getPayload(
      fresh.action.invocation.runId,
      fresh.action.original.privateRef,
      "agent.update",
    );
    if (!("update" in retainedBefore) || !("update" in retainedAfter))
      throw new Error("actual retained captures required");
    expect(JSON.parse(retainedAfter.update.text!).bytes).toBe(JSON.parse(retainedBefore.update.text!).bytes);
    expect(policy).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("original caller cancellation survives a successful revision refresh", async () => {
    const f = await fixture();
    const b = await f.binding();
    const old = b.capture();
    await old.evaluate(f.base.caller.signal);
    await f.save(old.action);
    b.snapshot.authority.currentPolicyRevision = (await f.store.read()).revision;
    const fresh = f.service.refreshPolicyRevision(old);
    f.base.caller.abort();
    await expect(fresh.evaluate(new AbortController().signal)).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
  });

  it("same invocation captures/races coalesce, replacement wrappers and changed arguments refuse", async () => {
    const { f, bound, invocation } = await prepared();
    expect(bound.capture()).toBe(invocation);
    expect(() => f.service.capture({ ...bound.owner }, f.parameters, bound.policy, f.base.evidence)).toThrow();
    expect(() =>
      f.service.capture(bound.owner, { ...f.parameters, length: 1 }, bound.policy, f.base.evidence),
    ).toThrow();
    const verdict = await f.allow(invocation);
    if (verdict.outcome !== "allow") throw new Error("expected actual rule allow");
    const permits = await Promise.all(
      Array.from({ length: 8 }, () => invocation.authorize(invocation.action, verdict, f.base.caller.signal)),
    );
    expect(new Set(permits).size).toBe(1);
    const receipts = await Promise.all(permits.map((permit) => invocation.dispatch(permit, f.base.caller.signal)));
    expect(receipts.every((r) => r.state === "completed")).toBe(true);
    expect((await invocation.dispatch(permits[0]!, f.base.caller.signal)).state).toBe("completed");
    await expect(invocation.authorize(invocation.action, verdict, f.base.caller.signal)).rejects.toThrow();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.base.state.authWrites).toBe(1);
    expect(Object.keys(invocation)).not.toContain("executor");
    expect(Object.keys(f.service)).not.toContain("executor");
    expect(Object.keys(invocation)).not.toContain("capture");
  });

  it.each(["symlink", "replacement", "rename", "cwd"])("%s cannot redirect either invocation", async (change) => {
    const { f, invocation } = await prepared();
    const gate = barrier();
    f.base.state.afterRecord = gate.wait;
    const operation = f.run(invocation);
    await gate.entered;
    const moved = `${f.service.root}-moved`;
    const previous = process.cwd();
    try {
      if (change === "symlink") fs.symlinkSync("missing-decoy", f.service.path);
      if (change === "replacement") fs.writeFileSync(f.service.path, "decoy", { flag: "wx", mode: 0o600 });
      if (change === "rename") fs.renameSync(f.service.root, moved);
      if (change === "cwd") process.chdir(f.service.root);
      gate.release();
      expect((await operation).state).toBe("completed");
      delete f.base.state.afterRecord;
      expect((await f.run((await f.binding()).capture())).state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(2);
      expect(f.outputs.map((b) => Buffer.from(b).toString())).toEqual(["synthetic", "synthetic"]);
    } finally {
      process.chdir(previous);
      if (change === "rename") fs.renameSync(moved, f.service.root);
    }
  });

  it.each(["principal", "host", "boot", "generation", "lease"])(
    "replacement %s cannot reuse the service",
    async (change) => {
      const { f } = await prepared();
      const b = await f.binding();
      b.snapshot.invocation = {
        ...b.snapshot.invocation,
        ...(change === "principal" ? { principalRef: "foreign" } : {}),
        ...(change === "host" ? { hostId: "foreign" } : {}),
        ...(change === "boot" ? { instanceId: "foreign" } : {}),
      };
      b.snapshot.authority = {
        ...b.snapshot.authority,
        ...(change === "generation" ? { capturedGeneration: "foreign" } : {}),
        ...(change === "lease" ? { leaseEpoch: "foreign" } : {}),
      };
      expect(() => b.capture()).toThrow();
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(["revocation", "ceiling", "outage", "expiry", "close", "owner", "resource"])(
    "%s before dispatch never reads",
    async (change) => {
      const { f, bound, invocation } = await prepared();
      const verdict = await f.allow(invocation);
      if (verdict.outcome !== "allow") throw new Error("expected actual rule allow");
      const permit = await invocation.authorize(invocation.action, verdict, f.base.caller.signal);
      if (change === "revocation") f.base.state.revoked = true;
      if (change === "outage") f.controls.outage = true;
      if (change === "expiry") f.base.clock.advance(60_001);
      if (change === "close") f.service.close();
      if (change === "owner") bound.snapshot.authority = { ...bound.snapshot.authority, authorityRevision: "replaced" };
      if (change === "resource") {
        const stat = vi.spyOn(fs, "fstatSync");
        const real = stat.getMockImplementation();
        stat.mockRestore();
        const actual = fs.fstatSync.bind(fs);
        void real;
        vi.spyOn(fs, "fstatSync").mockImplementation(((...args: unknown[]) => ({
          ...Reflect.apply(actual, fs, args),
          ino: 999n,
        })) as typeof fs.fstatSync);
      }
      if (change === "ceiling") {
        const denied = (await f.binding(false)).capture();
        f.controls.ceiling = true; // Current allowance cannot widen the captured false ceiling.
        expect((await f.allow(denied)).outcome).toBe("deny");
        expect(reads).not.toHaveBeenCalled();
        return;
      }
      expect((await invocation.dispatch(permit, f.base.caller.signal)).state).toBe("not-dispatched");
      expect((await invocation.dispatch(permit, f.base.caller.signal)).state).toBe("not-dispatched");
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(["response", "observed", "record"] as const)("uncertain %s is terminal for its invocation", async (where) => {
    const { f, invocation } = await prepared();
    if (where === "record") f.base.state.recordFailure = "after";
    else f.controls[where] = () => Promise.reject(new Error("test lost acknowledgement"));
    const receipt = await f.run(invocation);
    expect(receipt.state).toBe(where === "record" ? "not-dispatched" : "execution-unknown");
    expect((await f.run(invocation)).state).toBe(receipt.state);
    expect(() => f.service.refreshPolicyRevision(invocation)).toThrow();
    expect(reads).toHaveBeenCalledTimes(where === "record" ? 0 : 1);
    expect(f.base.state.authWrites).toBe(1);
  });

  it("original cancellation cannot be replaced by a fresh caller and close aborts retained work", async () => {
    const { f, invocation } = await prepared();
    const gate = barrier();
    f.controls.observed = gate.wait;
    const operation = f.run(invocation);
    await gate.entered;
    f.base.caller.abort();
    expect((await operation).state).toBe("execution-unknown");
    gate.release();
    const verdict = await f.allow(invocation);
    if (verdict.outcome !== "allow") throw new Error("retained verdict");
    const fresh = new AbortController();
    await expect(invocation.authorize(invocation.action, verdict, fresh.signal)).rejects.toThrow();
    f.service.close();
    expect(() => f.service.capture(f.base.owner, f.parameters, f.base.policy, f.base.evidence)).toThrow();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("bounds the lifetime table without evicting replay tombstones", async () => {
    const { f, invocation } = await prepared(false, 2);
    expect((await f.run(invocation)).state).toBe("completed");
    expect(() => Object.assign(invocation.action.authority, { currentPolicyRevision: "replacement" })).toThrow();
    expect(() =>
      f.service.capture(f.base.owner, { ...f.parameters, resourceRef: "foreign" }, f.base.policy, f.base.evidence),
    ).toThrow();
    const third = await f.binding();
    expect(() => third.capture()).toThrow();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("retains final argument values and rejects accessors, extra keys and invalid bounds", async () => {
    const { f, invocation, bound } = await prepared();
    f.parameters.length = 1;
    expect((await f.run(invocation)).state).toBe("completed");
    expect(reads.mock.results[0]?.value).toBe(9);
    for (const parameters of [
      { ...f.parameters, path: f.service.path },
      { ...f.parameters, offset: -0 },
      { ...f.parameters, length: 0 },
      { ...f.parameters, offset: Number.MAX_SAFE_INTEGER },
      {
        ...f.parameters,
        get length(): number {
          throw new Error("getter must not run");
        },
      },
    ])
      expect(() => f.service.capture(bound.owner, parameters, bound.policy, f.base.evidence)).toThrow();
    await expect(invocation.dispatch({} as never, f.base.caller.signal)).rejects.toThrow();
  });

  it("a replacement service has a different resource and cannot accept old refs or saved rule", async () => {
    const { f } = await prepared();
    f.service.close();
    const g = await fixture();
    const b = await g.binding();
    expect(g.service.resource).not.toEqual(f.service.resource);
    expect(() => g.service.capture(b.owner, f.parameters, b.policy, g.base.evidence)).toThrow();
    expect((await g.allow(b.capture())).outcome).toBe("require-human");
    expect(reads).not.toHaveBeenCalled();
  });

  it("descriptor replacement is detected using real inode metadata", async () => {
    const stats = vi.spyOn(fs, "fstatSync");
    const { f, invocation } = await prepared();
    const fd = stats.mock.calls[0]![0];
    const verdict = await f.allow(invocation);
    if (verdict.outcome !== "allow") throw new Error("actual rule allow required");
    const permit = await invocation.authorize(invocation.action, verdict, f.base.caller.signal);
    const replacement = `${f.service.root}/replacement`;
    fs.writeFileSync(replacement, "different inode", { flag: "wx", mode: 0o400 });
    fs.closeSync(fd);
    const replaced = fs.openSync(replacement, fs.constants.O_RDONLY);
    expect(replaced).toBe(fd);
    expect((await invocation.dispatch(permit, f.base.caller.signal)).state).toBe("not-dispatched");
    expect(reads).not.toHaveBeenCalled();
  });

  it("owner lifetime abort closes retained work and cannot recreate a service", async () => {
    const { f, invocation } = await prepared();
    f.base.abort.abort();
    await expect(invocation.evaluate(new AbortController().signal)).rejects.toThrow();
    expect(() =>
      createOwnedFileReadServiceForTest({
        enabled: true,
        owner: f.base.owner,
        content: "private",
        maximumInvocations: 2,
        observed: async () => {},
        respond: async () => {},
      }),
    ).toThrow();
    expect(reads).not.toHaveBeenCalled();
  });

  it("close cannot reopen or replace the resource on the same authenticated lifetime", async () => {
    const { f } = await prepared();
    f.service.close();
    expect(() =>
      createOwnedFileReadServiceForTest({
        enabled: true,
        owner: f.base.owner,
        content: "replacement",
        maximumInvocations: 2,
        observed: async () => {},
        respond: async () => {},
      }),
    ).toThrow();
    expect(reads).not.toHaveBeenCalled();
  });

  it("setup rejects default-off and invalid bounds before filesystem work", async () => {
    const f = await fixture();
    const setup = vi.spyOn(fs, "mkdtempSync");
    for (const overrides of [
      { enabled: false },
      { maximumInvocations: 0 },
      { maximumInvocations: 129 },
      { content: "x".repeat(4097) },
    ]) {
      expect(() =>
        createOwnedFileReadServiceForTest({
          enabled: true,
          owner: f.base.owner,
          content: "private",
          maximumInvocations: 2,
          observed: async () => {},
          respond: async () => {},
          ...overrides,
        } as never),
      ).toThrow();
    }
    expect(setup).not.toHaveBeenCalled();
  });

  it("does not convert source conformance into installed qualification", async () => {
    const { invocation } = await prepared();
    expect(invocation.action.coverage).toMatchObject({
      level: "policy-per-ask",
      evidence: { installedRefs: [], independentlyObservedEffects: false },
    });
  });
});
