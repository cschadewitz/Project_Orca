// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateControl } from "../src/chrome/update-control.js";
import { harness, installBridge } from "./harness.js";
import { installDesignSystem, setTheme } from "./themes.js";
import type { LinuxUpdateNotice } from "../../src/linux-update-contract.js";
afterEach(cleanup);

const NOTICE: LinuxUpdateNotice = {
  current: "0.7.0",
  version: "0.7.1",
  releaseUrl: "https://github.com/cschadewitz/Project_Orca/releases/tag/v0.7.1",
  installCommand: "sudo apt install ./ORCA-0.7.1-linux-amd64.deb",
};

function mount(platform: string, initial: LinuxUpdateNotice | null) {
  const fake = installBridge({ platform });
  const h = harness(platform);
  let push!: (notice: LinuxUpdateNotice | null) => void;
  const act_ = vi.fn(() => Promise.resolve({ ok: true as const, result: null }));
  fake.bridge.updates = {
    read: () => ({ phase: "unavailable", current: "0.7.0" }),
    act: vi.fn(),
    subscribe: () => () => undefined,
    prepare: () => () => undefined,
  };
  fake.bridge.linuxUpdates = {
    read: () => initial,
    act: act_,
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
  return { act: act_, push: (n: LinuxUpdateNotice | null) => act(() => push(n)), mounted, h };
}

it.each(["light", "dark"] as const)("shows the Linux notice only when a newer release exists, in %s", async (theme) => {
  installDesignSystem();
  setTheme(theme);
  const view = mount("linux", null);
  try {
    expect(screen.queryByRole("button")).toBeNull();
    view.push(NOTICE);
    fireEvent.click(screen.getByRole("button", { name: "ORCA 0.7.1 is available" }));
    expect(screen.getByText(NOTICE.installCommand)).toBeTruthy();
    expect(screen.getByText(/You have 0\.7\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy install command" }));
    await vi.waitFor(() => expect(view.act).toHaveBeenLastCalledWith("copy"));
    fireEvent.click(screen.getByRole("button", { name: "ORCA 0.7.1 is available" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open release page" }));
    await vi.waitFor(() => expect(view.act).toHaveBeenLastCalledWith("open"));
    // Current again: the notice goes away.
    view.push(null);
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.mounted.unmount();
    view.h.dispose();
  }
});

it("never shows the Linux notice on another platform", () => {
  const view = mount("win32", NOTICE);
  try {
    expect(screen.queryByRole("button", { name: /available/ })).toBeNull();
  } finally {
    view.mounted.unmount();
    view.h.dispose();
  }
});
