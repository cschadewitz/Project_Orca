/** Renderer ordering/aging regressions using #495's exported fixtures and schema, never a local DTO. */
import { describe, expect, it } from "vitest";
import {
  hostResourceFixture,
  HostResourceSnapshotSchema,
  resourceWarnings,
  workstreamSummaryFixture,
} from "@orca/protocol";
import {
  ageResourceSnapshot,
  displayedSnapshot,
  resourceViewReducer,
  resourceViewState,
  type ResourceViewState,
} from "../src/resources/resource-model.js";

const fixture = hostResourceFixture();
const initial = () => resourceViewState("Fixture daemon", fixture.daemonInstanceId, "fixture");
const receive = (state: ResourceViewState, snapshot: unknown = fixture, requestGeneration = state.generation) =>
  resourceViewReducer(state, { type: "receive", snapshot, requestGeneration });

describe("resource observations", () => {
  it.each([
    "healthy",
    "pressure",
    "partial",
    "stale",
    "tmpfs",
    "cgroup-cpu-unsupported",
    "cgroup-cpu-denied",
    "cgroup-memory-unsupported",
    "cgroup-memory-denied",
  ] as const)("accepts the exact shared %s fixture without changing it", (kind) => {
    const snapshot = hostResourceFixture(kind);
    const copy = structuredClone(snapshot);
    expect(displayedSnapshot(receive(initial(), snapshot))).toEqual(snapshot);
    expect(snapshot).toEqual(copy);
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("keeps independent CPU/memory outcomes and the shared memory warning after the review fix", () => {
    for (const kind of ["cgroup-cpu-unsupported", "cgroup-cpu-denied"] as const) {
      const snapshot = displayedSnapshot(receive(initial(), hostResourceFixture(kind)))!;
      expect(snapshot.memoryLimit).toMatchObject({ status: "available", value: { headroomBytes: 200_000_000 } });
      expect(snapshot.warnings).toContainEqual(
        expect.objectContaining({ code: "memory-pressure", metric: "memoryLimit" }),
      );
    }
    for (const kind of ["cgroup-memory-unsupported", "cgroup-memory-denied"] as const)
      expect(displayedSnapshot(receive(initial(), hostResourceFixture(kind)))!.cpuLimit.status).toBe("available");
  });

  it("ages every observed metric and authorized summary at the exact shared expiry", () => {
    const snapshot = { ...fixture, workstreams: workstreamSummaryFixture("active") };
    expect(ageResourceSnapshot(snapshot, 14_999).cpu.status).toBe("available");
    const aged = ageResourceSnapshot(snapshot, 15_000);
    expect(aged.cpu).toMatchObject({ status: "stale", ageMs: 15_000, observedAt: fixture.collectedAt });
    expect(aged.workstreams.status).toBe("stale");
    expect(aged.storage.every((disk) => disk.measurement.status === "stale")).toBe(true);
    expect(HostResourceSnapshotSchema.safeParse(aged).success).toBe(true);
    expect(aged.warnings).toEqual(resourceWarnings(aged));
    expect(ageResourceSnapshot(hostResourceFixture("pressure"), 15_000).warnings.map((w) => w.code)).toEqual([
      "stale-data",
    ]);
  });

  it("ages original source observations rather than the arrival or collection timestamp", () => {
    const snapshot = hostResourceFixture();
    if (snapshot.cpu.status === "available") snapshot.cpu.ageMs = 14_000;
    expect(ageResourceSnapshot(snapshot, 1_000).cpu.status).toBe("stale");
    expect(ageResourceSnapshot(snapshot, 1_000).memory.status).toBe("available");
    expect(ageResourceSnapshot(hostResourceFixture("stale"), 7_000).cpu).toMatchObject({
      ageMs: 27_000,
      reason: "expired",
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not make an invalid clock interval fresh (%s)",
    (elapsed) => {
      expect(ageResourceSnapshot(fixture, elapsed).cpu).toMatchObject({
        status: "stale",
        reason: "clock-discontinuity",
      });
    },
  );

  it("never reads or exposes data while the gate is closed, including revocation", () => {
    for (const access of ["unconnected", "permission-denied", "unsupported"] as const) {
      let state = receive(initial());
      state = resourceViewReducer(state, { type: "access", access });
      expect(state.snapshot).toBeUndefined();
      expect(displayedSnapshot(receive(state))).toBeUndefined();
      const opened = resourceViewReducer(state, { type: "access", access: "fixture" });
      expect(receive(opened, fixture, 0).snapshot).toBeUndefined();
    }
    expect(resourceViewState("Target", fixture.daemonInstanceId).access).toBe("unconnected");
  });

  it("clears the prior target immediately and rejects delayed responses even after switching back", () => {
    let state = receive(initial());
    state = resourceViewReducer(state, {
      type: "select",
      targetLabel: "Another daemon",
      daemonInstanceId: "20000000-0000-4000-8000-000000000001",
    });
    expect(displayedSnapshot(state)).toBeUndefined();
    expect(receive(state, fixture, 0)).toBe(state);
    expect(receive(state, fixture)).toBe(state);
    state = resourceViewReducer(state, {
      type: "select",
      targetLabel: "Fixture daemon",
      daemonInstanceId: fixture.daemonInstanceId,
    });
    expect(receive(state, fixture, 0)).toBe(state);
    expect(receive(state).snapshot).toEqual(fixture);
  });

  it("retains and ages disconnected readings, fences old requests, and awaits valid data after reconnect", () => {
    let state = receive(initial());
    state = resourceViewReducer(state, { type: "connection", connection: "disconnected" });
    state = resourceViewReducer(state, { type: "time", nowMs: 20_000 });
    expect(displayedSnapshot(state)!.cpu).toMatchObject({ status: "stale", ageMs: 20_000 });
    expect(receive(state)).toBe(state);
    state = resourceViewReducer(state, { type: "connection", connection: "live" });
    expect(state.awaitingSnapshot).toBe(true);
    expect(receive(state, fixture, 0)).toBe(state);
    const recovered = receive(state, { ...fixture, sequence: 2 });
    expect(recovered.awaitingSnapshot).toBe(false);
    expect(displayedSnapshot(recovered)!.cpu.status).toBe("available");
  });

  it("rejects backwards sequences, backwards cache ages, and repeated refresh that would renew old data", () => {
    let state = receive(initial(), { ...fixture, sequence: 3 });
    state = resourceViewReducer(state, { type: "time", nowMs: 8_000 });
    expect(receive(state, { ...fixture, sequence: 2 })).toBe(state);
    for (let n = 0; n < 5; n++) expect(receive(state, { ...fixture, sequence: 3 })).toBe(state);
    const accepted = receive(state, ageResourceSnapshot({ ...fixture, sequence: 3 }, 8_000));
    expect(displayedSnapshot(accepted)!.cpu).toMatchObject({ ageMs: 8_000 });
    const advanced = resourceViewReducer(accepted, { type: "time", nowMs: 15_000 });
    expect(displayedSnapshot(advanced)!.cpu).toMatchObject({ status: "stale", ageMs: 15_000 });
  });

  it("requires an authoritative generation reset before accepting a new boot or collector", () => {
    const state = receive(initial());
    const next = hostResourceFixture();
    if ("value" in next.bootId) next.bootId.value = "30000000-0000-4000-8000-000000000001";
    next.sequence = 2;
    expect(receive(state, next)).toBe(state);
    expect(receive(state, { ...fixture, hostId: "30000000-0000-4000-8000-000000000002", sequence: 2 })).toBe(state);
    const reset = resourceViewReducer(state, {
      type: "select",
      targetLabel: "Restarted fixture daemon",
      daemonInstanceId: fixture.daemonInstanceId,
    });
    expect(receive(reset, next, state.generation)).toBe(reset);
    expect(receive(reset, next).snapshot).toEqual(next);
  });

  it("contains malformed responses without exposing raw error contents or discarding old observations", () => {
    const state = receive(initial());
    const refused = receive(state, { ...fixture, privatePath: "/sensitive/credential" });
    expect(refused.invalidResponse).toBe(true);
    expect(refused.snapshot).toEqual(fixture);
    expect(JSON.stringify(refused)).not.toContain("sensitive");
  });
});
