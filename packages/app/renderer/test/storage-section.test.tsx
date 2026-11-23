// @vitest-environment happy-dom
/** Workspace storage and "Switch to SQLite" (#339): the renderer only shows main's state and asks. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StorageSection } from "../src/config/storage-section.js";
import { harness, installBridge } from "./harness.js";
import type { StoreSwitchState } from "../../src/store-switch-contract.js";
afterEach(cleanup);

function mount(initial: StoreSwitchState, result: StoreSwitchState = { phase: "restarting", backend: "file" }) {
  const fake = installBridge({ platform: "linux" });
  const h = harness("linux");
  let push!: (state: StoreSwitchState) => void;
  const restart = vi.fn(() => Promise.resolve({ ok: true as const, result }));
  fake.bridge.storeSwitch = {
    read: () => initial,
    restart,
    subscribe: (listener) => {
      push = listener;
      return () => undefined;
    },
  };
  const view = render(
    <h.Providers>
      <StorageSection />
    </h.Providers>,
  );
  return { restart, push: (s: StoreSwitchState) => act(() => push(s)), view };
}

it("shows nothing for a daemon that reported no store", () => {
  const { view } = mount({ phase: "unavailable" });
  expect(view.container.textContent).toBe("");
});

it("shows the backend, and no switch where main does not offer one", () => {
  mount({ phase: "unavailable", backend: "sqlite", last: { status: "switched" } });
  expect(screen.getByText(/kept in: SQLite/)).toBeTruthy();
  expect(screen.getByText("Switched to SQLite on this start.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Switch to SQLite" })).toBeNull();
});

it("asks main to restart and switch only after confirming", async () => {
  const { restart } = mount({ phase: "ready", backend: "file" });
  fireEvent.click(screen.getByRole("button", { name: "Switch to SQLite" }));
  expect(restart).not.toHaveBeenCalled();
  expect(screen.getByText(/ORCA restarts to switch/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(restart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Switch to SQLite" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Restart and switch" }));
  });
  expect(restart).toHaveBeenCalledTimes(1);
  expect(restart).toHaveBeenCalledWith();
  expect(screen.getByRole("button", { name: "Preparing restart" }).getAttribute("aria-disabled")).toBe("true");
});

it("shows why a switch did not happen, and offers it again", () => {
  const { push } = mount({ phase: "ready", backend: "file" });
  push({
    phase: "ready",
    backend: "file",
    last: { status: "refused", reason: "BUSY", message: "A run is active, so the store stays on files." },
  });
  expect(screen.getByText(/Not switched on this start \(BUSY\): A run is active/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch to SQLite" })).toBeTruthy();
});
