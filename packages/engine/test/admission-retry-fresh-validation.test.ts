import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import { FileExecutionStore, fileStores } from "@orca/store";
import type { RetryContext, RetryOperation } from "../../core/src/model/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims, canonicalJson } from "../src/admission-retry.js";
import { DirectAdmissionService, type DirectCapturedLaunch } from "../src/direct-admission.js";
import { RequestSubmissionService } from "../src/program/request-submission.js";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { submissionFixture } from "./request-submission-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "Limit"),
};
const authority = { principalId: "alice", workspaceId: "workspace", authorize: async (_command: unknown) => {} };
type Command = { value: string; payload: { note: string } };
const command = (value = "original"): Command => ({ value, payload: { note: "original note" } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-retry-fresh-engine-"));
  directories.push(dir);
  const execution = new FileExecutionStore(dir);
  const store = new FileRetryClaimStore({ storeDir: dir, execution, faults, lockTimeoutMs: 2_000 });
  return { dir, execution, store, claims: new RegisteredRetryClaims(store, faults) };
}
function operation(validateFresh: (command: Command) => Promise<void>) {
  const prepare = vi.fn(async (value: Command, context: RetryContext) => {
    await context.bind({ revisionId: "revision" });
    return { value: value.value, note: value.payload.note };
  });
  const recover = vi.fn(async (_value: Command, context: RetryContext) => ({
    value: (await context.readBinding())!.revisionId as string,
    note: "recovered",
  }));
  const op: RetryOperation<Command, { value: string; note: string }> = {
    kind: "revision.submit",
    canonicalize: (value) => value,
    validateFresh,
    prepare,
    recover,
  };
  return { op, prepare, recover };
}

describe("registered fresh retry validation", () => {
  it("rejects fresh invalid input without consuming its key, then accepts corrected input", async () => {
    const { claims, store, dir } = await fixture();
    const validate = vi.fn(async (value: Command) => {
      if (value.value === "invalid") throw new OrcaError("WORKFLOW_INPUT_INVALID", "Invalid fresh input");
    });
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    await expect(
      claims.execute(registered, command("invalid"), { idempotencyKey: "same-key" }, authority),
    ).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(await readdir(join(dir, "admission-retries"))).toEqual([]);
    expect(await store.batch()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    const corrected = await claims.execute(registered, command("corrected"), { idempotencyKey: "same-key" }, authority);
    expect(corrected).toMatchObject({ state: "resolved", replayed: false, result: { value: "corrected" } });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await store.batch()).toEqual([corrected.operationId]);
  });

  it("preserves accepted replay and conflict semantics without rerunning fresh validation", async () => {
    const { claims } = await fixture();
    const validate = vi.fn(async (_value: Command) => {});
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    const first = await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority);
    validate.mockImplementation(async () => {
      throw new OrcaError("RUN_STATE", "Boundary has moved");
    });
    expect(await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority)).toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      claims.execute(registered, command("changed"), { idempotencyKey: "same-key" }, authority),
    ).rejects.toMatchObject({ code: "RETRY_CONFLICT" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it("leaves existing unbound claims blocked and never validates, rebinds or autoreplays them", async () => {
    const { claims, store } = await fixture();
    const validate = vi.fn(async (_value: Command) => {
      throw new Error("Existing unbound claim must bypass validation");
    });
    const { op, prepare, recover } = operation(validate);
    const registered = claims.register(op);
    const input = command();
    const first = await store.claim(
      { principalId: authority.principalId, workspaceId: authority.workspaceId, kind: op.kind },
      "same-key",
      input,
      canonicalJson(input),
    );
    const pending = { state: "in-progress", operationId: first.record.operationId, recovery: "inspect-or-retry" };
    expect(await claims.execute(registered, input, { idempotencyKey: "same-key" }, authority)).toEqual(pending);
    expect(await claims.reconcile(first.record.operationId, authority)).toEqual(pending);
    expect(await store.read(first.record.operationId)).toEqual(first.record);
    expect(validate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("isolates fresh validation and its authority checks from the sealed canonical intent", async () => {
    const { claims, store } = await fixture();
    let validated!: Command;
    const { op, prepare } = operation(async (value) => {
      validated = value;
      value.value = "validator mutation";
      value.payload.note = "validator nested mutation";
    });
    let checks = 0;
    const registered = claims.register(op, async (value) => {
      if (++checks <= 2) value.payload.note = "fresh authority mutation";
    });
    const input = command();
    const result = await claims.execute(registered, input, { idempotencyKey: "same-key" }, authority);
    validated.payload.note = "late mutation";
    expect(input).toEqual(command());
    expect(result).toMatchObject({ state: "resolved", result: { value: "original", note: "original note" } });
    expect(prepare.mock.calls[0]![0]).toEqual(command());
    expect(await store.read(result.operationId)).toMatchObject({ command: input, canonical: canonicalJson(input) });
  });

  it.each(["caller", "registered"])("checks %s authority again after validation before publishing", async (kind) => {
    const { claims, store } = await fixture();
    let revoked = false;
    const authorize = vi.fn(async (_value: unknown) => {
      if (revoked) throw new OrcaError("RUN_STATE", "Authority revoked");
    });
    const validate = vi.fn(async (_value: Command) => {
      revoked = true;
    });
    const { op, prepare } = operation(validate);
    const registered = claims.register(op, kind === "registered" ? authorize : undefined);
    await expect(
      claims.execute(
        registered,
        command(),
        { idempotencyKey: "same-key" },
        {
          ...authority,
          ...(kind === "caller" ? { authorize } : {}),
        },
      ),
    ).rejects.toThrow("Authority revoked");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(await store.batch()).toEqual([]);
    expect(authorize).toHaveBeenCalledTimes(kind === "caller" ? 3 : 2);
    revoked = false;
    validate.mockImplementation(async () => {});
    expect(await claims.execute(registered, command(), { idempotencyKey: "same-key" }, authority)).toMatchObject({
      state: "resolved",
      replayed: false,
    });
  });

  it("checks authority after waiting for the catalog mutex and before calling the validator", async () => {
    const { claims, store } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = store.claim(
      { principalId: authority.principalId, workspaceId: authority.workspaceId, kind: "run.admit" },
      "blocker",
      {},
      "{}",
      async () => {
        entered();
        await waiting;
      },
    );
    await ready;

    const validate = vi.fn(async (_value: Command) => {});
    const { op, prepare } = operation(validate);
    const registered = claims.register(op);
    let revoked = false;
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      requested();
      return claim(...args);
    });
    const result = claims.execute(
      registered,
      command(),
      { idempotencyKey: "same-key" },
      {
        ...authority,
        authorize: async () => {
          if (revoked) throw new OrcaError("RUN_STATE", "Authority revoked while waiting");
        },
      },
    );
    const refusal = expect(result).rejects.toThrow("Authority revoked while waiting");
    await requestStarted;
    revoked = true;
    release();
    const existing = await blocker;
    await refusal;
    expect(validate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(await store.batch()).toEqual([existing.record.operationId]);
  });
});

type AdmissionKind = "direct" | "request";
async function admissionFixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-fresh-"));
  directories.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), {
    strictInputs: true,
    nativeCorrelation: true,
  });
  await f.ready();
  const capture = vi.fn(f.generations.captureLaunch);
  const directAuthority = { ...f.authority, authorize: vi.fn(async () => {}) };
  const services = (lockTimeoutMs = 2_000) => {
    const store = new FileRetryClaimStore({
      storeDir: dir,
      execution: f.stores.execution,
      faults,
      lockTimeoutMs,
    });
    const claims = new RegisteredRetryClaims(store, faults);
    const direct = new DirectAdmissionService({
      orchestrator: f.orc,
      retries: claims,
      captureLaunch: capture,
      restoreLaunch: f.generations.restoreDirectLaunch,
    });
    const request = new RequestSubmissionService({
      orchestrator: f.orc,
      admissions: f.admissions,
      retries: claims,
      captureLaunch: capture,
      restoreLaunch: f.generations.restoreLaunch,
    });
    const submit = (
      kind: AdmissionKind,
      patch: {
        expectedConfigGeneration?: string;
        expectedWorkflowRevision?: string;
        vars?: Record<string, unknown>;
      } = {},
    ) =>
      kind === "direct"
        ? direct.admitRun({ workflowId: "program", ...patch }, { idempotencyKey: "same-intent" }, directAuthority)
        : request.submitRetry(
            { title: "A Request", body: "body", ...patch },
            { idempotencyKey: "same-intent" },
            f.authority,
          );
    return { store, claims, direct, request, submit };
  };
  const start = vi.spyOn(f.orc, "startRun");
  const run = vi.spyOn(f.orc, "run");
  const mutations = [
    vi.spyOn(f.orc.stores.events, "append"),
    vi.spyOn(f.stores.execution, "putInputs"),
    vi.spyOn(f.stores.execution, "putPayload"),
    vi.spyOn(f.stores.requests, "put"),
    vi.spyOn(f.admissions.records, "put"),
    vi.mocked(f.authority.onRunAdmitted),
    start,
    run,
  ];
  const generationsWritten = vi.spyOn(f.stores.execution, "putGeneration");
  return { ...f, ...services(), dir, capture, directAuthority, services, mutations, generationsWritten, start, run };
}
async function expectNoAdmission(f: Awaited<ReturnType<typeof admissionFixture>>) {
  // Also proves a rejected validator releases the catalog mutex and leaves no journal or key pointer.
  expect(await readdir(join(f.dir, "admission-retries"))).toEqual([]);
  expect(await f.store.batch()).toEqual([]);
  expect(await f.admissions.records.list()).toEqual([]);
  expect(await f.stores.requests.list()).toEqual([]);
  expect(await f.orc.listRuns()).toEqual([]);
  for (const mutation of f.mutations) expect(mutation).not.toHaveBeenCalled();
  // The existing shared store may initialize its lookup salt, never a sealed claim or launch material.
  expect(f.generationsWritten.mock.calls.every(([id]) => id === "admission-retry-lookup")).toBe(true);
}

describe.each(["direct", "request"] as const)("fresh %s admission", (kind) => {
  it.each([
    { name: "stale config", patch: { expectedConfigGeneration: "stale-generation" }, code: "CONFIG_STALE" },
    { name: "stale workflow", patch: { expectedWorkflowRevision: "stale-revision" }, code: "WORKFLOW_INVALID" },
    { name: "invalid input", patch: { vars: { unknown: "invalid" } }, code: "WORKFLOW_INPUT_INVALID" },
  ])("refuses $name before publication, then admits the corrected same key once", async ({ patch, code }) => {
    const f = await admissionFixture();
    await expect(f.submit(kind, patch)).rejects.toMatchObject({ code });
    await expectNoAdmission(f);
    const first = await f.submit(kind);
    expect(first).toMatchObject({ state: "resolved", replayed: false, result: { state: "accepted" } });
    expect(await f.submit(kind)).toEqual({ ...first, replayed: true });
    expect(await f.store.batch()).toEqual([first.operationId]);
    expect(await f.orc.listRuns()).toHaveLength(1);
    expect(await f.admissions.records.list()).toHaveLength(kind === "request" ? 1 : 0);
    expect(await f.stores.requests.list()).toHaveLength(kind === "request" ? 1 : 0);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("refuses unsupported providers without consuming the key", async () => {
    const f = await admissionFixture();
    f.capture.mockImplementationOnce(async (selection) => {
      const launch = await f.generations.captureLaunch(selection);
      return {
        ...launch,
        ...(kind === "direct" ? { admissionRunIds: undefined } : { requestAdmissionCorrelation: undefined }),
      } as unknown as DirectCapturedLaunch;
    });
    await expect(f.submit(kind)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expectNoAdmission(f);
    expect(await f.submit(kind)).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    expect(await f.orc.listRuns()).toHaveLength(1);
  });

  it("rechecks revoked authority after fresh validation before publishing", async () => {
    const f = await admissionFixture();
    let revoked = false;
    const authorize = async () => {
      if (revoked) throw new OrcaError("RUN_STATE", "Authority revoked");
    };
    vi.mocked(f.authority.authorize).mockImplementation(authorize);
    f.directAuthority.authorize.mockImplementation(authorize);
    f.capture.mockImplementationOnce(async (selection) => {
      const launch = await f.generations.captureLaunch(selection);
      return {
        ...launch,
        validateStartRun: async (options) => {
          await launch.validateStartRun(options);
          revoked = true;
        },
      };
    });
    await expect(f.submit(kind)).rejects.toThrow("Authority revoked");
    await expectNoAdmission(f);
    revoked = false;
    expect(await f.submit(kind)).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    expect(await f.orc.listRuns()).toHaveLength(1);
  });

  it("replays accepted intent and rejects changed commands after the current generation moves", async () => {
    const f = await admissionFixture();
    const expectedConfigGeneration = f.generations.current.snapshot.id;
    const first = await f.submit(kind, { expectedConfigGeneration });
    expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    const applied = await f.generations.apply(
      f.generations.current.snapshot.config,
      "new-config-revision",
      expectedConfigGeneration,
      false,
      async () => {},
    );
    expect(applied.outcome).toBe("applied");
    expect(f.generations.current.snapshot.id).not.toBe(expectedConfigGeneration);
    f.capture.mockClear();
    for (const mutation of f.mutations) mutation.mockClear();
    f.generationsWritten.mockClear();
    expect(await f.submit(kind, { expectedConfigGeneration })).toEqual({ ...first, replayed: true });
    await expect(f.submit(kind, { expectedConfigGeneration, vars: { token: "changed" } })).rejects.toMatchObject({
      code: "RETRY_CONFLICT",
    });
    expect(f.capture).not.toHaveBeenCalled();
    for (const mutation of f.mutations) expect(mutation).not.toHaveBeenCalled();
    expect(f.generationsWritten).not.toHaveBeenCalled();
    expect(await f.store.batch()).toEqual([first.operationId]);
    expect(await f.orc.listRuns()).toHaveLength(1);
  });

  it("serializes compatible callers through separate file claim stores and publishes once", async () => {
    const f = await admissionFixture();
    const other = f.services();
    let [first, second] = await Promise.all([f.submit(kind), other.submit(kind)]);
    expect(first.operationId).toBe(second.operationId);
    // A contender may exhaust the bounded lock wait before the owner publishes.
    // Once both calls finish, the same key must converge without another admission.
    if (first.state === "in-progress") {
      expect(first.recovery).toBe("inspect-or-retry");
      first = await f.submit(kind);
    }
    if (second.state === "in-progress") {
      expect(second.recovery).toBe("inspect-or-retry");
      second = await other.submit(kind);
    }
    expect(first).toMatchObject({ state: "resolved", result: { state: "accepted" } });
    expect(second).toMatchObject({ state: "resolved", operationId: first.operationId });
    if (first.state !== "resolved" || second.state !== "resolved") throw new Error("admissions did not resolve");
    expect(second.result).toEqual(first.result);
    expect(await f.store.batch()).toEqual([first.operationId]);
    expect(await f.orc.listRuns()).toHaveLength(1);
    expect(await f.stores.requests.list()).toHaveLength(kind === "request" ? 1 : 0);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "bounds a held-owner contender and rechecks authority on same-key retry (revoked=%s)",
    async (revoked) => {
      const f = await admissionFixture();
      // Only the contender's wait is shortened: it spends all of it, because the owner is held
      // until it gives up. The owner's service keeps the fixture's two seconds.
      const other = f.services(150);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Fresh validation succeeds. Hold prepare under the operation lock until the
      // contender exhausts its own acquisition budget (150 ms for `other`; the owner's service
      // keeps the fixture's two seconds).
      f.capture.mockImplementationOnce(f.generations.captureLaunch).mockImplementationOnce(async (selection) => {
        entered();
        await held;
        return f.generations.captureLaunch(selection);
      });
      const owner = f.submit(kind);
      let contender: Awaited<ReturnType<typeof other.submit>>;
      try {
        await Promise.race([
          ready,
          owner.then(() => {
            throw new Error("Owner completed before entering the prepare barrier");
          }),
        ]);
        contender = await other.submit(kind);
        expect(contender).toMatchObject({ state: "in-progress", recovery: "inspect-or-retry" });
      } finally {
        release();
        await owner;
      }
      const first = await owner;
      expect(first).toMatchObject({ state: "resolved", replayed: false, result: { state: "accepted" } });
      expect(contender.operationId).toBe(first.operationId);
      const record = await f.store.read(first.operationId);
      if (revoked) {
        const refusal = new OrcaError("RUN_STATE", "Authority revoked after contention");
        vi.mocked(f.authority.authorize).mockRejectedValueOnce(refusal);
        f.directAuthority.authorize.mockRejectedValueOnce(refusal);
        await expect(other.submit(kind)).rejects.toBe(refusal);
      } else {
        expect(await other.submit(kind)).toEqual({ ...first, replayed: true });
      }
      expect(await f.store.read(first.operationId)).toEqual(record);
      expect(await f.store.batch()).toEqual([first.operationId]);
      expect(await f.orc.listRuns()).toHaveLength(1);
      expect(await f.stores.requests.list()).toHaveLength(kind === "request" ? 1 : 0);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.capture).toHaveBeenCalledTimes(2);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("retains explicit uncertainty when prepare revalidation fails after publication", async () => {
    const f = await admissionFixture();
    f.capture
      .mockImplementationOnce(f.generations.captureLaunch)
      .mockRejectedValueOnce(new OrcaError("CONFIG_STALE", "generation moved after claim publication"));
    await expect(f.submit(kind)).rejects.toMatchObject({ code: "CONFIG_STALE" });
    const [operationId] = await f.store.batch();
    expect(operationId).toBeDefined();
    const record = await f.store.read(operationId!);
    expect(record?.phase).toBe(kind === "direct" ? "claimed" : "bound");
    const retried = await f.submit(kind);
    expect(retried).toMatchObject(
      kind === "direct"
        ? { state: "in-progress", operationId }
        : { state: "resolved", operationId, result: { state: "recoverable-failure" } },
    );
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect((await f.store.read(operationId!))?.binding).toEqual(record?.binding);
    expect(await f.orc.listRuns()).toEqual([]);
    expect(await f.admissions.records.list()).toEqual([]);
    expect(await f.stores.requests.list()).toEqual([]);
    for (const mutation of f.mutations) expect(mutation).not.toHaveBeenCalled();
  });
});
