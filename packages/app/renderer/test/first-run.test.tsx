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
function setup() {
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
