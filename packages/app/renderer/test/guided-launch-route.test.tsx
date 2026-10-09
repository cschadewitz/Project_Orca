// @vitest-environment happy-dom
/** Real shell routing, persistent drafts, permission review and exact protected recovery wiring. */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrcaBridge } from "../../src/bridge.js";
import type { GuidedLaunchSnapshot } from "../../src/guided-launch-bridge.js";
import type { LaunchReview, RetainedLaunch } from "../../src/configuration-launch-contract.js";
import type { DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import type { DiagnosticsStatus } from "../../src/diagnostics-contract.js";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_TASK } from "../../src/first-run-sample.js";
import { hasUpdateDrafts } from "../src/update-drafts.js";
import { launchUrl, resolveRoute } from "../src/route-table.js";
import { fakeBridge } from "./fake-bridge.js";
import { CONFIG_GET } from "./fixtures-config.js";
import { harness, renderChrome } from "./harness.js";
const teardown: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});
function setup({ disconnected = false, lose = false, prepared = false, sample = false } = {}) {
  const workflowId = sample ? FIRST_RUN_SAMPLE.id : "safe-fixture";
  const workflowRevision = sample ? FIRST_RUN_SAMPLE.revision : "digest-1";
  const fake = fakeBridge({ deepLink: "orca://config" });
  const bridge = fake.bridge;
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    url: "http://localhost:7331",
    source: "bundled",
    environmentOverride: false,
    identity: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
    },
  };
  const listeners = new Set<(value: DaemonTargetSnapshot) => void>();
  bridge.daemonConnection = {
    read: () => target,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    show: vi.fn(),
    onShow: () => () => {},
    connect: async () => ({ ok: true }),
    cancel: () => {},
    activate: () => {},
  };
  const snapshot = (): GuidedLaunchSnapshot => ({
    target: { ...target.identity!, epoch: target.epoch },
    endpointId: "bundled:/synthetic/project",
    principalId: "operator",
    activeGeneration: "generation-1",
    operations: ["operator.admitRun", "operator.submitRequest", "operator.admission", "operator.reconcileAdmission"],
    checkout: {
      state: "verified",
      target: { ...target.identity!, epoch: target.epoch },
      configGeneration: "generation-1",
      evidenceId: "root-1",
      profile: "prepared-local",
      repository: "/synthetic/project",
      cwd: "/synthetic/project",
      branch: "prepared",
      baseCommit: "fixture-base",
      asOf: "2026-10-08T00:00:00Z",
    },
    workflows: catalogMissing
      ? []
      : [
          {
            id: workflowId,
            name: "Safe fixture",
            version: "1",
            revision: workflowRevision,
            inputSchema: {
              fields: {
                task: { type: "string", required: true },
                count: { type: "integer" },
                enabled: { type: "boolean" },
                token: { type: "string", sensitive: true },
              },
            },
          },
        ],
  });
  let retainedReview: LaunchReview | undefined;
  let catalogMissing = false;
  const intent = (): RetainedLaunch => ({
    intentId: "opaque-exact-intent",
    target: retainedReview?.target ?? snapshot().target,
    workflowId,
    mode: retainedReview?.command.mode ?? "direct",
    operationId: "operation-original",
    admissionId: "admission-original",
  });
  const response = () => ({
    kind: "retry" as const,
    receipt: {
      state: "resolved" as const,
      operationId: "operation-original",
      replayed: true,
      result: prepared
        ? { state: "prepared" as const, admissionId: "admission-original" }
        : {
            state: "accepted" as const,
            admissionId: "admission-original",
            ...(retainedReview?.command.mode === "request" ? { requestId: "request-original" } : {}),
            runId: "run-parent",
          },
    },
  });
  const guided = {
    snapshot: vi.fn(async () => ({ ok: true as const, result: snapshot() })),
    preflight: vi.fn<NonNullable<OrcaBridge["guidedLaunch"]>["preflight"]>(async (params) => ({
      ok: true,
      result: {
        checkout: snapshot().checkout,
        preflight: {
          target: params.target,
          workflowId,
          workflowVersion: "1",
          expectedWorkflowRevision: workflowRevision,
          expectedConfigGeneration: "generation-1",
          validation: { ok: true, errors: [], warnings: [] },
          asOf: "2026-10-08T00:00:00Z",
        },
      },
    })),
    submit: vi.fn<NonNullable<OrcaBridge["guidedLaunch"]>["submit"]>(async (review) => {
      retainedReview = structuredClone(review);
      if (lose) return { ok: false, error: { code: "AGENT_TRANSPORT", message: "private transport needle" } };
      return { ok: true, result: { intent: intent(), response: response() } };
    }),
    retained: vi.fn(async () => ({ ok: true as const, result: retainedReview ? [intent()] : [] })),
    resolve: vi.fn<NonNullable<OrcaBridge["guidedLaunch"]>["resolve"]>(async (review) => ({
      ok: true,
      result: JSON.stringify(review) === JSON.stringify(retainedReview) ? intent() : undefined,
    })),
    load: vi.fn<NonNullable<OrcaBridge["guidedLaunch"]>["load"]>(async () => ({
      ok: true,
      result: { intent: intent(), review: retainedReview! },
    })),
    recover: vi.fn<NonNullable<OrcaBridge["guidedLaunch"]>["recover"]>(async () => ({ ok: true, result: response() })),
    abandon: vi.fn(async () => ({ ok: true as const, result: { abandoned: false } })),
  } satisfies NonNullable<OrcaBridge["guidedLaunch"]>;
  bridge.guidedLaunch = guided;
  const status: DiagnosticsStatus = {
    enabled: false,
    productionEnabled: false,
    scopeVersion: 1,
    minutes: 5,
    code: "off",
    previous: false,
    tailLossPossible: true,
    cleanupPending: false,
    acknowledgedUnknown: false,
    olderUnknowns: false,
    payloadReservedBytes: 0,
    revision: 0,
  };
  const diagnostics = {
    status: vi.fn(async () => ({ ok: true as const, value: status })),
    subscribe: vi.fn(() => () => {}),
    setEnabled: vi.fn(async () => ({ ok: true as const, value: status })),
    setMinutes: async () => ({ ok: true as const, value: status }),
    prepareExport: vi.fn(async () => ({ ok: false as const, code: "unavailable" as const })),
    cancelExport: async () => ({ ok: true as const, value: status }),
    chooseDestination: async () => ({ ok: false as const, code: "unavailable" as const }),
    save: async () => ({ ok: false as const, code: "unavailable" as const }),
    discardPrevious: async () => ({ ok: true as const, value: status }),
    retryCleanup: async () => ({ ok: true as const, value: status }),
    acknowledgeUnknown: async () => ({ ok: true as const, value: status }),
  };
  bridge.diagnostics = diagnostics;
  fake.script({
    "config.get": () => ({
      ok: true,
      result: {
        ...CONFIG_GET,
        generation: {
          savedRevision: CONFIG_GET.config.revision,
          activeRevision: CONFIG_GET.config.revision,
          activeGeneration: "generation-1",
          state: "active",
          restartRequired: [],
        },
      },
    }),
  });
  if (disconnected) fake.connect({ ...fake.connection, state: "disconnected" });
  teardown.push(fake.install());
  const h = harness("darwin", bridge.preferences);
  teardown.push(h.dispose);
  renderChrome(h);
  return {
    fake,
    h,
    guided,
    diagnostics,
    bridge,
    review: () => retainedReview,
    seed: (review: LaunchReview) => {
      retainedReview = review;
      catalogMissing = true;
    },
    reconnect: () => {
      target = {
        ...target,
        epoch: target.epoch + 1,
        identity: { ...target.identity!, instanceId: "33333333-3333-4333-8333-333333333333" },
      };
      act(() => listeners.forEach((fn) => fn(target)));
    },
  };
}
async function enter() {
  fireEvent.click(await screen.findByRole("button", { name: "Launch work" }));
  await screen.findByRole("heading", { name: "Launch work" });
  fireEvent.click(screen.getByRole("button", { name: "Workflow" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Safe fixture/ }));
  fireEvent.change(screen.getByLabelText(/^task/), { target: { value: "Make a safe change" } });
}
async function preview() {
  fireEvent.click(screen.getByRole("button", { name: "Preview launch" }));
  await screen.findByRole("checkbox", { name: /I reviewed the configured permission policy/ });
}
describe("mounted guided launch route", () => {
  it("selects the exact smoke-check task without launching and still requires explicit permission review", async () => {
    const f = setup({ sample: true, prepared: true });
    fireEvent.click(await screen.findByRole("button", { name: "Launch work" }));
    await screen.findByRole("heading", { name: "Launch work" });
    const choose = screen.getByRole("button", { name: "Choose harmless launch smoke check" });
    await waitFor(() => expect(choose.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(choose);
    expect(screen.getByLabelText<HTMLInputElement>(/^task/).value).toBe(FIRST_RUN_SAMPLE_TASK);
    expect(f.guided.preflight).not.toHaveBeenCalled();
    expect(f.guided.submit).not.toHaveBeenCalled();
    await preview();
    expect(f.guided.preflight.mock.calls[0]![0]).toMatchObject({
      purpose: "workflow",
      workflowId: FIRST_RUN_SAMPLE.id,
      vars: { task: FIRST_RUN_SAMPLE_TASK },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(f.guided.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(f.guided.submit).toHaveBeenCalledTimes(1));
    expect(f.review()).toMatchObject({
      workflowId: FIRST_RUN_SAMPLE.id,
      workflowVersion: FIRST_RUN_SAMPLE.version,
      expectedWorkflowRevision: FIRST_RUN_SAMPLE.revision,
      command: { mode: "direct", params: { vars: { task: FIRST_RUN_SAMPLE_TASK } } },
    });
    expect(
      screen.getByRole("button", { name: "Choose harmless launch smoke check" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
  it("keeps diagnostics mounted and typed drafts protected across Config/launch navigation, with per-preview permission review", async () => {
    const f = setup({ prepared: true });
    const diagnostics = await screen.findByRole("region", { name: "Local diagnostics" });
    await enter();
    expect(screen.getByRole("region", { name: "Local diagnostics" })).toBe(diagnostics);
    expect(f.diagnostics.status).toHaveBeenCalledTimes(1);
    expect(f.diagnostics.subscribe).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(/^count/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/^enabled/), { target: { value: "false" } });
    expect(hasUpdateDrafts()).toBe(true);
    expect(screen.getByRole("button", { name: "Save protected draft" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Restore protected launch" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Workflow" }));
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("heading", { name: "Launch work" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape", code: "Escape" });
    await screen.findByRole("button", { name: "Launch work" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Launch work" })));
    expect(screen.getByRole("region", { name: "Local diagnostics" })).toBe(diagnostics);
    fireEvent.click(screen.getByRole("button", { name: "Launch work" }));
    await screen.findByRole("heading", { name: "Launch work" });
    expect(screen.getByLabelText<HTMLInputElement>(/^task/).value).toBe("Make a safe change");
    expect(screen.getByLabelText<HTMLInputElement>(/^count/).value).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Launch work" })).toBeNull());
    expect(hasUpdateDrafts()).toBe(true);
    act(() =>
      f.h.keyboard
        .list()
        .find((row) => row.label === "Launch or recover work")!
        .action(),
    );
    await screen.findByRole("heading", { name: "Launch work" });
    expect(screen.getByLabelText<HTMLInputElement>(/^task/).value).toBe("Make a safe change");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview launch" }).getAttribute("aria-disabled")).toBeNull(),
    );
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(f.guided.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    await preview();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /I reviewed/ }).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(f.guided.submit).toHaveBeenCalledTimes(1));
    expect(f.review()?.command.params.vars).toEqual({ task: "Make a safe change", count: 0, enabled: false });
    expect(f.review()?.command.params).not.toHaveProperty("idempotencyKey");
    await screen.findByText(/Admission admission-original \/ prepared/);
    expect(screen.getByRole("heading", { name: "Launch work" })).toBeTruthy();
    expect(f.diagnostics.setEnabled).not.toHaveBeenCalled();
    expect(f.diagnostics.prepareExport).not.toHaveBeenCalled();
  });
  it("binds Request title/body to the guarded Request command and navigates from its distinct accepted receipt", async () => {
    const f = setup();
    await enter();
    fireEvent.click(screen.getByRole("button", { name: "Launch mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Submit a Request" }));
    fireEvent.change(screen.getByLabelText(/^Request title/), { target: { value: "Reviewed task" } });
    fireEvent.change(screen.getByLabelText(/^Request body/), { target: { value: "Specific instructions" } });
    await preview();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(f.guided.submit).toHaveBeenCalledTimes(1));
    expect(f.review()?.command).toMatchObject({
      mode: "request",
      params: { title: "Reviewed task", body: "Specific instructions", workflowVersion: "1" },
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Launch work" })).toBeNull());
    expect(
      f.fake.calls.some(
        (call) => call.method === "runs.get" && (call.params as { runId?: string }).runId === "run-parent",
      ),
    ).toBe(true);
  });
  it("recovers exact lost acknowledgement through main lookup after target review, without a second submission", async () => {
    const f = setup({ lose: true });
    await enter();
    await preview();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await screen.findByRole("button", { name: "Recover original launch" });
    expect(document.body.textContent).not.toContain("private transport needle");
    f.reconnect();
    await waitFor(() => expect(f.guided.snapshot).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Review target" }));
    fireEvent.click(screen.getByRole("button", { name: "Recover original launch" }));
    await waitFor(() => expect(f.guided.resolve).toHaveBeenCalledTimes(1));
    expect(f.guided.resolve.mock.calls[0]![0]).toEqual(f.review());
    expect(f.guided.submit).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(f.guided.recover).toHaveBeenCalledWith({ id: "opaque-exact-intent", action: "reconcile" }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Launch work" })).toBeNull());
    expect(
      f.fake.calls.some(
        (call) => call.method === "runs.get" && (call.params as { runId?: string }).runId === "run-parent",
      ),
    ).toBe(true);
  });
  it("restores an explicitly selected protected command when its workflow is absent, masking values and requiring acknowledged abandonment", async () => {
    const f = setup({ prepared: true });
    const source = (await f.guided.snapshot()).result;
    const params = {
      workflowId: "safe-fixture",
      workflowVersion: "1",
      expectedWorkflowRevision: "digest-old",
      expectedConfigGeneration: "generation-old",
      vars: { task: "protected task needle", token: "protected secret needle" },
    };
    f.seed({
      target: source.target,
      draftSequence: 7,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
      expectedWorkflowRevision: params.expectedWorkflowRevision,
      expectedConfigGeneration: params.expectedConfigGeneration,
      checkout: source.checkout,
      command: { mode: "direct", params },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Launch work" }));
    await screen.findByRole("heading", { name: "Launch work" });
    fireEvent.click(screen.getByRole("button", { name: "Protected launch to restore" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /safe-fixture/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore protected launch" }));
    await screen.findByRole("button", { name: "Recover original launch" });
    expect(f.guided.load).toHaveBeenCalledWith("opaque-exact-intent");
    for (const needle of ["protected task needle", "protected secret needle"])
      expect(document.body.textContent).not.toContain(needle);
    fireEvent.click(screen.getByRole("button", { name: "Start explicit new work" }));
    await waitFor(() => expect(f.guided.abandon).toHaveBeenCalledWith("opaque-exact-intent"));
    expect(screen.getByRole("button", { name: "Recover original launch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recover original launch" }));
    await waitFor(() =>
      expect(f.guided.recover).toHaveBeenCalledWith({ id: "opaque-exact-intent", action: "reconcile" }),
    );
    expect(f.guided.submit).not.toHaveBeenCalled();
    expect(f.guided.preflight).not.toHaveBeenCalled();
  });
  it("offers setup and palette navigation before handshake without enabling capture or launch", async () => {
    const f = setup({ disconnected: true });
    const row = f.h.keyboard.list().find((command) => command.label === "Launch or recover work")!;
    act(() => row.action());
    await screen.findByText(/Connect a writable local daemon/);
    expect(f.guided.snapshot).not.toHaveBeenCalled();
    expect(f.guided.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    expect(f.bridge.daemonConnection?.show).toHaveBeenCalled();
    expect(f.diagnostics.setEnabled).not.toHaveBeenCalled();
    expect(resolveRoute(launchUrl())).toEqual({ kind: "launch", surface: "config" });
    expect(resolveRoute("orca://launch/arbitrary")).toBeUndefined();
  });
});
