/** "Restart to finish update" for the Linux `.deb` (#905). */
import { describe, expect, it, vi } from "vitest";
import {
  executableMatchesPackage,
  installedDebVersion,
  LinuxPackageRestart,
} from "../src/main/linux-package-restart.js";
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
  /** Whether the executable on disk is the installed package's file. */
  let binaryOk = true;
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
    verifyTarget: (version) => {
      calls.push("verify");
      return installed === version && binaryOk;
    },
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
    tamper: () => {
      binaryOk = false;
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
    expect(f.calls).toEqual([
      "verify",
      "prepareDrafts",
      "prepareDaemon:36",
      "stopDaemon",
      "verify",
      "handOff:0.8.0->0.9.0",
      "verify",
      "relaunch",
    ]);
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
    expect(f.calls).toEqual(["verify"]);
    expect(f.restart.state).toMatchObject({ phase: "ready", installed: "1.0.0" });
  });

  it("a refused handoff after the stop starts nothing and never restarts the running version", async () => {
    const f = rig({ guards: { handOff: vi.fn(() => Promise.reject(new Error("refused"))) } });
    f.restart.check();
    expect(await f.restart.restart()).toMatchObject({
      phase: "error",
      message: expect.stringContaining("reinstall ORCA 0.8.0"),
    });
    expect(f.relaunch).not.toHaveBeenCalled();
    expect(f.guards.resume).not.toHaveBeenCalled();
    await f.restart.restart();
    expect(f.guards.prepareDrafts).toHaveBeenCalledOnce();
  });

  it("a package or binary that moves during the restart is not started, before or after the handoff", async () => {
    // apt installs another version while the daemon drains: no handoff, nothing started.
    const moved = rig({
      guards: { stopDaemon: vi.fn(async () => void moved.install("1.0.0")) },
    });
    moved.restart.check();
    expect(await moved.restart.restart()).toMatchObject({
      phase: "error",
      message: expect.stringContaining("changed"),
    });
    expect(moved.guards.handOff).not.toHaveBeenCalled();
    expect(moved.relaunch).not.toHaveBeenCalled();
    expect(moved.guards.resume).not.toHaveBeenCalled();
    // The executable stops matching the package after the handoff: the record stays inert
    // (it names 0.9.0), and nothing is started.
    const tampered = rig({ guards: { handOff: vi.fn(async () => void tampered.tamper()) } });
    tampered.restart.check();
    expect(await tampered.restart.restart()).toMatchObject({ phase: "error" });
    expect(tampered.relaunch).not.toHaveBeenCalled();
  });

  it("reopens admission on the running daemon when it cannot be prepared, and offers the restart again", async () => {
    for (const step of ["prepareDaemon"] as const) {
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

  it("an uncertain stop keeps admission closed and the restart held, with no resume of the old version", async () => {
    const f = rig({
      guards: {
        stopDaemon: vi.fn(() => Promise.reject(new Error("exit uncertain"))),
      },
    });
    f.restart.check();
    expect(await f.restart.restart()).toMatchObject({ phase: "error" });
    expect(f.guards.resume).not.toHaveBeenCalled();
    expect(f.relaunch).not.toHaveBeenCalled();
    await f.restart.restart();
    expect(f.guards.prepareDrafts).toHaveBeenCalledOnce();
  });
});

describe("executableMatchesPackage", () => {
  const files = (binary: string, sums: string) => (path: string) =>
    Buffer.from(path.endsWith(".md5sums") ? sums : binary);
  it("matches only dpkg's recorded checksum for opt/ORCA/orca-desktop", async () => {
    const { createHash } = await import("node:crypto");
    const real = createHash("md5").update("new binary").digest("hex");
    const sums = `${"0".repeat(32)}  opt/ORCA/libffmpeg.so\n${real}  opt/ORCA/orca-desktop\n`;
    expect(executableMatchesPackage("/opt/ORCA/orca-desktop", "x.md5sums", files("new binary", sums))).toBe(true);
    expect(executableMatchesPackage("/opt/ORCA/orca-desktop", "x.md5sums", files("old binary", sums))).toBe(false);
    expect(
      executableMatchesPackage(
        "/opt/ORCA/orca-desktop",
        "x.md5sums",
        files("new binary", `${"1".repeat(32)}  opt/other\n`),
      ),
    ).toBe(false);
    expect(
      executableMatchesPackage("/opt/ORCA/orca-desktop", "x.md5sums", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });
});
