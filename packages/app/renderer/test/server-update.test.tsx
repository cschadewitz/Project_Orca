// @vitest-environment happy-dom
/** The connected server in the connection dialog, and "Update now" (#879). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConnectionSnapshot, OrcaBridge } from "../../src/bridge.js";
import type { ServerUpdateBridge, ServerUpdateOutcome, ServerUpdateProgress } from "../../src/server-update.js";
import type { DaemonConnectionBridge } from "../../src/daemon-connection.js";
import { ConnectionDialog } from "../src/daemon-connection/dialog.js";
import {
  ConnectedServer,
  describe as describeOutcome,
  ServerUpdatePanel,
} from "../src/daemon-connection/server-update.js";
import { harness } from "./harness.js";

afterEach(() => {
  cleanup();
  delete (window as { orca?: unknown }).orca;
});

const live = (
  extra: { [K in keyof ConnectionSnapshot]?: ConnectionSnapshot[K] | undefined } = {},
): ConnectionSnapshot => {
  const snapshot: Record<string, unknown> = {
    state: "live",
    since: "2026-11-22T12:00:00.000Z",
    orcaVersion: "0.7.1",
    versions: { app: "2.2", daemon: "2.2" },
    managedServer: { ring: "preview" },
    ...extra,
  };
  for (const key of Object.keys(snapshot)) if (snapshot[key] === undefined) delete snapshot[key];
  return snapshot as unknown as ConnectionSnapshot;
};

function bridge() {
  let finish: (outcome: ServerUpdateOutcome) => void = () => {};
  let listener: ((progress: ServerUpdateProgress) => void) | undefined;
  const fake: ServerUpdateBridge = {
    update: vi.fn(() => new Promise<ServerUpdateOutcome>((resolve) => (finish = resolve))),
    onProgress: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    fake,
    finish: async (outcome: ServerUpdateOutcome) => {
      await act(async () => {
        finish(outcome);
        await Promise.resolve();
      });
    },
    say: (line: string) => act(() => listener?.({ stream: "stdout", line })),
    listening: () => listener !== undefined,
  };
}

describe("the connected server", () => {
  it("shows version, protocol and ring, offers the update when behind, and streams it", async () => {
    const b = bridge();
    render(<ServerUpdatePanel bridge={b.fake} connection={live()} appVersion="0.8.0" />);
    expect(screen.getByText("0.7.1")).toBeTruthy();
    expect(screen.getByText("2.2")).toBeTruthy();
    expect(screen.getByText("preview")).toBeTruthy();
    expect(screen.getByText("Older than this app (0.8.0).")).toBeTruthy();
    fireEvent.click(screen.getByText("Update now to 0.8.0"));
    expect(b.fake.update).toHaveBeenCalledOnce();
    expect(screen.getByText("Updating…")).toBeTruthy();
    b.say("/opt/orca/releases/0.8.0");
    expect(screen.getByRole("region", { name: "Server updater output" }).textContent).toBe("/opt/orca/releases/0.8.0");
    await b.finish({ status: "updated", version: "0.8.0" });
    expect(screen.getByRole("status").textContent).toContain("now runs 0.8.0");
  });

  it("quotes the server when it refuses, as an alert", async () => {
    const b = bridge();
    render(<ServerUpdatePanel bridge={b.fake} connection={live()} appVersion="0.8.0" />);
    fireEvent.click(screen.getByText("Update now to 0.8.0"));
    await b.finish({ status: "work-running", detail: "Daemon busy: 1 run active" });
    expect(screen.getByRole("alert").textContent).toContain("nothing was cancelled");
    expect(screen.getByRole("alert").textContent).toContain("Daemon busy: 1 run active");
    expect(screen.getByText("Update now to 0.8.0")).toBeTruthy();
  });

  it("offers no update for an unmanaged, current or newer server, and nothing before hello", () => {
    const b = bridge();
    const { rerender } = render(
      <ServerUpdatePanel bridge={b.fake} connection={live({ managedServer: undefined })} appVersion="0.8.0" />,
    );
    expect(screen.getByText(/outside the managed server updater/)).toBeTruthy();
    expect(screen.queryByText(/Update now/)).toBeNull();
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.8.0" })} appVersion="0.8.0" />);
    expect(screen.getByText("The same release as this app.")).toBeTruthy();
    expect(screen.queryByText(/Update now/)).toBeNull();
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.9.0" })} appVersion="0.8.0" />);
    expect(screen.getByText("Newer than this app (0.8.0).")).toBeTruthy();
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: undefined })} appVersion="0.8.0" />);
    expect(screen.queryByText("Connected server")).toBeNull();
  });

  it("stops listening when the dialog closes, and ignores an outcome that lands after", async () => {
    const b = bridge();
    const { unmount } = render(<ServerUpdatePanel bridge={b.fake} connection={live()} appVersion="0.8.0" />);
    fireEvent.click(screen.getByText("Update now to 0.8.0"));
    unmount();
    expect(b.listening()).toBe(false);
    await b.finish({ status: "updated", version: "0.8.0" });
  });

  it("follows the live connection and this app's version through the bridge", () => {
    const b = bridge();
    let push: ((snapshot: ConnectionSnapshot) => void) | undefined;
    (window as { orca?: Partial<OrcaBridge> }).orca = {
      connection: {
        read: () => live(),
        subscribe: (fn) => {
          push = fn;
          return () => undefined;
        },
      },
      updates: { read: () => ({ status: "idle", current: "0.8.0" }) } as unknown as OrcaBridge["updates"],
    };
    render(<ConnectedServer bridge={b.fake} />);
    expect(screen.getByText("Update now to 0.8.0")).toBeTruthy();
    act(() => push?.(live({ orcaVersion: "0.8.0" })));
    expect(screen.queryByText(/Update now/)).toBeNull();
  });
});

it("sits in the connection dialog for a profile connection only", () => {
  const b = bridge();
  (window as { orca?: Partial<OrcaBridge> }).orca = {
    serverUpdate: b.fake,
    connection: { read: () => live(), subscribe: () => () => undefined },
    updates: { read: () => ({ status: "idle", current: "0.8.0" }) } as unknown as OrcaBridge["updates"],
  };
  const connection = {
    cancel: vi.fn(),
    connect: vi.fn(),
  } as unknown as DaemonConnectionBridge;
  const target = { epoch: 1, url: "http://127.0.0.1:41000", source: "saved" as const, environmentOverride: false };
  const h = harness();
  const { rerender } = render(
    <h.Providers>
      <ConnectionDialog bridge={connection} target={target} close={() => {}} />
    </h.Providers>,
  );
  expect(screen.queryByText("Connected server")).toBeNull();
  rerender(
    <h.Providers>
      <ConnectionDialog
        bridge={connection}
        target={{ ...target, profile: { id: "lab", name: "Lab", destination: "casey@lab" } }}
        close={() => {}}
      />
    </h.Providers>,
  );
  expect(screen.getByText("Connected server")).toBeTruthy();
  h.dispose();
});

describe("outcome sentences", () => {
  it.each<[ServerUpdateOutcome, string]>([
    [{ status: "another-update", detail: "Busy: update.lock" }, "Another update is running"],
    [{ status: "failed", detail: "x", restored: true }, "back on its previous release"],
    [{ status: "failed", detail: "bad signer", restored: false }, "The update failed. The server said: bad signer"],
    [{ status: "unreachable", refusal: "auth-failed", message: "Key refused." }, "nothing changed there. Key refused."],
    [{ status: "unavailable", reason: "Not a release build." }, "Not a release build."],
  ])("%j", (outcome, text) => {
    expect(describeOutcome(outcome)).toContain(text);
  });
});
