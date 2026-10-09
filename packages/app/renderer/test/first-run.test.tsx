// @vitest-environment happy-dom
/** Directory review controls and safe refusal handling, with no automatic setup, provider or launch. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FirstRunBridge, FirstRunStatus } from "../../src/first-run-contract.js";
import { FIRST_RUN_SAMPLE } from "../../src/first-run-sample.js";
import { FirstRunSection } from "../src/first-run/first-run-section.js";
import { fakeBridge } from "./fake-bridge.js";
import { harness } from "./harness.js";
const teardown: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});
function setup(overrides: Partial<FirstRunBridge> = {}) {
  const fake = fakeBridge();
  let state: FirstRunStatus = { state: "selection-required", reason: "Explicit owned directories required." };
  const firstRun = {
    status: vi.fn<FirstRunBridge["status"]>(async () => ({ ok: true, result: state })),
    choose: vi.fn<FirstRunBridge["choose"]>(async () => {
      state = {
        state: "review",
        review: {
          id: "main-review",
          project: "/Sample α",
          workspace: "/App β",
          branch: "prepared",
          baseCommit: "base",
          sample: FIRST_RUN_SAMPLE,
        },
      };
      return { ok: true, result: state };
    }),
    prepare: vi.fn<FirstRunBridge["prepare"]>(async () => {
      state = { state: "prepared", project: "/Sample α", workspace: "/App β", sample: FIRST_RUN_SAMPLE };
      return { ok: true, result: state };
    }),
    connect: vi.fn<FirstRunBridge["connect"]>(async () => ({ ok: true, result: state })),
  } satisfies FirstRunBridge;
  Object.assign(firstRun, overrides);
  Object.assign(fake.bridge, { firstRun });
  teardown.push(fake.install());
  const h = harness();
  teardown.push(h.dispose);
  render(
    <h.Providers>
      <FirstRunSection />
    </h.Providers>,
  );
  return { firstRun, h };
}
it("requires explicit directory review, create and connect actions, and labels the remaining coding/provider gates", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  expect(f.firstRun.choose).not.toHaveBeenCalled();
  expect(f.firstRun.prepare).not.toHaveBeenCalled();
  expect(f.firstRun.connect).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  expect(screen.getByText(/Project: \/Sample α/)).toBeTruthy();
  expect(screen.getByText(/Sample: orca-beta-local-check/)).toBeTruthy();
  expect(f.firstRun.prepare).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create reviewed sample files" })));
  expect(f.firstRun.prepare).toHaveBeenCalledExactlyOnceWith("main-review");
  expect(f.firstRun.connect).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect selected local workspace" })));
  expect(f.firstRun.connect).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/The #420 coding task and a real local-agent run require separate/)).toBeTruthy();
});
it("keeps the selected review after a refused write and never displays private native error text", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  f.firstRun.prepare.mockResolvedValueOnce({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message: "private path/secret needle" },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create reviewed sample files" })));
  expect(screen.getByText(/Setup was refused/)).toBeTruthy();
  expect(screen.queryByText(/private path\/secret needle/)).toBeNull();
  expect(screen.getByRole("button", { name: "Create reviewed sample files" })).toBeTruthy();
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});

it("requires explicit recovery preparation and reconciliation without connecting or resuming work", async () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const prepared: FirstRunStatus = {
    state: "prepared",
    project: "/Sample α",
    workspace: "/App β",
    sample: FIRST_RUN_SAMPLE,
  };
  const prepareRecovery = vi.fn(async () => ({
    ok: true as const,
    result: { state: "recovery" as const, recovery: { state: "ready" as const, requestId } },
  }));
  const reconcileRecovery = vi.fn(async () => ({ ok: true as const, result: prepared }));
  const f = setup({ status: async () => ({ ok: true, result: prepared }), prepareRecovery, reconcileRecovery });
  await screen.findByRole("button", { name: "Review same-boot recovery" });
  expect(prepareRecovery).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Review same-boot recovery" })));
  expect(prepareRecovery).toHaveBeenCalledOnce();
  expect(screen.getByText(/Recovery checks exclusive ownership/)).toBeTruthy();
  expect(reconcileRecovery).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconcile same-boot ownership" })));
  expect(reconcileRecovery).toHaveBeenCalledExactlyOnceWith(requestId);
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});
it("reviews executable availability and requires explicit saved-config binding without provider execution", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const reviewConfiguration = vi.fn(async () => ({
    ok: true as const,
    result: {
      state: "configuration-review" as const,
      review: {
        id,
        revision: "synthetic revision",
        agentCount: 1,
        checks: [{ agentId: "local", state: "missing" as const }],
      },
    },
  }));
  const bindConfiguration = vi.fn(async () => ({
    ok: true as const,
    result: { state: "prepared" as const, project: "/Sample α", workspace: "/App β", sample: FIRST_RUN_SAMPLE },
  }));
  const f = setup({ reviewConfiguration, bindConfiguration });
  await screen.findByRole("button", { name: "Review saved configuration for reopening" });
  expect(reviewConfiguration).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Review saved configuration for reopening" })),
  );
  expect(screen.getByText(/Executable missing from the app PATH/)).toBeTruthy();
  expect(bindConfiguration).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bind reviewed saved configuration" })));
  expect(bindConfiguration).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.firstRun.connect).not.toHaveBeenCalled();
});
it("shows fixed recovery instructions while withholding arbitrary native error text", async () => {
  const f = setup();
  await screen.findByText("Explicit owned directories required.");
  f.firstRun.choose.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "AGENT_TRANSPORT",
      message: "Local startup ownership requires reconciliation. private secret needle",
    },
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose project and empty workspace" })));
  expect(screen.getByText(/Review same-boot recovery, then reconcile when the owned writer has exited/)).toBeTruthy();
  expect(screen.queryByText(/private secret needle/)).toBeNull();
});
