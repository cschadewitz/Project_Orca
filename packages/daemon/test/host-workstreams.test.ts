/** Authorized counts remain bounded, revocable, private and explicit about uncertainty. */
import { afterEach, expect, it, vi } from "vitest";
import { HOST_RESOURCE_LIMITS, WorkstreamSummarySchema } from "@orca/protocol";
import {
  HostWorkstreamCollector,
  type AuthorizedWorkstreamRun,
  type WorkstreamAuthority,
  type WorkstreamObservation,
  type WorkstreamSource,
} from "../src/host-workstreams.js";

const now = Date.parse("2026-10-04T12:00:00.000Z");
const ref = (runId: string, rootRunId = runId): AuthorizedWorkstreamRun => ({ runId, rootRunId });
const observation = (
  status: WorkstreamObservation["status"],
  extra: Partial<WorkstreamObservation> = {},
): WorkstreamObservation => ({
  status,
  lease: "live",
  observedAt: now,
  ...extra,
});
function setup(rows: [AuthorizedWorkstreamRun, WorkstreamObservation][]) {
  let valid = true;
  const denied = new Set<string>();
  const authority: WorkstreamAuthority = {
    current: () => (valid ? { scope: "caller-visible" } : undefined),
    allows: (run) => !denied.has(run.runId),
  };
  const source: WorkstreamSource = {
    enumerate: vi.fn(async () => ({ runs: rows.map(([run]) => run), complete: true })),
    read: vi.fn(async (id) => rows.find(([run]) => run.runId === id)![1]),
  };
  const collector = new HostWorkstreamCollector(source, () => now);
  return {
    source,
    authority,
    collector,
    denied,
    revoke: () => {
      valid = false;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it("counts direct and root work once, includes executing children and parked waiting/blocked work", async () => {
  const s = setup([
    [ref("root"), observation("waiting", { waitingOn: "child-run" })],
    [ref("child", "root"), observation("running")],
    [ref("human"), observation("paused", { lease: "missing" })],
    [ref("dependencies"), observation("waiting", { waitingOn: "dependencies" })],
    [ref("plan"), observation("waiting", { waitingOn: "plan" })],
    [ref("created"), observation("created", { lease: "missing" })],
    [ref("question"), observation("waiting", { waitingOn: "human-input" })],
    [ref("done"), observation("completed")],
    [ref("failed"), observation("failed")],
    [ref("cancelled"), observation("cancelled")],
  ]);
  const result = await s.collector.collect(s.authority);
  expect(WorkstreamSummarySchema.parse(result)).toMatchObject({
    status: "available",
    value: {
      coverage: "authorized-run-set",
      complete: true,
      activeRoots: 6,
      executingRuns: 2,
      waitingRuns: 2,
      blockedRuns: 3,
      uncertainRuns: 0,
    },
  });
});

it("keeps missing, lapsed and unknown executing leases uncertain", async () => {
  const s = setup([
    [ref("missing"), observation("running", { lease: "missing" })],
    [ref("lapsed"), observation("waiting", { lease: "lapsed", waitingOn: "agent-turn" })],
    [ref("unknown"), observation("running", { lease: "unknown" })],
  ]);
  expect(await s.collector.collect(s.authority)).toMatchObject({
    status: "available",
    value: { activeRoots: 3, executingRuns: 0, uncertainRuns: 3 },
  });
});

it("marks old and future observations stale and does not report stale execution as executing", async () => {
  const s = setup([
    [ref("old"), observation("running", { observedAt: now - HOST_RESOURCE_LIMITS.expiresAfterMs })],
    [ref("future"), observation("paused", { observedAt: now + 1 })],
  ]);
  expect(WorkstreamSummarySchema.parse(await s.collector.collect(s.authority))).toMatchObject({
    status: "stale",
    reason: "clock-discontinuity",
    ageMs: HOST_RESOURCE_LIMITS.expiresAfterMs,
    value: { executingRuns: 0, uncertainRuns: 2 },
  });
});

it("denies before enumeration and distinguishes an authorized empty set", async () => {
  const denied = setup([]);
  denied.revoke();
  expect(await denied.collector.collect(denied.authority)).toEqual({
    status: "permission-denied",
    source: "runtime-ownership",
    reason: "not-authorized",
  });
  expect(denied.source.enumerate).not.toHaveBeenCalled();
  const empty = setup([]);
  expect(await empty.collector.collect(empty.authority)).toMatchObject({
    status: "available",
    value: { complete: true, activeRoots: 0, executingRuns: 0 },
  });
});

it("expires at the exact freshness boundary and fails closed on a regressed collection clock", async () => {
  const old = setup([[ref("old"), observation("running", { observedAt: now - HOST_RESOURCE_LIMITS.expiresAfterMs })]]);
  expect(await old.collector.collect(old.authority)).toMatchObject({
    status: "stale",
    reason: "expired",
    value: { uncertainRuns: 1 },
  });
  const s = setup([[ref("run"), observation("running")]]);
  let clock = now;
  const collector = new HostWorkstreamCollector(s.source, () => clock);
  s.source.read = vi.fn(async () => {
    clock = now - 1;
    return observation("running");
  });
  expect(await collector.collect(s.authority)).toMatchObject({ status: "unavailable", reason: "clock-discontinuity" });
  const invalid = new HostWorkstreamCollector(s.source, () => Number.NaN);
  expect(await invalid.collect(s.authority)).toMatchObject({ reason: "clock-discontinuity" });
});

it("rejects invalid runtime authority scopes and excessive IDs", async () => {
  const s = setup([]);
  s.authority.current = () => ({ scope: "invented" }) as unknown as ReturnType<WorkstreamAuthority["current"]>;
  expect(await s.collector.collect(s.authority)).toMatchObject({ reason: "not-authorized" });
  expect(s.source.enumerate).not.toHaveBeenCalled();
  const long = setup([[ref("x".repeat(257)), observation("running")]]);
  expect(await long.collector.collect(long.authority)).toMatchObject({ reason: "invalid-source" });
  expect(long.source.read).not.toHaveBeenCalled();
});

it("rechecks revocation after enumeration and reads; does not return accumulated counts", async () => {
  const s = setup([[ref("private-root"), observation("running")]]);
  s.source.enumerate = vi.fn(async () => {
    s.revoke();
    return { runs: [ref("private-root")], complete: true };
  });
  expect(await s.collector.collect(s.authority)).toMatchObject({ reason: "not-authorized" });
  expect(s.source.read).not.toHaveBeenCalled();
  const duringRead = setup([[ref("private-root"), observation("running")]]);
  duringRead.source.read = vi.fn(async () => {
    duringRead.revoke();
    return observation("running");
  });
  const result = await duringRead.collector.collect(duringRead.authority);
  expect(result).toMatchObject({ reason: "not-authorized" });
  expect(result).not.toHaveProperty("value");
});

it("denies unexpected unauthorized records before reading them and rechecks earlier ownership", async () => {
  const s = setup([
    [ref("visible"), observation("running")],
    [ref("secret"), observation("running")],
  ]);
  s.denied.add("secret");
  expect(await s.collector.collect(s.authority)).toMatchObject({ reason: "not-authorized" });
  expect(s.source.read).toHaveBeenCalledTimes(1);
  const changed = setup([
    [ref("first"), observation("running")],
    [ref("last"), observation("running")],
  ]);
  changed.source.read = vi.fn(async (id) => {
    if (id === "last") changed.denied.add("first");
    return observation("running");
  });
  expect(await changed.collector.collect(changed.authority)).toMatchObject({ reason: "not-authorized" });
});

it("deduplicates records and bounds authorized coverage without exposing overflow counts", async () => {
  const s = setup([]);
  s.source.enumerate = vi.fn(async () => ({
    runs: Array.from({ length: 1_005 }, (_, i) => ref(`run-${i}`)),
    complete: true,
  }));
  s.source.read = vi.fn(async () => observation("created"));
  expect(await s.collector.collect(s.authority)).toMatchObject({
    status: "available",
    value: { complete: false, activeRoots: 1_000, blockedRuns: 1_000 },
  });
  expect(s.source.enumerate).toHaveBeenCalledWith(s.authority, 1_000, expect.any(AbortSignal));
  expect(s.source.read).toHaveBeenCalledTimes(1_000);
  const duplicates = setup([
    [ref("same"), observation("running")],
    [ref("same"), observation("running")],
  ]);
  expect(await duplicates.collector.collect(duplicates.authority)).toMatchObject({
    value: { activeRoots: 1, executingRuns: 1 },
  });
});

it("partial reads disclose uncertainty without returning errors or metadata", async () => {
  const s = setup([[ref("private-id"), observation("running")]]);
  s.source.read = vi.fn(async () => {
    throw new Error("/private/path token=secret workflow=private-id");
  });
  const result = await s.collector.collect(s.authority);
  expect(WorkstreamSummarySchema.parse(result)).toMatchObject({
    value: { complete: false, activeRoots: 0, uncertainRuns: 1 },
  });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|token|workflow|runId/);
});

it("rejects missing/conflicting lineage and treats malformed observations as uncertain", async () => {
  const missing = setup([[ref("child", ""), observation("running")]]);
  expect(await missing.collector.collect(missing.authority)).toMatchObject({ reason: "invalid-source" });
  expect(missing.source.read).not.toHaveBeenCalled();
  const conflicting = setup([
    [ref("child", "root-a"), observation("running")],
    [ref("child", "root-b"), observation("running")],
  ]);
  expect(await conflicting.collector.collect(conflicting.authority)).toMatchObject({ reason: "invalid-source" });
  const malformed = setup([[ref("run"), observation("running")]]);
  malformed.source.read = vi.fn(
    async () => ({ status: "invented", lease: "live", observedAt: now }) as unknown as WorkstreamObservation,
  );
  expect(await malformed.collector.collect(malformed.authority)).toMatchObject({
    value: { complete: false, activeRoots: 0, uncertainRuns: 1 },
  });
});

it("times out with partial observations and retains the slot until ignored cancellation settles", async () => {
  vi.useFakeTimers();
  const s = setup([
    [ref("fast"), observation("running")],
    [ref("stuck"), observation("running")],
  ]);
  const stuck = deferred<WorkstreamObservation>();
  s.source.read = vi.fn(async (id) => (id === "stuck" ? stuck.promise : observation("running")));
  const pending = s.collector.collect(s.authority);
  await vi.advanceTimersByTimeAsync(HOST_RESOURCE_LIMITS.collectionTimeoutMs);
  expect(await pending).toMatchObject({
    status: "stale",
    reason: "timeout",
    value: { complete: false, executingRuns: 1 },
  });
  expect(await s.collector.collect(s.authority)).toMatchObject({ reason: "busy" });
  expect(s.source.enumerate).toHaveBeenCalledTimes(1);
  stuck.resolve(observation("running"));
  await vi.advanceTimersByTimeAsync(0);
  expect(await s.collector.collect(s.authority)).toMatchObject({ status: "available", value: { executingRuns: 2 } });
});

it("times out before enumeration completes and still enforces revocation at timeout", async () => {
  vi.useFakeTimers();
  const s = setup([]);
  const never = deferred<{ runs: AuthorizedWorkstreamRun[]; complete: boolean }>();
  s.source.enumerate = vi.fn(() => never.promise);
  const pending = s.collector.collect(s.authority);
  await vi.advanceTimersByTimeAsync(HOST_RESOURCE_LIMITS.collectionTimeoutMs);
  expect(await pending).toMatchObject({ status: "unavailable", reason: "timeout" });
  s.revoke();
  expect(await s.collector.collect(s.authority)).toMatchObject({ reason: "not-authorized" });
  const revoked = setup([]);
  revoked.source.enumerate = vi.fn(() => never.promise);
  const reading = revoked.collector.collect(revoked.authority);
  revoked.revoke();
  await vi.advanceTimersByTimeAsync(HOST_RESOURCE_LIMITS.collectionTimeoutMs);
  expect(await reading).toMatchObject({ reason: "not-authorized" });
  never.resolve({ runs: [], complete: true });
  await vi.advanceTimersByTimeAsync(0);
});
