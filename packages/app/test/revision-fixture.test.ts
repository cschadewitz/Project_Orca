import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenInputView } from "@orca/protocol";
import type { AdmissionDaemon } from "./smoke/admission-daemon.js";
import { REVISION_FIXTURE, startRevisionRun } from "./smoke/revision-daemon.js";

function gate(runId = "run-exact", revision = true): OpenInputView {
  return {
    id: "input-exact",
    kind: "decision",
    question: REVISION_FIXTURE.question,
    options: [
      { id: "changes", label: "Request changes" },
      { id: "continue", label: "Continue unchanged" },
    ],
    context: {},
    runId,
    runName: "Synthetic",
    stepRunId: "step-review",
    nodeId: "review",
    requestedAt: "2026-10-03T00:00:00Z",
    waitingMs: 0,
    artifacts: [],
    revisionActionId: "changes",
    ...(revision
      ? {
          revision: {
            target: {
              runId,
              stepRunId: "step-review",
              requestId: "input-exact",
              destinationId: "destination",
              expectedRevision: "cas",
            },
            capability: {
              actionId: "changes",
              destinationNodeId: REVISION_FIXTURE.destination,
              composition: "replace-revision-slot" as const,
              payload: { kind: "text" as const, maxBytes: 4096 },
            },
            destinationDescription: "Designated synthetic worker",
          },
        }
      : {}),
  };
}
function fixture(pages: OpenInputView[][]) {
  let reads = 0;
  const rpc = vi.fn(async (method: string) => {
    if (method === "runs.start") return { runId: "run-exact" };
    const inputs = pages[Math.min(reads++, pages.length - 1)]!;
    return { inputs, waiting: inputs.length, asOf: "2026-10-03T00:00:00Z" };
  });
  return { daemon: { rpc } as unknown as AdmissionDaemon, rpc };
}
afterEach(() => vi.useRealTimers());

describe("native revision fixture exact-run readiness", () => {
  it("selects the returned run rather than another run with the same question", async () => {
    const { daemon, rpc } = fixture([[gate("other"), gate()]]);
    expect((await startRevisionRun(daemon, "corrective")).runId).toBe("run-exact");
    expect(rpc.mock.calls[1]).toEqual(["inputs.list", { runId: "run-exact" }]);
  });
  it("ordinary setup accepts an exact restricted gate without the optional revision capability", async () => {
    const { daemon, rpc } = fixture([[gate("run-exact", false)]]);
    expect((await startRevisionRun(daemon, "ordinary", false)).revision).toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("waits read-only for the required boundary after temporary omission", async () => {
    vi.useFakeTimers();
    const { daemon, rpc } = fixture([[gate("run-exact", false)], [gate()]]);
    const result = startRevisionRun(daemon, "corrective");
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).revision).toBeDefined();
    expect(rpc.mock.calls.filter(([method]) => method === "runs.start")).toHaveLength(1);
  });
  it.each([
    { name: "missing gate", pages: [[]], error: "exact-run gate" },
    { name: "wrong run with same question", pages: [[gate("other")]], error: "exact-run gate" },
    { name: "missing boundary", pages: [[gate("run-exact", false)]], error: "exact-run revision boundary" },
  ])("bounds reads for $name without another start", async ({ pages, error }) => {
    vi.useFakeTimers();
    const { daemon, rpc } = fixture(pages);
    const result = expect(startRevisionRun(daemon, "corrective")).rejects.toThrow(error);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(rpc.mock.calls.filter(([method]) => method === "runs.start")).toHaveLength(1);
    expect(rpc.mock.calls.filter(([method]) => method === "inputs.list")).toHaveLength(101);
  });
  it("rejects duplicate exact gates and mismatched boundaries", async () => {
    await expect(startRevisionRun(fixture([[gate(), gate()]]).daemon, "x")).rejects.toThrow("ambiguous");
    const mismatch = gate();
    mismatch.revision!.target.requestId = "different";
    await expect(startRevisionRun(fixture([[mismatch]]).daemon, "x")).rejects.toThrow("mismatched");
  });
  it("propagates authority/read failure without retrying or guessing readiness", async () => {
    const { daemon, rpc } = fixture([[]]);
    rpc.mockImplementationOnce(async () => ({ runId: "run-exact" }));
    rpc.mockImplementationOnce(async () => {
      throw new Error("AUTH_FORBIDDEN");
    });
    await expect(startRevisionRun(daemon, "x")).rejects.toThrow("AUTH_FORBIDDEN");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("does not treat an unverified declaration as an ordinary gate", async () => {
    const input = gate("run-exact", false);
    delete input.revisionActionId;
    await expect(startRevisionRun(fixture([[input]]).daemon, "x", false)).rejects.toThrow(
      "declared action restriction",
    );
  });
});
