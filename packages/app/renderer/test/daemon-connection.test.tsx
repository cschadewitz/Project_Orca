// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonConnectionBridge, DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { ConnectionBoundary } from "../src/daemon-connection/boundary.js";
import { ConnectionDialog } from "../src/daemon-connection/dialog.js";
import { useUpdateDraft } from "../src/update-drafts.js";
import { harness, stubMatchMedia } from "./harness.js";
afterEach(cleanup);
function rig() {
  let target: DaemonTargetSnapshot = {
    epoch: 1,
    url: "http://localhost:6722",
    source: "saved",
    environmentOverride: false,
  };
  let listener: ((snapshot: DaemonTargetSnapshot) => void) | undefined;
  const bridge: DaemonConnectionBridge = {
    read: () => target,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    show: vi.fn(),
    onShow: () => () => {},
    cancel: vi.fn(),
    activate: vi.fn(),
    connect: vi.fn(async () => ({ ok: false as const, message: "Credential invalid or revoked" })),
  };
  return {
    bridge,
    target,
    change: () => {
      target = { ...target, epoch: target.epoch + 1 };
      listener?.(target);
    },
  };
}
function Draft() {
  useUpdateDraft(true);
  return <input aria-label="Pending edit" defaultValue="keep my edits" />;
}
it("keeps old drafts mounted and refuses target activation until explicit discard", async () => {
  const r = rig();
  render(
    <ConnectionBoundary bridge={r.bridge}>
      <Draft />
    </ConnectionBoundary>,
  );
  act(r.change);
  expect(screen.getByLabelText<HTMLInputElement>("Pending edit").value).toBe("keep my edits");
  expect(r.bridge.activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Discard pending edits and load this daemon"));
  await waitFor(() => expect(r.bridge.activate).toHaveBeenCalledWith(2));
});
it("clean target changes remount resource selections before activation", async () => {
  const r = rig();
  const gone = vi.fn();
  render(
    <ConnectionBoundary bridge={r.bridge}>
      <input
        ref={(node) => {
          if (!node) gone();
        }}
        aria-label="Selection"
        defaultValue=""
      />
    </ConnectionBoundary>,
  );
  fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "old workspace run" } });
  act(r.change);
  await waitFor(() => expect(r.bridge.activate).toHaveBeenCalledWith(2));
  expect(screen.getByLabelText<HTMLInputElement>("Selection").value).toBe("");
  expect(gone).toHaveBeenCalled();
});
it("shows an inline auth failure and keeps the dialog open; Cancel fences the probe", async () => {
  const r = rig();
  stubMatchMedia(1200);
  const h = harness();
  const close = vi.fn();
  render(
    <h.Providers>
      <ConnectionDialog bridge={r.bridge} target={r.target} close={close} />
    </h.Providers>,
  );
  fireEvent.click(screen.getByText("Connect"));
  await screen.findByText("Credential invalid or revoked");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Cancel"));
  expect(r.bridge.cancel).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  h.dispose();
});
