/** Exact shared declaration mappings, distinct receipt shapes and atomic owner acknowledgement loss. */
import { describe, expect, it, vi } from "vitest";
import type { CheckoutEvidence, GuidedLaunchPorts, LaunchResponse } from "../../src/configuration-launch-contract.js";
import type { LaunchPorts, LaunchReceipt } from "../src/guided-launch/contracts.js";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import {
  editorTarget,
  sharedLaunchReview,
  sharedLaunchResult,
  sharedPreflight,
  sharedSubmission,
  sharedRecovery,
} from "../src/guided-launch/shared-bindings.js";
import { launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

function checkout(): CheckoutEvidence {
  return {
    state: "verified",
    target: editorTarget(launchContext().target),
    configGeneration: "generation-1",
    evidenceId: "root-evidence-1",
    profile: "prepared-local",
    repository: "/synthetic/repository",
    cwd: "/synthetic/owned-checkout",
    branch: "synthetic/disposable",
    baseCommit: "synthetic-base",
    asOf: "2026-10-08T00:00:00Z",
  };
}
const decode = (raw: unknown): LaunchReceipt => raw as LaunchReceipt; // Synthetic already-typed fixture decoder only.
describe("shared guided-launch declaration bindings", () => {
  it("preserves canonical flat Request recovery and uses the explicit inspection action", async () => {
    const recover = vi.fn<GuidedLaunchPorts["recover"]>().mockResolvedValue({
      kind: "request",
      receipt: { state: "accepted", admissionId: "admission", requestId: "request", runId: "run" },
    });
    const assertCurrent = vi.fn();
    const call = sharedRecovery(
      { recover },
      { target: launchContext().target, mode: "request", action: "inspect", assertCurrent, decodeRetryReceipt: decode },
    );
    expect(await call({ id: "durable-intent" })).toEqual({
      state: "accepted",
      admissionId: "admission",
      requestId: "request",
      runId: "run",
    });
    expect(recover).toHaveBeenCalledWith("durable-intent", "inspect");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("requires the full canonical checkout observation instead of upgrading a display summary", async () => {
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), launchPorts());
    await controller.preview();
    const submit = vi.fn<GuidedLaunchPorts["submit"]>();
    const launch = sharedSubmission({ submit }, { assertCurrent: () => {}, decodeRetryReceipt: decode });
    await expect(launch(controller.read().review!)).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });
  it("uses canonical review names and excludes client retry/scope fields", async () => {
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), launchPorts());
    await controller.preview();
    const mapped = sharedLaunchReview(controller.read().review!, checkout());
    expect(mapped).toMatchObject({
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      checkout: { profile: "prepared-local", evidenceId: "root-evidence-1" },
    });
    expect(Object.keys(mapped.target).sort()).toEqual(["epoch", "instanceId", "workspaceId"]);
    expect(mapped.command.params).not.toHaveProperty("expectedScope");
    expect(mapped.command.params).not.toHaveProperty("idempotencyKey");
    expect(() =>
      sharedLaunchReview(controller.read().review!, { state: "unavailable", reason: "No authoritative evidence" }),
    ).toThrow();
    const stale = checkout();
    if (stale.state === "verified") stale.configGeneration = "changed";
    expect(() => sharedLaunchReview(controller.read().review!, stale)).toThrow();
  });
  it("retains flat direct and Request receipts and unflattened retry envelopes", () => {
    const direct: LaunchResponse = {
      kind: "direct",
      receipt: { state: "accepted", operationId: "op", admissionId: "ad", runId: "run" },
    };
    const request: LaunchResponse = {
      kind: "request",
      receipt: { state: "accepted", admissionId: "ad", requestId: "request", runId: "run" },
    };
    expect(sharedLaunchResult(direct, "direct", decode)).toEqual(direct.receipt);
    expect(sharedLaunchResult(request, "request", decode)).toEqual(request.receipt);
    const retry: LaunchResponse = {
      kind: "retry",
      receipt: {
        state: "resolved",
        operationId: "op",
        replayed: false,
        result: { state: "accepted", admissionId: "ad", runId: "run" },
      },
    };
    expect(sharedLaunchResult(retry, "direct", decode)).toEqual(retry.receipt);
    expect(() => sharedLaunchResult(direct, "request", decode)).toThrow();
    expect(() => sharedLaunchResult(retry, "request", decode)).toThrow();
    expect(() =>
      sharedLaunchResult(retry, "direct", () => {
        throw new Error("canonical decoder refused");
      }),
    ).toThrow();
  });
  it("does not decode or flatten in-progress recovery", () => {
    const parser = vi.fn();
    const response: LaunchResponse = {
      kind: "retry",
      receipt: { state: "in-progress", operationId: "op", recovery: "inspect-or-retry" },
    };
    expect(sharedLaunchResult(response, "direct", parser)).toEqual(response.receipt);
    expect(parser).not.toHaveBeenCalled();
  });
  it("maps coherent preflight and actual checkout evidence without adding wire fields", async () => {
    const preflight = vi.fn<GuidedLaunchPorts["preflight"]>().mockResolvedValue({
      target: editorTarget(launchContext().target),
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      validation: { ok: true, errors: [], warnings: [] },
      asOf: "2026-10-08T00:00:00Z",
    });
    const ports = { preflight, checkout: vi.fn<GuidedLaunchPorts["checkout"]>().mockResolvedValue(checkout()) };
    const assertCurrent = vi.fn();
    const call = sharedPreflight(ports, { assertCurrent, configuredRootId: "disposable-root" });
    const candidate = {
      target: launchContext().target,
      mode: "direct" as const,
      rootId: "disposable-root",
      workflowId: "synthetic-work",
      workflowVersion: "1",
      vars: { count: 0, enabled: false },
    };
    const result = await call(candidate);
    expect(result.rootRevision).toBe("root-evidence-1");
    expect(preflight.mock.calls[0]![0]).toEqual({
      target: { workspaceId: candidate.target.workspaceId, instanceId: candidate.target.instanceId },
      purpose: "workflow",
      workflowId: "synthetic-work",
      workflowVersion: "1",
      vars: candidate.vars,
    });
    await expect(call({ ...candidate, rootId: "arbitrary-root" })).rejects.toThrow();
    await expect(
      call({ ...candidate, mode: "request", overrides: { model: "unsupported-projection" } }),
    ).rejects.toThrow();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalled();
  });
  it("consumes authoritative Request override validation and preserves validation errors without a second selection validator", async () => {
    const preflight = vi.fn<GuidedLaunchPorts["preflight"]>().mockResolvedValue({
      target: editorTarget(launchContext().target),
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      validation: { ok: true, errors: [], warnings: [] },
      selections: [],
      inputSchema: null,
      asOf: "2026-10-08T00:00:00Z",
    });
    const call = sharedPreflight(
      { preflight, checkout: vi.fn<GuidedLaunchPorts["checkout"]>().mockResolvedValue(checkout()) },
      {
        assertCurrent: () => {},
        configuredRootId: "disposable-root",
      },
    );
    const candidate = {
      target: launchContext().target,
      mode: "request" as const,
      rootId: "disposable-root",
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      vars: {},
      request: { title: "Reviewed Request", body: "Reviewed body" },
      overrides: { model: { "agent-1": "declared-model" } },
    };
    expect((await call(candidate)).selections).toEqual([]);
    expect(preflight.mock.calls[0]?.[0]).toMatchObject({
      overrides: candidate.overrides,
      request: candidate.request,
      expectedConfigGeneration: "generation-1",
    });
    preflight.mockResolvedValue({
      target: editorTarget(launchContext().target),
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      validation: {
        ok: false,
        errors: [{ path: "overrides.model.agent-1", message: "Model is unavailable" }],
        warnings: [],
      },
      asOf: "2026-10-08T00:00:00Z",
    });
    expect((await call(candidate)).validation.errors[0]?.path).toBe("overrides.model.agent-1");
  });
  it("uses canonical atomic submission and retains the returned durable handle", async () => {
    const ownerSubmit = vi.fn<GuidedLaunchPorts["submit"]>().mockResolvedValue({
      intent: {
        intentId: "shared-intent",
        mode: "direct",
        workflowId: "synthetic-work",
        target: editorTarget(launchContext().target),
      },
      response: {
        kind: "direct",
        receipt: {
          state: "accepted",
          operationId: "shared-operation",
          admissionId: "shared-admission",
          runId: "shared-run",
        },
      },
    });
    const ports = launchPorts();
    const { retain: _retain, ...base } = ports;
    const launch = sharedSubmission({ submit: ownerSubmit }, { assertCurrent: () => {}, decodeRetryReceipt: decode });
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), { ...base, launch });
    base.preflight.mockResolvedValue({
      target: editorTarget(launchContext().target),
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      validation: { ok: true, errors: [], warnings: [] },
      rootId: "disposable-root",
      rootRevision: "root-evidence-1",
      checkout: checkout(),
    });
    await controller.preview();
    await controller.submit();
    expect(ownerSubmit).toHaveBeenCalledTimes(1);
    expect(ports.submit).not.toHaveBeenCalled();
    expect(controller.read().intent).toEqual({ id: "shared-intent" });
    expect(controller.read().phase).toBe("admitted");
  });
  it("preserves exact original review on atomic acknowledgement loss and never invents a handle", async () => {
    const launch = vi.fn<NonNullable<LaunchPorts["launch"]>>().mockRejectedValue(new Error("response lost"));
    const { retain: _retain, ...ports } = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), { ...ports, launch });
    await controller.preview();
    const review = controller.read().review!;
    await controller.submit();
    controller.edit({ ...launchDraft(), vars: { task: "replacement" } });
    await controller.newWork();
    expect(controller.read().draft).toEqual(launchDraft());
    expect(controller.read().intent).toBeUndefined();
    expect(controller.read().unresolvedReview).toEqual(review);
    launch.mockResolvedValue({
      intent: { id: "original" },
      response: { state: "accepted", operationId: "op", admissionId: "ad", runId: "run" },
    });
    await controller.recover();
    expect(launch).toHaveBeenNthCalledWith(2, review);
    expect(controller.read().phase).toBe("admitted");
  });
  it("blocks blind retry when the unknown durable handle outlives its original connection", async () => {
    const launch = vi.fn<NonNullable<LaunchPorts["launch"]>>().mockRejectedValue(new Error("lost"));
    const { retain: _retain, ...ports } = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), { ...ports, launch });
    await controller.preview();
    await controller.submit();
    const changed = launchContext();
    changed.target.epoch = 2;
    controller.contextChanged(changed);
    controller.reviewTarget();
    await controller.recover();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(controller.read().message).toContain("handle is unavailable");
    expect(controller.read().unresolvedReview).toBeDefined();
  });
});
