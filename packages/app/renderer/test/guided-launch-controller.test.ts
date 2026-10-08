import { describe, expect, it, vi } from "vitest";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import { LaunchPortFailure } from "../src/guided-launch/contracts.js";
import type { LaunchInitialResult, LaunchPorts, LaunchReview } from "../src/guided-launch/contracts.js";
import { parseInput, inputSensitive } from "../src/guided-launch/input-model.js";
import { deferred, launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

describe("guided launch exact review and admission", () => {
  it.each(["unauthorized", "stale", "validation"] as const)(
    "preserves exact retained command on current runtime %s refusal",
    async (reason) => {
      const ports = launchPorts();
      ports.submit.mockRejectedValue(new LaunchPortFailure(reason));
      const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
      await controller.preview();
      await controller.submit();
      expect(controller.read().phase).toBe("blocked");
      expect(controller.read().intent).toEqual({ id: "protected-intent-1" });
      expect(controller.read().draft).toEqual(launchDraft());
      expect(ports.navigate).not.toHaveBeenCalled();
      expect(controller.read().message).toContain("preserved");
      await controller.recover();
      expect(ports.recover).toHaveBeenCalledWith({ id: "protected-intent-1" });
    },
  );
  it("keeps an accepted receipt admitted when navigation fails", async () => {
    const ports = launchPorts();
    ports.navigate.mockImplementation(() => {
      throw new Error("route unavailable");
    });
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    expect(controller.read().phase).toBe("admitted");
    expect(controller.read().message).toContain("Work admitted");
    expect(controller.read().result).toMatchObject({ state: "accepted", runId: "run-original" });
  });
  it("ignores stale asynchronous preflight and leaves the original draft bound to its target", async () => {
    const ports = launchPorts();
    const result = await ports.preflight({
      target: launchContext().target,
      mode: "direct",
      rootId: "disposable-root",
      workflowId: "synthetic-work",
      workflowVersion: "1",
      vars: launchDraft().vars,
    });
    ports.preflight.mockClear();
    const delayed = deferred<typeof result>();
    ports.preflight.mockReturnValue(delayed.promise);
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    const pending = controller.preview();
    const context = launchContext();
    context.target.endpointId = "changed-target";
    controller.contextChanged(context);
    delayed.resolve(result);
    await pending;
    expect(controller.read().review).toBeUndefined();
    expect(controller.read().phase).toBe("blocked");
    expect(controller.read().draftTarget.endpointId).toBe("synthetic-target");
    controller.reviewTarget();
    expect(controller.read().draftTarget.endpointId).toBe("changed-target");
    expect(controller.read().draft).toEqual(launchDraft());
  });
  it("retains user inputs and never sends when protected intent storage refuses", async () => {
    const ports = launchPorts();
    ports.retain.mockRejectedValue(new Error("secure storage unavailable"));
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    expect(ports.submit).not.toHaveBeenCalled();
    expect(controller.read().draft).toEqual(launchDraft());
    expect(controller.read().message).toContain("No launch was sent");
  });
  it("restores draft-only typed inputs through protected storage and invalidates its old review", async () => {
    const ports = launchPorts();
    const loaded = { ...launchDraft(), vars: { task: "Restored protected task", count: 0 } };
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), {
      ...ports,
      drafts: { save: async () => {}, load: async () => loaded },
    });
    await controller.preview();
    await controller.loadDraft();
    expect(controller.read().draft).toEqual(loaded);
    expect(controller.read().review).toBeUndefined();
    expect(controller.read().inputEpoch).toBe(1);
    await controller.submit();
    expect(ports.submit).not.toHaveBeenCalled();
  });
  it("freezes exact values and guards, omits defaults, and retains before sending", async () => {
    const ports = launchPorts();
    const draft = { ...launchDraft(), vars: { task: "", count: 0, enabled: false, nested: [null, { a: 1 }] } };
    const controller = new GuidedLaunchController(launchContext(), draft, ports);
    await controller.preview();
    draft.vars.count = 9;
    const review = controller.read().review!;
    expect(review.command.params.vars).toEqual({ task: "", count: 0, enabled: false, nested: [null, { a: 1 }] });
    expect(review.command.params).toMatchObject({
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
    });
    expect(Object.isFrozen(review.command.params.vars)).toBe(true);
    await controller.submit();
    expect(ports.retain.mock.invocationCallOrder[0]).toBeLessThan(ports.submit.mock.invocationCallOrder[0]!);
    expect(controller.read().phase).toBe("admitted");
    expect(controller.read().result).toMatchObject({
      operationId: "retry-original",
      admissionId: "admission-original",
    });
    expect(ports.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-original" }),
      launchContext().target,
    );
  });
  it("keeps defaulted inputs absent and Request overrides in their own wire field", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(
      launchContext(),
      {
        ...launchDraft(),
        mode: "request",
        overrides: { roles: { build: "agent" }, model: { agent: "model" }, itemWorkflow: "item", templatePack: "pack" },
      },
      ports,
    );
    await controller.preview();
    expect(controller.read().review!.command.params.vars).toEqual({ task: "Make a small change" });
    expect(controller.read().review!.command.params).toMatchObject({
      title: "New task",
      body: "Request body",
      overrides: { roles: { build: "agent" }, model: { agent: "model" }, itemWorkflow: "item", templatePack: "pack" },
    });
    ports.submit.mockResolvedValue({
      state: "accepted",
      admissionId: "request-admission",
      requestId: "request-1",
      runId: "run-1",
    });
    await controller.submit();
    expect(controller.read().result).toEqual({
      state: "accepted",
      admissionId: "request-admission",
      requestId: "request-1",
      runId: "run-1",
    });
  });
  it("rejects direct overrides rather than hiding them in vars", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(
      launchContext(),
      { ...launchDraft(), overrides: { model: "unsupported" } },
      ports,
    );
    await controller.preview();
    await controller.submit();
    expect(ports.preflight).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
    expect(controller.read().message).toContain("do not support overrides");
  });
  it.each(["unavailableReason", "directReason"] as const)("blocks current authority limitation %s", async (field) => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(
      { ...launchContext(), [field]: "Read-only connection" },
      launchDraft(),
      ports,
    );
    await controller.preview();
    await controller.submit();
    expect(ports.preflight).not.toHaveBeenCalled();
    expect(ports.retain).not.toHaveBeenCalled();
  });
  it("blocks missing protected guided intent persistence", async () => {
    const { retain: _retain, ...ports } = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    expect(controller.read().message).toContain("Protected guided-launch intent storage is unavailable");
    expect(ports.submit).not.toHaveBeenCalled();
  });
  it("blocks unverified roots and workflows outside a selected root", async () => {
    const context = launchContext();
    context.roots[0]!.evidence = { state: "unavailable", reason: "Checkout is not verified" };
    const ports = launchPorts();
    const controller = new GuidedLaunchController(context, launchDraft(), ports);
    await controller.preview();
    expect(controller.read().message).toBe("Checkout is not verified");
    controller.contextChanged(launchContext());
    controller.edit({ ...launchDraft(), workflowId: "missing" });
    await controller.preview();
    expect(ports.preflight).not.toHaveBeenCalled();
  });
  it.each(["expectedConfigGeneration", "expectedWorkflowRevision", "workflowVersion", "rootRevision"] as const)(
    "blocks stale %s preflight binding",
    async (field) => {
      const ports = launchPorts();
      ports.preflight.mockResolvedValue({
        ...((await ports.preflight.mock.results[0]?.value) ?? {
          target: launchContext().target,
          workflowId: "synthetic-work",
          workflowVersion: "1",
          expectedWorkflowRevision: "digest-1",
          expectedConfigGeneration: "generation-1",
          rootId: "disposable-root",
          rootRevision: "root-evidence-1",
          validation: { ok: true, errors: [], warnings: [] },
        }),
        [field]: "changed",
      });
      const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
      await controller.preview();
      await controller.submit();
      expect(controller.read().phase).toBe("blocked");
      expect(ports.retain).not.toHaveBeenCalled();
    },
  );
  it("preserves validation errors, warnings and draft", async () => {
    const ports = launchPorts();
    ports.preflight.mockImplementation(async () => ({
      target: launchContext().target,
      workflowId: "synthetic-work",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-1",
      expectedConfigGeneration: "generation-1",
      rootId: "disposable-root",
      rootRevision: "root-evidence-1",
      validation: { ok: false, errors: [{ path: "vars.task", message: "Required value missing" }], warnings: [] },
    }));
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    expect(controller.read().errors[0]!.path).toBe("vars.task");
    expect(controller.read().draft).toEqual(launchDraft());
  });
  it("suppresses double clicks synchronously including protected storage delay", async () => {
    const ports = launchPorts();
    const retained = deferred<{ id: string }>();
    ports.retain.mockReturnValue(retained.promise);
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    const first = controller.submit();
    await controller.submit();
    expect(ports.retain).toHaveBeenCalledTimes(1);
    expect(ports.submit).not.toHaveBeenCalled();
    retained.resolve({ id: "original" });
    await first;
    expect(ports.submit).toHaveBeenCalledTimes(1);
  });
  it("retains exact original intent after lost acknowledgement and recovers once", async () => {
    const ports = launchPorts();
    ports.submit.mockRejectedValue(new Error("transport lost"));
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    controller.edit({ ...launchDraft(), vars: { task: "replacement" } });
    await controller.submit();
    expect(controller.read().draft).toEqual(launchDraft());
    expect(controller.read().phase).toBe("recovering");
    await controller.recover();
    expect(ports.retain).toHaveBeenCalledTimes(1);
    expect(ports.submit).toHaveBeenCalledTimes(1);
    expect(ports.recover).toHaveBeenCalledWith({ id: "protected-intent-1" });
    expect(controller.read().result).toMatchObject({
      state: "resolved",
      replayed: true,
      operationId: "retry-original",
    });
  });
  it.each(["prepared", "recoverable-failure"] as const)(
    "does not navigate from an initial %s receipt",
    async (state) => {
      const ports = launchPorts();
      ports.submit.mockResolvedValue(
        state === "prepared"
          ? { state, operationId: "op", admissionId: "ad" }
          : {
              state,
              operationId: "op",
              admissionId: "ad",
              runId: "not-proof-of-acceptance",
              failure: { code: "RUN_STATE", message: "Retry reconciliation", recovery: "reconcile" },
            },
      );
      const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
      await controller.preview();
      await controller.submit();
      expect(controller.read().phase).toBe("recovering");
      expect(ports.navigate).not.toHaveBeenCalled();
    },
  );
  it("preserves in-progress recovery envelope", async () => {
    const ports = launchPorts();
    ports.submit.mockRejectedValue(new Error("lost"));
    ports.recover.mockResolvedValue({ state: "in-progress", operationId: "op", recovery: "inspect-or-retry" });
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    await controller.recover();
    expect(controller.read().result).toEqual({ state: "in-progress", operationId: "op", recovery: "inspect-or-retry" });
    expect(ports.navigate).not.toHaveBeenCalled();
  });
  it("fences target changes during preflight and late admission", async () => {
    const ports = launchPorts();
    const waiting = deferred<LaunchInitialResult>();
    ports.submit.mockReturnValue(waiting.promise);
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    const pending = controller.submit();
    await Promise.resolve();
    const changed = launchContext();
    changed.target.endpointId = "another-daemon";
    controller.contextChanged(changed);
    waiting.resolve({ state: "accepted", operationId: "op", admissionId: "ad", runId: "old-target-run" });
    await pending;
    expect(ports.navigate).not.toHaveBeenCalled();
    expect(controller.read().intent).toBeDefined();
    controller.reviewTarget();
    await controller.recover();
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("does not send after target changes while retaining protected intent", async () => {
    const ports = launchPorts();
    const retained = deferred<{ id: string }>();
    ports.retain.mockReturnValue(retained.promise);
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    const pending = controller.submit();
    const changed = launchContext();
    changed.target.principalId = "other-principal";
    controller.contextChanged(changed);
    retained.resolve({ id: "original" });
    await pending;
    expect(ports.submit).not.toHaveBeenCalled();
    expect(controller.read().intent).toEqual({ id: "original" });
  });
  it("requires target review after reconnect and recovers without changed configuration defaults", async () => {
    const ports = launchPorts();
    ports.submit.mockRejectedValue(new Error("lost"));
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    const context = launchContext();
    context.target.epoch = 2;
    context.activeGeneration = "generation-2";
    context.workflows = [];
    context.roots = [];
    controller.contextChanged(context);
    await controller.recover();
    expect(ports.recover).not.toHaveBeenCalled();
    controller.reviewTarget();
    await controller.recover();
    expect(ports.recover).toHaveBeenCalledWith({ id: "protected-intent-1" });
    expect(ports.preflight).toHaveBeenCalledTimes(1);
  });
  it("invalidates reviewed command when inputs or context change", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    controller.edit({ ...launchDraft(), vars: { task: "changed" } });
    await controller.submit();
    expect(ports.retain).not.toHaveBeenCalled();
    await controller.preview();
    controller.contextChanged(launchContext());
    await controller.submit();
    expect(ports.retain).not.toHaveBeenCalled();
  });
  it("blocks invalid typed values before preflight", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(
      launchContext(),
      { ...launchDraft(), vars: { task: undefined } },
      ports,
    );
    await controller.preview();
    expect(ports.preflight).not.toHaveBeenCalled();
  });
  it("requires explicit abandonment for new work without cancelling a run", async () => {
    const ports = launchPorts();
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await controller.preview();
    await controller.submit();
    ports.abandon.mockResolvedValue(false);
    await controller.newWork();
    expect(controller.read().intent).toBeDefined();
    ports.abandon.mockResolvedValue(true);
    await controller.newWork();
    expect(controller.read().intent).toBeUndefined();
    ports.retain.mockResolvedValue({ id: "new-intent" });
    await controller.preview();
    await controller.submit();
    expect(ports.submit).toHaveBeenNthCalledWith(2, { id: "new-intent" });
  });
  it("restores a protected exact-command intent in a fresh controller and blocks foreign scope", async () => {
    const ports = launchPorts();
    const original = new GuidedLaunchController(launchContext(), launchDraft(), ports);
    await original.preview();
    const review = original.read().review!;
    const restore = vi
      .fn<NonNullable<LaunchPorts["restore"]>>()
      .mockResolvedValue({ review, intent: { id: "original" }, draft: launchDraft() });
    const fresh = new GuidedLaunchController(launchContext(), launchDraft(), { ...ports, restore });
    await fresh.restore();
    await fresh.recover();
    expect(ports.recover).toHaveBeenCalledWith({ id: "original" });
    const foreignReview: LaunchReview = { ...review, target: { ...review.target, principalId: "foreign" } };
    restore.mockResolvedValue({ review: foreignReview, intent: { id: "foreign" }, draft: launchDraft() });
    const foreign = new GuidedLaunchController(launchContext(), launchDraft(), { ...ports, restore });
    await foreign.restore();
    expect(foreign.read().intent).toBeUndefined();
  });
  it("saves only through injected protected storage and retains inputs on refusal", async () => {
    const ports = launchPorts();
    const save = vi
      .fn<NonNullable<LaunchPorts["drafts"]>["save"]>()
      .mockRejectedValue(new Error("keychain unavailable"));
    const controller = new GuidedLaunchController(launchContext(), launchDraft(), {
      ...ports,
      drafts: { save, load: async () => undefined },
    });
    await controller.saveDraft();
    expect(save).toHaveBeenCalledWith(launchContext().target, launchDraft());
    expect(controller.read().draft).toEqual(launchDraft());
    expect(controller.read().message).toContain("failed");
  });
});
describe("typed launch input parsing", () => {
  it.each([
    ["integer", "0", 0],
    ["boolean", "false", false],
    ["string", "", ""],
    ["object", '{"a":1}', { a: 1 }],
    ["array", "[0,false,null]", [0, false, null]],
  ])("preserves %s values", (type, text, value) => {
    expect(parseInput({ type }, text)).toEqual({ ok: true, value });
  });
  it.each([
    ["integer", "1.1"],
    ["boolean", "0"],
    ["number", '"2"'],
    ["object", "[]"],
    ["unknown", "value"],
  ])("rejects unsupported or incorrectly typed %s", (type, text) => {
    expect(parseInput({ type }, text).ok).toBe(false);
  });
  it("withholds nested sensitive values", () => {
    expect(inputSensitive({ type: "object", properties: { token: { type: "string", sensitive: true } } })).toBe(true);
  });
});
