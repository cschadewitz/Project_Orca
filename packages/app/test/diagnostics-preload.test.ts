/** Execute the actual preload with synthetic IPC to verify descriptor-only export calls. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import type { OrcaBridge } from "../src/bridge.js";
import type { DiagnosticsResult, DiagnosticsStatus } from "../src/diagnostics-contract.js";

const ok = <T>(value: T): DiagnosticsResult<T> => ({ ok: true, value });
function fixture() {
  let bridge: OrcaBridge | undefined;
  const listeners = new Map<string, ((event: unknown, status: DiagnosticsStatus) => void)[]>();
  const invoke = vi.fn<(channel: string, params?: unknown) => Promise<DiagnosticsResult<unknown>>>();
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, value: OrcaBridge) => {
        bridge = value;
      },
    },
    ipcRenderer: {
      sendSync: () => ({ epoch: 0 }),
      send: vi.fn(),
      invoke,
      on: (channel: string, listener: (event: unknown, status: DiagnosticsStatus) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      off: vi.fn(),
    },
  };
  const source = readFileSync(new URL("../src/preload/index.cts", import.meta.url), "utf8");
  const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;
  runInNewContext(compiled, {
    require: () => electron,
    exports: {},
    process: { platform: "win32" },
    ArrayBuffer,
    Uint8Array,
    Promise,
  });
  if (!bridge?.diagnostics) throw new Error("fixture unavailable");
  const emit = (revision: number, enabled: boolean, handle?: string) => {
    const status: DiagnosticsStatus = {
      revision,
      enabled,
      productionEnabled: true,
      scopeVersion: 1,
      minutes: 5,
      code: enabled ? "ready" : "off",
      previous: false,
      tailLossPossible: false,
      cleanupPending: false,
      acknowledgedUnknown: false,
      olderUnknowns: false,
      payloadReservedBytes: 0,
      ...(handle ? { activeExportHandle: handle } : {}),
    };
    for (const listener of listeners.get("orca:diagnostics.changed") ?? []) listener(undefined, status);
  };
  return { bridge: bridge.diagnostics, invoke, emit };
}

it("exposes only export descriptors and removes every preview-content capability", async () => {
  const f = fixture();
  expect(Object.keys(f.bridge).sort()).toEqual([
    "acknowledgeUnknown",
    "cancelExport",
    "chooseDestination",
    "discardPrevious",
    "prepareExport",
    "retryCleanup",
    "save",
    "setEnabled",
    "setMinutes",
    "status",
    "subscribe",
  ]);
  const report = {
    handle: "frozen",
    statusRevision: 5,
    byteLength: 12,
    sha256: "a".repeat(64),
    source: "previous",
    expiresInMs: 1000,
    tailLossPossible: true,
  };
  f.invoke.mockResolvedValueOnce(ok(report));
  expect(await f.bridge.prepareExport("previous")).toEqual(ok(report));
  expect(f.invoke).toHaveBeenCalledWith("orca:diagnostics.prepareExport", { source: "previous" }, 0);
  expect(f.bridge).not.toHaveProperty("readPreviewBlock");
  expect(f.bridge).not.toHaveProperty("releasePreviewBlock");
  expect(f.bridge).not.toHaveProperty("preparePreview");
});

it("sends only opaque handle and destination token for explicit picker, Save and cancellation", async () => {
  const f = fixture();
  f.invoke.mockResolvedValue(ok(true));
  await f.bridge.chooseDestination("frozen");
  await f.bridge.save("frozen", "destination");
  await f.bridge.cancelExport("frozen");
  expect(f.invoke.mock.calls).toEqual([
    ["orca:diagnostics.chooseDestination", { handle: "frozen" }, 0],
    ["orca:diagnostics.save", { handle: "frozen", destinationToken: "destination" }, 0],
    ["orca:diagnostics.cancelExport", { handle: "frozen" }, 0],
  ]);
});

it("forwards authoritative status without report contents or automatic export actions", async () => {
  const f = fixture();
  const received = vi.fn();
  f.bridge.subscribe(received);
  f.emit(6, false);
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ revision: 6, enabled: false }));
  expect(f.invoke).not.toHaveBeenCalled();
});

it("maps rejected transport to closed actionable status without exposing native exception text", async () => {
  const f = fixture();
  f.invoke.mockRejectedValue(new Error("PRIVATE report and path"));
  expect(await f.bridge.prepareExport("current")).toEqual({ ok: false, code: "unavailable" });
});
