// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DiagnosticDestination,
  DiagnosticPreview,
  DiagnosticsBridge,
  DiagnosticsResult,
  DiagnosticsStatus,
} from "../../src/diagnostics-contract.js";
import { DiagnosticsSection } from "../src/diagnostics/diagnostics-section.js";
import { ConfigProvider } from "../src/config/config-context.js";
import { ConfigSurface } from "../src/config/config-surface.js";
import { harness, installBridge } from "./harness.js";

const exact = '{"omissions":["capacity"],"coverage":"unknown","events":[]}\n';
const defaults: DiagnosticsStatus = {
  enabled: false,
  productionEnabled: false,
  scopeVersion: 1,
  minutes: 5,
  code: "off",
  previous: false,
  tailLossPossible: true,
  cleanupPending: false,
  acknowledgedUnknown: false,
  olderUnknowns: false,
  payloadReservedBytes: 0,
};
const preview: DiagnosticPreview = {
  handle: "opaque-preview",
  source: "current",
  text: exact,
  byteLength: new TextEncoder().encode(exact).byteLength,
  expiresInMs: 300_000,
  tailLossPossible: true,
};
const ok = <T,>(value: T): DiagnosticsResult<T> => ({ ok: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeBridge(patch: Partial<DiagnosticsStatus> = {}) {
  let state: DiagnosticsStatus = { ...defaults, ...patch };
  const listeners = new Set<(status: DiagnosticsStatus) => void>();
  const emit = (next: DiagnosticsStatus) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  const result = (patch: Partial<DiagnosticsStatus> = {}) => {
    emit({ ...state, ...patch });
    return ok(state);
  };
  const bridge = {
    status: vi.fn(async () => ok(state)),
    subscribe: vi.fn((listener: (status: DiagnosticsStatus) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    setEnabled: vi.fn(async (enabled: boolean, _scopeVersion: number) =>
      result({ enabled, code: enabled ? "ready" : "off" }),
    ),
    setMinutes: vi.fn(async (minutes: number) => result({ minutes })),
    preparePreview: vi.fn(async (source: "current" | "previous") => {
      emit({ ...state, activePreviewHandle: preview.handle });
      return ok({ ...preview, source });
    }),
    closePreview: vi.fn(async (_handle: string) => {
      const { activePreviewHandle: _active, ...rest } = state;
      emit(rest);
      return ok(state);
    }),
    chooseDestination: vi.fn(async (_handle: string) =>
      ok({ token: "destination-token", displayPath: "/local/report.json" }),
    ),
    save: vi.fn(async (_handle: string, _token: string) => result({ code: "saved", lastSaveOutcome: "saved" })),
    discardPrevious: vi.fn(async () => result({ previous: false })),
    retryCleanup: vi.fn(async () => result({ cleanupPending: false })),
    acknowledgeUnknown: vi.fn(async (_handle: string) =>
      result({ code: "acknowledged_unknown", acknowledgedUnknown: true }),
    ),
  } satisfies DiagnosticsBridge;
  return { bridge, emit, state: () => state };
}

const disposals: (() => void)[] = [];
function mount(bridge?: DiagnosticsBridge) {
  const fake = installBridge();
  disposals.push(fake.install());
  const h = harness("darwin");
  disposals.push(h.dispose);
  const { Providers } = h;
  return render(
    <Providers>
      <DiagnosticsSection {...(bridge === undefined ? {} : { bridge })} />
    </Providers>,
  );
}
afterEach(() => {
  cleanup();
  while (disposals.length) disposals.pop()?.();
  vi.useRealTimers();
});

describe("persistent diagnostics choice", () => {
  it("remains available while daemon configuration is pending and preserves its preview when that read completes", async () => {
    const f = fakeBridge({ enabled: true, productionEnabled: true, code: "ready" });
    const daemon = installBridge();
    Object.assign(daemon.bridge, { diagnostics: f.bridge });
    disposals.push(daemon.install());
    const release = daemon.hold("config.get");
    const h = harness("darwin");
    disposals.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <ConfigProvider>
          <ConfigSurface connection="live" />
        </ConfigProvider>
      </Providers>,
    );
    await screen.findByText("Local diagnostics: On");
    expect(screen.getByText("Loading the configuration")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview current diagnostics" }));
    const report = await screen.findByRole("region", { name: "Complete exact diagnostic report" });
    await act(async () => release());
    await screen.findByRole("region", { name: "Agents" });
    expect(screen.getByRole("region", { name: "Complete exact diagnostic report" })).toBe(report);
    expect(report.textContent).toBe(exact);
    expect(f.bridge.subscribe).toHaveBeenCalledTimes(1);
    expect(f.bridge.closePreview).not.toHaveBeenCalled();
  });
  it("starts off with five minutes and no automatic consent, preview, picker or save", async () => {
    const f = fakeBridge();
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
    expect(f.bridge.preparePreview).not.toHaveBeenCalled();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Diagnostic lookback" }).textContent).toBe("5 minutes");
    expect(screen.getByText(/Production capture is unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview current diagnostics" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable local diagnostics" }));
    await waitFor(() => expect(f.bridge.setEnabled).toHaveBeenCalledWith(true, 1));
    expect(f.bridge.preparePreview).not.toHaveBeenCalled();
  });

  it("does not migrate a remembered setting into production capture or automatically preview recovery", async () => {
    const f = fakeBridge({ enabled: true, previous: true });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    expect(screen.getByRole("button", { name: "Preview previous session" }).getAttribute("aria-disabled")).toBe("true");
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
    expect(f.bridge.preparePreview).not.toHaveBeenCalled();
  });

  it("uses the shared menu to explicitly set the approved lookback range", async () => {
    const f = fakeBridge();
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    fireEvent.click(screen.getByRole("button", { name: "Diagnostic lookback" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "15 minutes" }));
    await waitFor(() => expect(f.bridge.setMinutes).toHaveBeenCalledWith(15));
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
  });

  it("leaves ordinary UI usable when the bridge is absent or rejects without rendering a raw exception", async () => {
    const first = mount();
    expect(screen.getByText(/unavailable in this build/)).toBeTruthy();
    first.unmount();
    const f = fakeBridge();
    vi.mocked(f.bridge.status).mockRejectedValue(new Error("PRIVATE raw filesystem path"));
    mount(f.bridge);
    await screen.findByText("Local diagnostics are unavailable. Ordinary app work can continue.");
    expect(document.body.textContent).not.toContain("PRIVATE");
  });

  it("does not let an old initial status read replace a newer main push", async () => {
    const f = fakeBridge();
    const initial = deferred<DiagnosticsResult<DiagnosticsStatus>>();
    vi.mocked(f.bridge.status).mockReturnValueOnce(initial.promise);
    mount(f.bridge);
    act(() => f.emit({ ...f.state(), enabled: true }));
    await act(async () => initial.resolve(ok(defaults)));
    expect(screen.getByText("Local diagnostics: On")).toBeTruthy();
    expect(screen.queryByText("Local diagnostics: Off")).toBeNull();
  });
});

async function open(f: ReturnType<typeof fakeBridge>) {
  mount(f.bridge);
  await screen.findByText("Local diagnostics: On");
  fireEvent.click(screen.getByRole("button", { name: "Preview current diagnostics" }));
  return screen.findByRole("region", { name: "Complete exact diagnostic report" });
}
const enabled = { enabled: true, productionEnabled: true, code: "ready" as const };

describe("exact preview and separate local Save", () => {
  it("renders every exact byte including omissions and newline, then requires picker and separate Save", async () => {
    const f = fakeBridge(enabled);
    const report = await open(f);
    expect(report.textContent).toBe(exact);
    expect(screen.getByText(/Checkpoint tail loss is possible/)).toBeTruthy();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    act(() => f.emit({ ...f.state(), minutes: 10, checkpointAgeMs: 7 }));
    expect(report.textContent).toBe(exact);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(screen.getByText(/file will be unencrypted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save exact content" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledWith("opaque-preview", "destination-token"));
    expect(report.textContent).toBe(exact);
  });

  it("removes old destination authority while a new picker is pending and ignores its late reply after close", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    const selected = deferred<DiagnosticsResult<DiagnosticDestination>>();
    vi.mocked(f.bridge.chooseDestination).mockReturnValueOnce(selected.promise);
    fireEvent.click(screen.getByRole("button", { name: "Choose another destination" }));
    expect(screen.queryByRole("button", { name: "Save exact content" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await act(async () => selected.resolve(ok({ token: "late", displayPath: "/late/private-path.json" })));
    expect(document.body.textContent).not.toContain("/late/private-path.json");
    expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
    expect(f.bridge.save).not.toHaveBeenCalled();
  });

  it("acknowledges disposal only after the text is gone and restores no content on a late preview reply", async () => {
    const f = fakeBridge(enabled);
    const prepared = deferred<DiagnosticsResult<DiagnosticPreview>>();
    vi.mocked(f.bridge.preparePreview).mockReturnValueOnce(prepared.promise);
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    fireEvent.click(screen.getByRole("button", { name: "Preview current diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await act(async () => prepared.resolve(ok(preview)));
    expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
    expect(f.bridge.closePreview).toHaveBeenCalledWith(preview.handle);

    fireEvent.click(screen.getByRole("button", { name: "Enable local diagnostics" }));
    await screen.findByText("Local diagnostics: On");
    fireEvent.click(screen.getByRole("button", { name: "Preview current diagnostics" }));
    await screen.findByRole("region", { name: "Complete exact diagnostic report" });
    vi.mocked(f.bridge.closePreview).mockImplementationOnce(async () => {
      expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
      return ok(f.state());
    });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(f.bridge.closePreview).toHaveBeenCalledTimes(2));
  });

  it("clears a revoked handle on target/source/key-loss status push, and closes the handle on unmount", async () => {
    const f = fakeBridge(enabled);
    const report = await open(f);
    expect(report.textContent).toBe(exact);
    act(() => {
      const { activePreviewHandle: _active, ...rest } = f.state();
      f.emit({ ...rest, code: "stale_preview" });
    });
    expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
    await waitFor(() => expect(f.bridge.closePreview).toHaveBeenCalledWith(preview.handle));
    cleanup();
    const second = fakeBridge(enabled);
    await open(second);
    cleanup();
    expect(second.bridge.closePreview).toHaveBeenCalledWith(preview.handle);
    expect(second.bridge.subscribe).toHaveBeenCalledTimes(1);
  });

  it("expires the exact preview without renewing it for new checkpoints", async () => {
    const f = fakeBridge(enabled);
    vi.mocked(f.bridge.preparePreview).mockImplementation(async () => {
      f.emit({ ...f.state(), activePreviewHandle: preview.handle });
      return ok({ ...preview, expiresInMs: 10 });
    });
    await open(f);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull());
    expect(f.bridge.closePreview).toHaveBeenCalledWith(preview.handle);
  });

  it("reports a Save admitted before opt-out truthfully when its completion arrives late", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await screen.findByText("Local diagnostics: Off");
    act(() => f.emit({ ...f.state(), code: "off", lastSaveOutcome: "saved", saveAdmittedBeforeRevocation: true }));
    expect(screen.getByText(/Save was admitted before revocation and completed/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
  });

  it("does not carry a prior Save success into a new pending or unknown Save", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    fireEvent.click(screen.getByRole("button", { name: "Save exact content" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce());
    const oldSuccess = "The exact reviewed content was saved locally. ORCA will not remove that exported file.";
    await screen.findAllByText(oldSuccess);

    vi.mocked(f.bridge.chooseDestination).mockResolvedValueOnce(
      ok({ token: "fresh-token", displayPath: "/local/second-report.json" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose another destination" }));
    await screen.findByText("Destination: /local/second-report.json");
    const saved = deferred<DiagnosticsResult<DiagnosticsStatus>>();
    vi.mocked(f.bridge.save).mockReturnValueOnce(saved.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save exact content" }));
    act(() => {
      const { lastSaveOutcome: _oldOutcome, ...rest } = f.state();
      f.emit({ ...rest, code: "publication_pending" });
    });
    expect(screen.queryAllByText(oldSuccess)).toHaveLength(0);
    act(() =>
      f.emit({ ...f.state(), code: "unknown_blocked", lastSaveOutcome: "unknown", unknownOperation: "new-operation" }),
    );
    expect(screen.queryAllByText(oldSuccess)).toHaveLength(0);
    expect(screen.getByText(/ORCA cannot claim that nothing was saved/)).toBeTruthy();
    await act(async () => saved.resolve(ok(f.state())));
    expect(f.bridge.save).toHaveBeenLastCalledWith(preview.handle, "fresh-token");
    expect(screen.queryAllByText(oldSuccess)).toHaveLength(0);
  });

  it("clears the view even when durable opt-out fails and says only off for this session", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    vi.mocked(f.bridge.setEnabled).mockResolvedValueOnce({ ok: false, code: "cleanup_pending" });
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await screen.findByText("Off for this session; the setting or cleanup could not be completed.");
    expect(screen.queryByRole("region", { name: "Complete exact diagnostic report" })).toBeNull();
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(f.bridge.closePreview).toHaveBeenCalledWith(preview.handle);
  });
});

describe("unknown Save, cleanup and explicit acknowledgement", () => {
  it("blocks unknown work and offers a disabled acknowledgement with a visible cleanup retry", async () => {
    const f = fakeBridge({
      ...enabled,
      code: "unknown_blocked",
      unknownOperation: "old-operation",
      cleanupPending: true,
    });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    const acknowledge = screen.getByRole("button", { name: "Acknowledge and save again" });
    expect(acknowledge.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(acknowledge);
    expect(f.bridge.acknowledgeUnknown).not.toHaveBeenCalled();
    expect(screen.getByText("This action does not save a file.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(f.bridge.retryCleanup).toHaveBeenCalledOnce());
    expect(f.bridge.save).not.toHaveBeenCalled();
  });

  it("acknowledges only, then requires a fresh explicit preview, picker and Save", async () => {
    const f = fakeBridge({ ...enabled, code: "unknown_ready", unknownOperation: "old-operation" });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge and save again" }));
    await waitFor(() => expect(f.bridge.acknowledgeUnknown).toHaveBeenCalledWith("old-operation"));
    expect(f.bridge.preparePreview).not.toHaveBeenCalled();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview current diagnostics" }));
    await screen.findByRole("region", { name: "Complete exact diagnostic report" });
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByRole("button", { name: "Save exact content" });
    expect(screen.getByText(/The earlier export may already exist/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save exact content" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce());
  });

  it("keeps cleanup and unresolved outcome visible while off without offering capture authority", async () => {
    const f = fakeBridge({
      code: "unknown_blocked",
      unknownOperation: "old",
      cleanupPending: true,
      lastSaveOutcome: "unknown",
    });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable local diagnostics" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/ORCA cannot claim that nothing was saved/)).toBeTruthy();
    expect(f.bridge.preparePreview).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
  });
});
