/** Restart discovery remains a protected, allowlisted view of the current pinned revision. */
import { describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import { PendingRevisionViewSchema } from "../../protocol/src/revision-input.js";
import type {
  PendingRevisionTarget,
  ReplacePendingRevisionCommand,
  RevisionCapability,
  RevisionReceipt,
} from "../../core/src/model/revision-input.js";
import {
  RevisionInputService,
  RunRevisionJournal,
  type JsonValue,
  type RetryAuthority,
  type RetryClaims,
  type RevisionAccess,
  type RevisionBoundary,
  type RevisionJournal,
  type RevisionJournalEntry,
  type RevisionRecord,
} from "../src/revision-input.js";

const stale = () => new OrcaError("REVISION_STALE", "Revision target changed");
const textCapability = (): RevisionCapability => ({
  actionId: "changes",
  destinationNodeId: "build",
  composition: "replace-revision-slot",
  payload: { kind: "text", maxBytes: 128 },
});
function fixture(capability = textCapability()) {
  const initial: RevisionBoundary = {
    target: { runId: "run", stepRunId: "gate", requestId: "ask", destinationId: "dest", expectedRevision: "v0" },
    capability,
    destinationDescription: "Build agent",
    attemptId: "attempt",
    generationId: "private-generation",
    workflowRevision: "private-workflow-revision",
    status: "waiting",
  };
  const receipt: RevisionReceipt = {
    revisionId: "revision",
    target: structuredClone(initial.target),
    state: "pending",
    attemptId: initial.attemptId,
    currentRevisionId: "revision",
    expectedRevision: "v1",
  };
  const record: RevisionRecord = {
    receipt,
    capability: structuredClone(capability),
    payload:
      capability.payload.kind === "text"
        ? { kind: "text", text: "Correct the retry boundary" }
        : { kind: "values", values: { count: 2 } },
    provenance: {
      actor: { principalId: "human", credentialId: "private-credential" },
      workspaceId: "workspace",
      operationId: "private-original-operation",
      source: "human-revision",
      recordedAt: "2026-10-02T00:00:00Z",
    },
    delivery: "unclaimed",
    prompt: "private-prompt",
  };
  const entries: RevisionJournalEntry[] = [
    { kind: "boundary", boundary: initial },
    {
      kind: "commit",
      change: {
        operationId: record.provenance.operationId,
        record,
        decision: { requestId: "ask", stepRunId: "gate", answer: "changes", actor: { principalId: "human" } },
      },
    },
  ];
  const grants = { read: true, content: true, mutate: true };
  const hooks: {
    read?: (count: number) => void;
    afterRecord?: () => Promise<void>;
    afterBoundary?: () => Promise<void>;
    boundary?: (boundary: RevisionBoundary) => RevisionBoundary | undefined;
  } = {};
  let reads = 0;
  const access: RevisionAccess = {
    principalId: "human",
    workspaceId: "workspace",
    actor: async () => ({ principalId: "human" }),
    read: async (runId) => {
      hooks.read?.(++reads);
      if (!grants.read || runId !== "run") throw new OrcaError("RUN_NOT_FOUND", "Read denied");
      return { content: grants.content, mutate: grants.mutate };
    },
    mutate: async (runId) => {
      if (!grants.mutate || runId !== "run") throw new OrcaError("RUN_NOT_FOUND", "Mutation denied");
    },
  };
  const durable = new RunRevisionJournal(
    {
      withRun: async (_runId, work) => work(),
      read: async () => structuredClone(entries),
      append: async (_runId, entry) => {
        entries.push(structuredClone(entry));
      },
      status: async (_runId, boundary) => boundary.status,
    },
    stale,
  );
  const journal: RevisionJournal = {
    withRun: (runId, work) =>
      durable.withRun(runId, (tx) =>
        work({
          ...tx,
          record: async (id) => {
            const value = await tx.record(id);
            await hooks.afterRecord?.();
            return value;
          },
          boundary: async (id) => {
            const value = await tx.boundary(id);
            await hooks.afterBoundary?.();
            return value && hooks.boundary ? hooks.boundary(value) : value;
          },
        }),
      ),
  };
  let operations = 0;
  const retries: RetryClaims = {
    execute: async (operation, command, _retry, authority) => {
      await authority.authorize(command);
      const operationId = `replacement-operation-${++operations}`;
      let binding: Record<string, JsonValue> | undefined;
      const result = await operation.prepare(command, {
        operationId,
        readBinding: async () => binding,
        bind: async (value) => {
          binding = value;
        },
        reauthorize: () => authority.authorize(command),
      });
      return { state: "resolved", operationId, replayed: false, result };
    },
  };
  const service = () => new RevisionInputService({ journal, retries, access, stale });
  const target: PendingRevisionTarget = {
    runId: "run",
    revisionId: "revision",
    destinationId: "dest",
    attemptId: "attempt",
  };
  const authority: RetryAuthority<ReplacePendingRevisionCommand> = {
    principalId: "human",
    workspaceId: "workspace",
    authorize: (command) => access.mutate(command.target.runId),
  };
  return { initial, receipt, record, entries, grants, hooks, service, target, authority };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("protected pending revision boundary", () => {
  it("rediscovers only the current declared editor capability after a service restart", async () => {
    const f = fixture();
    const before = await f.service().readPending(f.target);
    const after = await f.service().readPending(f.target);
    expect(after).toEqual(before);
    expect(after).toEqual({
      target: f.target,
      expectedRevision: "v1",
      state: "pending",
      payload: f.record.payload,
      boundary: {
        target: { ...f.initial.target, expectedRevision: "v1" },
        capability: textCapability(),
        destinationDescription: "Build agent",
      },
      replacementAllowed: true,
    });
    expect(PendingRevisionViewSchema.parse(after)).toEqual(after);
    expect(JSON.stringify(after)).not.toContain("private-");
  });

  it("leaves the viewer response payload-free and boundary-free", async () => {
    const f = fixture();
    f.grants.content = f.grants.mutate = false;
    expect(await f.service().readPending(f.target)).toEqual({
      target: f.target,
      expectedRevision: "v1",
      state: "pending",
      replacementAllowed: false,
    });
  });

  it.each([1, 2, 3])("rejects denied read access at authorization check %s", async (check) => {
    const f = fixture();
    f.hooks.read = (count) => {
      if (count === check) f.grants.read = false;
    };
    await expect(f.service().readPending(f.target)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it.each(["afterRecord", "afterBoundary"] as const)("rechecks content grants when revoked during %s", async (hook) => {
    const f = fixture();
    const reading = deferred();
    const resume = deferred();
    f.hooks[hook] = async () => {
      reading.resolve();
      await resume.promise;
    };
    const pending = f.service().readPending(f.target);
    await reading.promise;
    f.grants.content = f.grants.mutate = false;
    resume.resolve();
    const view = await pending;
    expect(view).not.toHaveProperty("payload");
    expect(view).not.toHaveProperty("boundary");
    expect(view.replacementAllowed).toBe(false);
  });

  it("does not upgrade a viewer read to content access midway through the journal read", async () => {
    const f = fixture();
    f.grants.content = f.grants.mutate = false;
    f.hooks.afterBoundary = async () => {
      f.grants.content = f.grants.mutate = true;
    };
    const view = await f.service().readPending(f.target);
    expect(view).not.toHaveProperty("payload");
    expect(view).not.toHaveProperty("boundary");
    expect(view.replacementAllowed).toBe(false);
  });

  it.each(["runId", "destinationId", "attemptId", "revisionId"] as const)(
    "does not resolve an inexact pending target: %s",
    async (field) => {
      const f = fixture();
      await expect(f.service().readPending({ ...f.target, [field]: "other" })).rejects.toThrow();
    },
  );

  it.each([
    "missing",
    "runId",
    "destinationId",
    "stepRunId",
    "requestId",
    "expectedRevision",
    "attemptId",
    "currentRevisionId",
    "capability",
    "moved",
    "cancelled",
  ])("omits editor metadata when the current boundary is %s", async (mismatch) => {
    const f = fixture();
    f.hooks.boundary = (boundary) => {
      if (mismatch === "missing") return undefined;
      if (["moved", "cancelled"].includes(mismatch)) boundary.status = mismatch as "moved" | "cancelled";
      else if (mismatch === "attemptId") boundary.attemptId = "other";
      else if (mismatch === "currentRevisionId") boundary.currentRevisionId = "other";
      else if (mismatch === "capability") boundary.capability.payload.maxBytes = 127;
      else boundary.target[mismatch as keyof RevisionBoundary["target"]] = "other";
      return boundary;
    };
    const view = await f.service().readPending(f.target);
    expect(view).not.toHaveProperty("boundary");
    expect(view.replacementAllowed).toBe(false);
    expect(view.unavailableReason).toBe(mismatch === "cancelled" ? "cancelled" : "target-changed");
  });

  it.each(["delivered", "rejected", "superseded"] as const)(
    "does not expose a current editor for a %s record",
    async (state) => {
      const f = fixture();
      f.record.receipt.state = state;
      const view = await f.service().readPending(f.target);
      expect(view).not.toHaveProperty("boundary");
      expect(view.replacementAllowed).toBe(false);
    },
  );

  it.each(["claimed", "confirmed", "uncertain"] as const)(
    "omits editor metadata after delivery becomes %s",
    async (delivery) => {
      const f = fixture();
      f.record.delivery = delivery;
      const view = await f.service().readPending(f.target);
      expect(view).not.toHaveProperty("boundary");
      expect(view).toMatchObject({ replacementAllowed: false, unavailableReason: "delivery-uncertain" });
    },
  );

  it("projects declared values constraints without sensitive defaults or enum values", async () => {
    const f = fixture({
      ...textCapability(),
      payload: {
        kind: "values",
        maxBytes: 256,
        inputSchema: {
          unknown: "reject",
          fields: {
            count: { type: "integer", required: true, minimum: 1, maximum: 4 },
            secret: { type: "string", sensitive: true, default: "private-default", enum: ["private-default"] },
            nested: {
              type: "object",
              sensitive: true,
              properties: { secret: { type: "string", enum: ["private-nested-enum"] } },
            },
          },
        },
      },
    });
    const view = await f.service().readPending(f.target);
    expect(view.boundary?.capability.payload).toEqual({
      kind: "values",
      maxBytes: 256,
      inputSchema: {
        unknown: "reject",
        fields: {
          count: { type: "integer", required: true, minimum: 1, maximum: 4 },
          secret: { type: "string", sensitive: true },
          nested: { type: "object", sensitive: true, properties: { secret: { type: "string" } } },
        },
      },
    });
    expect(JSON.stringify(view)).not.toContain("private-");
    expect(PendingRevisionViewSchema.safeParse(view).success).toBe(true);
  });

  it("omits a declaration with arbitrary private schema extras instead of inventing an editor", async () => {
    const f = fixture();
    for (const capability of [f.initial.capability, f.record.capability])
      Object.assign(capability, { config: "private-config" });
    const view = await f.service().readPending(f.target);
    expect(view).not.toHaveProperty("boundary");
    expect(view.replacementAllowed).toBe(false);
    expect(JSON.stringify(view)).not.toContain("private-");
  });

  it("rejects additional wire fields at every boundary level", async () => {
    const f = fixture();
    const view = await f.service().readPending(f.target);
    const boundary = view.boundary!;
    const invalid = [
      { ...view, provenance: f.record.provenance },
      { ...view, boundary: { ...boundary, generationId: "private-generation" } },
      { ...view, boundary: { ...boundary, target: { ...boundary.target, attemptId: "private-attempt" } } },
      { ...view, boundary: { ...boundary, capability: { ...boundary.capability, secret: "private-secret" } } },
      {
        ...view,
        boundary: {
          ...boundary,
          capability: { ...boundary.capability, payload: { ...boundary.capability.payload, config: {} } },
        },
      },
      {
        ...view,
        boundary: {
          ...boundary,
          capability: {
            ...boundary.capability,
            payload: {
              kind: "values",
              maxBytes: 128,
              inputSchema: { fields: { count: { type: "integer", secret: "private-secret" } } },
            },
          },
        },
      },
    ];
    for (const candidate of invalid) expect(PendingRevisionViewSchema.safeParse(candidate).success).toBe(false);
    const { boundary: _boundary, ...legacy } = view;
    expect(PendingRevisionViewSchema.safeParse(legacy).success).toBe(true);
  });

  it("uses the freshly read CAS version for replacement and hides the superseded editor", async () => {
    const f = fixture();
    const service = f.service();
    const view = await service.readPending(f.target);
    const result = await service.replacePending(
      {
        target: view.target,
        expectedRevision: view.expectedRevision,
        payload: { kind: "text", text: "Updated correction" },
      },
      {},
      f.authority,
    );
    expect(result.state).toBe("resolved");
    const superseded = await f.service().readPending(f.target);
    expect(superseded).toMatchObject({
      state: "superseded",
      replacementAllowed: false,
      unavailableReason: "target-changed",
    });
    expect(superseded).not.toHaveProperty("boundary");
    if (result.state !== "resolved") throw new Error("Expected replacement receipt");
    const current = await f.service().readPending({ ...f.target, revisionId: result.result.revisionId });
    expect(current.replacementAllowed).toBe(true);
    expect(current.boundary?.target.expectedRevision).toBe(result.result.expectedRevision);
    await expect(
      service.replacePending(
        {
          target: view.target,
          expectedRevision: view.expectedRevision,
          payload: { kind: "text", text: "Stale correction" },
        },
        {},
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "REVISION_STALE" });
  });

  it.each(["revoked", "moved", "attempt", "delivered", "oversized"])(
    "rechecks the server boundary and grants when replacement is %s after discovery",
    async (change) => {
      const f = fixture();
      const view = await f.service().readPending(f.target);
      const before = f.entries.length;
      let text = "Updated correction";
      if (change === "revoked") f.grants.content = f.grants.mutate = false;
      if (change === "delivered") f.record.delivery = "claimed";
      if (change === "oversized") text = "x".repeat(129);
      if (change === "moved" || change === "attempt") {
        f.hooks.boundary = (boundary) => {
          if (change === "moved") boundary.status = "moved";
          else boundary.attemptId = "another-attempt";
          return boundary;
        };
      }
      await expect(
        f
          .service()
          .replacePending(
            { target: view.target, expectedRevision: view.expectedRevision, payload: { kind: "text", text } },
            {},
            f.authority,
          ),
      ).rejects.toThrow();
      expect(f.entries).toHaveLength(before);
    },
  );
});
