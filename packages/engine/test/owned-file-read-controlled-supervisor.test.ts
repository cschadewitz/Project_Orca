/** Independent #742 review regressions for the internal controlled-supervisor seam.
 * The connected CLI lane pre-checks its interval before `service.capture`, so these cases
 * exercise the service's own gates directly. Passing here is not installed acceptance.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createOwnedFileReadServiceForTest } from "../src/owned-file-read-service.js";
import { syntheticReadFixture } from "./fixtures/synthetic-read-fence.js";

const fixtures: Awaited<ReturnType<typeof syntheticReadFixture>>[] = [];
const services: { close(): void }[] = [];
let reads: MockInstance<typeof fs.readSync>;
beforeEach(() => {
  reads = vi.spyOn(fs, "readSync");
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const f of fixtures.splice(0)) {
    f.abort.abort();
    f.caller.abort();
  }
  vi.restoreAllMocks();
});
async function base() {
  const f = await syntheticReadFixture();
  fixtures.push(f);
  return f;
}
const content = "disposable candidate bytes";
function supervised(f: Awaited<ReturnType<typeof base>>, supervisor: unknown) {
  const service = createOwnedFileReadServiceForTest({
    enabled: true,
    owner: f.owner,
    content,
    maximumInvocations: 4,
    controlledSupervisor: supervisor as never,
    observed: async () => {},
    respond: async () => {},
  });
  services.push(service);
  return service;
}
function pinned(offset: number, length: number) {
  const state = { current: true, intervals: [] as [number, number][] };
  return {
    state,
    supervisor: {
      installedEvidenceRef: "test-supervisor-bootstrap:review",
      assertCurrent: (): undefined => {
        if (!state.current) throw new Error("supervisor no longer current");
        return undefined;
      },
      assertInterval: (candidateOffset: number, candidateLength: number): undefined => {
        state.intervals.push([candidateOffset, candidateLength]);
        if (candidateOffset !== offset || candidateLength !== length) throw new Error("interval not supervised");
        return undefined;
      },
    },
  };
}

describe.skipIf(process.platform !== "linux")("controlled supervisor seam (#742 review)", () => {
  it("wire/config data cannot supply supervisor authority", async () => {
    const callable = pinned(2, 4).supervisor;
    const setup = vi.spyOn(fs, "mkdtempSync");
    for (const candidate of [
      JSON.parse(JSON.stringify(callable)),
      { ...callable, assertCurrent: "undefined" },
      { ...callable, installedEvidenceRef: "" },
      { ...callable, assertCurrent: () => false },
      { ...callable, assertCurrent: () => "current" },
    ]) {
      const f = await base();
      expect(() => supervised(f, candidate)).toThrow();
    }
    expect(setup).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it("the service itself refuses an unsupervised interval before any read", async () => {
    const f = await base();
    const { state, supervisor } = pinned(2, 4);
    const service = supervised(f, supervisor);
    for (const [offset, length] of [
      [3, 4],
      [2, 5],
      [0, 26],
    ] as const)
      expect(() =>
        service.capture(f.owner, { resourceRef: service.resourceRef, offset, length }, f.policy, f.evidence),
      ).toThrow();
    expect(state.intervals).toEqual([
      [3, 4],
      [2, 5],
      [0, 26],
    ]);
    const invocation = service.capture(
      f.owner,
      { resourceRef: service.resourceRef, offset: 2, length: 4 },
      f.policy,
      f.evidence,
    );
    expect(state.intervals.at(-1)).toEqual([2, 4]);
    expect(invocation.action.coverage.level).toBe("verified-per-execution");
    expect(invocation.action.coverage.evidence.installedRefs).toEqual(["test-supervisor-bootstrap:review"]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("supervisor currentness lost after a permit refuses physical dispatch", async () => {
    const f = await base();
    const { state, supervisor } = pinned(2, 4);
    const service = supervised(f, supervisor);
    const invocation = service.capture(
      f.owner,
      { resourceRef: service.resourceRef, offset: 2, length: 4 },
      f.policy,
      f.evidence,
    );
    const evaluated = await invocation.evaluate(f.caller.signal);
    if (evaluated.phase !== "final" || evaluated.verdict.outcome !== "allow")
      throw new Error("synthetic allow required");
    const permit = await invocation.authorize(invocation.action, evaluated.verdict, f.caller.signal);
    state.current = false;
    const outcome = await invocation.dispatch(permit, f.caller.signal).then(
      (receipt) => receipt.state,
      () => "refused",
    );
    expect(outcome).not.toBe("completed");
    expect(reads).not.toHaveBeenCalled();
    expect(() =>
      service.capture(f.owner, { resourceRef: service.resourceRef, offset: 2, length: 4 }, f.policy, f.evidence),
    ).toThrow();
  });

  it("the default service stays unqualified beside a supervised one", async () => {
    const plain = await base();
    const service = createOwnedFileReadServiceForTest({
      enabled: true,
      owner: plain.owner,
      content,
      maximumInvocations: 4,
      observed: async () => {},
      respond: async () => {},
    });
    services.push(service);
    expect(service.coverage).toMatchObject({
      level: "policy-per-ask",
      evidence: { installedRefs: [], independentlyObservedEffects: false },
    });
    const other = await base();
    expect(supervised(other, pinned(2, 4).supervisor).coverage.level).toBe("verified-per-execution");
    expect(service.coverage.level).toBe("policy-per-ask");
  });
});
