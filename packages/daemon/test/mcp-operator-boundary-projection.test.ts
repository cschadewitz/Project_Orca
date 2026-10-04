import { describe, expect, it, vi } from "vitest";
import { OperatorReadModel, type OperatorReadOptions } from "../src/operator-read-model.js";
import type { Principal } from "../src/auth/principal.js";
import {
  OperatorRowSchema,
  OperatorBoundaryRowSchema,
  type OperatorBoundaryRow,
  type OperatorPageParams,
  type OperatorRow,
} from "@orca/protocol";
import { operatorProjectionFixture as f } from "../../protocol/test/fixtures/operator-mutations.js";

const params: OperatorPageParams = { ...f.params, limit: 1 };
function fixture(
  overrides: Partial<OperatorReadOptions> = {},
  rows: OperatorRow[] = [OperatorRowSchema.parse(f.before)],
) {
  let revision = "boundary-1";
  let principal: Principal = {
    id: "caller",
    kind: "credential",
    credentialId: "credential",
    scope: { runs: "all", workflows: "*" },
    permissions: new Set(["runs.read", "inputs.answer", "runs.control"]),
  };
  const source = async () => ({
    revision: "events",
    currentRevision: async () => "events",
    rows: (async function* () {
      yield* rows;
    })(),
  });
  const boundaryRow = vi.fn(async (_p: OperatorPageParams, row: OperatorRow): Promise<OperatorBoundaryRow> => ({
    ...row,
    revisionActionId: "changes",
    revisionState: "available",
    revision: structuredClone(f.after.revision),
  }));
  const model = new OperatorReadModel({
    target: f.params.target,
    orcaVersion: "test",
    protocol: { major: 1, minor: 0 },
    current: async () => principal,
    allowsRun: async (_p, id) => id === "run",
    collections: { inputs: source, runs: source, events: source },
    operations: () => ["operator.page"],
    boundaryRow,
    boundaryRevision: async () => revision,
    declaredRevisionActionId: async () => "changes",
    ...overrides,
  });
  return {
    model,
    boundaryRow,
    change: () => {
      revision = "boundary-2";
    },
    weak: () => {
      principal = { ...principal, permissions: new Set(["runs.read"]) };
    },
    revoke: () => {
      principal = { ...principal, permissions: new Set() };
    },
  };
}

describe("trusted bounded boundary projection", () => {
  it("preserves exact revision fields and invalidates cursors on boundary-only publication", async () => {
    const x = fixture({}, [OperatorRowSchema.parse(f.before), OperatorRowSchema.parse(f.before)]);
    const first = await x.model.page(params);
    expect(first.items).toEqual([f.after]);
    expect(first.nextCursor).toBeTruthy();
    expect((await x.model.page({ ...params, cursor: first.nextCursor })).items).toEqual([f.after]);
    x.change();
    expect(await x.model.page({ ...params, cursor: first.nextCursor })).toMatchObject({
      items: [],
      restartRequired: true,
    });
  });
  it("does not enrich unscoped runs, unrelated collections or unauthorized resources", async () => {
    const x = fixture();
    await x.model.page({ ...params, collection: "runs", runId: undefined });
    await x.model.page({ ...params, collection: "events" });
    await expect(x.model.page({ ...params, runId: "hidden" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(x.boundaryRow).not.toHaveBeenCalled();
  });
  it.each([
    { id: "changed" },
    { text: "PRIVATE" },
    { secret: "PRIVATE" },
    { revisionState: "unavailable" },
    { revision: { ...f.after.revision, target: { ...f.after.revision.target, runId: "other" } } },
    { revisionActionId: "invented" },
  ])("refuses contradictory or secret-bearing callback output: %j", async (extra) => {
    const x = fixture({
      boundaryRow: async () => ({ ...OperatorBoundaryRowSchema.parse(f.after), ...extra }) as OperatorBoundaryRow,
    });
    await expect(x.model.page(params)).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
  });
  it("does not accept a self-attested action ID or missing trusted readers", async () => {
    const x = fixture({ declaredRevisionActionId: async () => undefined });
    await expect(x.model.page(params)).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
    expect(() => fixture({ boundaryRevision: undefined } as unknown as Partial<OperatorReadOptions>)).toThrow(
      "requires pinned declaration",
    );
    expect(() => fixture({ declaredRevisionActionId: undefined } as unknown as Partial<OperatorReadOptions>)).toThrow(
      "requires pinned declaration",
    );
  });
  it("keeps weak restriction-only reads but refuses stronger disclosure and late grant loss", async () => {
    const weak = fixture({ boundaryRow: async (_p, row) => ({ ...row, revisionActionId: "changes" }) });
    weak.weak();
    expect((await weak.model.page(params)).items[0]).toEqual({ ...f.before, revisionActionId: "changes" });
    const strong = fixture();
    strong.weak();
    await expect(strong.model.page(params)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    const late = fixture({
      boundaryRevision: async () => {
        late.weak();
        return "revision";
      },
    });
    await expect(late.model.page(params)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
  it("distinguishes unsupported from unavailable and propagates unexpected source failure", async () => {
    for (const revisionState of ["unsupported", "unavailable"] as const) {
      const x = fixture({ boundaryRow: async (_p, row) => ({ ...row, revisionActionId: "changes", revisionState }) });
      expect((await x.model.page(params)).items[0]?.revisionState).toBe(revisionState);
    }
    const x = fixture({
      boundaryRow: async () => {
        throw Object.assign(new Error("store failed"), { code: "RUN_STATE" });
      },
    });
    await expect(x.model.page(params)).rejects.toMatchObject({ code: "RUN_STATE" });
  });
  it("rechecks boundaries after awaited work even if the provider revision did not change", async () => {
    let reads = 0;
    const x = fixture({
      boundaryRow: async (_p, row) => ({
        ...row,
        revisionActionId: "changes",
        revisionState: ++reads === 1 ? "unsupported" : "unavailable",
      }),
    });
    expect(await x.model.page(params)).toMatchObject({ items: [], restartRequired: true });
  });
  it("bounds enriched rows before page sizing and retains an authorized drill-down ID", async () => {
    const x = fixture({
      boundaryRow: async () => ({
        ...OperatorBoundaryRowSchema.parse(f.after),
        revision: {
          ...structuredClone(f.after.revision),
          destinationDescription: "x".repeat(20_000),
        },
      }),
    });
    expect((await x.model.page(params)).items).toEqual([
      { id: "input", kind: "decision", runId: "run", omitted: ["oversized-item"] },
    ]);
  });
  it("only emits a continuation guard through the exact authorized callback", async () => {
    const rows = [{ id: "run", kind: "run", runId: "run", expectedBoundary: "untrusted" }];
    const x = fixture(
      {
        declaredRevisionActionId: async () => undefined,
        boundaryRow: async (_p, row) => ({ ...row, continuationState: "available", expectedBoundary: "trusted" }),
      },
      rows,
    );
    expect((await x.model.page({ ...params, collection: "runs" })).items[0]).toMatchObject({
      expectedBoundary: "trusted",
      continuationState: "available",
    });
    expect((await x.model.page({ ...params, collection: "runs", runId: undefined })).items[0]).not.toHaveProperty(
      "expectedBoundary",
    );
  });
});

describe("production pending-input event projection", () => {
  async function eventsFixture() {
    const { InMemoryEventStore } = await import("@orca/store");
    const { operatorEventCollections } = await import("../src/operator-read-model.js");
    const events = new InMemoryEventStore();
    const schedule = (runId = "run", stepRunId = "step", nodeId = "gate") =>
      events.append({
        type: "step.scheduled",
        runId,
        payload: { stepRunId, nodeId, nodeType: "gate", attempt: 1 },
      });
    const ask = (runId = "run", stepRunId = "step", requestId = "input") =>
      events.append({
        type: "human.requested",
        runId,
        payload: {
          stepRunId,
          requestId,
          kind: "decision",
          question: "Same question",
          options: [{ id: "changes", label: "Request changes" }],
          context: {},
        },
      });
    const readRange = events.readRange.bind(events);
    const reads = vi.spyOn(events, "readRange");
    const collections = operatorEventCollections({ events, allowsRun: async (_p, id) => id === "run" });
    const make = (overrides: Partial<OperatorReadOptions> = {}) =>
      fixture({
        collections,
        // Represents the existing reader's mandatory identity precondition, not lifecycle evidence.
        declaredRevisionActionId: async (_p, row) => {
          if (!row.nodeId) throw Object.assign(new Error("Pinned declaration unavailable"), { code: "RUN_STATE" });
          return "changes";
        },
        ...overrides,
      });
    const plain = () => make({ boundaryRow: undefined } as unknown as Partial<OperatorReadOptions>);
    return { events, schedule, ask, reads, readRange, make, plain };
  }

  it("derives exact node identity despite identical questions in other runs and steps, using bounded reads", async () => {
    const x = await eventsFixture();
    await x.schedule("other", "step", "foreign-node");
    await x.ask("other");
    await x.schedule("run", "other-step", "other-node");
    await x.ask("run", "other-step", "other-input");
    await x.schedule();
    await x.ask();
    const result = await x.make().model.page({ ...params, stepRunId: "step" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "input",
      runId: "run",
      stepRunId: "step",
      nodeId: "gate",
      revisionActionId: "changes",
      revisionState: "available",
    });
    expect(
      x.reads.mock.calls.every(([runId, range]) => runId === "run" && range?.limit !== undefined && range.limit <= 100),
    ).toBe(true);
    const scheduledReads = x.reads.mock.calls.filter(([, range]) => range?.types?.includes("step.scheduled"));
    expect(scheduledReads.length).toBeGreaterThan(0);
    expect(scheduledReads.every(([, range]) => range?.limit === 2)).toBe(true);
  });

  it.each(["absent", "wrong-run", "wrong-step", "duplicate", "conflicting", "late", "empty-node"])(
    "leaves %s scheduled evidence unavailable to the pinned reader",
    async (kind) => {
      const x = await eventsFixture();
      if (kind === "wrong-run") await x.schedule("other");
      if (kind === "wrong-step") await x.schedule("run", "other-step");
      if (kind === "duplicate" || kind === "conflicting") {
        await x.schedule();
        await x.schedule("run", "step", kind === "duplicate" ? "gate" : "other-gate");
      }
      if (kind === "empty-node") await x.schedule("run", "step", "");
      await x.ask();
      if (kind === "late") await x.schedule();
      const result = await x.plain().model.page(params);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty("nodeId");
      expect(result.items[0]).not.toHaveProperty("revisionState");
      const enriched = x.make();
      await expect(enriched.model.page(params)).rejects.toMatchObject({ code: "RUN_STATE" });
      expect(enriched.boundaryRow).not.toHaveBeenCalled();
    },
  );

  it("checks current authority after scheduled evidence is awaited and before publishing", async () => {
    const x = await eventsFixture();
    await x.schedule();
    await x.ask();
    const model = x.make();
    const readRange = x.readRange;
    x.reads.mockImplementation(async (runId, range) => {
      const rows = await readRange(runId, range);
      if (range?.types?.includes("step.scheduled")) model.revoke();
      return rows;
    });
    await expect(model.model.page(params)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("invalidates event-backed cursors on boundary changes and on ambiguous scheduled publication", async () => {
    const x = await eventsFixture();
    await x.schedule();
    await x.ask();
    await x.ask("run", "step", "second-input");
    const model = x.make({
      boundaryRow: async (_p, row) => ({ ...row, revisionActionId: "changes", revisionState: "unavailable" }),
    });
    const first = await model.model.page(params);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[0]?.nodeId).toBe("gate");
    model.change();
    expect(await model.model.page({ ...params, cursor: first.nextCursor })).toMatchObject({
      items: [],
      restartRequired: true,
    });
    const current = await model.model.page(params);
    await x.schedule("run", "step", "conflicting-gate");
    expect(await model.model.page({ ...params, cursor: current.nextCursor })).toMatchObject({
      items: [],
      restartRequired: true,
    });
    await expect(model.model.page(params)).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("discards a page if scheduled evidence changes during its bounded scan", async () => {
    const x = await eventsFixture();
    await x.schedule();
    await x.ask();
    const model = x.make();
    const readRange = x.readRange;
    let appended = false;
    x.reads.mockImplementation(async (runId, range) => {
      const rows = await readRange(runId, range);
      if (!appended && range?.types?.includes("step.scheduled")) {
        appended = true;
        await x.schedule("run", "step", "concurrent-gate");
      }
      return rows;
    });
    expect(await model.model.page(params)).toMatchObject({ items: [], restartRequired: true });
  });
});
