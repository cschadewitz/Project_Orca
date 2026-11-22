/** "Restart to finish update" for the Linux `.deb` (#905). */
import { describe, expect, it, vi } from "vitest";
import { installedDebVersion, LinuxPackageRestart } from "../src/main/linux-package-restart.js";
import { UpdatePreflightRefusal, type UpdateGuards } from "../src/main/updates.js";
import type { LinuxRestartState } from "../src/linux-update-contract.js";

const stanza = (pkg: string, version: string, status = "install ok installed") =>
  `Package: ${pkg}\nStatus: ${status}\nPriority: optional\nArchitecture: amd64\nVersion: ${version}\nDescription: x\n continued line\n`;

describe("installedDebVersion", () => {
  it("reads the installed orca-desktop version in the app's spelling", () => {
    const status = [stanza("orca", "3.0"), stanza("orca-desktop", "0.8.0~rc.1"), stanza("zlib1g", "1:1.3")].join("\n");
    expect(installedDebVersion(status)).toBe("0.8.0-rc.1");
    expect(installedDebVersion(stanza("orca-desktop", "0.8.0"))).toBe("0.8.0");
  });
  it("is undefined while the package is absent, half-installed or unparseable", () => {
    expect(installedDebVersion(stanza("orca", "3.0"))).toBeUndefined();
    expect(installedDebVersion(stanza("orca-desktop", "0.8.0", "install ok half-configured"))).toBeUndefined();
    expect(installedDebVersion(stanza("orca-desktop", "0.8.0", "install ok unpacked"))).toBeUndefined();
    expect(installedDebVersion(stanza("orca-desktop", "garbage"))).toBeUndefined();
    expect(installedDebVersion("")).toBeUndefined();
  });
});

function rig(options: { installed?: string; guards?: Partial<UpdateGuards> } = {}) {
  let installed: string | undefined = options.installed ?? "0.9.0";
  const calls: string[] = [];
  const guards: UpdateGuards = {
    prepareDrafts: vi.fn(async () => void calls.push("prepareDrafts")),
    prepareDaemon: vi.fn(async (token: string) => void calls.push(`prepareDaemon:${token.length}`)),
    stopDaemon: vi.fn(async () => void calls.push("stopDaemon")),
    handOff: vi.fn(async (_token: string, from: string, to: string) => void calls.push(`handOff:${from}->${to}`)),
    resume: vi.fn(async () => void calls.push("resume")),
    releaseDrafts: vi.fn(() => void calls.push("releaseDrafts")),
    ...options.guards,
  };
  const relaunch = vi.fn(() => void calls.push("relaunch"));
  const states: (LinuxRestartState | undefined)[] = [];
  const restart = new LinuxPackageRestart({
    current: "0.8.0",
    readInstalled: () => installed,
    guards,
    relaunch,
    changed: (state) => states.push(state),
    setTimer: () => ({}),
  });
  return {
    restart,
    guards,
    relaunch,
    calls,
    states,
    install: (version: string | undefined) => {
      installed = version;
    },
  };
}

describe("LinuxPackageRestart", () => {
  it("offers a restart only while dpkg reports another installed version", () => {
    const f = rig({ installed: "0.8.0" });
    f.restart.start();
    expect(f.restart.state).toBeUndefined();
    f.install("0.9.0");
    f.restart.check();
    expect(f.restart.state).toEqual({ phase: "ready", current: "0.8.0", installed: "0.9.0" });
    f.restart.check();
    expect(f.states).toHaveLength(1);
    // Mid-upgrade (half-installed): no offer until apt finishes.
    f.install(undefined);
    f.restart.check();
    expect(f.restart.state).toBeUndefined();
  });

  it("prepares drafts, drains and stops the daemon, hands the store to the installed version, then relaunches", async () => {
    const f = rig();
    f.restart.check();
    await f.restart.restart();
    expect(f.calls).toEqual(["prepareDrafts", "prepareDaemon:36", "stopDaemon", "handOff:0.8.0->0.9.0", "relaunch"]);
    expect(f.restart.state).toMatchObject({ phase: "restarting", message: "Starting ORCA 0.9.0" });
    // Held: nothing more runs, and checks no longer change the state.
    f.install("1.0.0");
    f.restart.check();
    await f.restart.restart();
    expect(f.relaunch).toHaveBeenCalledOnce();
    expect(f.restart.state).toMatchObject({ installed: "0.9.0" });
  });

  it("does nothing when apt moved on since the offer", async () => {
    const f = rig();
    f.restart.check();
    f.install("1.0.0");
    await f.restart.restart();
    expect(f.calls).toEqual([]);
    expect(f.restart.state).toMatchObject({ phase: "ready", installed: "1.0.0" });
  });

  it("still relaunches when the handoff is refused: the new version then refuses to convert by itself", async () => {
    const f = rig({ guards: { handOff: vi.fn(() => Promise.reject(new Error("refused"))) } });
    f.restart.check();
    await f.restart.restart();
    expect(f.relaunch).toHaveBeenCalledOnce();
  });

  it("resumes this version's daemon when the daemon cannot be prepared or stopped, and offers the restart again", async () => {
    for (const step of ["prepareDaemon", "stopDaemon"] as const) {
      const f = rig({ guards: { [step]: vi.fn(() => Promise.reject(new Error("busy"))) } });
      f.restart.check();
      const state = await f.restart.restart();
      expect(f.calls.slice(-2)).toEqual(["resume", "releaseDrafts"]);
      expect(f.relaunch).not.toHaveBeenCalled();
      expect(state).toMatchObject({ phase: "ready", message: expect.stringContaining("Restart blocked") });
      await f.restart.restart();
      expect(f.guards.prepareDrafts).toHaveBeenCalledTimes(2);
    }
  });

  it("a refused preflight claimed nothing: no resume", async () => {
    const f = rig({
      guards: { prepareDaemon: vi.fn((token: string) => Promise.reject(new UpdatePreflightRefusal(token, "busy"))) },
    });
    f.restart.check();
    await f.restart.restart();
    expect(f.guards.resume).not.toHaveBeenCalled();
    expect(f.guards.releaseDrafts).toHaveBeenCalledOnce();
  });

  it("drafts that are not ready never touch the daemon", async () => {
    const f = rig({ guards: { prepareDrafts: vi.fn(() => Promise.reject(new Error("drafts"))) } });
    f.restart.check();
    await f.restart.restart();
    expect(f.guards.prepareDaemon).not.toHaveBeenCalled();
    expect(f.guards.resume).not.toHaveBeenCalled();
    expect(f.restart.state).toMatchObject({ phase: "ready" });
  });

  it("an uncertain recovery keeps admission closed and the restart held", async () => {
    const f = rig({
      guards: {
        stopDaemon: vi.fn(() => Promise.reject(new Error("exit uncertain"))),
        resume: vi.fn(() => Promise.reject(new Error("uncertain"))),
      },
    });
    f.restart.check();
    expect(await f.restart.restart()).toMatchObject({ phase: "error" });
    await f.restart.restart();
    expect(f.guards.prepareDrafts).toHaveBeenCalledOnce();
  });
});
