/** Automatic desktop updates (#566): when the scheduler checks, downloads and installs. */
import { describe, expect, it, vi } from "vitest";
import { AUTO_UPDATE_TIMING, AutoUpdates } from "../src/main/auto-updates.js";
import { Updates, UpdatePreflightRefusal, type UpdateDriver, type UpdateGuards } from "../src/main/updates.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function rig(options: { enabled?: boolean; busy?: () => boolean } = {}) {
  let now = 1_000_000;
  let idle = 0;
  let enabled = options.enabled ?? true;
  const driver: UpdateDriver = {
    check: vi.fn(() => Promise.resolve("0.8.1")),
    download: vi.fn(() => Promise.resolve()),
    install: vi.fn(() => Promise.resolve("launched" as const)),
  };
  const guards: UpdateGuards = {
    prepareDrafts: vi.fn(() => Promise.resolve()),
    prepareDaemon: vi.fn((token: string) =>
      options.busy?.() ? Promise.reject(new UpdatePreflightRefusal(token, "Bundled daemon busy")) : Promise.resolve(),
    ),
    stopDaemon: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    releaseDrafts: vi.fn(),
  };
  const updates = new Updates(driver, "0.8.0", guards, () => {});
  const auto = new AutoUpdates({
    updates,
    enabled: () => enabled,
    idleSeconds: () => idle,
    now: () => now,
  });
  return {
    driver,
    guards,
    updates,
    auto,
    advance: (ms: number) => {
      now += ms;
    },
    setIdle: (seconds: number) => {
      idle = seconds;
    },
    setEnabled: (on: boolean) => {
      enabled = on;
      auto.refresh();
    },
  };
}

/** Checked and downloaded, ready to install. */
async function ready(r: ReturnType<typeof rig>) {
  r.advance(AUTO_UPDATE_TIMING.firstCheckMs);
  await r.auto.tick();
  expect(r.updates.state.phase).toBe("ready");
}

describe("automatic updates", () => {
  it("checks shortly after start, downloads what it found, then checks every four hours", async () => {
    const r = rig();
    r.driver.check = vi.fn(() => Promise.resolve(undefined));
    expect(r.updates.state.automatic).toBe(true);
    await r.auto.tick();
    expect(r.driver.check).not.toHaveBeenCalled();
    r.advance(AUTO_UPDATE_TIMING.firstCheckMs);
    await r.auto.tick();
    expect(r.driver.check).toHaveBeenCalledOnce();
    expect(r.updates.state.phase).toBe("current");
    r.advance(4 * HOUR - MINUTE);
    await r.auto.tick();
    expect(r.driver.check).toHaveBeenCalledOnce();
    r.driver.check = vi.fn(() => Promise.resolve("0.8.1"));
    r.advance(MINUTE);
    await r.auto.tick();
    expect(r.driver.check).toHaveBeenCalledOnce();
    expect(r.driver.download).toHaveBeenCalledOnce();
    expect(r.updates.state).toMatchObject({ phase: "ready", version: "0.8.1", automatic: true });
    expect(r.updates.state.message).toContain("never during work");
  });

  it("installs only after 15 minutes without input, with the runtime idle proof, and relaunches", async () => {
    const r = rig();
    await ready(r);
    r.setIdle(AUTO_UPDATE_TIMING.idleSeconds - 1);
    await r.auto.tick();
    expect(r.guards.prepareDrafts).not.toHaveBeenCalled();
    r.setIdle(AUTO_UPDATE_TIMING.idleSeconds);
    await r.auto.tick();
    expect(r.guards.prepareDaemon).toHaveBeenCalledExactlyOnceWith(expect.any(String), { idleProof: true });
    expect(r.driver.install).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(r.updates.state.phase).toBe("restarting");
  });

  it("a busy daemon or drafts stop nothing: it waits five minutes and tries again", async () => {
    let busy = true;
    const r = rig({ busy: () => busy });
    await ready(r);
    r.setIdle(AUTO_UPDATE_TIMING.idleSeconds);
    await r.auto.tick();
    expect(r.updates.state).toMatchObject({ phase: "ready", message: expect.stringContaining("Nothing was stopped") });
    expect(r.guards.stopDaemon).not.toHaveBeenCalled();
    expect(r.guards.resume).not.toHaveBeenCalled();
    expect(r.guards.releaseDrafts).toHaveBeenCalledOnce();
    r.advance(4 * MINUTE);
    await r.auto.tick();
    expect(r.guards.prepareDaemon).toHaveBeenCalledOnce();
    busy = false;
    r.advance(MINUTE);
    await r.auto.tick();
    expect(r.guards.prepareDaemon).toHaveBeenCalledTimes(2);
    expect(r.driver.install).toHaveBeenCalledOnce();
  });

  it("marks a download overdue after three days of waiting, and clears it once it moves on", async () => {
    const r = rig({ busy: () => true });
    await ready(r);
    r.advance(3 * 24 * HOUR - MINUTE);
    await r.auto.tick();
    expect(r.updates.state.overdue).toBeFalsy();
    r.advance(MINUTE);
    await r.auto.tick();
    expect(r.updates.state.overdue).toBe(true);
    expect(r.guards.stopDaemon).not.toHaveBeenCalled();
  });

  it("does nothing while turned off, and says so at once", async () => {
    const r = rig({ enabled: false });
    expect(r.updates.state.automatic).toBe(false);
    r.advance(AUTO_UPDATE_TIMING.firstCheckMs);
    await r.auto.tick();
    expect(r.driver.check).not.toHaveBeenCalled();
    // A person still downloads by hand; nothing installs on its own.
    await r.updates.act("check");
    await r.updates.act("download");
    r.setIdle(AUTO_UPDATE_TIMING.idleSeconds);
    await r.auto.tick();
    expect(r.guards.prepareDrafts).not.toHaveBeenCalled();
    expect(r.auto.installsOnClose).toBe(false);
    r.setEnabled(true);
    expect(r.updates.state.automatic).toBe(true);
    await r.auto.tick();
    expect(r.driver.install).toHaveBeenCalledOnce();
  });

  it("closing the last window installs without starting the app again, and tries only once", async () => {
    let busy = true;
    const r = rig({ busy: () => busy });
    await ready(r);
    expect(r.auto.installsOnClose).toBe(true);
    expect(await r.auto.installOnClose()).toBe(false);
    expect(r.auto.installsOnClose).toBe(false);
    busy = false;
    expect(await r.auto.installOnClose()).toBe(false);
    expect(r.guards.prepareDaemon).toHaveBeenCalledOnce();

    const fresh = rig();
    await ready(fresh);
    expect(await fresh.auto.installOnClose()).toBe(true);
    expect(fresh.driver.install).toHaveBeenCalledExactlyOnceWith({ relaunch: false });
  });

  it("an unknown installer outcome is left alone: no further automatic attempts", async () => {
    const r = rig();
    r.driver.install = vi.fn(() => Promise.reject(new Error("timeout")));
    await ready(r);
    r.setIdle(AUTO_UPDATE_TIMING.idleSeconds);
    await r.auto.tick();
    expect(r.updates.state.phase).toBe("error");
    r.advance(5 * HOUR);
    await r.auto.tick();
    expect(r.driver.check).toHaveBeenCalledOnce();
    expect(r.driver.install).toHaveBeenCalledOnce();
    expect(r.auto.installsOnClose).toBe(false);
  });
});
