// @vitest-environment happy-dom
/** The connected server in the connection dialog: approving its updater, and "Update now" (#879). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionSnapshot, OrcaBridge } from "../../src/bridge.js";
import type {
  ServerUpdateBridge,
  ServerUpdateOutcome,
  ServerUpdateProgress,
  ServerUpdatePreview,
} from "../../src/server-update.js";
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

const PATHS = { adapter: "/opt/orca/orca-release.py", manifest: "/etc/orca/deployment.json" };
const PREVIEW: ServerUpdatePreview = {
  id: "preview-1",
  profile: "lab",
  epoch: 3,
  hostKey: "SHA256:abc",
  workspaceId: "9b2b3c5e-3c0e-4f6a-9a59-6c1b8e6f0a11",
  serverVersion: "0.7.1",
  targetVersion: "0.8.0",
  declared: PATHS,
  approved: PATHS,
};

type Loose = { [K in keyof ServerUpdatePreview]?: ServerUpdatePreview[K] | undefined };
/** A preview without the fields set to `undefined`, as main would send it. */
const shaped = (fields: Loose): ServerUpdatePreview =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as unknown as ServerUpdatePreview;

function bridge(initial: Loose = {}) {
  let preview: ServerUpdatePreview | undefined = shaped({ ...PREVIEW, ...initial });
  let finish: (outcome: ServerUpdateOutcome) => void = () => {};
  let listener: ((progress: ServerUpdateProgress) => void) | undefined;
  let approval: { ok: true } | { ok: false; message: string } = { ok: true };
  const fake = {
    read: vi.fn(async () => preview),
    approve: vi.fn(async () => {
      if (approval.ok && preview) {
        const { blocked: _blocked, ...rest } = preview;
        preview = { ...rest, approved: preview.declared! };
      }
      return approval;
    }),
    update: vi.fn(() => new Promise<ServerUpdateOutcome>((resolve) => (finish = resolve))),
    onProgress: (fn: (progress: ServerUpdateProgress) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  } satisfies ServerUpdateBridge;
  return {
    fake,
    set: (next: Loose | undefined) => (preview = next && shaped(next)),
    refuse: (message: string) => (approval = { ok: false, message }),
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

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the connected server", () => {
  it("shows main's preview, and updates by naming it", async () => {
    const b = bridge();
    render(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.7.0" })} />);
    // The version shown is the preview's, from the same look as everything confirmed.
    expect(await screen.findByText("0.7.1")).toBeTruthy();
    expect(screen.queryByText("0.7.0")).toBeNull();
    expect(screen.getByText("2.2")).toBeTruthy();
    expect(screen.getByText("preview")).toBeTruthy();
    expect(screen.getByText("SHA256:abc")).toBeTruthy();
    expect(screen.getByText(PREVIEW.workspaceId!)).toBeTruthy();
    expect(screen.getByText("Older than this app (0.8.0).")).toBeTruthy();
    fireEvent.click(screen.getByText("Update now to 0.8.0"));
    expect(b.fake.update).toHaveBeenCalledExactlyOnceWith({ preview: "preview-1" });
    expect(screen.getByText("Updating…")).toBeTruthy();
    b.say("/opt/orca/releases/0.8.0");
    expect(screen.getByRole("region", { name: "Server updater output" }).textContent).toBe("/opt/orca/releases/0.8.0");
    await b.finish({ status: "updated", version: "0.8.0" });
    expect(screen.getByRole("status").textContent).toContain("now runs 0.8.0");
  });

  it("has the person enter the updater's paths, with the server's report only as a hint", async () => {
    const b = bridge({ approved: undefined, blocked: "Approve this server's updater first." });
    render(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    expect(await screen.findByText(/The server reports: \/opt\/orca\/orca-release.py/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Updater (orca-release.py)").value).toBe("");
    expect(screen.queryByText(/Update now/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Command the app will run on the server" })).toBeNull();
    type("Updater (orca-release.py)", " /opt/orca/orca-release.py ");
    type("Deployment manifest", "/etc/orca/deployment.json");
    expect(screen.getByRole("region", { name: "Command the app will run on the server" }).textContent).toBe(
      "python3 /opt/orca/orca-release.py --deployment /etc/orca/deployment.json update --bundle v0.8.0 --expect-current 0.7.1",
    );
    fireEvent.click(screen.getByText("Approve this updater"));
    expect(b.fake.approve).toHaveBeenCalledExactlyOnceWith({ preview: "preview-1", ...PATHS });
    expect(await screen.findByText("Update now to 0.8.0")).toBeTruthy();
  });

  it("asks again when the server points elsewhere than approved, and shows main's refusal", async () => {
    const b = bridge({
      declared: { ...PATHS, adapter: "/srv/orca/orca-release.py" },
      blocked: "The server reports its updater somewhere other than you approved.",
    });
    b.refuse("The server or the connection changed since this was shown.");
    render(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("somewhere other than you approved");
    expect(screen.queryByText(/Update now/)).toBeNull();
    type("Updater (orca-release.py)", "/srv/orca/orca-release.py");
    type("Deployment manifest", "/etc/orca/deployment.json");
    fireEvent.click(screen.getByText("Approve this updater"));
    expect(await screen.findByText("The server or the connection changed since this was shown.")).toBeTruthy();
  });

  it("offers nothing that main blocks, and asks for no approval it could not use", async () => {
    const b = bridge({
      hostKey: undefined,
      approved: undefined,
      blocked: "This server has not identified itself yet.",
    });
    const { rerender } = render(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    await waitFor(() => expect(b.fake.read).toHaveBeenCalled());
    expect(screen.queryByText(/Update now|Approve/)).toBeNull();
    b.set({ ...PREVIEW, targetVersion: "0.8.0-dev", approved: undefined, blocked: "not a release build" });
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.7.0" })} />);
    await waitFor(() => expect(b.fake.read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Update now|Approve/)).toBeNull();
  });

  it("quotes the server when it refuses, as an alert", async () => {
    const b = bridge();
    render(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    fireEvent.click(await screen.findByText("Update now to 0.8.0"));
    await b.finish({ status: "work-running", detail: "Daemon busy: 1 run active" });
    expect(screen.getByRole("alert").textContent).toContain("nothing was cancelled");
    expect(screen.getByRole("alert").textContent).toContain("Daemon busy: 1 run active");
    expect(screen.getByText("Update now to 0.8.0")).toBeTruthy();
  });

  it("says how the server compares, and nothing before hello or a preview", async () => {
    const b = bridge({ managedServer: undefined } as Partial<ServerUpdatePreview>);
    const { rerender } = render(<ServerUpdatePanel bridge={b.fake} connection={live({ managedServer: undefined })} />);
    expect(await screen.findByText(/outside the managed server updater/)).toBeTruthy();
    b.set({ ...PREVIEW, serverVersion: "0.8.0", blocked: "already" });
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.8.0" })} />);
    expect(await screen.findByText("The same release as this app.")).toBeTruthy();
    b.set({ ...PREVIEW, serverVersion: "0.9.0", blocked: "already" });
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: "0.9.0" })} />);
    expect(await screen.findByText("Newer than this app (0.8.0).")).toBeTruthy();
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live({ orcaVersion: undefined })} />);
    expect(screen.queryByText("Connected server")).toBeNull();
    b.set(undefined);
    rerender(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    await waitFor(() => expect(screen.queryByText("Connected server")).toBeNull());
  });

  it("stops listening when the dialog closes, and ignores answers that land after", async () => {
    const b = bridge();
    const { unmount } = render(<ServerUpdatePanel bridge={b.fake} connection={live()} />);
    fireEvent.click(await screen.findByText("Update now to 0.8.0"));
    unmount();
    expect(b.listening()).toBe(false);
    await b.finish({ status: "updated", version: "0.8.0" });

    const late = bridge({ approved: undefined, blocked: "Approve" });
    const second = render(<ServerUpdatePanel bridge={late.fake} connection={live()} />);
    await screen.findByText("Approve this updater");
    type("Updater (orca-release.py)", PATHS.adapter);
    type("Deployment manifest", PATHS.manifest);
    fireEvent.click(screen.getByText("Approve this updater"));
    second.unmount();
    await act(async () => Promise.resolve());
  });

  it("follows the live connection through the bridge", async () => {
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
    };
    render(<ConnectedServer bridge={b.fake} />);
    expect(await screen.findByText("Update now to 0.8.0")).toBeTruthy();
    b.set({ ...PREVIEW, serverVersion: "0.8.0", blocked: "already" });
    act(() => push?.(live({ orcaVersion: "0.8.0" })));
    await waitFor(() => expect(screen.queryByText(/Update now/)).toBeNull());
  });
});

it("sits in the connection dialog for a profile connection only", async () => {
  const b = bridge();
  (window as { orca?: Partial<OrcaBridge> }).orca = {
    serverUpdate: b.fake,
    connection: { read: () => live(), subscribe: () => () => undefined },
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
  expect(await screen.findByText("Connected server")).toBeTruthy();
  h.dispose();
});

describe("outcome sentences", () => {
  it.each<[ServerUpdateOutcome, string]>([
    [{ status: "another-update", detail: "Busy: update.lock" }, "Another update is running"],
    [{ status: "moved", detail: "Server moved: it runs 0.8.0" }, "release changed since you checked"],
    [{ status: "failed", detail: "x", restored: true }, "back on its previous release"],
    [{ status: "failed", detail: "bad signer", restored: false }, "The update failed. The server said: bad signer"],
    [
      { status: "unreachable", refusal: "auth-failed", message: "Key refused." },
      "nothing ran on the server. Key refused.",
    ],
    [{ status: "unknown", reason: "connection-lost" }, "whether the server updated is not known"],
    [
      { status: "unknown", reason: "not-confirmed", serverVersion: "0.7.1" },
      "has not confirmed the new version. The server last said it runs 0.7.1.",
    ],
    [{ status: "unavailable", reason: "Not a release build." }, "Not a release build."],
  ])("%j", (outcome, text) => {
    expect(describeOutcome(outcome)).toContain(text);
  });
});
