/** Cached retry records are projections: acceptance still requires the protected run journal's marker. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow, reduceRun, silentLogger, systemClock } from "@orca/core";
import { executionEvents, fileStores } from "@orca/store";
import type { RetryContext, RetryRecord } from "../../core/src/model/admission-retry.js";
import type { RevisionCommand, RevisionReceipt } from "../../core/src/model/revision-input.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import {
  RevisionInputService,
  createRevisionInputServices,
  registerRevisionInputOperation,
} from "../src/revision-input.js";
import { createRevisionRuntime } from "../src/revision-runtime.js";
import { RunContext } from "../src/run-context.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};
const uncertain = { code: "RUN_STATE", details: { reason: "revision-publication-uncertain" } };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-receipt-"));
  dirs.push(dir);
  const stores = fileStores(dir);
  const definition = parseWorkflow(`
id: revise
name: Revise
version: '1'
start: gate
nodes:
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: agent
      payload: {kind: text, maxBytes: 1024}
      composition: replace-revision-slot
  agent: {type: agent, agent: worker, prompt: Original}
  end: {type: end}
edges:
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`);
  await stores.events.append({
    runId: "run",
    type: "run.created",
    payload: {
      workflowId: definition.id,
      workflowVersion: definition.version,
      vars: {},
      workspace: { hostId: "local", cwd: dir },
      provenance: {
        configGeneration: "generation",
        workflow: { id: definition.id, version: definition.version, revision: "workflow-revision" },
        inputs: [],
        selections: [],
      },
    },
  });
  await stores.events.append({ runId: "run", type: "run.started", payload: {} });
  const rc = await RunContext.load("run", definition, {
    stores,
    clock: systemClock,
    logger: silentLogger,
    loadState: async (runId) => reduceRun(await executionEvents(await stores.events.read(runId), stores.execution)),
  });
  rc.lease = await stores.leases.acquire({ resource: "run:run", holder: randomUUID() });
  await rc.emit({
    type: "step.scheduled",
    payload: { stepRunId: "gate-step", nodeId: "gate", nodeType: "gate", attempt: 1 },
  });
  await rc.emit({ type: "step.started", payload: { stepRunId: "gate-step" } });
  const query = {
    runId: "run",
    stepRunId: "gate-step",
    requestId: "ask",
    kind: "decision" as const,
    question: "Continue?",
    options: [
      { id: "changes", label: "Changes" },
      { id: "done", label: "Done" },
    ],
    context: {},
  };
  await rc.emit({ type: "human.requested", payload: query });
  const eventPath = join(dir, "runs", "run.jsonl");
  const beforeBoundary = await readFile(eventPath, "utf8");
  const runtime = createRevisionRuntime({ stores, authorizeExecution: async () => undefined });
  await runtime.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(query);
  await stores.leases.release(rc.lease);
  const boundary = (await runtime.readBoundaries("run"))[0]!;
  const beforeCommit = await readFile(eventPath, "utf8");
  const claimStore = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
  const claims = new RegisteredRetryClaims(claimStore, faults);
  const authorize = vi.fn(async (_command: unknown) => undefined);
  const mutate = vi.fn(async (_runId: string) => undefined);
  const authority = { principalId: "user", workspaceId: "workspace", authorize };
  const service = new RevisionInputService({
    journal: runtime.journal,
    retries: claims,
    stale: () => new OrcaError("REVISION_STALE", "stale"),
    access: {
      principalId: "user",
      workspaceId: "workspace",
      actor: async () => ({ principalId: "user" }),
      read: async () => ({ content: true, mutate: true }),
      mutate,
    },
  });
  const prepare = vi.fn(service.submitOperation.prepare.bind(service.submitOperation));
  const recover = vi.fn(service.submitOperation.recover.bind(service.submitOperation));
  const prepareReplacement = vi.fn(service.replaceOperation.prepare.bind(service.replaceOperation));
  const recoverReplacement = vi.fn(service.replaceOperation.recover.bind(service.replaceOperation));
  service.submitOperation.prepare = prepare;
  service.submitOperation.recover = recover;
  service.replaceOperation.prepare = prepareReplacement;
  service.replaceOperation.recover = recoverReplacement;
  const registeredAuthorize = (command: { target: { runId: string } }) => mutate(command.target.runId);
  registerRevisionInputOperation(claims, service.submitOperation, runtime.journal, registeredAuthorize);
  registerRevisionInputOperation(claims, service.replaceOperation, runtime.journal, registeredAuthorize);
  const command: RevisionCommand = {
    target: boundary.target,
    actionId: "changes",
    payload: { kind: "text", text: "PRIVATE CORRECTION" },
  };
  const submit = async () => {
    const response = await service.submit(command, { idempotencyKey: "submit" }, authority);
    if (response.state !== "resolved") throw new Error("expected resolved receipt");
    return response;
  };
  const replacement = (receipt: RevisionReceipt) => ({
    target: {
      runId: receipt.target.runId,
      destinationId: receipt.target.destinationId,
      attemptId: receipt.attemptId,
      revisionId: receipt.revisionId,
    },
    expectedRevision: receipt.expectedRevision,
    payload: { kind: "text" as const, text: "REPLACEMENT CORRECTION" },
  });
  const sideEffects = () => ({
    append: vi.spyOn(stores.events, "appendDurableUnique"),
    writeClaim: vi.spyOn(claimStore, "write"),
    prepare: prepare.mockClear(),
    recover: recover.mockClear(),
    prepareReplacement: prepareReplacement.mockClear(),
    recoverReplacement: recoverReplacement.mockClear(),
  });
  return {
    dir,
    stores,
    runtime,
    claimStore,
    claims,
    service,
    authority,
    authorize,
    mutate,
    command,
    eventPath,
    beforeBoundary,
    beforeCommit,
    submit,
    replacement,
    prepare,
    recover,
    sideEffects,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const modes = ["inspect", "replay", "reconcile"] as const;
function retry(f: Fixture, operationId: string, mode: (typeof modes)[number]) {
  return mode === "replay" ? f.submit() : f.claims[mode](operationId, f.authority);
}
function noEffects(effects: ReturnType<Fixture["sideEffects"]>) {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
}

describe("authoritative cached revision receipts", () => {
  it("reauthenticates and synchronizes accepted inspection and replay without running the operation", async () => {
    const f = await fixture();
    const first = await f.submit();
    const before = await readFile(f.eventPath, "utf8");
    const effects = f.sideEffects();
    const sync = vi.spyOn(f.stores.events, "synchronizeJournal");
    f.mutate.mockClear();
    for (const mode of ["inspect", "replay"] as const) {
      expect(await retry(f, first.operationId, mode)).toEqual({ ...first, replayed: true });
    }
    expect(sync).toHaveBeenCalled();
    expect(f.mutate).toHaveBeenCalledWith("run");
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(before);
    expect(before).not.toContain("PRIVATE CORRECTION");
  });

  it.each(modes)("refuses %s if the commit marker was rewound, without recovering or republishing", async (mode) => {
    const f = await fixture();
    const first = await f.submit();
    await writeFile(f.eventPath, f.beforeCommit);
    const effects = f.sideEffects();
    await expect(retry(f, first.operationId, mode)).rejects.toMatchObject(uncertain);
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(f.beforeCommit);
    expect((await f.claimStore.read(first.operationId))?.phase).toBe("accepted");
  });

  it.each(modes)("refuses %s if all authoritative revision markers are missing", async (mode) => {
    const f = await fixture();
    const first = await f.submit();
    await writeFile(f.eventPath, f.beforeBoundary);
    const effects = f.sideEffects();
    await expect(retry(f, first.operationId, mode)).rejects.toMatchObject(uncertain);
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(f.beforeBoundary);
  });

  it.each(modes)("propagates journal synchronization failure from cached %s without effects", async (mode) => {
    const f = await fixture();
    const first = await f.submit();
    const effects = f.sideEffects();
    vi.spyOn(f.stores.events, "synchronizeJournal").mockRejectedValueOnce(new OrcaError("STORE_WRITE", "sync failed"));
    await expect(retry(f, first.operationId, mode)).rejects.toThrow("sync failed");
    noEffects(effects);
  });

  it.each(modes)("checks current authority and resource access before cached %s touches the journal", async (mode) => {
    const f = await fixture();
    const first = await f.submit();
    const journal = vi.spyOn(f.runtime.journal, "withRun");
    const effects = f.sideEffects();
    f.authorize.mockRejectedValueOnce(new OrcaError("RUN_STATE", "authority revoked"));
    await expect(retry(f, first.operationId, mode)).rejects.toThrow("authority revoked");
    f.mutate.mockRejectedValueOnce(new OrcaError("RUN_STATE", "resource revoked"));
    await expect(retry(f, first.operationId, mode)).rejects.toThrow("resource revoked");
    expect(journal).not.toHaveBeenCalled();
    noEffects(effects);
  });

  it("rechecks resource access after acquiring the journal fence", async () => {
    const f = await fixture();
    const first = await f.submit();
    const withRun = f.runtime.journal.withRun.bind(f.runtime.journal);
    vi.spyOn(f.runtime.journal, "withRun").mockImplementationOnce((runId, work) => {
      f.mutate.mockRejectedValue(new OrcaError("RUN_STATE", "revoked while waiting"));
      return withRun(runId, work);
    });
    const effects = f.sideEffects();
    await expect(f.claims.inspect(first.operationId, f.authority)).rejects.toThrow("revoked while waiting");
    noEffects(effects);
  });

  it.each([
    [
      "receipt identity",
      (record: RetryRecord) => {
        (record.result as { revisionId: string }).revisionId = "other";
      },
    ],
    [
      "receipt state",
      (record: RetryRecord) => {
        (record.result as { state: string }).state = "delivered";
      },
    ],
    [
      "receipt target",
      (record: RetryRecord) => {
        (record.result as { target: { runId: string } }).target.runId = "other";
      },
    ],
    [
      "missing receipt",
      (record: RetryRecord) => {
        delete record.result;
      },
    ],
    [
      "binding identity",
      (record: RetryRecord) => {
        record.binding!.revisionId = "other";
      },
    ],
    [
      "binding attempt",
      (record: RetryRecord) => {
        record.binding!.attemptId = "other";
      },
    ],
    [
      "missing binding",
      (record: RetryRecord) => {
        delete record.binding;
      },
    ],
  ] as const)("refuses a mismatched %s in the accepted claim", async (_label, corrupt) => {
    const f = await fixture();
    const first = await f.submit();
    const record = (await f.claimStore.read(first.operationId))!;
    corrupt(record);
    // The normal claim-store CAS already prevents a binding rewrite. Inject a stale
    // authenticated projection at its read seam to exercise the additional verifier.
    vi.spyOn(f.claimStore, "read").mockImplementation(async () => structuredClone(record));
    const before = await readFile(f.eventPath, "utf8");
    const effects = f.sideEffects();
    for (const mode of modes) await expect(retry(f, first.operationId, mode)).rejects.toMatchObject(uncertain);
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(before);
  });

  it("verifies an accepted claim after both the runtime and retry service restart", async () => {
    const f = await fixture();
    const first = await f.submit();
    const stores = fileStores(f.dir);
    const runtime = createRevisionRuntime({ stores, authorizeExecution: async () => undefined });
    const claims = new RegisteredRetryClaims(
      new FileRetryClaimStore({ storeDir: f.dir, execution: stores.execution, faults }),
      faults,
    );
    registerRevisionInputOperation(claims, { ...f.service.submitOperation }, runtime.journal, f.authorize);
    expect(await claims.inspect(first.operationId, f.authority)).toEqual({ ...first, replayed: true });
    await writeFile(f.eventPath, f.beforeCommit);
    await expect(claims.inspect(first.operationId, f.authority)).rejects.toMatchObject(uncertain);
    expect(await readFile(f.eventPath, "utf8")).toBe(f.beforeCommit);
  });

  it("registers factory operations with live request scope and refuses unscoped receipt lookup", async () => {
    const f = await fixture();
    const first = await f.submit();
    const claims = new RegisteredRetryClaims(f.claimStore, faults);
    const factory = createRevisionInputServices({
      journal: f.runtime.journal,
      retries: claims,
      stale: () => new OrcaError("REVISION_STALE", "stale"),
    });
    factory.register(claims);
    const service = factory.forAccess({
      principalId: "user",
      workspaceId: "workspace",
      actor: async () => ({ principalId: "user" }),
      read: async () => ({ content: true, mutate: true }),
      mutate: f.mutate,
    });
    expect(await service.submit(f.command, { idempotencyKey: "submit" }, f.authority)).toEqual({
      ...first,
      replayed: true,
    });
    await expect(claims.inspect(first.operationId, f.authority)).rejects.toThrow("no authenticated scope");
    f.mutate.mockRejectedValue(new OrcaError("RUN_STATE", "resource revoked"));
    await expect(service.submit(f.command, { idempotencyKey: "submit" }, f.authority)).rejects.toThrow(
      "resource revoked",
    );
  });

  it("continues explicit recovery for a valid accepted revision without another marker", async () => {
    const f = await fixture();
    const first = await f.submit();
    const before = await readFile(f.eventPath, "utf8");
    expect(await f.claims.reconcile(first.operationId, f.authority)).toEqual({ ...first, replayed: true });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(await readFile(f.eventPath, "utf8")).toBe(before);
  });

  it("preserves cached and explicit recovery behavior for registrations without a verifier", async () => {
    const f = await fixture();
    const prepare = vi.fn(async (_command: unknown, context: RetryContext) => {
      await context.bind({ id: "continued" });
      return { id: "continued" };
    });
    const recover = vi.fn(async () => ({ id: "continued" }));
    const operation = f.claims.register({
      kind: "run.continue",
      canonicalize: () => ({ input: "continue" }),
      prepare,
      recover,
    });
    const result = await f.claims.execute(operation, {}, { idempotencyKey: "continue" }, f.authority);
    expect(await f.claims.inspect(result.operationId, f.authority)).toEqual({ ...result, replayed: true });
    expect(await f.claims.execute(operation, {}, { idempotencyKey: "continue" }, f.authority)).toEqual({
      ...result,
      replayed: true,
    });
    expect(recover).not.toHaveBeenCalled();
    expect(await f.claims.reconcile(result.operationId, f.authority)).toEqual({ ...result, replayed: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("preserves original accepted receipts after replacement and verifies replacement retries too", async () => {
    const f = await fixture();
    const first = await f.submit();
    const command = f.replacement(first.result);
    const replace = () => f.service.replacePending(command, { idempotencyKey: "replace" }, f.authority);
    const second = await replace();
    expect(second.state).toBe("resolved");
    const before = await readFile(f.eventPath, "utf8");
    const effects = f.sideEffects();
    expect(await f.submit()).toEqual({ ...first, replayed: true });
    expect(await f.claims.inspect(first.operationId, f.authority)).toEqual({ ...first, replayed: true });
    expect(await replace()).toEqual({ ...second, replayed: true });
    expect(await f.claims.inspect(second.operationId, f.authority)).toEqual({ ...second, replayed: true });
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(before);
    const withoutReplacement = before.trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
    await writeFile(f.eventPath, withoutReplacement);
    await expect(replace()).rejects.toMatchObject(uncertain);
    await expect(f.claims.inspect(second.operationId, f.authority)).rejects.toMatchObject(uncertain);
    await expect(f.claims.reconcile(second.operationId, f.authority)).rejects.toMatchObject(uncertain);
    noEffects(effects);
    expect(await readFile(f.eventPath, "utf8")).toBe(withoutReplacement);
  });

  it.each(["bound", "marker", "accepted"] as const)(
    "recovers acknowledgement loss after %s exactly once",
    async (point) => {
      const f = await fixture();
      if (point === "marker") {
        const append = f.stores.events.appendDurableUnique!.bind(f.stores.events);
        vi.spyOn(f.stores.events, "appendDurableUnique").mockImplementationOnce(async (...args) => {
          await append(...args);
          throw new Error("acknowledgement lost");
        });
      } else {
        const write = f.claimStore.write.bind(f.claimStore);
        let failed = false;
        vi.spyOn(f.claimStore, "write").mockImplementation(async (record) => {
          await write(record);
          if (!failed && record.phase === point) {
            failed = true;
            throw new Error("acknowledgement lost");
          }
        });
      }
      await expect(f.submit()).rejects.toThrow("acknowledgement lost");
      const operationId = (await f.claimStore.batch())[0]!;
      const beforeInspection = await readFile(f.eventPath, "utf8");
      const inspected = await f.claims.inspect(operationId, f.authority);
      expect(inspected.state).toBe(point === "accepted" ? "resolved" : "in-progress");
      expect(await readFile(f.eventPath, "utf8")).toBe(beforeInspection);
      expect(f.recover).not.toHaveBeenCalled();
      const response = await f.submit();
      expect(response).toMatchObject({ state: "resolved", operationId, replayed: true });
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.recover).toHaveBeenCalledTimes(point === "accepted" ? 0 : 1);
      const events = await f.stores.events.read("run");
      expect(events.filter((event) => event.type === "revision.recorded" && event.payload.decision)).toHaveLength(1);
    },
  );
});
