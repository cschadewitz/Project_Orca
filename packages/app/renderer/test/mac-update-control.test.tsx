// @vitest-environment happy-dom
/** Exact Mac approval/defer UI; retains the shared root draft freeze and hides unavailable owners. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateControl } from "../src/chrome/update-control.js";
import { harness, installBridge } from "./harness.js";
import type { MacUpdateView } from "../../src/mac-update-contract.js";
afterEach(cleanup);

it("makes exact approval and automatic restart explicit, offers defer and never calls the Windows driver", async () => {
  const fake = installBridge({ platform: "darwin" });
  const h = harness("darwin");
  let push!: (state: MacUpdateView) => void;
  let state: MacUpdateView = {
    phase: "available",
    offerId: "offer-one",
    manifestSha256: "a".repeat(64),
    version: "0.7.0",
    channel: "synthetic-beta",
    compatibilityPlanId: "synthetic-compat",
    recoveryPlanId: "synthetic-recovery",
  };
  const nativeAct = vi.fn(async () => {
    const next = { ...state, phase: "waiting" as const, blocker: "activity" as const };
    push(next);
    return { ok: true as const, result: next };
  });
  const windowsAct = vi.fn();
  fake.bridge.updates = {
    read: () => ({ phase: "unavailable", current: "fixture" }),
    act: windowsAct,
    subscribe: () => () => undefined,
    prepare: () => () => undefined,
  };
  fake.bridge.macUpdates = {
    read: () => state,
    act: nativeAct,
    subscribe: (listener) => {
      push = listener;
      return () => undefined;
    },
  };
  const mounted = render(
    <h.Providers>
      <div className="orca-window">
        <UpdateControl />
      </div>
    </h.Providers>,
  );
  try {
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Approve automatic update and restart to 0.7.0" })),
    );
    expect(nativeAct).toHaveBeenCalledExactlyOnceWith({
      action: "approve",
      offerId: "offer-one",
      manifestSha256: "a".repeat(64),
    });
    expect(screen.getByRole("button", { name: "Update waiting for safe idle" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Defer" })));
    expect(nativeAct).toHaveBeenLastCalledWith({
      action: "defer",
      offerId: "offer-one",
      manifestSha256: "a".repeat(64),
    });
    state = { ...state, offerId: "offer-two", manifestSha256: "b".repeat(64), phase: "available" };
    act(() => push(state));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Approve automatic update and restart to 0.7.0" })),
    );
    expect(nativeAct).toHaveBeenLastCalledWith({
      action: "approve",
      offerId: "offer-two",
      manifestSha256: "b".repeat(64),
    });
    act(() => push({ ...state, phase: "recovery-required" }));
    expect(
      screen.getByRole("button", { name: "Update outcome unknown · Recovery required" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();
    act(() => push({ ...state, phase: "failed" }));
    expect(screen.getByRole("button", { name: "Update did not proceed" })).toBeTruthy();
    expect(windowsAct).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
    h.dispose();
  }
});

it("hides Mac controls when the trusted production owner is unavailable", () => {
  const fake = installBridge({ platform: "darwin" });
  const h = harness("darwin");
  fake.bridge.updates.read = () => ({ phase: "unavailable", current: "fixture" });
  fake.bridge.macUpdates = { read: () => ({ phase: "unavailable" }), act: vi.fn(), subscribe: () => () => undefined };
  const mounted = render(
    <h.Providers>
      <UpdateControl />
    </h.Providers>,
  );
  try {
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    mounted.unmount();
    h.dispose();
  }
});

it("keeps a newer pushed offer when an older approval reply arrives later", async () => {
  const fake = installBridge({ platform: "darwin" });
  const h = harness("darwin");
  const first: MacUpdateView = {
    phase: "available",
    offerId: "first",
    manifestSha256: "a".repeat(64),
    version: "0.7.0",
  };
  const second: MacUpdateView = { ...first, offerId: "second", manifestSha256: "b".repeat(64), version: "0.7.1" };
  let push!: (state: MacUpdateView) => void;
  let finish!: (value: { ok: true; result: MacUpdateView }) => void;
  const response = new Promise<{ ok: true; result: MacUpdateView }>((resolve) => {
    finish = resolve;
  });
  fake.bridge.updates.read = () => ({ phase: "unavailable", current: "fixture" });
  fake.bridge.macUpdates = {
    read: () => first,
    act: vi.fn(() => response),
    subscribe: (listener) => {
      push = listener;
      return () => undefined;
    },
  };
  const mounted = render(
    <h.Providers>
      <UpdateControl />
    </h.Providers>,
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: "Approve automatic update and restart to 0.7.0" }));
    act(() => push(second));
    await act(async () => {
      finish({ ok: true, result: { ...first, phase: "waiting" } });
      await response;
    });
    expect(
      screen
        .getByRole("button", { name: "Approve automatic update and restart to 0.7.1" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Update waiting for safe idle" })).toBeNull();
  } finally {
    mounted.unmount();
    h.dispose();
  }
});
