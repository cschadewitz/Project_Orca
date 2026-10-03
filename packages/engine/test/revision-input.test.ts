/** Shared service fixtures: one durable journal marker owns correction, supersession and branch; retry facility is a #331 fixture. */
import { describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import {
  RevisionInputService,
  createRevisionInputServices,
  revisionCanonical,
  type JsonValue,
  type RetryClaims,
  type RetryOperation,
  type RetryAuthority,
  type RetryOptions,
  type RetryResult,
  type RevisionJournal,
  type RevisionTransaction,
  type RevisionRecord,
  type RevisionBoundary,
  type RevisionCommit,
} from "../src/revision-input.js";
import { RevisionDelivery, rejectUndeliveredRevision } from "../src/revision-delivery.js";
import type { RevisionCommand, RevisionReceipt, PendingRevisionTarget } from "../../core/src/model/revision-input.js";

const stale = () => new OrcaError("RUN_STATE", "stale revision fixture"); // REVISION_STALE is in the reserved integration patch.
const boundary = (): RevisionBoundary => ({
  target: { runId: "run", stepRunId: "gate", requestId: "ask", destinationId: "dest", expectedRevision: "v0" },
  capability: {
    actionId: "changes",
    destinationNodeId: "build",
    payload: { kind: "text", maxBytes: 128 },
    composition: "replace-revision-slot",
  },
  destinationDescription: "Build agent",
  attemptId: "attempt",
  generationId: "generation",
  workflowRevision: "workflow",
  status: "waiting",
});
const command = (): RevisionCommand => ({
  target: boundary().target,
  actionId: "changes",
  payload: { kind: "text", text: "Fix the boundary check." },
});

/** Snapshots represent persisted bytes, shared across restarted service instances. No production in-memory implementation. */
class Journal implements RevisionJournal {
  state = boundary();
  records = new Map<string, RevisionRecord>();
  operations = new Map<string, RevisionReceipt>();
  history: unknown[] = [];
  answers = 0;
  fail: "before" | "after" | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  withRun<T>(runId: string, work: (tx: RevisionTransaction) => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      if (runId !== "run") throw stale();
      return work({
        boundary: async (id) => (id === "dest" ? structuredClone(this.state) : undefined),
        record: async (id) => structuredClone(this.records.get(id)),
        committed: async (id) => structuredClone(this.operations.get(id)),
        commit: async (change) => {
          if (this.fail === "before") {
            this.fail = undefined;
            throw new OrcaError("STORE_WRITE", "interrupted");
          }
          this.apply(change);
          if (this.fail === "after") {
            this.fail = undefined;
            throw new OrcaError("STORE_WRITE", "response lost");
          }
        },
        transition: async (record, version) => {
          if (this.records.get(record.receipt.revisionId)?.receipt.expectedRevision !== version) throw stale();
          this.records.set(record.receipt.revisionId, structuredClone(record));
          this.state.target.expectedRevision = record.receipt.expectedRevision;
          this.history.push(structuredClone(record));
        },
      });
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private apply(change: RevisionCommit) {
    if (change.supersedesRevisionId) {
      const old = this.records.get(change.supersedesRevisionId)!;
      this.records.set(change.supersedesRevisionId, {
        ...old,
        receipt: {
          ...old.receipt,
          state: "superseded",
          currentRevisionId: change.record.receipt.revisionId,
          expectedRevision: change.record.receipt.expectedRevision,
        },
      });
    }
    if (change.decision) {
      this.answers++;
      this.state.status = "answered";
    }
    this.records.set(change.record.receipt.revisionId, structuredClone(change.record));
    this.operations.set(change.operationId, structuredClone(change.record.receipt));
    this.state.currentRevisionId = change.record.receipt.revisionId;
    this.state.target.expectedRevision = change.record.receipt.expectedRevision;
    this.history.push(structuredClone(change));
  }
  restart(): Journal {
    const fresh = new Journal();
    const snapshot = JSON.parse(
      JSON.stringify({
        state: this.state,
        records: [...this.records],
        operations: [...this.operations],
        answers: this.answers,
        history: this.history,
      }),
    ) as {
      state: RevisionBoundary;
      records: [string, RevisionRecord][];
      operations: [string, RevisionReceipt][];
      answers: number;
      history: unknown[];
    };
    Object.assign(fresh, snapshot, { records: new Map(snapshot.records), operations: new Map(snapshot.operations) });
    return fresh;
  }
}
class Claims implements RetryClaims {
  entries = new Map<string, { command: string; binding?: Record<string, JsonValue>; result?: unknown }>();
  async execute<C, R>(
    operation: RetryOperation<C, R>,
    cmd: C,
    retry: RetryOptions,
    authority: RetryAuthority<C>,
  ): Promise<RetryResult<R>> {
    await authority.authorize(cmd);
    const canonical = JSON.stringify(operation.canonicalize(cmd));
    const id = JSON.stringify([
      authority.workspaceId,
      authority.principalId,
      operation.kind,
      retry.idempotencyKey ?? crypto.randomUUID(),
    ]);
    const found = this.entries.get(id);
    if (found && found.command !== canonical) throw new OrcaError("RUN_STATE", "retry conflict fixture");
    if (found?.result)
      return { state: "resolved", operationId: id, replayed: true, result: structuredClone(found.result) as R };
    const entry = found ?? { command: canonical };
    this.entries.set(id, entry);
    const result = await operation[found ? "recover" : "prepare"](cmd, {
      operationId: id,
      readBinding: async () => entry.binding,
      bind: async (binding) => {
        if (entry.binding && JSON.stringify(entry.binding) !== JSON.stringify(binding)) throw stale();
        entry.binding = structuredClone(binding);
      },
      reauthorize: () => authority.authorize(cmd),
    });
    entry.result = structuredClone(result);
    return { state: "resolved", operationId: id, replayed: false, result };
  }
}
function setup(journal = new Journal(), retries = new Claims()) {
  let revoked = false;
  let content = true;
  const mutate = async (runId: string) => {
    if (revoked || runId !== "run") throw new OrcaError("RUN_NOT_FOUND", "unavailable");
  };
  const access = {
    principalId: "human",
    workspaceId: "workspace",
    actor: async () => ({ principalId: "human", credentialId: "credential" }),
    mutate,
    read: async (runId: string) => {
      await mutate(runId);
      return { content, mutate: content };
    },
  };
  const service = new RevisionInputService({ journal, retries, access, stale });
  const authority = <C extends { target: { runId: string } }>(): RetryAuthority<C> => ({
    principalId: "human",
    workspaceId: "workspace",
    authorize: (cmd) => mutate(cmd.target.runId),
  });
  const delivery = new RevisionDelivery({ journal, authorize: mutate, stale });
  return {
    journal,
    retries,
    service,
    authority,
    delivery,
    revoke: () => {
      revoked = true;
    },
    hide: () => {
      content = false;
    },
  };
}
async function submit(f: ReturnType<typeof setup>, key = "intent"): Promise<RevisionReceipt> {
  const result = await f.service.submit(command(), { idempotencyKey: key }, f.authority());
  if (result.state !== "resolved") throw new Error("expected receipt");
  return result.result;
}
function target(receipt: RevisionReceipt): PendingRevisionTarget {
  return { runId: "run", revisionId: receipt.revisionId, destinationId: "dest", attemptId: receipt.attemptId };
}

describe("atomic revision service", () => {
  it("records one action and retries the same receipt with immutable author and payload", async () => {
    const f = setup();
    const first = await submit(f);
    expect(await submit(f)).toEqual(first);
    expect(f.journal.answers).toBe(1);
    expect(f.journal.records.get(first.revisionId)).toMatchObject({
      payload: command().payload,
      provenance: { actor: { principalId: "human" }, source: "human-revision" },
    });
    await expect(
      f.service.submit(
        { ...command(), payload: { kind: "text", text: "different" } },
        { idempotencyKey: "intent" },
        f.authority(),
      ),
    ).rejects.toThrow("retry conflict");
    f.revoke();
    await expect(submit(f)).rejects.toThrow("unavailable");
  });
  it.each(["before", "after"] as const)(
    "recovers %s the single commit marker without a second answer",
    async (point) => {
      const f = setup();
      f.journal.fail = point;
      await expect(submit(f)).rejects.toThrow();
      expect(f.journal.answers).toBe(point === "before" ? 0 : 1);
      const restarted = setup(f.journal.restart(), f.retries);
      const result = await submit(restarted);
      expect(restarted.journal.answers).toBe(1);
      expect(restarted.journal.records.size).toBe(1);
      expect(result.attemptId).toBe("attempt");
    },
  );
  it("replaces pending input after the gate closes, retains history and refuses a second client's stale edit", async () => {
    const f = setup();
    const original = await submit(f);
    const view = await f.service.readPending(target(original));
    expect(view.replacementAllowed).toBe(true);
    const cmd = {
      target: view.target,
      expectedRevision: view.expectedRevision,
      payload: { kind: "text" as const, text: "Updated correction" },
    };
    const results = await Promise.allSettled([
      f.service.replacePending(cmd, { idempotencyKey: "edit-a" }, f.authority()),
      f.service.replacePending(cmd, { idempotencyKey: "edit-b" }, f.authority()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.journal.answers).toBe(1);
    expect(f.journal.records.size).toBe(2);
    expect(await f.service.readPending(target(original))).toMatchObject({
      state: "superseded",
      replacementAllowed: false,
      payload: command().payload,
    });
  });
  it("validates the payload and exact source before any claim binding or gate effects", async () => {
    const f = setup();
    for (const bad of [
      { ...command(), note: "not a correction" },
      { ...command(), payload: { kind: "text" as const, text: "x".repeat(65537) } },
    ])
      await expect(f.service.submit(bad, {}, f.authority())).rejects.toThrow();
    expect(f.retries.entries.size).toBe(0);
    for (const field of ["runId", "stepRunId", "requestId", "expectedRevision"]) {
      await expect(
        f.service.submit({ ...command(), target: { ...command().target, [field]: "wrong" } }, {}, f.authority()),
      ).rejects.toThrow();
    }
    await expect(
      f.service.submit(command(), {}, { ...f.authority<RevisionCommand>(), principalId: "other" }),
    ).rejects.toThrow();
    expect(f.journal.answers).toBe(0);
  });
  it("validates values using workflow schema and applies defaults only inside the revision slot", async () => {
    const f = setup();
    f.journal.state.capability.payload = {
      kind: "values",
      maxBytes: 100,
      inputSchema: {
        unknown: "reject",
        fields: { count: { type: "integer", required: true, minimum: 1 }, mode: { type: "string", default: "safe" } },
      },
    };
    await expect(
      f.service.submit({ ...command(), payload: { kind: "values", values: { count: "1" } } }, {}, f.authority()),
    ).rejects.toThrow("Invalid");
    const result = await f.service.submit(
      { ...command(), payload: { kind: "values", values: { count: 1 } } },
      {},
      f.authority(),
    );
    if (result.state !== "resolved") throw new Error();
    expect(f.journal.records.get(result.result.revisionId)?.payload).toEqual({
      kind: "values",
      values: { count: 1, mode: "safe" },
    });
  });
  it("omits protected content independently of replacement state", async () => {
    const f = setup();
    const receipt = await submit(f);
    f.hide();
    expect(await f.service.readPending(target(receipt))).toEqual({
      target: target(receipt),
      expectedRevision: receipt.expectedRevision,
      state: "pending",
      replacementAllowed: false,
    });
  });
});
describe("intended attempt delivery", () => {
  it("assembles one slot, persists the prompt, and refuses replacement and repeat claim", async () => {
    const f = setup();
    const receipt = await submit(f);
    const t = { ...target(receipt), nodeId: "build" };
    const handoff = await f.delivery.claim(t, async (slot) => {
      expect(slot.provenance.actor.principalId).toBe("human");
      return "Base instructions";
    });
    expect(handoff.prompt.split("Fix the boundary check.")).toHaveLength(2);
    expect(await f.service.readPending(t)).toMatchObject({
      state: "pending",
      unavailableReason: "delivery-uncertain",
      replacementAllowed: false,
    });
    await expect(
      f.service.replacePending(
        { target: target(receipt), expectedRevision: receipt.expectedRevision, payload: command().payload },
        {},
        f.authority(),
      ),
    ).rejects.toThrow();
    await expect(f.delivery.claim(t, async () => "again")).rejects.toThrow();
    await f.delivery.confirm(handoff);
    await f.delivery.confirm(handoff);
    expect(await f.service.readPending(t)).toMatchObject({ state: "delivered", unavailableReason: "delivered" });
  });
  it("replacement winning the race prevents dispatch of the superseded payload", async () => {
    const f = setup();
    const receipt = await submit(f);
    await f.service.replacePending(
      { target: target(receipt), expectedRevision: receipt.expectedRevision, payload: { kind: "text", text: "new" } },
      {},
      f.authority(),
    );
    await expect(f.delivery.claim({ ...target(receipt), nodeId: "build" }, async () => "base")).rejects.toThrow();
  });
  it("restart after claim remains visibly pending and never silently resends", async () => {
    const f = setup();
    const receipt = await submit(f);
    const t = { ...target(receipt), nodeId: "build" };
    await f.delivery.claim(t, async () => "base");
    const restarted = setup(f.journal.restart());
    expect(await restarted.service.readPending(t)).toMatchObject({
      state: "pending",
      unavailableReason: "delivery-uncertain",
    });
    await expect(restarted.delivery.claim(t, async () => "base")).rejects.toThrow();
  });
  it("wrong attempt/node, cancellation and moved targets cannot dispatch", async () => {
    const f = setup();
    const receipt = await submit(f);
    for (const patch of [{ attemptId: "other" }, { nodeId: "other" }, { runId: "other" }])
      await expect(
        f.delivery.claim({ ...target(receipt), nodeId: "build", ...patch }, async () => "base"),
      ).rejects.toThrow();
    f.journal.state.status = "cancelled";
    f.journal.records.set(receipt.revisionId, rejectUndeliveredRevision(f.journal.records.get(receipt.revisionId)!));
    expect(await f.service.readPending(target(receipt))).toMatchObject({
      state: "rejected",
      unavailableReason: "cancelled",
    });
    await expect(f.delivery.claim({ ...target(receipt), nodeId: "build" }, async () => "base")).rejects.toThrow();
  });
  it("keeps values out of unrelated prompt text and leaves no global vars mutation", async () => {
    const f = setup();
    f.journal.state.capability.payload = {
      kind: "values",
      maxBytes: 100,
      inputSchema: { fields: { n: { type: "integer" } }, unknown: "reject" },
    };
    const result = await f.service.submit(
      { ...command(), payload: { kind: "values", values: { n: 2 } } },
      {},
      f.authority(),
    );
    if (result.state !== "resolved") throw new Error();
    const handoff = await f.delivery.claim({ ...target(result.result), nodeId: "build" }, async (slot) => {
      expect(slot.payload).toEqual({ kind: "values", values: { n: 2 } });
      return "Unchanged";
    });
    expect(handoff.prompt).toBe("Unchanged");
  });
});
it("normalizes only JSON maps, preserving arrays, Unicode and guards", () => {
  expect(revisionCanonical({ z: 1, a: ["é", "é"] })).toEqual({ a: ["é", "é"], z: 1 });
  for (const value of [NaN, undefined, new Date(), { x: () => 1 }]) expect(() => revisionCanonical(value)).toThrow();
});

it("cancellation after a handoff claim does not imply that uncertain input was never delivered", async () => {
  const f = setup();
  const receipt = await submit(f);
  const t = { ...target(receipt), nodeId: "build" };
  const handoff = await f.delivery.claim(t, async () => "base");
  f.journal.state.status = "cancelled";
  expect(await f.service.readPending(t)).toMatchObject({ state: "pending", unavailableReason: "delivery-uncertain" });
  await expect(f.delivery.beforeSend(handoff)).rejects.toThrow();
});
it("registers stable operation objects while keeping concurrent caller scopes separate", async () => {
  const journal = new Journal();
  const retries = new Claims();
  const runtime = createRevisionInputServices({ journal, retries, stale });
  const forPrincipal = (principalId: string) => {
    const access = {
      principalId,
      workspaceId: "workspace",
      actor: async () => ({ principalId }),
      read: async () => ({ content: true, mutate: true }),
      mutate: async () => undefined,
    };
    return {
      service: runtime.forAccess(access),
      authority: { principalId, workspaceId: "workspace", authorize: async () => undefined },
    };
  };
  const alice = forPrincipal("alice"),
    bob = forPrincipal("bob");
  const results = await Promise.allSettled([
    alice.service.submit(command(), { idempotencyKey: "same" }, alice.authority),
    bob.service.submit(command(), { idempotencyKey: "same" }, bob.authority),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect([...journal.records.values()][0]?.provenance.actor.principalId).toBe("alice");
  expect(runtime.operations.map((operation) => operation.kind)).toEqual(["revision.submit", "revision.replace"]);
});

it.each(["delivery", "replacement"] as const)(
  "serializes concurrent replacement and delivery when %s wins",
  async (first) => {
    const f = setup();
    const receipt = await submit(f);
    const t = { ...target(receipt), nodeId: "build" };
    const delivery = () => f.delivery.claim(t, async () => "base");
    const replacement = () =>
      f.service.replacePending(
        {
          target: target(receipt),
          expectedRevision: receipt.expectedRevision,
          payload: { kind: "text", text: "Updated" },
        },
        {},
        f.authority(),
      );
    // Enter both callers without awaiting either. Authorizing replacement has additional
    // awaits, so synchronize the calls at the shared run fence to exercise both orders.
    const queued: (() => void)[] = [];
    const original = f.journal.withRun.bind(f.journal);
    f.journal.withRun = (runId, work) =>
      new Promise((resolve, reject) => {
        queued.push(() => {
          void original(runId, work).then(resolve, reject);
        });
        if (queued.length === 2) {
          const order = first === "delivery" ? queued : [...queued].reverse();
          for (const invoke of order) invoke();
        }
      });
    const outcomes = await Promise.allSettled([delivery(), replacement()]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      first === "delivery" ? ["fulfilled", "rejected"] : ["rejected", "fulfilled"],
    );
    expect(f.journal.answers).toBe(1);
  },
);
it("reauthorizes after prompt assembly before committing the handoff", async () => {
  const f = setup();
  const receipt = await submit(f);
  await expect(
    f.delivery.claim({ ...target(receipt), nodeId: "build" }, async () => {
      f.revoke();
      return "base";
    }),
  ).rejects.toThrow("unavailable");
  expect(f.journal.records.get(receipt.revisionId)?.delivery).toBe("unclaimed");
});
