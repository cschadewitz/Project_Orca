/** The native acceptance observer must read actual DaemonClientError codes without changing transport behavior. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingRevisionViewSchema,
  RevisionResultSchema,
  type InputsReplaceRevisionParams,
  type RevisionResult,
} from "@orca/protocol";
import * as clientModule from "../src/client/daemon-client.js";
import { installRevisionSmokeObservation, type RevisionSmokeProbe } from "./smoke/revision-smoke-observation.js";

const { DaemonClient, DaemonClientError } = clientModule;
const observedGlobal = globalThis as typeof globalThis & { orcaRevisionSmoke?: RevisionSmokeProbe };
const params: InputsReplaceRevisionParams = {
  command: {
    target: {
      runId: "synthetic-run",
      revisionId: "synthetic-revision",
      destinationId: "synthetic-destination",
      attemptId: "synthetic-attempt",
    },
    expectedRevision: "synthetic-version",
    payload: { kind: "text", text: "SYNTHETIC-PROTECTED-CORRECTION" },
  },
  retry: { idempotencyKey: "synthetic-retry-key" },
};
const result: RevisionResult = {
  state: "in-progress",
  operationId: "synthetic-operation",
  recovery: "inspect-or-retry",
};

/** Resolve the identical native installer against the real production classes in this test process. */
function install() {
  const modulePath = "synthetic-client-module";
  const load = vi.fn(() => clientModule);
  const createRequire = vi
    .spyOn(process.getBuiltinModule("module"), "createRequire")
    .mockReturnValue(load as unknown as NodeJS.Require);
  try {
    installRevisionSmokeObservation({ app: { getAppPath: () => "synthetic-app" } }, modulePath);
  } finally {
    createRequire.mockRestore();
  }
  expect(load).toHaveBeenCalledExactlyOnceWith(modulePath);
  expect(observedGlobal.orcaRevisionSmoke).toBeDefined();
  return observedGlobal.orcaRevisionSmoke!;
}

afterEach(() => {
  const probe = observedGlobal.orcaRevisionSmoke;
  probe?.releaseReplacement?.();
  for (const release of probe?.releasePendingReads ?? []) release();
  vi.restoreAllMocks();
  delete observedGlobal.orcaRevisionSmoke;
});

describe("native revision smoke observation", () => {
  it("records the nested REVISION_STALE from the exact production error instance and rethrows it unchanged", async () => {
    const error = new DaemonClientError({
      code: "REVISION_STALE",
      message: "SYNTHETIC-PRIVATE-MESSAGE",
      details: { privateValue: "SYNTHETIC-PRIVATE-DETAIL" },
    });
    expect(error).not.toHaveProperty("code");
    const original = vi.spyOn(DaemonClient.prototype, "call").mockRejectedValue(error);
    const probe = install();
    const client = new DaemonClient("http://127.0.0.1:1");
    const signal = new AbortController().signal;
    await expect(
      client.call("inputs.replaceRevision", params, RevisionResultSchema, false, signal, false),
    ).rejects.toBe(error);
    expect(original).toHaveBeenCalledExactlyOnceWith(
      "inputs.replaceRevision",
      params,
      RevisionResultSchema,
      false,
      signal,
      false,
    );
    expect(original.mock.contexts[0]).toBe(client);
    expect(original.mock.calls[0]![1]).toBe(params);
    expect(original.mock.calls[0]![2]).toBe(RevisionResultSchema);
    expect(probe.errors).toEqual([{ method: "inputs.replaceRevision", code: "REVISION_STALE" }]);
    expect(probe.methods).toEqual(["inputs.replaceRevision"]);
    expect(probe.receipts).toEqual([]);
    const evidence = JSON.stringify(probe);
    for (const privateValue of [
      error.message,
      "SYNTHETIC-PRIVATE-DETAIL",
      params.command.payload,
      params.retry.idempotencyKey,
    ])
      expect(evidence).not.toContain(typeof privateValue === "string" ? privateValue : JSON.stringify(privateValue));
  });

  it("does not mislabel an unrelated top-level code as a protocol refusal", async () => {
    const error = Object.assign(new Error("SYNTHETIC-UNRELATED-ERROR"), { code: "REVISION_STALE" });
    vi.spyOn(DaemonClient.prototype, "call").mockRejectedValue(error);
    const probe = install();
    await expect(new DaemonClient().inputsReplaceRevision(params)).rejects.toBe(error);
    expect(probe.errors).toEqual([{ method: "inputs.replaceRevision", code: "UNKNOWN" }]);
  });

  it("holds the replacement before the captured call and then forwards the same request and real refusal", async () => {
    const error = new DaemonClientError({ code: "REVISION_STALE", message: "The competing revision won" });
    const original = vi.spyOn(DaemonClient.prototype, "call").mockRejectedValue(error);
    const probe = install();
    probe.holdNextReplacement = true;
    const client = new DaemonClient();
    const rejected = client.inputsReplaceRevision(params).catch((caught: unknown) => caught);
    expect(probe.replacementWaiting).toBe(true);
    expect(original).not.toHaveBeenCalled();
    expect(probe.errors).toEqual([]);
    probe.releaseReplacement!();
    expect(await rejected).toBe(error);
    expect(original).toHaveBeenCalledExactlyOnceWith("inputs.replaceRevision", params, RevisionResultSchema);
    expect(original.mock.contexts[0]).toBe(client);
    expect(original.mock.calls[0]![1]).toBe(params);
    expect(probe.replacementWaiting).toBe(false);
    expect(probe.releaseReplacement).toBeUndefined();
    expect(probe.errors).toEqual([{ method: "inputs.replaceRevision", code: "REVISION_STALE" }]);
  });

  it("forwards successful write results by identity and records only their public receipt", async () => {
    const original = vi.spyOn(DaemonClient.prototype, "call").mockResolvedValue(result);
    const probe = install();
    expect(await new DaemonClient().inputsReplaceRevision(params)).toBe(result);
    expect(original).toHaveBeenCalledExactlyOnceWith("inputs.replaceRevision", params, RevisionResultSchema);
    expect(probe.receipts).toEqual([{ method: "inputs.replaceRevision", value: result }]);
    expect(probe.receipts[0]!.value).toBe(result);
    expect(probe.errors).toEqual([]);
  });

  it("holds protected reads without recording their payload or changing their arguments and result", async () => {
    const pending = {
      target: params.command.target,
      expectedRevision: "synthetic-current-version",
      state: "pending" as const,
      replacementAllowed: true,
      payload: params.command.payload,
    };
    const original = vi.spyOn(DaemonClient.prototype, "call").mockResolvedValue(pending);
    const probe = install();
    probe.holdPendingReads = true;
    const client = new DaemonClient();
    const readParams = { target: params.command.target };
    const read = client.inputsRevisionPending(readParams);
    expect(probe.pendingReadsWaiting).toBe(1);
    expect(probe.delayedReadCount).toBe(1);
    expect(original).not.toHaveBeenCalled();
    probe.holdPendingReads = false;
    for (const release of probe.releasePendingReads.splice(0)) release();
    expect(await read).toBe(pending);
    expect(original).toHaveBeenCalledExactlyOnceWith("inputs.revisionPending", readParams, PendingRevisionViewSchema);
    expect(original.mock.contexts[0]).toBe(client);
    expect(original.mock.calls[0]![1]).toBe(readParams);
    expect(probe.pendingReadsWaiting).toBe(0);
    expect(probe.receipts).toEqual([]);
    expect(probe.errors).toEqual([]);
    expect(probe.methods).toEqual([]);
    expect(JSON.stringify(probe)).not.toContain("SYNTHETIC-PROTECTED-CORRECTION");
  });
});
