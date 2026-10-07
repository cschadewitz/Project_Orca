/** Renderer ordering/aging regressions using #495's exported fixtures and schema, never a local DTO. */
import { describe, expect, it } from "vitest";
import {
  hostResourceFixture,
  HostResourceSnapshotSchema,
  resourceWarnings,
  workstreamSummaryFixture,
  type HostResourceSnapshot,
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
      expect(state.provenance).toBeUndefined();
      expect(displayedSnapshot(receive(state))).toBeUndefined();
      const opened = resourceViewReducer(state, { type: "access", access: "fixture" });
      expect(receive(opened, fixture, 0).snapshot).toBeUndefined();
      expect(opened.provenance).toBeUndefined();
      expect(receive(opened).provenance).toMatchObject({ sequence: fixture.sequence });
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
    expect(state.provenance).toBeUndefined();
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
    expect(receive(advanced, ageResourceSnapshot({ ...fixture, sequence: 3 }, 14_999))).toBe(advanced);
    const expired = receive(advanced, ageResourceSnapshot({ ...fixture, sequence: 3 }, 15_000));
    expect(expired.provenance?.ageMs).toBe(15_000);
    expect(displayedSnapshot(expired)!.cpu).toMatchObject({ status: "stale", ageMs: 15_000 });
    const later = resourceViewReducer(expired, { type: "time", nowMs: 16_000 });
    expect(receive(later, expired.snapshot)).toBe(later);
    expect(displayedSnapshot(later)!.cpu).toMatchObject({ status: "stale", ageMs: 16_000 });
  });

  it("preserves source age when the same sequence is delivered repeatedly with advancing cache age", () => {
    const snapshot = ageResourceSnapshot(fixture, 4_000);
    if ("value" in snapshot.cpu) snapshot.cpu.ageMs = 6_000;
    let state = receive(initial(), snapshot);
    for (const nowMs of [1_000, 3_000, 7_000, 9_000]) {
      state = resourceViewReducer(state, { type: "time", nowMs });
      expect(receive(state, ageResourceSnapshot(snapshot, nowMs - 1))).toBe(state);
      state = receive(state, ageResourceSnapshot(snapshot, nowMs));
      expect(state.provenance?.ageMs).toBe(4_000 + nowMs);
      expect(displayedSnapshot(state)!.cpu).toMatchObject({ ageMs: 6_000 + nowMs });
      const repeated = receive(state, state.snapshot);
      expect(displayedSnapshot(repeated)).toEqual(displayedSnapshot(state));
      state = repeated;
    }
    expect(displayedSnapshot(state)!.cpu).toMatchObject({ status: "stale", reason: "expired" });
    expect(displayedSnapshot(state)!.memory.status).toBe("available");
  });

  it("retains only provenance when a newer response removes authorized workstream counts", () => {
    const active = { ...fixture, workstreams: workstreamSummaryFixture("active") };
    const state = receive(initial(), active);
    const next: HostResourceSnapshot = {
      ...fixture,
      sequence: 2,
      bootId: { status: "unavailable", source: "linux-boot-id", reason: "source-failed" },
      workstreams: { status: "permission-denied", source: "runtime-ownership", reason: "not-authorized" },
    };
    next.warnings = resourceWarnings(next);
    const updated = receive(state, next);
    expect(updated.snapshot).toEqual(next);
    expect(displayedSnapshot(updated)!.workstreams).toEqual(next.workstreams);
    expect(updated.provenance).toEqual({
      daemonInstanceId: next.daemonInstanceId,
      hostId: next.hostId,
      bootId: fixture.bootId,
      sequence: next.sequence,
      ageMs: next.ageMs,
    });
    expect(updated.provenance?.bootId).not.toBe(state.provenance?.bootId);
    expect(updated).not.toHaveProperty("lastKnownBootSnapshot");
    expect(JSON.stringify(updated)).not.toContain("activeRoots");
  });

  it.each(["healthy", "stale"] as const)("learns a %s boot after initially unknown boot observations", (kind) => {
    let state = initial();
    for (const sequence of [1, 2]) {
      const gap: HostResourceSnapshot = {
        ...fixture,
        sequence,
        bootId: { status: "unavailable", source: "linux-boot-id", reason: "source-failed" },
      };
      state = receive(state, gap);
      expect(state.provenance?.bootId).toEqual(gap.bootId);
    }
    const known = { ...hostResourceFixture(kind), sequence: 3 };
    state = receive(state, known);
    expect(state.snapshot).toEqual(known);
    expect(state.provenance?.bootId).toEqual(known.bootId);
    const different = { ...fixture, sequence: 4, bootId: structuredClone(fixture.bootId) };
    if ("value" in different.bootId) different.bootId.value = "30000000-0000-4000-8000-000000000001";
    expect(receive(state, different)).toBe(state);
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
    expect(refused.provenance).toBe(state.provenance);
    expect(JSON.stringify(refused)).not.toContain("sensitive");
  });

  describe.each(["healthy", "stale"] as const)("%s known boot provenance", (kind) => {
    it.each([
      { status: "unavailable", reason: "source-failed" },
      { status: "permission-denied", reason: "permission-denied" },
      { status: "unsupported", reason: "unsupported-source" },
    ] as const)("survives repeated $status boot observations until an authoritative reset", ({ status, reason }) => {
      let state = receive(initial(), hostResourceFixture(kind));
      for (const sequence of [2, 3]) {
        const gap: HostResourceSnapshot = {
          ...hostResourceFixture(),
          sequence,
          bootId: { status, reason, source: "linux-boot-id" },
        };
        gap.warnings = resourceWarnings(gap);
        state = receive(state, gap);
        expect(displayedSnapshot(state)?.bootId).toEqual(gap.bootId);
        expect(state.snapshot?.sequence).toBe(sequence);
        expect(state.provenance).toMatchObject({ bootId: hostResourceFixture(kind).bootId, sequence });
        state = resourceViewReducer(state, { type: "time", nowMs: state.nowMs + 1_000 });
        expect(receive(state, gap)).toBe(state);
        expect(receive(state, ageResourceSnapshot(gap, 999))).toBe(state);
        state = receive(state, ageResourceSnapshot(gap, 1_000));
        expect(state.provenance).toMatchObject({ bootId: hostResourceFixture(kind).bootId, sequence, ageMs: 1_000 });
      }
      const differentBoot = hostResourceFixture();
      differentBoot.sequence = 4;
      if ("value" in differentBoot.bootId) differentBoot.bootId.value = "30000000-0000-4000-8000-000000000001";
      expect(receive(state, differentBoot)).toBe(state);
      expect(receive(state, ageResourceSnapshot(differentBoot, 20_000))).toBe(state);
      expect(receive(state, { ...hostResourceFixture(), sequence: 2 })).toBe(state);
      const recoveryGeneration = state.generation;
      let reconnecting = resourceViewReducer(state, { type: "connection", connection: "disconnected" });
      reconnecting = resourceViewReducer(reconnecting, { type: "time", nowMs: 20_000 });
      reconnecting = resourceViewReducer(reconnecting, { type: "connection", connection: "live" });
      expect(reconnecting.provenance).toEqual(state.provenance);
      expect(receive(reconnecting, differentBoot)).toBe(reconnecting);
      const sameBoot = { ...hostResourceFixture(), sequence: 4 };
      expect(receive(reconnecting, sameBoot, recoveryGeneration)).toBe(reconnecting);
      const recovered = receive(reconnecting, sameBoot);
      expect(recovered.snapshot).toEqual(sameBoot);
      expect(recovered.provenance?.bootId).toEqual(sameBoot.bootId);
      expect(recovered.awaitingSnapshot).toBe(false);
      expect(displayedSnapshot(recovered)!.cpu.status).toBe("available");
      const reset = resourceViewReducer(state, {
        type: "select",
        targetLabel: "Restarted fixture daemon",
        daemonInstanceId: fixture.daemonInstanceId,
      });
      expect(reset.provenance).toBeUndefined();
      expect(receive(reset, differentBoot, state.generation)).toBe(reset);
      expect(receive(reset, differentBoot).snapshot).toEqual(differentBoot);
    });
  });

  it.each(["hostId", "daemonInstanceId"] as const)(
    "accepts a new %s only after authoritative selection",
    (identity) => {
      const state = receive(initial());
      const next = { ...fixture, [identity]: "30000000-0000-4000-8000-000000000002", sequence: 0 };
      expect(receive(state, next)).toBe(state);
      const reset = resourceViewReducer(state, {
        type: "select",
        targetLabel: "Replacement daemon",
        daemonInstanceId: next.daemonInstanceId,
      });
      expect(reset.provenance).toBeUndefined();
      expect(receive(reset, next, state.generation)).toBe(reset);
      expect(receive(reset, next).snapshot).toEqual(next);
      expect(receive(reset, next).provenance?.[identity]).toBe(next[identity]);
    },
  );
});
