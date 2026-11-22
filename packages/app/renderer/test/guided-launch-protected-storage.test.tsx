// @vitest-environment happy-dom
/**
 * #857: a protected-storage refusal is shown as its cause with recovery guidance and a
 * retry, not as a generic failure. The exact reviewed command stays ready, nothing is left
 * looking retained, and Retry submits the same review once storage is available.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GuidedLaunchController } from "../src/guided-launch/controller.js";
import { LaunchPortFailure, type LaunchPorts } from "../src/guided-launch/contracts.js";
import { GuidedLaunch } from "../src/guided-launch/guided-launch.js";
import { unwrap } from "../src/guided-launch/production-bindings.js";
import { harness } from "./harness.js";
import { launchContext, launchDraft, launchPorts } from "./guided-launch-fixtures.js";

const KEYRING =
  "Secure run-intent storage is unavailable. No run was submitted. The system keyring did not give ORCA its encryption key: the keyring is locked or not set up yet, or its prompt was cancelled. ORCA can ask the keyring only once each time it starts, so quit and reopen ORCA, follow the system prompt to create or unlock your keyring, then launch again.";
const accepted = {
  intent: { id: "protected-intent-1" },
  response: { state: "accepted", operationId: "op", admissionId: "admission", runId: "run-original" },
} as const;
function refused(
  reason: "keyring-locked" | "no-keyring" | "unavailable" = "keyring-locked",
  message = KEYRING,
  stage: "before-send" | "after-send" | "unconfirmed" = "before-send",
) {
  return new LaunchPortFailure("protected-storage", { reason, stage, message });
}
function setup() {
  const launch = vi.fn<NonNullable<LaunchPorts["launch"]>>();
  const ports = { ...launchPorts(), launch };
  const controller = new GuidedLaunchController(launchContext(), launchDraft(), ports);
  return { launch, ports, controller };
}
const teardown: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

describe("guided launch protected-storage refusal (#857)", () => {
  it("maps the bridge's PROTECTED_STORAGE code to a classified refusal, and other codes stay generic", () => {
    expect(() =>
      unwrap({
        ok: false,
        error: {
          code: "PROTECTED_STORAGE",
          message: KEYRING,
          details: { reason: "keyring-locked", stage: "before-send" },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        reason: "protected-storage",
        storage: { reason: "keyring-locked", stage: "before-send", message: KEYRING },
      }),
    );
    expect(() =>
      unwrap({ ok: false, error: { code: "PROTECTED_STORAGE", message: "m", details: { reason: "keyring-locked" } } }),
    ).toThrow(expect.objectContaining({ storage: { reason: "keyring-locked", stage: "unconfirmed", message: "m" } }));
    expect(() =>
      unwrap({ ok: false, error: { code: "PROTECTED_STORAGE", message: "m", details: { reason: "bogus" } } }),
    ).toThrow(expect.objectContaining({ storage: { reason: "unavailable", stage: "unconfirmed", message: "m" } }));
    expect(() => unwrap({ ok: false, error: { code: "AGENT_TRANSPORT", message: KEYRING } })).toThrow(
      expect.objectContaining({ reason: "unavailable", storage: undefined }),
    );
  });
  it("keeps the exact review ready with the cause and guidance, and leaves nothing to recover", async () => {
    const f = setup();
    f.launch.mockRejectedValueOnce(refused());
    await f.controller.preview();
    const review = f.controller.read().review;
    await f.controller.submit();
    const state = f.controller.read();
    expect(state.phase).toBe("review");
    expect(state.review).toBe(review);
    expect(state.unresolvedReview).toBeUndefined();
    expect(state.intent).toBeUndefined();
    expect(state.storageRefusal).toEqual({
      reason: "keyring-locked",
      stage: "before-send",
      message: `${KEYRING} Your draft is retained.`,
    });
    expect(state.message).toContain("its prompt was cancelled");
    expect(state.message).not.toContain("launch operation is unavailable");
    expect(f.ports.announce).toHaveBeenCalledWith(`${KEYRING} Your draft is retained.`);
    expect(f.ports.navigate).not.toHaveBeenCalled();
  });
  it.each(["after-send", "unconfirmed"] as const)(
    "keeps the original launch to recover, with no Retry, on a %s refusal",
    async (stage) => {
      const f = setup();
      f.launch.mockRejectedValueOnce(refused("keyring-locked", "Sent; unlock and recover.", stage));
      await f.controller.preview();
      await f.controller.submit();
      const state = f.controller.read();
      expect(state.phase).toBe("blocked");
      expect(state.storageRefusal).toBeUndefined();
      expect(state.unresolvedReview).toBeDefined();
      expect(state.message).toContain("Sent; unlock and recover.");
      expect(state.message).toContain("Recover original launch");
      await f.controller.retryProtectedStorage();
      expect(f.launch).toHaveBeenCalledTimes(1);
    },
  );
  it("retries the same reviewed command once storage is available", async () => {
    const f = setup();
    f.launch.mockRejectedValueOnce(refused()).mockResolvedValueOnce(accepted);
    await f.controller.preview();
    await f.controller.submit();
    await f.controller.retryProtectedStorage();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[1]![0]).toBe(f.launch.mock.calls[0]![0]);
    expect(f.controller.read().phase).toBe("admitted");
    expect(f.controller.read().storageRefusal).toBeUndefined();
  });
  it("any other phase change retires the refusal", async () => {
    const f = setup();
    f.launch.mockRejectedValueOnce(refused());
    await f.controller.preview();
    await f.controller.submit();
    f.controller.edit({ ...launchDraft(), vars: { ...launchDraft().vars, task: "changed" } });
    expect(f.controller.read().storageRefusal).toBeUndefined();
    await f.controller.retryProtectedStorage();
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["keyring-locked", "Keyring locked, not set up, or prompt cancelled", false],
    ["no-keyring", "No system keyring available", false],
    ["unavailable", "Secure storage unavailable", true],
  ] as const)(
    "renders a %s refusal as an error state; Retry only where a retry can work",
    async (reason, title, retry) => {
      const h = harness();
      teardown.push(h.dispose);
      const f = setup();
      f.launch.mockRejectedValueOnce(refused(reason, `Guidance for ${reason}.`)).mockResolvedValueOnce(accepted);
      render(
        <h.Providers>
          <GuidedLaunch
            controller={f.controller}
            onClose={() => {}}
            onConfiguration={() => {}}
            onConnections={() => {}}
          />
        </h.Providers>,
      );
      await act(() => f.controller.preview());
      await act(() => f.controller.submit());
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByText(`Guidance for ${reason}. Your draft is retained.`)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Recover original launch" })).toBeNull();
      const button = screen.queryByRole("button", { name: "Retry launch" });
      if (!retry) {
        // A Linux keyring refusal holds until ORCA restarts: no in-app Retry is offered.
        expect(button).toBeNull();
        return;
      }
      await act(async () => {
        fireEvent.click(button!);
      });
      expect(f.launch).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: "Retry launch" })).toBeNull();
    },
  );
});
