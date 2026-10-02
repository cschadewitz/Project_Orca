/** Cached acceptance is a projection; reads must retain and verify original durable evidence. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaError } from "@orca/core";
import { fileStores } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { RegisteredRetryClaims } from "../src/admission-retry.js";
import { DirectAdmissionService } from "../src/direct-admission.js";
import { RequestSubmissionService } from "../src/program/request-submission.js";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { submissionFixture } from "./request-submission-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-accepted-evidence-"));
  dirs.push(dir);
  const f = submissionFixture(fileStores(dir), new FileAdmissionStore(dir), { nativeCorrelation: true });
  await f.ready();
  const faults = {
    conflict: () => new OrcaError("RUN_STATE", "conflict"),
    limit: () => new OrcaError("RUN_STATE", "limit"),
  };
  const ledger = new FileRetryClaimStore({ storeDir: dir, execution: f.stores.execution, faults });
  const claims = new RegisteredRetryClaims(ledger, faults);
  const request = new RequestSubmissionService({
    orchestrator: f.orc,
    admissions: f.admissions,
    retries: claims,
    captureLaunch: f.generations.captureLaunch,
    restoreLaunch: f.generations.restoreLaunch,
  });
  const directAuthority = { ...f.authority, authorize: vi.fn(async () => {}) };
  const direct = new DirectAdmissionService({
    orchestrator: f.orc,
    retries: claims,
    captureLaunch: f.generations.captureLaunch,
    restoreLaunch: f.generations.restoreDirectLaunch,
  });
  const scope = {
    principalId: f.authority.actor.principalId,
    workspaceId: f.authority.workspaceId,
    authorize: async () => {},
  };
  const commands = { request: { title: "  Private title  ", body: "Private body" }, direct: { workflowId: "program" } };
  const submit = (kind: "request" | "direct") =>
    kind === "request"
      ? request.submitRetry(commands.request, { idempotencyKey: "original-intent" }, f.authority)
      : direct.admitRun(commands.direct, { idempotencyKey: "original-intent" }, directAuthority);
  const inspect = (kind: "request" | "direct", operationId: string) =>
    kind === "request"
      ? request.withRetryAuthority(f.authority, () => claims.inspect(operationId, scope))
      : direct.withRetryAuthority(directAuthority, () => claims.inspect(operationId, scope));
  return { ...f, dir, ledger, claims, request, direct, directAuthority, scope, submit, inspect };
}
function accepted<T extends { state: string }>(value: T) {
  expect(value).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  return value as T & {
    operationId: string;
    result: { state: "accepted"; admissionId: string; requestId?: string; runId: string };
  };
}
function writes(f: Awaited<ReturnType<typeof fixture>>) {
  return [
    vi.spyOn(f.stores.events, "append"),
    vi.spyOn(f.stores.execution, "putGeneration"),
    vi.spyOn(f.stores.execution, "putInputs"),
    vi.spyOn(f.stores.execution, "putPayload"),
    vi.spyOn(f.stores.requests, "put"),
    vi.spyOn(f.admissions.records, "put"),
    vi.mocked(f.authority.onRunAdmitted).mockClear(),
  ];
}
it.each(["request", "direct"] as const)(
  "%s synchronizes creation before accepting and replays original identities without writes",
  async (kind) => {
    const f = await fixture();
    const sync = vi.spyOn(f.stores.events, "synchronizeEvent");
    const first = accepted(await f.submit(kind));
    expect(sync).toHaveBeenCalled();
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.authority.onRunAdmitted).mock.invocationCallOrder[0]!,
    );
    const mutations = writes(f);
    expect(await f.submit(kind)).toEqual({ ...first, replayed: true });
    expect(await f.inspect(kind, first.operationId)).toEqual({ ...first, replayed: true });
    if (kind === "request")
      expect(await f.request.inspect(first.result.admissionId, f.authority)).toEqual(first.result);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await f.orc.listRuns()).toEqual([first.result.runId]);
  },
);
it.each(["request", "direct"] as const)(
  "%s retains its receipt after a committed retry acknowledgement is lost",
  async (kind) => {
    const f = await fixture();
    const write = f.ledger.write.bind(f.ledger);
    let operationId = "";
    vi.spyOn(f.ledger, "write").mockImplementation(async (record) => {
      await write(record);
      if (record.phase === "accepted") {
        operationId = record.operationId;
        throw new Error("lost acknowledgement");
      }
    });
    await expect(f.submit(kind)).rejects.toThrow("lost acknowledgement");
    const stored = await f.ledger.read(operationId);
    const mutations = writes(f);
    const replay = accepted(await f.submit(kind));
    expect(replay).toMatchObject({ operationId, replayed: true, result: stored!.result });
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await f.orc.listRuns()).toEqual([replay.result.runId]);
  },
);
const faults = [
  "marker-missing",
  "marker-rewound",
  "marker-tampered",
  "private-payload",
  "private-inputs",
  "admission-material",
  "policy-binding",
  "generation",
  "definition",
  "policy",
  "ownership",
] as const;
it.each(["request", "direct"] as const)(
  "%s refuses damaged accepted evidence without repairing or changing identity",
  async (kind) => {
    for (const fault of faults) {
      const f = await fixture();
      const first = accepted(await f.submit(kind));
      const runId = first.result.runId;
      const root = (await f.stores.events.readRange(runId, { limit: 1 }))[0]!;
      const generationId = f.generations.current.snapshot.id;
      if (fault === "marker-missing") await rm(join(f.dir, "runs", `${runId}.jsonl`));
      if (fault === "marker-rewound") await writeFile(join(f.dir, "runs", `${runId}.jsonl`), "");
      if (fault === "marker-tampered")
        await writeFile(
          join(f.dir, "runs", `${runId}.jsonl`),
          `${JSON.stringify({ ...root, id: "forged-event-id" })}\n`,
        );
      if (fault === "private-payload")
        await rm(join(f.dir, "private-execution", `${root.executionPayloadRef!}.payload.json`));
      if (fault === "private-inputs")
        await rm(join(f.dir, "private-execution", `${encodeURIComponent(runId)}.inputs.json`));
      if (fault === "admission-material") {
        const operation = (await f.ledger.read(first.operationId))!;
        const materialId = kind === "request" ? first.result.admissionId : (operation.binding!.materialId as string);
        await rm(
          join(
            f.dir,
            "private-execution",
            `${encodeURIComponent(materialId)}.${kind === "request" ? "inputs" : "generation"}.json`,
          ),
        );
      }
      if (fault === "policy-binding") {
        const get = f.stores.execution.getGeneration.bind(f.stores.execution);
        vi.spyOn(f.stores.execution, "getGeneration").mockImplementation(async (id) => {
          const raw = await get(id);
          if (id === `admission-execution-policy:${runId}` && raw && typeof raw === "object")
            return { ...raw, binding: { kind: "direct", runId: "wrong-root" } };
          return raw;
        });
      }
      if (fault === "generation")
        await rm(join(f.dir, "private-execution", `${encodeURIComponent(generationId)}.generation.json`));
      if (fault === "definition") vi.spyOn(f.stores.workflows, "get").mockResolvedValue(undefined);
      if (fault === "policy" || fault === "ownership") {
        const key = fault === "policy" ? `admission-execution-policy:${runId}` : `fixture-owner:${runId}`;
        await rm(join(f.dir, "private-execution", `${encodeURIComponent(key)}.generation.json`));
      }
      const mutations = writes(f);
      for (const attempt of [() => f.submit(kind), () => f.inspect(kind, first.operationId)])
        await expect(attempt(), fault).rejects.toMatchObject({
          code: "RUN_STATE",
          details: {
            operationId: first.operationId,
            admissionId: first.result.admissionId,
            runId,
          },
        });
      if (kind === "request") {
        expect(await f.request.inspect(first.result.admissionId, f.authority), fault).toMatchObject({
          state: "recoverable-failure",
          admissionId: first.result.admissionId,
          requestId: first.result.requestId,
          runId,
        });
        expect(await f.admissions.records.get(first.result.admissionId)).toMatchObject({ state: "accepted", runId });
      }
      for (const mutation of mutations) expect(mutation, fault).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  },
);
it("Request inspection refuses missing or changed program-root links without restoring them", async () => {
  for (const programRunId of [undefined, "wrong-root"]) {
    const f = await fixture();
    const first = accepted(await f.submit("request"));
    const stored = (await f.stores.requests.get(first.result.requestId!))!;
    await f.stores.requests.put({ ...stored, programRunId });
    const mutations = writes(f);
    expect(await f.request.inspect(first.result.admissionId, f.authority)).toMatchObject({
      state: "recoverable-failure",
      runId: first.result.runId,
    });
    await expect(f.submit("request")).rejects.toMatchObject({ code: "RUN_STATE" });
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});
it.each(["request", "direct"] as const)("%s rechecks current authority on cached receipt inspection", async (kind) => {
  const f = await fixture();
  const first = accepted(await f.submit(kind));
  const authority = kind === "request" ? f.authority : f.directAuthority;
  vi.mocked(authority.authorize).mockRejectedValue(new OrcaError("RUN_STATE", "revoked"));
  const mutations = writes(f);
  await expect(f.submit(kind)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(f.inspect(kind, first.operationId)).rejects.toMatchObject({ code: "RUN_STATE" });
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
});

it.each(["request", "direct"] as const)(
  "%s keeps creation synchronization failures uncertain without ownership or policy",
  async (kind) => {
    const f = await fixture();
    vi.spyOn(f.stores.events, "synchronizeEvent").mockRejectedValue(
      new OrcaError("RUN_STATE", "synchronization unavailable"),
    );
    const first = await f.submit(kind);
    expect(first).toMatchObject({ state: "resolved", result: { state: "recoverable-failure" } });
    const [runId] = await f.orc.listRuns();
    expect(runId).toBeDefined();
    expect(f.authority.onRunAdmitted).not.toHaveBeenCalled();
    expect(await f.stores.execution.getGeneration(`admission-execution-policy:${runId!}`)).toBeUndefined();
    const mutations = writes(f);
    expect(await f.submit(kind)).toEqual({ ...first, replayed: true });
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await f.orc.listRuns()).toEqual([runId]);
  },
);

it.each(["request", "direct"] as const)(
  "%s refuses acceptance if authority is revoked while synchronizing an inspected marker",
  async (kind) => {
    const f = await fixture();
    const first = accepted(await f.submit(kind));
    const authority = kind === "request" ? f.authority : f.directAuthority;
    const synchronize = f.stores.events.synchronizeEvent!.bind(f.stores.events);
    vi.spyOn(f.stores.events, "synchronizeEvent").mockImplementation(async (event) => {
      const original = await synchronize(event);
      vi.mocked(authority.authorize).mockRejectedValue(new OrcaError("RUN_STATE", "revoked during synchronization"));
      return original;
    });
    const mutations = writes(f);
    await expect(f.inspect(kind, first.operationId)).rejects.toMatchObject({
      code: "RUN_STATE",
      details: {
        operationId: first.operationId,
        admissionId: first.result.admissionId,
        runId: first.result.runId,
      },
    });
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  },
);
