// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  DiagnosticDestination,
  DiagnosticExport,
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
  revision: 0,
};
const preview: DiagnosticExport = {
  handle: "opaque-preview",
  statusRevision: 0,
  source: "current",
  byteLength: new TextEncoder().encode(exact).byteLength,
  sha256: "a".repeat(64),
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

/**
 * Hold the one timer set for `delay` and run it on demand, instead of waiting the delay out. A
 * preview's expiry has to land after the steps a test takes before it: a short real timer races
 * those steps and a long one is a wait. Every other timer, Testing Library's included, stays real.
 */
function holdTimer(delay: number) {
  const held = new Map<number, () => void>();
  let last = 0;
  const realSet = globalThis.setTimeout.bind(globalThis);
  const realClear = globalThis.clearTimeout.bind(globalThis);
  const set = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
    if (ms !== delay) return realSet(handler, ms);
    held.set(--last, handler);
    return last;
  }) as unknown as typeof setTimeout);
  const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id?: number) => {
    if (id === undefined || !held.delete(id)) realClear(id);
  }) as unknown as typeof clearTimeout);
  disposals.push(() => {
    set.mockRestore();
    clear.mockRestore();
  });
  return {
    armed: () => held.size,
    run: () =>
      act(() => {
        for (const [id, handler] of [...held]) {
          held.delete(id);
          handler();
        }
      }),
  };
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
    prepareExport: vi.fn(async (source: "current" | "previous") => {
      emit({ ...state, activeExportHandle: preview.handle });
      return ok({ ...preview, source });
    }),
    cancelExport: vi.fn(async (_handle: string) => {
      const { activeExportHandle: _active, ...rest } = state;
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
  it.each(["legacy", "studio"])(
    "remains available while %s configuration is pending and preserves its preview when that read completes",
    async (route) => {
      const f = fakeBridge({ enabled: true, productionEnabled: true, code: "ready" });
      const daemon = installBridge();
      Object.assign(daemon.bridge, { diagnostics: f.bridge });
      if (route === "studio")
        daemon.bridge.daemonConnection = {
          read: () => ({
            epoch: 1,
            url: "http://localhost:7331",
            source: "bundled",
            environmentOverride: false,
            identity: { workspaceId: "workspace", instanceId: "daemon" },
          }),
          subscribe: () => () => {},
          show: () => {},
          onShow: () => () => {},
          connect: async () => ({ ok: true }),
          cancel: () => {},
          activate: () => {},
        };
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
      expect(screen.getByText(route === "studio" ? "Read configuration" : "Loading the configuration")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
      const report = await screen.findByRole("region", { name: "Diagnostic export" });
      await act(async () => release());
      if (route === "studio") await screen.findByText("Structured metadata unavailable");
      else await screen.findByRole("region", { name: "Agents" });
      expect(screen.getByRole("region", { name: "Diagnostic export" })).toBe(report);
      expect(report.textContent).not.toContain(exact);
      expect(f.bridge.subscribe).toHaveBeenCalledTimes(1);
      expect(f.bridge.cancelExport).not.toHaveBeenCalled();
    },
  );
  it("starts off with five minutes and no automatic consent, preview, picker or save", async () => {
    const f = fakeBridge();
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
    expect(f.bridge.prepareExport).not.toHaveBeenCalled();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Diagnostic lookback: 5\sminutes/ }).textContent).toBe("5\u00a0minutes");
    expect(screen.getByText(/Production capture is unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export current diagnostics" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable local diagnostics" }));
    await waitFor(() => expect(f.bridge.setEnabled).toHaveBeenCalledWith(true, 1));
    expect(f.bridge.prepareExport).not.toHaveBeenCalled();
  });

  it("does not migrate a remembered setting into production capture or automatically preview recovery", async () => {
    const f = fakeBridge({ enabled: true, previous: true });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    expect(screen.getByRole("button", { name: "Export previous session" }).getAttribute("aria-disabled")).toBe("true");
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
    expect(f.bridge.prepareExport).not.toHaveBeenCalled();
  });

  it("uses the shared menu to explicitly set the approved lookback range", async () => {
    const f = fakeBridge();
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    fireEvent.click(screen.getByRole("button", { name: /Diagnostic lookback: 5\sminutes/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "15 minutes" }));
    await waitFor(() => expect(f.bridge.setMinutes).toHaveBeenCalledWith(15));
    expect(screen.getByRole("button", { name: /Diagnostic lookback: 15\sminutes/ }).textContent).toBe(
      "15\u00a0minutes",
    );
    expect(f.bridge.setEnabled).not.toHaveBeenCalled();
  });

  it.each([
    [1, "1 minute"],
    [5, "5 minutes"],
    [15, "15 minutes"],
  ])("includes the visible duration and field context in the lookback name at %i minutes", async (minutes, label) => {
    const f = fakeBridge({ minutes });
    mount(f.bridge);
    await screen.findByText("Local diagnostics: Off");
    const trigger = screen.getByRole("button", { name: `Diagnostic lookback: ${label.replace(" ", "\u00a0")}` });
    expect(trigger.textContent?.replace(/\s/g, " ")).toBe(label);
    const help = document.getElementById(trigger.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toBe("One to fifteen minutes; five minutes by default. Limits may retain less history.");
    expect(f.bridge.setMinutes).not.toHaveBeenCalled();
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
  fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
  return screen.findByRole("region", { name: "Diagnostic export" });
}
const enabled = { enabled: true, productionEnabled: true, code: "ready" as const };

describe("descriptor-only export and separate local Save", () => {
  it("fences descriptor authority with its revision without fetching report plaintext", async () => {
    const f = fakeBridge(enabled);
    vi.mocked(f.bridge.prepareExport).mockResolvedValueOnce(ok({ ...preview, statusRevision: 2 }));
    await open(f);
    act(() => f.emit({ ...f.state(), revision: 1 }));
    expect(screen.getByRole("region", { name: "Diagnostic export" })).toBeTruthy();
    expect(f.bridge).not.toHaveProperty("readPreviewBlock");
    expect(document.querySelector("pre, textarea, .orca-diagnostics__report")).toBeNull();
    expect(document.body.textContent).not.toContain(exact);
    act(() => f.emit({ ...f.state(), revision: 3 }));
    await waitFor(() => expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle));
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
  });

  it("guards same-turn repeated preparation and Save clicks before React commits busy state", async () => {
    const f = fakeBridge(enabled);
    const prepared = deferred<DiagnosticsResult<DiagnosticExport>>();
    vi.mocked(f.bridge.prepareExport).mockReturnValueOnce(prepared.promise);
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    const button = screen.getByRole("button", { name: "Export current diagnostics" });
    act(() => {
      button.click();
      button.click();
    });
    expect(f.bridge.prepareExport).toHaveBeenCalledOnce();
    await act(async () => prepared.resolve(ok(preview)));
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    const save = await screen.findByRole("button", { name: "Save report" });
    act(() => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Save report" })).toBeNull();
  });

  it("treats picker cancellation as a retryable choice without retaining old destination authority", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByRole("button", { name: "Save report" });
    vi.mocked(f.bridge.chooseDestination).mockResolvedValueOnce({ ok: false, code: "cancelled" });
    fireEvent.click(screen.getByRole("button", { name: "Choose another destination" }));
    await screen.findByText(/Destination selection was cancelled/);
    expect(screen.queryByRole("button", { name: "Save report" })).toBeNull();
    expect(screen.queryByText("Destination: /local/report.json")).toBeNull();
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose destination" })).toBeTruthy();
  });

  it("rejects late plaintext when age uncertainty arrives during pending preparation", async () => {
    const f = fakeBridge(enabled);
    const prepared = deferred<DiagnosticsResult<DiagnosticExport>>();
    vi.mocked(f.bridge.prepareExport).mockReturnValueOnce(prepared.promise);
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
    act(() => f.emit({ ...f.state(), code: "age_uncertain", cleanupPending: true }));
    await act(async () => prepared.resolve(ok(preview)));
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
    expect(document.body.textContent).not.toContain(exact);
    expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
  });

  it("shows report metadata without contents and requires picker and separate Save", async () => {
    const f = fakeBridge(enabled);
    const report = await open(f);
    expect(report.textContent).not.toContain(exact);
    expect(screen.getByText(/Checkpoint tail loss is possible/)).toBeTruthy();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    act(() => f.emit({ ...f.state(), minutes: 10, checkpointAgeMs: 7 }));
    expect(report.textContent).not.toContain(exact);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(screen.getByText(/file will be unencrypted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledWith("opaque-preview", "destination-token"));
    expect(report.textContent).not.toContain(exact);
  });

  it("removes old destination authority while a new picker is pending and ignores its late reply after close", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    const selected = deferred<DiagnosticsResult<DiagnosticDestination>>();
    vi.mocked(f.bridge.chooseDestination).mockReturnValueOnce(selected.promise);
    fireEvent.click(screen.getByRole("button", { name: "Choose another destination" }));
    expect(screen.queryByRole("button", { name: "Save report" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    await act(async () => selected.resolve(ok({ token: "late", displayPath: "/late/private-path.json" })));
    expect(document.body.textContent).not.toContain("/late/private-path.json");
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
    expect(f.bridge.save).not.toHaveBeenCalled();
  });

  it("acknowledges disposal only after the text is gone and restores no content on a late preview reply", async () => {
    const f = fakeBridge(enabled);
    const prepared = deferred<DiagnosticsResult<DiagnosticExport>>();
    vi.mocked(f.bridge.prepareExport).mockReturnValueOnce(prepared.promise);
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await act(async () => prepared.resolve(ok(preview)));
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
    expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);

    fireEvent.click(screen.getByRole("button", { name: "Enable local diagnostics" }));
    await screen.findByText("Local diagnostics: On");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Export current diagnostics" }).getAttribute("aria-disabled")).not.toBe(
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
    await screen.findByRole("region", { name: "Diagnostic export" });
    vi.mocked(f.bridge.cancelExport).mockImplementationOnce(async () => {
      expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
      return ok(f.state());
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    await waitFor(() => expect(f.bridge.cancelExport).toHaveBeenCalledTimes(2));
  });

  it("clears a revoked handle on target/source/key-loss status push, and closes the handle on unmount", async () => {
    const f = fakeBridge(enabled);
    const report = await open(f);
    expect(report.textContent).not.toContain(exact);
    act(() => {
      const { activeExportHandle: _active, ...rest } = f.state();
      f.emit({ ...rest, code: "stale_export" });
    });
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
    await waitFor(() => expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle));
    cleanup();
    const second = fakeBridge(enabled);
    await open(second);
    cleanup();
    expect(second.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);
    expect(second.bridge.subscribe).toHaveBeenCalledTimes(1);
  });

  it("expires the exact preview without renewing it for new checkpoints", async () => {
    const f = fakeBridge(enabled);
    vi.mocked(f.bridge.prepareExport).mockImplementation(async () => {
      f.emit({ ...f.state(), activeExportHandle: preview.handle });
      return ok({ ...preview, expiresInMs: 10 });
    });
    await open(f);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull());
    expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);
  });

  it("reports a Save admitted before opt-out truthfully when its completion arrives late", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await screen.findByText("Local diagnostics: Off");
    act(() => f.emit({ ...f.state(), code: "off", lastSaveOutcome: "saved", saveAdmittedBeforeRevocation: true }));
    expect(screen.getByText(/Save was admitted before revocation and completed/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
  });

  it("does not carry a prior Save success into a new pending or unknown Save", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/report.json");
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce());
    const oldSuccess = "The prepared report was saved locally. ORCA will not remove that exported file.";
    await screen.findAllByText(oldSuccess);

    vi.mocked(f.bridge.chooseDestination).mockResolvedValueOnce(
      ok({ token: "fresh-token", displayPath: "/local/second-report.json" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByText("Destination: /local/second-report.json");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save report" }).hasAttribute("disabled")).toBe(false),
    );
    const saved = deferred<DiagnosticsResult<DiagnosticsStatus>>();
    vi.mocked(f.bridge.save).mockReturnValueOnce(saved.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() => expect(f.bridge.save).toHaveBeenCalledTimes(2));
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

  it.each(["close", "expiry"] as const)(
    "allows a fresh explicit Save after known refusal and preview %s without changing consent",
    async (dismissal) => {
      // An odd delay, so that no other timer shares it; the test runs the preview's own expiry timer
      // once the refusal is showing rather than waiting out, or racing, a real one.
      const expiresInMs = 1_234;
      const expiry = dismissal === "expiry" ? holdTimer(expiresInMs) : undefined;
      const f = fakeBridge({ ...enabled, previous: true });
      vi.mocked(f.bridge.prepareExport).mockImplementationOnce(async () => {
        f.emit({ ...f.state(), activeExportHandle: preview.handle });
        return ok({ ...preview, expiresInMs: expiry === undefined ? preview.expiresInMs : expiresInMs });
      });
      await open(f);
      fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
      await screen.findByText("Destination: /local/report.json");
      vi.mocked(f.bridge.save).mockImplementationOnce(async () => {
        f.emit({ ...f.state(), code: "refused", lastSaveOutcome: "refused", cleanupPending: false });
        return ok(f.state());
      });
      fireEvent.click(screen.getByRole("button", { name: "Save report" }));
      await waitFor(() => expect(f.bridge.save).toHaveBeenCalledOnce());
      await screen.findAllByText("This diagnostics action was refused. Review the current status before trying again.");
      if (expiry === undefined) fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
      else {
        expect(expiry.armed()).toBe(1);
        expiry.run();
      }
      await waitFor(() => expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull(), {
        timeout: 2000,
      });
      await waitFor(() => expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle));
      act(() => f.emit({ ...f.state(), code: "refused", cleanupPending: false }));
      for (const name of ["Export current diagnostics", "Export previous session"])
        await waitFor(() => expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBeNull());
      expect(f.bridge.setEnabled).not.toHaveBeenCalled();
      expect(f.bridge.prepareExport).toHaveBeenCalledOnce();
      expect(f.bridge.chooseDestination).toHaveBeenCalledOnce();
      expect(f.bridge.save).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
      await screen.findByRole("region", { name: "Diagnostic export" });
      expect(f.bridge.save).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
      await screen.findByText("Destination: /local/report.json");
      expect(f.bridge.save).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Save report" }));
      await waitFor(() => expect(f.bridge.save).toHaveBeenCalledTimes(2));
      expect(f.bridge.prepareExport).toHaveBeenCalledTimes(2);
      expect(f.bridge.chooseDestination).toHaveBeenCalledTimes(2);
      expect(f.bridge.setEnabled).not.toHaveBeenCalled();
    },
  );

  it.each(["transport", "refused"] as const)(
    "coalesces repeated opt-out while pending and permits a deliberate retry after %s failure",
    async (failure) => {
      const f = fakeBridge(enabled);
      await open(f);
      fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
      await screen.findByText("Destination: /local/report.json");
      const off = deferred<DiagnosticsResult<DiagnosticsStatus>>();
      vi.mocked(f.bridge.setEnabled).mockImplementationOnce(async () => {
        await off.promise;
        if (failure === "transport") throw new Error("PRIVATE transport detail");
        return { ok: false, code: "refused" };
      });
      const button = screen.getByRole("button", { name: "Delete all and turn off" });
      act(() => {
        button.click();
        button.click();
        button.click();
      });
      expect(f.bridge.setEnabled).toHaveBeenCalledTimes(1);
      expect(f.bridge.setEnabled).toHaveBeenCalledWith(false, 1);
      expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
      expect(screen.queryByText("Destination: /local/report.json")).toBeNull();
      expect(f.bridge.cancelExport).toHaveBeenCalledOnce();
      // A later render must not release the in-flight guard either.
      fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
      expect(f.bridge.setEnabled).toHaveBeenCalledTimes(1);
      await act(async () => off.resolve({ ok: false, code: "refused" }));
      await screen.findByText("Revocation could not be confirmed. Local diagnostics may remain on.");
      expect(document.body.textContent).not.toContain("PRIVATE");
      expect(screen.getByText("Local diagnostics: On")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
      await screen.findByText("Local diagnostics: Off");
      expect(f.bridge.setEnabled).toHaveBeenCalledTimes(2);
      expect(f.bridge.setEnabled.mock.calls.every(([enabled]) => !enabled)).toBe(true);
      expect(f.bridge.save).not.toHaveBeenCalled();
    },
  );

  it.each(["save-first", "off-first"] as const)(
    "admits one opt-out during pending Save with %s settlement and preserves authoritative completion",
    async (order) => {
      const f = fakeBridge(enabled);
      await open(f);
      fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
      await screen.findByText("Destination: /local/report.json");
      const saved = deferred<DiagnosticsResult<DiagnosticsStatus>>();
      const off = deferred<DiagnosticsResult<DiagnosticsStatus>>();
      vi.mocked(f.bridge.save).mockReturnValueOnce(saved.promise);
      vi.mocked(f.bridge.setEnabled).mockReturnValueOnce(off.promise);
      fireEvent.click(screen.getByRole("button", { name: "Save report" }));
      expect(f.bridge.save).toHaveBeenCalledOnce();
      const button = screen.getByRole("button", { name: "Delete all and turn off" });
      act(() => {
        button.click();
        button.click();
      });
      expect(f.bridge.setEnabled).toHaveBeenCalledTimes(1);
      expect(f.bridge.setEnabled).toHaveBeenCalledWith(false, 1);
      expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
      const settleSave = () =>
        act(async () => saved.resolve(ok({ ...defaults, ...enabled, revision: 1, code: "saved" })));
      const settleOff = () => act(async () => off.resolve(ok({ ...defaults, revision: 2 })));
      if (order === "save-first") {
        await settleSave();
        await settleOff();
      } else {
        await settleOff();
        await settleSave();
      }
      await screen.findByText("Local diagnostics: Off");
      expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
      expect(screen.queryByText("Destination: /local/report.json")).toBeNull();
      // Only main's later authoritative push can report an admitted Save completion.
      act(() => f.emit({ ...defaults, revision: 3, lastSaveOutcome: "saved", saveAdmittedBeforeRevocation: true }));
      expect(screen.getByText(/Save was admitted before revocation and completed/)).toBeTruthy();
      expect(f.bridge.save).toHaveBeenCalledOnce();
      expect(f.bridge.chooseDestination).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Enable local diagnostics" }).getAttribute("aria-disabled")).toBeNull();
    },
  );

  it.each(["transport", "stale_export"] as const)(
    "disposes the view but does not claim Off when revocation is unconfirmed by %s",
    async (failure) => {
      const f = fakeBridge(enabled);
      await open(f);
      vi.mocked(f.bridge.cancelExport).mockResolvedValueOnce({ ok: false, code: "stale_export" });
      if (failure === "transport")
        vi.mocked(f.bridge.setEnabled).mockRejectedValueOnce(new Error("PRIVATE transport detail"));
      else vi.mocked(f.bridge.setEnabled).mockResolvedValueOnce({ ok: false, code: "stale_export" });
      fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
      expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
      await screen.findByText("Revocation could not be confirmed. Local diagnostics may remain on.");
      expect(screen.getByText("Local diagnostics: On")).toBeTruthy();
      expect(screen.queryByText("Local diagnostics: Off")).toBeNull();
      expect(document.body.textContent).not.toContain("Off for this session");
      expect(document.body.textContent).not.toContain("PRIVATE");
      act(() => f.emit({ ...f.state(), enabled: true, code: "ready" }));
      expect(screen.getByText("Local diagnostics: On")).toBeTruthy();
      expect(screen.queryByText("Revocation could not be confirmed. Local diagnostics may remain on.")).toBeNull();
      expect(document.body.textContent).not.toContain("Off for this session");
      expect(f.bridge.save).not.toHaveBeenCalled();
      expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);
    },
  );

  it("uses authoritative disabled status for failed durable opt-out and clears its feedback on explicit enable", async () => {
    const f = fakeBridge(enabled);
    await open(f);
    vi.mocked(f.bridge.setEnabled).mockImplementationOnce(async () => {
      f.emit({ ...f.state(), enabled: false, code: "cleanup_pending", cleanupPending: true });
      return { ok: false, code: "cleanup_pending" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await screen.findByText("Off for this session; the setting or cleanup could not be completed.");
    expect(screen.getByText("Local diagnostics: Off")).toBeTruthy();
    act(() => f.emit({ ...f.state(), enabled: false, code: "off", cleanupPending: false }));
    expect(screen.getByText("Off for this session; the setting or cleanup could not be completed.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Diagnostic export" })).toBeNull();
    expect(f.bridge.save).not.toHaveBeenCalled();
    expect(f.bridge.cancelExport).toHaveBeenCalledWith(preview.handle);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Enable local diagnostics" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable local diagnostics" }));
    await screen.findByText("Local diagnostics: On");
    act(() => f.emit({ ...f.state(), enabled: true, code: "ready" }));
    expect(document.body.textContent).not.toContain("Off for this session");
  });

  it("clears session-only off failure feedback when main reports diagnostics On again", async () => {
    const f = fakeBridge(enabled);
    mount(f.bridge);
    await screen.findByText("Local diagnostics: On");
    vi.mocked(f.bridge.setEnabled).mockImplementationOnce(async () => {
      f.emit({ ...f.state(), enabled: false, code: "cleanup_pending", cleanupPending: true });
      return { ok: false, code: "cleanup_pending" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete all and turn off" }));
    await screen.findByText("Off for this session; the setting or cleanup could not be completed.");
    act(() => f.emit({ ...f.state(), enabled: true, code: "ready", cleanupPending: false }));
    expect(screen.getByText("Local diagnostics: On")).toBeTruthy();
    expect(screen.queryByText("Local diagnostics: Off")).toBeNull();
    expect(document.body.textContent).not.toContain("Off for this session");
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
    expect(f.bridge.prepareExport).not.toHaveBeenCalled();
    expect(f.bridge.chooseDestination).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export current diagnostics" }));
    await screen.findByRole("region", { name: "Diagnostic export" });
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await screen.findByRole("button", { name: "Save report" });
    expect(screen.getByText(/The earlier export may already exist/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
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
    expect(f.bridge.prepareExport).not.toHaveBeenCalled();
    expect(f.bridge.save).not.toHaveBeenCalled();
  });
});

describe("cleanup prompt only when cleanup is really pending (#1205)", () => {
  it("shows no cleanup prompt on a fresh install with diagnostics off, before and after a reopen", async () => {
    // What main reports on a platform without diagnostics storage, and on a clean default-off profile.
    for (const code of ["unavailable", "off"] as const) {
      for (const session of [1, 2]) {
        const f = fakeBridge({ code, cleanupPending: false });
        mount(f.bridge);
        await screen.findByText("Local diagnostics: Off");
        expect(screen.queryByText(/Cleanup is pending/), `${code} session ${session}`).toBeNull();
        expect(screen.queryByRole("button", { name: "Retry cleanup" })).toBeNull();
        expect(screen.getByRole("button", { name: "Enable local diagnostics" }).getAttribute("title")).not.toBe(
          "Owned cleanup must finish before enabling again.",
        );
        cleanup();
      }
    }
  });

  it("names what a real pending cleanup is waiting on", async () => {
    const history = fakeBridge({ code: "cleanup_pending", cleanupPending: true });
    mount(history.bridge);
    expect(
      await screen.findByText(/ORCA could not yet verify that its retained diagnostic history and key material/),
    ).toBeTruthy();
    expect(screen.queryByText(/plaintext temporary/)).toBeNull();
    cleanup();

    const exported = fakeBridge({ code: "unknown_blocked", cleanupPending: true, unknownOperation: "old" });
    mount(exported.bridge);
    expect(await screen.findByText(/The earlier export's private plaintext temporary may remain/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeTruthy();
  });
});
