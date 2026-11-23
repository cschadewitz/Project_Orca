/** "Switch to SQLite" and back for the app's own workspace (#339): the restart, and the one-shot request. */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StoreStatus } from "@orca/protocol";
import { StoreSwitchRestart, takeStoreSwitchRequest, writeStoreSwitchRequest } from "../src/main/store-switch.js";
import { UpdatePreflightRefusal, type UpdateGuards } from "../src/main/updates.js";
import type { StoreSwitchState } from "../src/store-switch-contract.js";

const AVAILABLE: StoreStatus = { backend: "file", sqliteSwitch: "available" };
const CLAIM = "a".repeat(64);

function rig(
  options: {
    store?: StoreStatus | undefined;
    enabled?: boolean;
    platform?: NodeJS.Platform;
    guards?: Partial<UpdateGuards>;
    settle?: (token: string) => Promise<{ path: string; claimHash: string }>;
    request?: (workspace: string, after: string, to: "sqlite" | "files") => void;
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
        return { path: "/w", claimHash: CLAIM };
      }),
    request:
      options.request ??
      ((workspace, after, to) => {
        calls.push(`request:${workspace}:${after === CLAIM}:${to}`);
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
    expect(rig().restart.state).toEqual({ phase: "ready", backend: "file", to: "sqlite" });
    expect(rig({ enabled: false }).restart.state.phase).toBe("unavailable");
    expect(rig({ platform: "win32" }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: { backend: "file", sqliteSwitch: "unavailable" } }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: undefined }).restart.state).toEqual({ phase: "unavailable" });
    const switched = rig({
      store: { backend: "sqlite", sqliteSwitch: "unavailable", lastSwitch: { status: "switched" } },
    });
    expect(switched.restart.state).toEqual({ phase: "unavailable", backend: "sqlite", last: { status: "switched" } });
  });

  it("offers the switch back to files only for the app's own workspace on SQLite whose daemon can switch back", async () => {
    const back: StoreStatus = { backend: "sqlite", sqliteSwitch: "unavailable", filesSwitch: "available" };
    expect(rig({ store: back }).restart.state).toEqual({ phase: "ready", backend: "sqlite", to: "files" });
    expect(rig({ store: back, enabled: false }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: back, platform: "win32" }).restart.state.phase).toBe("unavailable");
    // A daemon from before the switch back reports nothing for it.
    expect(rig({ store: { backend: "sqlite", sqliteSwitch: "unavailable" } }).restart.state.phase).toBe("unavailable");
    expect(rig({ store: { ...back, filesSwitch: "unavailable" } }).restart.state.phase).toBe("unavailable");
  });

  it("records a switch back to files the same way, through the same guards", async () => {
    const r = rig({ store: { backend: "sqlite", sqliteSwitch: "unavailable", filesSwitch: "available" } });
    const state = await r.restart.restart();
    expect(r.calls).toEqual([
      "prepareDrafts",
      "prepareDaemon",
      "stopDaemon",
      "settle",
      "request:/w:true:files",
      "relaunch",
    ]);
    expect(state).toMatchObject({ phase: "restarting", to: "files", message: "Restarting ORCA to switch to files" });
  });

  it("drains and stops the daemon exactly, settles it, records the request, then restarts ORCA", async () => {
    const r = rig();
    const state = await r.restart.restart();
    expect(r.calls).toEqual([
      "prepareDrafts",
      "prepareDaemon",
      "stopDaemon",
      "settle",
      "request:/w:true:sqlite",
      "relaunch",
    ]);
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
      { settle: async () => ({ path: "/elsewhere", claimHash: CLAIM }) },
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
  const dir = (path: string, ino: string) => ({ path, dev: "1", ino, uid: "1000" });
  /** The workspace's and store's directory identity, as the fence reads it; a replacement changes the inode. */
  let inode = "10";
  const directories = (workspace: string) => ({
    workspace: dir(workspace, inode),
    store: dir(join(workspace, ".orca"), `${inode}1`),
  });
  const write = (path: string, workspace = "/w", after = CLAIM, to: "sqlite" | "files" = "sqlite") => {
    inode = "10";
    writeStoreSwitchRequest(path, workspace, after, to, directories);
  };
  const take = (path: string, previous: string | null = CLAIM, enabled = true, workspace = "/w") =>
    takeStoreSwitchRequest(path, workspace, { previous }, enabled, directories);

  it("is acted on once, by the launch that follows the stopped claim of the same workspace and store", () => {
    const path = file();
    expect(take(path)).toBeUndefined();
    write(path);
    expect(take(path)).toEqual({ to: "sqlite", after: CLAIM });
    expect(take(path)).toBeUndefined();
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  it("carries which way the switch goes, and reads a request from before the switch back as to SQLite", () => {
    const path = file();
    write(path, "/w", CLAIM, "files");
    expect(take(path)).toEqual({ to: "files", after: CLAIM });
    write(path);
    const { to: _to, ...older } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(older));
    expect(take(path)).toEqual({ to: "sqlite", after: CLAIM });
  });

  it("is spent, never acted on, while the switch is disabled: enabling it later finds nothing", () => {
    const path = file();
    write(path);
    expect(take(path, CLAIM, false)).toBeUndefined();
    expect(take(path, CLAIM, true)).toBeUndefined();
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  it("is refused, and spent, for another workspace, another launch, or a workspace replaced at the same path", () => {
    const path = file();
    write(path);
    expect(take(path, CLAIM, true, "/other")).toBeUndefined();
    expect(take(path)).toBeUndefined();
    // A launch that does not directly follow the stopped daemon (another came between).
    write(path);
    expect(take(path, "c".repeat(64))).toBeUndefined();
    write(path);
    expect(take(path, null)).toBeUndefined();
    // The workspace was replaced before the next launch: same path, other directories.
    write(path);
    inode = "20";
    expect(take(path)).toBeUndefined();
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  it("ignores, and removes, a damaged request", () => {
    const path = file();
    write(path);
    writeFileSync(path, "{ not json");
    expect(take(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 1, workspace: "/w" }));
    expect(take(path)).toBeUndefined();
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });
});
