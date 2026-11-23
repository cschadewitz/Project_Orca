/** "Switch to SQLite" for the app's own workspace (#339): the restart, and the one-shot request. */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StoreStatus } from "@orca/protocol";
import { StoreSwitchRestart, takeStoreSwitchRequest, writeStoreSwitchRequest } from "../src/main/store-switch.js";
import { UpdatePreflightRefusal, type UpdateGuards } from "../src/main/updates.js";
import type { StoreSwitchState } from "../src/store-switch-contract.js";

const AVAILABLE: StoreStatus = { backend: "file", sqliteSwitch: "available" };

function rig(
  options: {
    store?: StoreStatus | undefined;
    enabled?: boolean;
    platform?: NodeJS.Platform;
    guards?: Partial<UpdateGuards>;
    settle?: (token: string) => Promise<string>;
    request?: (workspace: string) => void;
  } = {},
) {
  const calls: string[] = [];
  const guards: UpdateGuards = {
    prepareDrafts: vi.fn(async () => void calls.push("prepareDrafts")),
    prepareDaemon: vi.fn(async () => void calls.push("prepareDaemon")),
    stopDaemon: vi.fn(async () => void calls.push("stopDaemon")),
    resume: vi.fn(async () => void calls.push("resume")),
    releaseDrafts: vi.fn(() => void calls.push("releaseDrafts")),
    ...options.guards,
  };
  let store = "store" in options ? options.store : AVAILABLE;
  const states: StoreSwitchState[] = [];
  const relaunch = vi.fn(() => void calls.push("relaunch"));
  const restart = new StoreSwitchRestart({
    guards,
    target: () => (store ? { path: "/w", store } : undefined),
    settle:
      options.settle ??
      (async () => {
        calls.push("settle");
        return "/w";
      }),
    request:
      options.request ??
      ((workspace) => {
        calls.push(`request:${workspace}`);
      }),
    relaunch,
    changed: (state) => states.push(state),
    enabled: options.enabled ?? true,
    platform: options.platform ?? "linux",
  });
  restart.refresh();
  return { restart, calls, guards, relaunch, states, setStore: (next: StoreStatus | undefined) => (store = next) };
}

describe("StoreSwitchRestart", () => {
  it("offers the switch only for the app's own workspace on files, outside Windows, once enabled", () => {
    expect(rig().restart.state).toEqual({ phase: "ready", backend: "file" });
    expect(rig({ enabled: false }).restart.state.phase).toBe("unavailable");
    expect(rig({ platform: "win32" }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: { backend: "file", sqliteSwitch: "unavailable" } }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: undefined }).restart.state).toEqual({ phase: "unavailable" });
    const switched = rig({
      store: { backend: "sqlite", sqliteSwitch: "unavailable", lastSwitch: { status: "switched" } },
    });
    expect(switched.restart.state).toEqual({ phase: "unavailable", backend: "sqlite", last: { status: "switched" } });
  });

  it("drains and stops the daemon exactly, settles it, records the request, then restarts ORCA", async () => {
    const r = rig();
    const state = await r.restart.restart();
    expect(r.calls).toEqual(["prepareDrafts", "prepareDaemon", "stopDaemon", "settle", "request:/w", "relaunch"]);
    expect(state.phase).toBe("restarting");
    // Held until ORCA restarts: a second ask does nothing.
    await r.restart.restart();
    expect(r.relaunch).toHaveBeenCalledTimes(1);
  });

  it("reopens admission when it is refused before the stop, and records nothing", async () => {
    const r = rig({
      guards: {
        prepareDaemon: vi
          .fn()
          .mockRejectedValueOnce(new Error("Bundled daemon busy: run_a"))
          .mockResolvedValue(undefined),
      },
    });
    const state = await r.restart.restart();
    expect(r.calls).toEqual(["prepareDrafts", "resume", "releaseDrafts"]);
    expect(state).toMatchObject({ phase: "error", message: expect.stringContaining("Nothing was changed") });
    expect(r.relaunch).not.toHaveBeenCalled();
    // And it can be asked again.
    await r.restart.restart();
    expect(r.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not resume an attempt the preflight never claimed", async () => {
    let token = "";
    const r = rig({
      guards: {
        prepareDaemon: vi.fn(async (t: string) => {
          token = t;
          throw new UpdatePreflightRefusal(t, "Workspace is busy");
        }),
      },
    });
    await r.restart.restart();
    expect(token).not.toBe("");
    expect(r.calls).toEqual(["prepareDrafts", "releaseDrafts"]);
  });

  it("after the stop, never restarts or records anything when the stop, settlement or request fails", async () => {
    const failures: Parameters<typeof rig>[0][] = [
      {
        guards: {
          stopDaemon: vi.fn(async () => {
            throw new Error("Exact child termination is uncertain");
          }),
        },
      },
      {
        settle: async () => {
          throw new Error("First-run ownership");
        },
      },
      { settle: async () => "/elsewhere" },
      {
        request: () => {
          throw new Error("EACCES");
        },
      },
    ];
    for (const failure of failures) {
      const r = rig(failure);
      const state = await r.restart.restart();
      expect(state).toMatchObject({ phase: "error", message: expect.stringContaining("Quit and reopen ORCA") });
      expect(r.relaunch).not.toHaveBeenCalled();
      expect(r.calls).not.toContain("resume");
      expect(r.calls.filter((c) => c.startsWith("request:"))).toEqual([]);
      // Held: no second attempt in this process.
      await r.restart.restart();
      expect(r.relaunch).not.toHaveBeenCalled();
    }
  });

  it("does nothing when the switch is not offered", async () => {
    const r = rig({ enabled: false });
    expect(await r.restart.restart()).toMatchObject({ phase: "unavailable" });
    expect(r.calls).toEqual([]);
  });
});

describe("store switch request", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "orca-store-switch-")), "store-switch", "request.json");

  it("is spent by asking, and acted on only for the workspace it names", () => {
    const path = file();
    expect(takeStoreSwitchRequest(path, "/w")).toBe(false);
    writeStoreSwitchRequest(path, "/w");
    expect(takeStoreSwitchRequest(path, "/w")).toBe(true);
    expect(takeStoreSwitchRequest(path, "/w")).toBe(false);
    writeStoreSwitchRequest(path, "/w");
    expect(takeStoreSwitchRequest(path, "/other")).toBe(false);
    // Spent even so: never acted on later.
    expect(takeStoreSwitchRequest(path, "/w")).toBe(false);
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  it("ignores, and removes, a damaged request", () => {
    const path = file();
    writeStoreSwitchRequest(path, "/w");
    writeFileSync(path, "{ not json");
    expect(takeStoreSwitchRequest(path, "/w")).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 2, workspace: "/w" }));
    expect(takeStoreSwitchRequest(path, "/w")).toBe(false);
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });
});
