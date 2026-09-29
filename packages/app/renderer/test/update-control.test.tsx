// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateControl } from "../src/chrome/update-control.js";
import { useUpdateDraft } from "../src/update-drafts.js";
import { harness, installBridge } from "./harness.js";
import { installDesignSystem, setTheme } from "./themes.js";
import type { UpdateSnapshot } from "../../src/update-contract.js";
afterEach(cleanup);
it.each(["light", "dark"] as const)("offers explicit actions and protects drafts in %s", (theme) => {
  const fake = installBridge({ platform: "win32" });
  const h = harness("win32");
  installDesignSystem();
  setTheme(theme);
  let push!: (state: UpdateSnapshot) => void;
  let prepare!: (locked: boolean) => boolean;
  const action = vi.fn(() =>
    Promise.resolve({ ok: true as const, result: { phase: "idle" as const, current: "0.6.0" } }),
  );
  fake.bridge.updates = {
    read: () => ({ phase: "idle", current: "0.6.0" }),
    act: action,
    subscribe: (listener) => {
      push = listener;
      return () => undefined;
    },
    prepare: (listener) => {
      prepare = listener;
      return () => undefined;
    },
  };
  function Draft({ dirty }: { dirty: boolean }) {
    useUpdateDraft(dirty);
    return null;
  }
  const view = (dirty: boolean) => (
    <h.Providers>
      <div className="orca-window">
        <Draft dirty={dirty} />
        <UpdateControl />
      </div>
    </h.Providers>
  );
  const mounted = render(view(true));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(action).toHaveBeenLastCalledWith("check");
    act(() => push({ phase: "available", current: "0.6.0", version: "0.6.1" }));
    fireEvent.click(screen.getByRole("button", { name: "Download 0.6.1" }));
    expect(action).toHaveBeenLastCalledWith("download");
    act(() => push({ phase: "ready", current: "0.6.0", version: "0.6.1" }));
    expect(prepare(true)).toBe(false);
    expect(document.querySelector<HTMLElement>(".orca-window")!.inert).toBe(true);
    prepare(false);
    mounted.rerender(view(false));
    expect(prepare(true)).toBe(true);
    prepare(false);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update to 0.6.1" }));
    expect(action).toHaveBeenLastCalledWith("restart");
  } finally {
    mounted.unmount();
    h.dispose();
  }
});
