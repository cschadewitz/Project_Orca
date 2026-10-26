/** Real OS read acceptance in new disposable trees; no provider, live policy or user files. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SyntheticReadFence } from "../src/synthetic-read-fence.js";
import { createDisposableFileReadForTest } from "../src/disposable-file-read.js";
import { LOCAL_ADVICE_SCHEMA } from "../../agents/src/review-judge/adapter.js";
import { composedFileGuard, barrier } from "./fixtures/composed-file-guard.js";

const fixtures: Awaited<ReturnType<typeof composedFileGuard>>[] = [];
async function fixture(...args: Parameters<typeof composedFileGuard>) {
  const f = await composedFileGuard(...args);
  fixtures.push(f);
  return f;
}
let reads: MockInstance<typeof fs.readSync>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  // Call-through spy independently observes real readSync calls and returned byte counts.
  reads = vi.spyOn(fs, "readSync");
});
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const frame = () =>
  JSON.stringify({
    schema: LOCAL_ADVICE_SCHEMA,
    recommendation: "allow",
    rationaleCode: "fixture-match",
    uncertainty: false,
  });
async function permit(f: Awaited<ReturnType<typeof fixture>>) {
  const evaluated = await f.fence.evaluate(f.action, f.caller.signal);
  const verdict = evaluated.phase === "final" ? evaluated.verdict : (await f.reviewed()).verdict;
  if (verdict.outcome !== "allow") throw new Error("Expected strict policy allow");
  return f.fence.authorize(f.action, verdict, f.caller.signal);
}

describe.skipIf(process.platform !== "linux")("owned detached Linux file composition", () => {
  it.each(["disabled", "required", "advisory"] as const)(
    "%s uses actual policy/judge/fence and one real read",
    async (mode) => {
      const f = await fixture(mode);
      expect(fs.existsSync(f.file.path)).toBe(false);
      expect(f.action.resources).toEqual({ state: "complete", value: [f.file.resource] });
      expect(f.file.resource).toHaveProperty("physicalTargetRef");
      expect(f.file.resource).not.toHaveProperty("targetKind");
      expect(f.action.coverage).toMatchObject({
        level: "policy-per-ask",
        evidence: { installedRefs: [], independentlyObservedEffects: false },
      });
      const receipt = await f.run();
      expect(receipt.state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.results[0]).toEqual({ type: "return", value: 9 });
      expect(reads.mock.calls[0]?.slice(2)).toEqual([0, 9, 0]);
      expect(Buffer.from(reads.mock.calls[0]![1] as Uint8Array).toString()).toBe("synthetic");
      expect(f.counters.judgeCalls).toBe(mode === "disabled" ? 0 : 1);
      expect(Buffer.from(f.contents[0]!).toString()).toBe("synthetic");
      expect(f.state.authWrites).toBe(1);
      expect((await f.fence.inspect(receipt, f.reader, f.caller.signal)).delivery.state).toBe("unknown");
      await f.deliver(receipt);
      expect((await f.fence.inspect(receipt, f.reader, f.caller.signal)).delivery.state).toBe("observed");
      expect((await f.fence.run(f.parameters, f.caller.signal)).state).toBe("completed");
      expect(reads).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["deny", "require-human"] as const)("%s never reaches OS read", async (decision) => {
    const f = await fixture("disabled", decision);
    expect((await f.run()).state).toBe("not-dispatched");
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["symlink", "replacement", "rename", "cwd"])(
    "%s cannot redirect retained inode while judgment awaits",
    async (change) => {
      const f = await fixture();
      const gate = barrier();
      f.controls.transport = async () => {
        await gate.wait();
        return frame();
      };
      const running = f.run();
      await gate.entered;
      const decoy = `${f.file.root}/decoy`;
      fs.writeFileSync(decoy, "wrong-file", { flag: "wx", mode: 0o600 });
      const previousCwd = process.cwd();
      const moved = `${f.file.root}-moved`;
      try {
        if (change === "symlink") fs.symlinkSync(decoy, f.file.path);
        if (change === "replacement") fs.writeFileSync(f.file.path, "wrong-file", { flag: "wx", mode: 0o600 });
        if (change === "rename") fs.renameSync(f.file.root, moved);
        if (change === "cwd") process.chdir(f.file.root);
        gate.release();
        expect((await running).state).toBe("completed");
        expect(Buffer.from(reads.mock.calls[0]![1] as Uint8Array).toString()).toBe("synthetic");
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        process.chdir(previousCwd);
        if (change === "rename") fs.renameSync(moved, f.file.root);
      }
    },
  );

  it.each([
    "ownership",
    "authorize",
    "capture-record",
    "projection",
    "judge",
    "review-record",
    "source",
    "authorization-record",
    "observed",
    "response",
  ] as const)("cancellation/revocation/resource loss across %s await cannot replay", async (where) => {
    for (const change of ["cancel", "revoke", "generation", "owner", "expiry", "dispose"] as const) {
      const f = await fixture();
      const gate = barrier();
      if (where === "ownership") f.controls.ownership = gate.wait;
      if (where === "authorize") f.controls.authorize = gate.wait;
      if (where === "capture-record") f.controls.captureRecord = gate.wait;
      if (where === "projection") f.controls.projection = gate.wait;
      if (where === "judge")
        f.controls.transport = async () => {
          await gate.wait();
          return frame();
        };
      if (where === "review-record") f.controls.reviewRecord = gate.wait;
      if (where === "source") f.controls.sourceRead = gate.wait;
      if (where === "authorization-record") f.state.afterRecord = gate.wait;
      if (where === "observed") f.controls.observed = gate.wait;
      if (where === "response") f.controls.response = gate.wait;
      const before = reads.mock.calls.length;
      const operation = f.run();
      const settled = Promise.allSettled([operation]);
      await gate.entered;
      if (change === "cancel") f.caller.abort();
      if (change === "revoke") f.base.state.revoked = true;
      if (change === "generation") f.file.invalidate();
      if (change === "owner")
        f.base.state.snapshot = {
          ...f.base.state.snapshot,
          invocation: { ...f.base.state.snapshot.invocation, principalRef: "replacement-owner" },
        };
      if (change === "expiry") f.clock.advance(60_001);
      if (change === "dispose") f.file.dispose();
      gate.release();
      const results = await settled;
      const postRead = where === "observed" || where === "response";
      if (results[0]?.status === "fulfilled")
        expect(results[0].value.state).toBe(postRead ? "execution-unknown" : "not-dispatched");
      expect(reads.mock.calls.length - before).toBe(postRead ? 1 : 0);
      expect(f.counters.responseStarts).toBe(where === "response" ? 1 : 0);
      await Promise.allSettled([f.run()]);
      expect(reads.mock.calls.length - before).toBe(postRead ? 1 : 0);
    }
  });

  it.each(["before", "after"] as const)("uncertain %s authorization record never reads or retries", async (failure) => {
    const f = await fixture();
    f.state.recordFailure = failure;
    expect((await f.run()).state).toBe("not-dispatched");
    expect((await f.fence.run(f.parameters, f.caller.signal)).state).toBe("not-dispatched");
    expect(f.state.authWrites).toBe(1);
    expect(reads).not.toHaveBeenCalled();
  });

  it("changed metadata before read refuses the same inode", async () => {
    const stat = vi.spyOn(fs, "fstatSync");
    const f = await fixture();
    const fd = stat.mock.calls[0]![0];
    const gate = barrier();
    f.controls.transport = async () => {
      await gate.wait();
      return frame();
    };
    const running = Promise.allSettled([f.run()]);
    await gate.entered;
    fs.fchmodSync(fd, 0o600); // Synthetic test mutation, no tool write capability.
    gate.release();
    await running;
    expect(reads).not.toHaveBeenCalled();
  });

  it("post-read changed metadata is unknown and never delivered/replayed", async () => {
    const f = await fixture();
    // Save the real implementation through mockRestore, then install a call-through mutator.
    reads.mockRestore();
    const realRead = fs.readSync.bind(fs);
    reads = vi.spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      const result = Reflect.apply(realRead, fs, [fd, ...args]);
      fs.fchmodSync(fd, 0o600);
      return result;
    }) as typeof fs.readSync);
    expect((await f.run()).state).toBe("execution-unknown");
    expect(f.counters.delivered).toBe(0);
    await Promise.allSettled([f.run()]);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("identical concurrent dispatch consumes once, then survives lost delivery acknowledgement", async () => {
    const f = await fixture();
    const allowed = await permit(f);
    const receipts = await Promise.all(Array.from({ length: 8 }, () => f.fence.dispatch(allowed, f.caller.signal)));
    expect(receipts.every((r) => r.state === "completed")).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.state.authWrites).toBe(1);
    await f.deliver(receipts[0]!, false);
    expect((await f.fence.inspect(receipts[0]!, f.reader, f.caller.signal)).delivery.state).toBe("unknown");
    expect((await f.fence.dispatch(allowed, f.caller.signal)).state).toBe("completed");
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("missing facts/required judge outage fail closed", async () => {
    const f = await fixture();
    f.controls.transport = async () => {
      throw new Error("offline unavailable");
    };
    expect((await f.run()).state).toBe("not-dispatched");
    expect(reads).not.toHaveBeenCalled();
    const g = await fixture();
    g.base.state.authorityUnavailable = true;
    await expect(g.run()).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
  });

  it("final parameter mutation, getters, paths, wrong owner and copied executors cannot mint capture", async () => {
    const f = await fixture("disabled");
    for (const parameters of [
      { ...f.parameters, path: f.file.path },
      { ...f.parameters, resourceRef: "foreign" },
      { ...f.parameters, offset: -0 },
      { ...f.parameters, offset: 4096 },
      { ...f.parameters, length: 4097 },
      { ...f.parameters, length: 0 },
      {
        ...f.parameters,
        get length(): number {
          throw new Error("getter executed");
        },
      },
    ])
      expect(() => f.file.executor.capture(parameters)).toThrow();
    expect(() => f.file.executor.encode({})).toThrow();
    const copied = new SyntheticReadFence(f.file.owner, { ...f.file.executor }, f.policy, f.evidence);
    expect(() => copied.capture(f.parameters)).toThrow();
    const foreign = new SyntheticReadFence(f.base.owner, f.file.executor, f.policy, f.evidence);
    expect(() => foreign.capture(f.parameters)).toThrow();
    f.parameters.length = 1;
    expect(() => f.fence.capture(f.parameters)).toThrow();
    const allowed = await permit(f);
    expect((await f.fence.dispatch(allowed, f.caller.signal)).state).toBe("completed");
    expect(reads.mock.results[0]).toEqual({ type: "return", value: 9 });
  });

  it.each([
    "currentAuthority",
    "capturedCeiling",
    "protectedAccess",
    "coverageAndState",
    "mandatoryHuman",
    "profile",
    "rules",
  ] as const)("missing %s fact never authorizes a physical resource", async (fact) => {
    const f = await fixture("disabled");
    f.controls.policy = { ...f.initialPolicy, [fact]: { state: "unknown", reason: "fixture missing fact" } };
    expect((await f.run()).state).toBe("not-dispatched");
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["rule", "resource", "policy-revision", "missing-ownership"] as const)(
    "changed %s during authorization recording prevents OS read",
    async (change) => {
      const f = await fixture();
      const gate = barrier();
      f.state.afterRecord = gate.wait;
      const running = Promise.allSettled([f.run()]);
      await gate.entered;
      const state = structuredClone(f.initialPolicy);
      if (state.rules.state !== "complete") throw new Error("fixture");
      const rule = state.rules.value[0]!;
      if (change === "rule")
        f.controls.policy = { ...state, rules: { state: "complete", value: [{ ...rule, status: "revoked" }] } };
      if (change === "resource")
        f.controls.policy = {
          ...state,
          rules: {
            state: "complete",
            value: [
              {
                ...rule,
                match: {
                  ...rule.match,
                  resources: [{ operation: "fs.readOwnedBytes", physicalTargetRef: "foreign-inode" }],
                },
              },
            ],
          },
        };
      if (change === "policy-revision")
        f.base.state.snapshot = {
          ...f.base.state.snapshot,
          authority: { ...f.base.state.snapshot.authority, currentPolicyRevision: "changed-policy" },
        };
      if (change === "missing-ownership") {
        const realStat = fs.fstatSync.bind(fs);
        vi.spyOn(fs, "fstatSync").mockImplementation(((...args: unknown[]) => ({
          ...Reflect.apply(realStat, fs, args),
          uid: undefined,
        })) as typeof fs.fstatSync);
      }
      gate.release();
      await running;
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(["observed", "response"] as const)(
    "uncooperative %s completion after cancellation cannot repeat a read",
    async (where) => {
      const f = await fixture();
      const gate = barrier();
      f.controls[where] = gate.wait;
      const running = f.run();
      await gate.entered;
      f.caller.abort();
      expect((await running).state).toBe("execution-unknown"); // Does not wait for uncooperative callback.
      expect(reads).toHaveBeenCalledTimes(1);
      expect(f.counters.responseStarts).toBe(where === "response" ? 1 : 0);
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([f.fence.run(f.parameters, f.caller.signal)]);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(f.counters.responseStarts).toBe(where === "response" ? 1 : 0);
    },
  );

  it("read failure has uncertain effect and terminal no-replay", async () => {
    const f = await fixture();
    reads.mockImplementation(() => {
      throw new Error("fixture lost read result");
    });
    expect((await f.run()).state).toBe("execution-unknown");
    expect((await f.fence.run(f.parameters, f.caller.signal)).state).toBe("execution-unknown");
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.counters.responseStarts).toBe(0);
  });

  it("owner and executor mutations cannot replace retained methods", async () => {
    const f = await fixture("disabled");
    expect(() => Object.assign(f.file.owner, { assertCurrent: () => undefined })).toThrow();
    expect(() => Object.assign(f.file.executor, { execute: () => Promise.resolve() })).toThrow();
    const next = new SyntheticReadFence(f.file.owner, f.file.executor, f.policy, f.evidence);
    expect(() => next.capture(f.parameters)).toThrow();
    const g = await fixture("disabled");
    const allowed = await permit(f);
    await expect(g.fence.dispatch(allowed, g.caller.signal)).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"])("%s is explicitly unsupported before fixture creation", async (platform) => {
    const f = await fixture();
    const mkdtemp = vi.spyOn(fs, "mkdtempSync");
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      expect(() =>
        createDisposableFileReadForTest({ enabled: true, owner: f.base.owner, content: "fixture" } as never),
      ).toThrow(/unsupported/);
      expect(mkdtemp).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("default-off setup rejects missing opt-in before filesystem work", async () => {
    const f = await fixture();
    const mkdtemp = vi.spyOn(fs, "mkdtempSync");
    expect(() =>
      createDisposableFileReadForTest({ enabled: false, owner: f.base.owner, content: "fixture" } as never),
    ).toThrow();
    expect(mkdtemp).not.toHaveBeenCalled();
  });
});
