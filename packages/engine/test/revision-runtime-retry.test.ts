/** New revision intents acquire real run ownership before creating durable retry claims. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow, reduceRun, silentLogger, systemClock } from "@orca/core";
import { executionEvents, fileStores } from "@orca/store";
import type { RetryOperation } from "../../core/src/model/admission-retry.js";
import type { RevisionCommand, RevisionReceipt } from "../../core/src/model/revision-input.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import { RevisionInputService, registerRevisionInputOperation, type RetryClaims } from "../src/revision-input.js";
import { createRevisionRuntime } from "../src/revision-runtime.js";
import { RunContext } from "../src/run-context.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};
const stale = () => new OrcaError("REVISION_STALE", "stale");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pendingTarget = (receipt: RevisionReceipt) => ({
  runId: receipt.target.runId,
  destinationId: receipt.target.destinationId,
  attemptId: receipt.attemptId,
  revisionId: receipt.revisionId,
});
const replacement = (receipt: RevisionReceipt) => ({
  target: pendingTarget(receipt),
  expectedRevision: receipt.expectedRevision,
  payload: { kind: "text" as const, text: "REPLACEMENT" },
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-revision-retry-fence-"));
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
  const runtime = createRevisionRuntime({ stores, authorizeExecution: async () => undefined });
  await runtime.runtime.forStep(rc, rc.state.steps["gate-step"]!).declareRevision!(query);
  await stores.leases.release(rc.lease);
  const boundary = (await runtime.readBoundaries("run"))[0]!;
  const claimStore = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
  const claims = new RegisteredRetryClaims(claimStore, faults);
  const authorize = vi.fn(async (_command: unknown) => undefined);
  const authority = { principalId: "user", workspaceId: "workspace", authorize };
  const service = new RevisionInputService({
    journal: runtime.journal,
    retries: runtime.fenceRetries(claims),
    stale,
    access: {
      principalId: "user",
      workspaceId: "workspace",
      actor: async () => ({ principalId: "user" }),
      read: async () => ({ content: true, mutate: true }),
      mutate: async () => undefined,
    },
  });
  const prepare = vi.fn(service.submitOperation.prepare.bind(service.submitOperation));
  const recover = vi.fn(service.submitOperation.recover.bind(service.submitOperation));
  service.submitOperation.prepare = prepare;
  service.submitOperation.recover = recover;
  registerRevisionInputOperation(claims, service.submitOperation, runtime.journal);
  registerRevisionInputOperation(claims, service.replaceOperation, runtime.journal);
  const command: RevisionCommand = {
    target: boundary.target,
    actionId: "changes",
    payload: { kind: "text", text: "PRIVATE CORRECTION" },
  };
  const submit = (key = "submit") => service.submit(command, { idempotencyKey: key }, authority);
  const commits = async () =>
    (await stores.events.readTypes("run", ["revision.recorded"])).filter(
      (event) => event.type === "revision.recorded" && event.payload.revisionId !== undefined,
    );
  return {
    dir,
    stores,
    runtime,
    claimStore,
    claims,
    service,
    authority,
    authorize,
    command,
    submit,
    prepare,
    recover,
    commits,
  };
}

/** The actual protected read has finished; only its final lease release is paused. */
async function holdRead(f: Awaited<ReturnType<typeof fixture>>, read: () => Promise<unknown>) {
  const entered = deferred();
  const proceed = deferred();
  const release = f.stores.leases.release.bind(f.stores.leases);
  vi.spyOn(f.stores.leases, "release").mockImplementationOnce(async (lease) => {
    expect(await f.stores.leases.get("run:run")).toEqual(lease);
    entered.resolve();
    await proceed.promise;
    await release(lease);
  });
  const reading = read();
  await entered.promise;
  return async () => {
    proceed.resolve();
    await reading;
  };
}

describe("revision retry run fence", () => {
  it("refuses submission during an actual protected boundary read without consuming its key", async () => {
    const f = await fixture();
    const claim = vi.spyOn(f.claimStore, "claim");
    const release = await holdRead(f, () => f.runtime.readBoundaries("run"));
    try {
      await expect(f.submit()).rejects.toMatchObject({ code: "RUN_LEASED" });
      expect(claim).not.toHaveBeenCalled();
      expect(await f.claimStore.batch()).toEqual([]);
      expect(await f.commits()).toHaveLength(0);
    } finally {
      await release();
    }
    const first = await f.submit();
    expect(first).toMatchObject({ state: "resolved", replayed: false });
    expect(await f.submit()).toEqual({ ...first, replayed: true });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.recover).not.toHaveBeenCalled();
    expect(await f.commits()).toHaveLength(1);
  });

  it.each(["readBoundaries", "readPending"] as const)(
    "refuses replacement during %s without consuming its key, then commits once",
    async (readMethod) => {
      const f = await fixture();
      const first = await f.submit();
      if (first.state !== "resolved") throw new Error("expected first receipt");
      const command = replacement(first.result);
      const claim = vi.spyOn(f.claimStore, "claim");
      const release = await holdRead(f, () =>
        readMethod === "readBoundaries" ? f.runtime.readBoundaries("run") : f.service.readPending(command.target),
      );
      const replace = () => f.service.replacePending(command, { idempotencyKey: "replace" }, f.authority);
      try {
        await expect(replace()).rejects.toMatchObject({ code: "RUN_LEASED" });
        expect(claim).not.toHaveBeenCalled();
        expect(await f.claimStore.batch()).toEqual([first.operationId]);
        expect(await f.commits()).toHaveLength(1);
      } finally {
        await release();
      }
      const second = await replace();
      expect(second).toMatchObject({ state: "resolved", replayed: false });
      expect(await replace()).toEqual({ ...second, replayed: true });
      expect(await f.commits()).toHaveLength(2);
      expect(reduceRun(await f.stores.events.read("run")).humanInputs.ask?.answer).toBe("changes");
    },
  );

  it("rechecks current authority under actual ownership before calling the shared registry", async () => {
    const f = await fixture();
    let authorized = true;
    f.authorize.mockImplementation(async () => {
      if (!authorized) {
        expect(await f.stores.leases.get("run:run")).toBeDefined();
        throw new OrcaError("RUN_STATE", "authority revoked");
      }
    });
    const acquire = f.stores.leases.acquire.bind(f.stores.leases);
    vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (request) => {
      const lease = await acquire(request);
      authorized = false;
      return lease;
    });
    const execute = vi.spyOn(f.claims, "execute");
    const claim = vi.spyOn(f.claimStore, "claim");
    await expect(f.submit()).rejects.toThrow("authority revoked");
    expect(execute).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(await f.stores.leases.get("run:run")).toBeUndefined();
    authorized = true;
    expect(await f.submit()).toMatchObject({ state: "resolved", replayed: false });
  });

  it("rejects malformed commands and nonrevision operations before taking a lease or creating a claim", async () => {
    const f = await fixture();
    const acquire = vi.spyOn(f.stores.leases, "acquire");
    const claim = vi.spyOn(f.claimStore, "claim");
    const adapter = f.runtime.fenceRetries(f.claims);
    const nonrevision: RetryOperation<RevisionCommand, RevisionReceipt> = {
      ...f.service.submitOperation,
      kind: "run.admit",
    };
    await expect(
      adapter.execute(
        nonrevision as Parameters<RetryClaims["execute"]>[0],
        f.command,
        { idempotencyKey: "other" },
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(
      adapter.execute(
        f.service.submitOperation,
        { ...f.command, target: { ...f.command.target, runId: "" } },
        {},
        f.authority,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(acquire).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("preserves old unbound ambiguity without rebinding, preparing, recovering or committing", async () => {
    const f = await fixture();
    const legacy = await f.claimStore.claim(
      { principalId: "user", workspaceId: "workspace", kind: "revision.submit" },
      "submit",
      f.service.submitOperation.canonicalize(f.command),
      JSON.stringify(f.service.submitOperation.canonicalize(f.command)),
    );
    const before = await f.claimStore.read(legacy.record.operationId);
    const write = vi.spyOn(f.claimStore, "write");
    const pending = { state: "in-progress", operationId: legacy.record.operationId, recovery: "inspect-or-retry" };
    expect(await f.submit()).toEqual(pending);
    expect(await f.claims.reconcile(legacy.record.operationId, f.authority)).toEqual(pending);
    expect(await f.claimStore.read(legacy.record.operationId)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
    expect(await f.commits()).toHaveLength(0);
  });

  it.each(["stale-submit", "stale-replace", "missing-boundary", "capability-payload"] as const)(
    "characterizes the remaining new-key %s prebinding refusal without automatic recovery",
    async (failure) => {
      const f = await fixture();
      const first = await f.submit();
      if (first.state !== "resolved") throw new Error("expected first receipt");
      const command = replacement(first.result);
      const key = "new-rejected-key";
      const invoke = () =>
        failure === "stale-submit"
          ? f.service.submit(f.command, { idempotencyKey: key }, f.authority)
          : f.service.replacePending(
              {
                ...command,
                ...(failure === "stale-replace" ? { expectedRevision: "outdated" } : {}),
                ...(failure === "missing-boundary" ? { target: { ...command.target, destinationId: "missing" } } : {}),
                ...(failure === "capability-payload" ? { payload: { kind: "text", text: "x".repeat(1025) } } : {}),
              },
              { idempotencyKey: key },
              f.authority,
            );
      await expect(invoke()).rejects.toMatchObject({
        code:
          failure === "missing-boundary"
            ? "NOT_SUPPORTED"
            : failure === "capability-payload"
              ? "WORKFLOW_INPUT_INVALID"
              : "REVISION_STALE",
      });
      const pending = await invoke();
      expect(pending).toMatchObject({ state: "in-progress" });
      const before = await f.claimStore.read(pending.operationId);
      expect(before).toMatchObject({ phase: "claimed" });
      expect(before?.binding).toBeUndefined();
      expect(await f.claims.reconcile(pending.operationId, f.authority)).toEqual(pending);
      expect(await f.claimStore.read(pending.operationId)).toEqual(before);
      expect(await f.commits()).toHaveLength(1);
      // Applying target/CAS preflight unconditionally would break this healthy replay.
      expect(await f.submit()).toEqual({ ...first, replayed: true });
    },
  );

  it("serializes independent runtimes racing one key without adding a second commit", async () => {
    const f = await fixture();
    const competingStores = fileStores(f.dir);
    const competingRuntime = createRevisionRuntime({
      stores: competingStores,
      authorizeExecution: async () => undefined,
    });
    // The registered operation belongs to f's journal: use the same service/runtime
    // pairing for each contender, as trusted production composition requires.
    const secondClaims = new RegisteredRetryClaims(
      new FileRetryClaimStore({
        storeDir: f.dir,
        execution: competingStores.execution,
        faults,
      }),
      faults,
    );
    const secondService = new RevisionInputService({
      journal: competingRuntime.journal,
      retries: competingRuntime.fenceRetries(secondClaims),
      stale,
      access: {
        principalId: "user",
        workspaceId: "workspace",
        actor: async () => ({ principalId: "user" }),
        read: async () => ({ content: true, mutate: true }),
        mutate: async () => undefined,
      },
    });
    registerRevisionInputOperation(secondClaims, secondService.submitOperation, competingRuntime.journal);
    registerRevisionInputOperation(secondClaims, secondService.replaceOperation, competingRuntime.journal);
    const second = () => secondService.submit(f.command, { idempotencyKey: "submit" }, f.authority);
    const results = await Promise.allSettled([f.submit(), second()]);
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value).toMatchObject({ state: "resolved" });
      else expect(result.reason).toMatchObject({ code: "RUN_LEASED" });
    }
    const first = await f.submit();
    expect(await second()).toEqual(first);
    expect(await f.commits()).toHaveLength(1);
  });

  it("observes a protected reader in another process before claiming a key", async () => {
    const f = await fixture();
    const script = `
      import { fileStores } from ${JSON.stringify(new URL("../../store/src/index.ts", import.meta.url).href)};
      import { createRevisionRuntime } from ${JSON.stringify(new URL("../src/revision-runtime.ts", import.meta.url).href)};
      const stores = fileStores(${JSON.stringify(f.dir)});
      const runtime = createRevisionRuntime({stores, authorizeExecution: async () => {}});
      const release = stores.leases.release.bind(stores.leases);
      stores.leases.release = async (lease) => {
        process.stdout.write('held\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        process.stdin.pause();
        await release(lease);
      };
      await runtime.readBoundaries('run');
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const held = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error(errors || "reader exited before holding lease")));
    });
    const finished = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    const claim = vi.spyOn(f.claimStore, "claim");
    try {
      await held;
      expect(await f.stores.leases.get("run:run")).toBeDefined();
      await expect(f.submit()).rejects.toMatchObject({ code: "RUN_LEASED" });
      expect(claim).not.toHaveBeenCalled();
      expect(await f.claimStore.batch()).toEqual([]);
    } finally {
      child.stdin.end("release\n");
      expect(await finished, errors).toBe(0);
    }
    const first = await f.submit();
    expect(first).toMatchObject({ state: "resolved", replayed: false });
    expect(await f.submit()).toEqual({ ...first, replayed: true });
    expect(await f.commits()).toHaveLength(1);
  });
});
