// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionBanner } from "../src/chrome/connection-banner.js";
import { toConnection } from "../src/connection.js";
import { installBridge } from "./harness.js";
import type { BridgeResult, WorkspaceSnapshot } from "../../src/bridge.js";

afterEach(cleanup);
const file = toConnection({ state: "file", since: new Date().toISOString() });
it.each([
  "Authentication required. Configure ORCA_DAEMON_TOKEN_FILE before connecting.",
  "Credential invalid or revoked. Update the configured credential file.",
  "Daemon protocol mismatch. Install compatible app and daemon versions.",
  "Save or discard pending edits before changing daemons.",
  "Connection cancelled.",
])("shows a refused return in the store banner: %s", async (message) => {
  installBridge({ workspace: { path: "/archive", source: "chosen", readOnly: true } });
  vi.spyOn(window.orca.workspace, "connectLive").mockResolvedValue({
    ok: false,
    error: { code: "AGENT_TRANSPORT", message },
  });
  render(<ConnectionBanner connection={file} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect to a daemon" }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText("/archive")).toBeTruthy();
  expect(window.orca.workspace.read().readOnly).toBe(true);
});
it("reports interrupted IPC and allows retry", async () => {
  installBridge();
  vi.spyOn(window.orca.workspace, "connectLive").mockRejectedValue(new Error("transport lost"));
  render(<ConnectionBanner connection={file} />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("The connection request was interrupted. Try again.");
  expect(screen.getByRole("button").getAttribute("aria-disabled")).toBeNull();
});
it("ignores a late failure after the connection has changed", async () => {
  installBridge();
  let finish!: (result: BridgeResult<WorkspaceSnapshot>) => void;
  vi.spyOn(window.orca.workspace, "connectLive").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ui = render(<ConnectionBanner connection={file} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button"));
  expect(window.orca.workspace.connectLive).toHaveBeenCalledOnce();
  ui.rerender(<ConnectionBanner connection={{ ...file, state: "live" }} />);
  await act(async () => {
    finish({ ok: false, error: { code: "AGENT_TRANSPORT", message: "Old failure" } });
  });
  ui.rerender(<ConnectionBanner connection={file} />);
  expect(screen.queryByText("Old failure")).toBeNull();
});
