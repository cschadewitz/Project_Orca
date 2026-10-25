// @vitest-environment happy-dom
/** Artifact metadata refresh ordering and request bounds at the real notification seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ArtifactsListResult, ArtifactView, NotificationMessage } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { useArtifactsList, type ArtifactsListQuery } from "../src/artifacts/use-artifacts.js";
import { artifactRecorded } from "./artifact-events.js";
import { RUN_ART } from "./fixtures-artifacts.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const VERSIONS = RUN_ART.artifacts.filter((a) => a.name === "spec");
const QUERY: ArtifactsListQuery = { runId: "run-art", name: "spec", producedByStepRunId: "s-spec-3" };
const recorded = (artifact = VERSIONS[2]!, runId = "run-art", seq = 100): NotificationMessage =>
  artifactRecorded(runId, artifact, seq);
const answer = (artifacts: readonly ArtifactView[]): BridgeResult<ArtifactsListResult> => ({
  ok: true,
  result: { artifacts: [...artifacts], total: artifacts.length, asOf: RUN_ART.asOf },
});

let fake: FakeBridge;
let h: Harness;

/** Resolve reads individually, so a stale answer cannot accidentally become fresh. */
function holdReads(): ((value: BridgeResult<ArtifactsListResult>) => void)[] {
  const pending: ((value: BridgeResult<ArtifactsListResult>) => void)[] = [];
  fake.script({ "artifacts.list": () => new Promise((resolve) => pending.push(resolve)) });
  return pending;
}

const reads = () => fake.calls.filter((c) => c.method === "artifacts.list");

describe("artifact metadata notifications", () => {
  beforeEach(() => {
    fake = installBridge();
    h = harness();
  });

  afterEach(() => {
    cleanup();
    h.dispose();
    vi.useRealTimers();
  });

  it("subscribes before reading and coalesces an initial-read burst into one follow-up", async () => {
    const pending = holdReads();
    const list = fake.bridge.artifacts.list;
    fake.bridge.artifacts.list = (params) => {
      // A push synchronously inside the first call catches read-before-subscribe bugs.
      if (reads().length === 0) fake.notify(recorded());
      return list(params);
    };
    const subscribe = fake.bridge.notifications.subscribe;
    fake.bridge.notifications.subscribe = (listener) => {
      const off = subscribe(listener);
      // Subscription replay can deliver before subscribe returns, too.
      fake.notify(recorded());
      return off;
    };
    const { result, rerender } = renderHook(() => useArtifactsList({ ...QUERY }), { wrapper: h.Providers });
    await act(async () => {});
    await act(async () => {
      for (let seq = 101; seq < 151; seq++) fake.notify(recorded(undefined, undefined, seq));
    });
    expect(reads()).toHaveLength(1);
    expect(pending).toHaveLength(1);

    await act(async () => pending[0]!(answer([])));
    expect(reads()).toHaveLength(2);
    expect(result.current).toEqual({ loading: true, artifacts: [] });
    await act(async () => pending[1]!(answer(VERSIONS)));
    expect(result.current).toEqual({ loading: false, artifacts: VERSIONS });
    rerender();
    expect(reads()).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "artifacts.get")).toHaveLength(0);
  });

  it("discards invalidated refresh answers while holding metadata, with one trailing read per burst", async () => {
    const pending = holdReads();
    const { result } = renderHook(() => useArtifactsList(QUERY), { wrapper: h.Providers });
    await act(async () => {});
    await act(async () => pending[0]!(answer(VERSIONS.slice(0, 1))));
    await act(async () => fake.notify(recorded()));
    expect(reads()).toHaveLength(2);
    await act(async () => {
      for (let seq = 101; seq < 201; seq++) fake.notify(recorded(undefined, undefined, seq));
    });
    expect(reads()).toHaveLength(2);
    await act(async () => pending[1]!(answer(VERSIONS.slice(0, 2))));
    expect(reads()).toHaveLength(3);
    expect(result.current).toEqual({ loading: false, artifacts: VERSIONS.slice(0, 1) });
    await act(async () => pending[2]!(answer(VERSIONS)));
    expect(result.current).toEqual({ loading: false, artifacts: VERSIONS });
    expect(reads()).toHaveLength(3);
  });

  it("ignores other runs, names, steps and event kinds, and never polls", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArtifactsList(QUERY), { wrapper: h.Providers });
    await act(async () => {});
    const before = result.current;
    await act(async () => {
      fake.notify(recorded(undefined, "other-run"));
      fake.notify(recorded({ ...VERSIONS[2]!, name: "other-name" }));
      fake.notify(recorded({ ...VERSIONS[2]!, producedByStepRunId: "other-step" }));
      fake.notify({
        kind: "notification",
        method: "event.appended",
        params: {
          subscriptionId: "sub-1",
          runId: "run-art",
          seq: 110,
          at: RUN_ART.asOf,
          event: {
            id: "rejection",
            runId: "run-art",
            seq: 110,
            at: RUN_ART.asOf,
            type: "artifact.rejected",
            payload: { stepRunId: "s-spec-3", kind: "spec", path: "spec.md", reason: "missing" },
          },
        },
      });
      fake.notify({
        kind: "notification",
        method: "agent.update",
        params: {
          subscriptionId: "sub-1",
          runId: "run-art",
          seq: 111,
          fromSeq: 111,
          at: RUN_ART.asOf,
          stepRunId: "s-spec-3",
          sessionId: "session",
          updates: [{ kind: "agent_message_chunk", text: "output" }],
        },
      });
      vi.advanceTimersByTime(60_000);
    });
    expect(reads()).toHaveLength(1);
    expect(result.current).toBe(before);
    await act(async () => fake.notify(recorded()));
    expect(reads()).toHaveLength(2);
  });

  it.each([
    { field: "runId", next: { ...QUERY, runId: "other-run" } },
    { field: "name", next: { ...QUERY, name: "other-name" } },
    { field: "step", next: { ...QUERY, producedByStepRunId: "other-step" } },
  ])("ignores a late $field response and its queued refresh after changing the query", async ({ next }) => {
    const pending = holdReads();
    const { result, rerender } = renderHook((query) => useArtifactsList(query), {
      initialProps: QUERY,
      wrapper: h.Providers,
    });
    await act(async () => {});
    await act(async () => fake.notify(recorded()));
    rerender(next);
    await act(async () => {});
    expect(reads()).toHaveLength(2);
    expect(h.notifications.listeners).toBe(1);
    const current = { ...VERSIONS[0]!, id: "current-query" };
    await act(async () => pending[1]!(answer([current])));
    await act(async () => pending[0]!(answer(VERSIONS)));
    expect(result.current).toEqual({ loading: false, artifacts: [current] });
    expect(reads()).toHaveLength(2);
  });

  it("unsubscribes and abandons a pending read and queued refresh on unmount", async () => {
    const pending = holdReads();
    const { unmount } = renderHook(() => useArtifactsList(QUERY), { wrapper: h.Providers });
    await act(async () => {});
    await act(async () => fake.notify(recorded()));
    unmount();
    expect(h.notifications.listeners).toBe(0);
    expect(fake.subscribers).toBe(0);
    await act(async () => {
      pending[0]!(answer(VERSIONS));
      fake.notify(recorded());
    });
    expect(reads()).toHaveLength(1);
  });

  it("retains held metadata on a failed refresh and recovers on the next relevant event", async () => {
    const { result } = renderHook(() => useArtifactsList(QUERY), { wrapper: h.Providers });
    await act(async () => {});
    const before = result.current.artifacts;
    const error = { code: "AGENT_TRANSPORT" as const, message: "unavailable" };
    fake.fail("artifacts.list", error);
    await act(async () => fake.notify(recorded()));
    expect(result.current).toEqual({ loading: false, artifacts: before, error });
    expect(reads()).toHaveLength(2);
    fake.script({ "artifacts.list": () => answer(VERSIONS) });
    await act(async () => fake.notify(recorded()));
    expect(result.current).toEqual({ loading: false, artifacts: VERSIONS });
    expect(reads()).toHaveLength(3);
  });

  it("refreshes an unfiltered list for a recorded artifact in any run", async () => {
    renderHook(() => useArtifactsList({}), { wrapper: h.Providers });
    await act(async () => fake.notify(recorded(undefined, "other-run")));
    expect(reads()).toHaveLength(2);
  });
});
