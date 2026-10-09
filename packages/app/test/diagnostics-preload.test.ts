/** Execute the actual preload with synthetic IPC to verify isolated copy ownership. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import type { OrcaBridge } from "../src/bridge.js";
import type { DiagnosticPreviewBlock, DiagnosticsResult, DiagnosticsStatus } from "../src/diagnostics-contract.js";

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
      ...(handle ? { activePreviewHandle: handle } : {}),
    };
    for (const listener of listeners.get("orca:diagnostics.changed") ?? []) listener(undefined, status);
  };
  return { bridge: bridge.diagnostics, invoke, emit };
}

it("ignores stale status and old closes while a successor owns an isolated-world copy", async () => {
  const f = fixture();
  const bytes = new Uint8Array([120, 10]);
  f.invoke.mockImplementation(async (channel) => {
    if (channel.endsWith("preparePreview")) return ok({ handle: "new", statusRevision: 5 });
    if (channel.endsWith("readPreviewBlock")) return ok({ handle: "new", offset: 0, bytes });
    return ok(true);
  });
  await f.bridge.preparePreview("current");
  expect((await f.bridge.readPreviewBlock("new", 0)).ok).toBe(true);
  f.emit(4, false);
  await f.bridge.closePreview("old");
  expect(bytes.byteLength).toBe(2);
  await f.bridge.releasePreviewBlock("new", 0);
  expect(bytes.byteLength).toBe(0);
});

it("erases and refuses a late block after a newer consent revocation while acknowledging main disposal", async () => {
  const f = fixture();
  let resolve!: (value: DiagnosticsResult<DiagnosticPreviewBlock>) => void;
  const held = new Promise<DiagnosticsResult<DiagnosticPreviewBlock>>((r) => {
    resolve = r;
  });
  f.invoke.mockImplementation(async (channel) => {
    if (channel.endsWith("preparePreview")) return ok({ handle: "new", statusRevision: 5 });
    if (channel.endsWith("readPreviewBlock")) return held;
    return ok(true);
  });
  await f.bridge.preparePreview("current");
  const pending = f.bridge.readPreviewBlock("new", 0);
  f.emit(6, false);
  const bytes = new Uint8Array([120, 10]);
  resolve(ok({ handle: "new", offset: 0, bytes }));
  expect(await pending).toEqual({ ok: false, code: "stale_preview" });
  expect(bytes.byteLength).toBe(0);
  expect(f.invoke).toHaveBeenCalledWith("orca:diagnostics.releasePreviewBlock", { handle: "new", offset: 0 }, 0);
});
