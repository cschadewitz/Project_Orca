// @vitest-environment happy-dom
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonConnectionBridge, DaemonTargetSnapshot } from "../../src/daemon-connection.js";
import { ConnectionBoundary } from "../src/daemon-connection/boundary.js";
import { ConnectionDialog } from "../src/daemon-connection/dialog.js";
import { ConnectionSource } from "../src/daemon-connection/source.js";
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
  expect(r.bridge.activate).toHaveBeenCalledExactlyOnceWith(1);
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

it("synchronizes the initial preload epoch before child resource effects run", () => {
  const r = rig();
  let preloadEpoch = 0;
  r.bridge.activate = vi.fn((epoch) => {
    preloadEpoch = epoch;
  });
  const epochs: number[] = [];
  function Resource() {
    useLayoutEffect(() => {
      epochs.push(preloadEpoch);
    }, []);
    return null;
  }
  render(
    <ConnectionBoundary bridge={r.bridge}>
      <Resource />
    </ConnectionBoundary>,
  );
  expect(epochs).toEqual([1]);
  expect(r.bridge.activate).toHaveBeenCalledExactlyOnceWith(1);
});

it.each(["bundled", "store", "development", "saved", "env"] as const)(
  "prefills only a durable external target (%s)",
  (source) => {
    stubMatchMedia(1200);
    const h = harness();
    const r = rig();
    render(
      <h.Providers>
        <ConnectionDialog bridge={r.bridge} target={{ ...r.target, source }} close={() => {}} />
      </h.Providers>,
    );
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe(
      source === "saved" || source === "env" ? r.target.url : "",
    );
    h.dispose();
  },
);

it("connects through a saved SSH profile and confirms removal on its row (#874)", async () => {
  stubMatchMedia(1200);
  const h = harness();
  const r = rig();
  const view = {
    id: "lab",
    name: "Lab",
    destination: "casey@lab",
    remotePort: 6722,
    hasCredential: true,
    hostKeyPinned: true,
  };
  const profiles = {
    list: vi.fn(async () => [view]),
    save: vi.fn(),
    remove: vi.fn(async () => ({ ok: true as const, value: { revoke: "not-reached" as const } })),
    importCredential: vi.fn(),
    forgetHostKey: vi.fn(),
  };
  r.bridge.connect = vi.fn(async () => ({ ok: false as const, message: "SSH authentication failed." }));
  render(
    <h.Providers>
      <ConnectionDialog bridge={{ ...r.bridge, profiles }} target={r.target} close={() => {}} />
    </h.Providers>,
  );
  await screen.findByText("casey@lab");
  fireEvent.click(screen.getAllByText("Connect")[0]!);
  await screen.findByText("SSH authentication failed.");
  expect(r.bridge.connect).toHaveBeenCalledWith({ profile: "lab" });
  fireEvent.click(screen.getByText("Remove"));
  expect(profiles.remove).not.toHaveBeenCalled();
  expect(document.activeElement?.textContent).toBe("Keep");
  fireEvent.click(screen.getByText("✕ Remove profile"));
  await waitFor(() => expect(profiles.remove).toHaveBeenCalledWith("lab"));
  // The server could not be reached: its credential stays valid there, and the person is told.
  await screen.findByText(/could not be reached, so its credential stays valid there/);
  h.dispose();
});

it("saves a profile's sign-in settings and says when it signs in (#875)", async () => {
  stubMatchMedia(1200);
  const h = harness();
  const r = rig();
  const saved = {
    id: "lab",
    name: "Lab",
    destination: "casey@lab",
    remotePort: 6722,
    serverCommand: "/opt/orca/bin/orca",
    readOnly: true as const,
    hasCredential: false,
    hostKeyPinned: false,
  };
  let views: (typeof saved)[] = [];
  const profiles = {
    list: vi.fn(async () => views),
    save: vi.fn(async () => {
      views = [saved];
      return { ok: true as const, value: saved };
    }),
    remove: vi.fn(),
    importCredential: vi.fn(),
    forgetHostKey: vi.fn(),
  };
  render(
    <h.Providers>
      <ConnectionDialog bridge={{ ...r.bridge, profiles }} target={r.target} close={() => {}} />
    </h.Providers>,
  );
  fireEvent.click(await screen.findByText("Add profile…"));
  // The editor's inputs in order: name, server, ssh port, key, jump, jump port, daemon port,
  // server command, workspace config, then the read-only box.
  const inputs = [...screen.getByRole("group", { name: "New profile" }).querySelectorAll("input")];
  const type = (index: number, value: string) => fireEvent.change(inputs[index]!, { target: { value } });
  type(0, "Lab");
  type(1, "casey@lab");
  type(7, "/opt/orca/bin/orca");
  expect(inputs[9]!.type).toBe("checkbox");
  fireEvent.click(inputs[9]!);
  fireEvent.click(screen.getByText("Save profile"));
  await waitFor(() =>
    expect(profiles.save).toHaveBeenCalledWith({
      name: "Lab",
      destination: "casey@lab",
      serverCommand: "/opt/orca/bin/orca",
      readOnly: true,
    }),
  );
  // No credential yet is not a blocker: Connect signs in.
  await screen.findByText("Signs in on first connect");
  expect((screen.getAllByText("Connect")[0] as HTMLButtonElement).disabled).toBe(false);
  h.dispose();
});

it("shows a profile connection by name in the Config header (#874)", () => {
  const r = rig();
  const bridge = {
    ...r.bridge,
    read: () => ({ ...r.target, profile: { id: "lab", name: "Lab", destination: "casey@lab" } }),
  };
  render(<ConnectionSource bridge={bridge} />);
  expect(screen.getByText(/Lab \(ssh casey@lab\)/)).toBeTruthy();
});
