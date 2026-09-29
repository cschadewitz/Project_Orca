import { describe, expect, it, vi } from "vitest";
import { Updates, type UpdateGuards, type UpdateDriver } from "../src/main/updates.js";
import { isUpdateAction, prepareDrafts } from "../src/main/update-ipc.js";
function rig() {
  const order: string[] = [];
  const driver: UpdateDriver = {
    check: vi.fn(() => Promise.resolve("0.6.1")),
    download: vi.fn((progress) => {
      progress(42);
      return Promise.resolve();
    }),
    install: vi.fn(() => {
      order.push("install");
      return Promise.resolve();
    }),
  };
  const guards: UpdateGuards = {
    prepareDrafts: vi.fn(() => {
      order.push("drafts");
      return Promise.resolve();
    }),
    prepareDaemon: vi.fn(() => {
      order.push("admission");
      return Promise.resolve();
    }),
    stopDaemon: vi.fn(() => {
      order.push("stop");
      return Promise.resolve();
    }),
    resume: vi.fn(() => Promise.resolve()),
    releaseDrafts: vi.fn(),
  };
  const changed = vi.fn();
  return { driver, guards, order, changed, updates: new Updates(driver, "0.6.0", guards, changed) };
}
describe("manual updates", () => {
  it("does not download on check or install on download; stops only after guards", async () => {
    const r = rig();
    await r.updates.act("restart");
    expect(r.driver.install).not.toHaveBeenCalled();
    expect((await r.updates.act("check")).phase).toBe("available");
    expect(r.driver.download).not.toHaveBeenCalled();
    expect((await r.updates.act("download")).phase).toBe("ready");
    expect(r.changed).toHaveBeenCalledWith(expect.objectContaining({ percent: 42 }));
    expect(r.driver.install).not.toHaveBeenCalled();
    await r.updates.act("restart");
    expect(r.order).toEqual(["drafts", "admission", "stop", "install"]);
  });
  it("serializes duplicate checks and hides feed credentials on failure, then retries", async () => {
    const r = rig();
    let reject!: (error: Error) => void;
    r.driver.check = vi.fn(
      () =>
        new Promise<string | undefined>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const first = r.updates.act("check");
    await r.updates.act("check");
    expect(r.driver.check).toHaveBeenCalledTimes(1);
    reject(new Error("Authorization: secret"));
    expect((await first).phase).toBe("error");
    expect(JSON.stringify(r.updates.state)).not.toContain("secret");
    r.driver.check = () => Promise.resolve(undefined);
    expect((await r.updates.act("check")).phase).toBe("current");
  });
  it.each(["prepareDrafts", "prepareDaemon", "stopDaemon"] as const)(
    "refuses restart on %s failure and keeps the download",
    async (guard) => {
      const r = rig();
      await r.updates.act("check");
      await r.updates.act("download");
      r.guards[guard] = vi.fn(() => Promise.reject(new Error("busy")));
      expect((await r.updates.act("restart")).phase).toBe("ready");
      expect(r.driver.install).not.toHaveBeenCalled();
      expect(r.guards.releaseDrafts).toHaveBeenCalledOnce();
      expect(r.guards.resume).toHaveBeenCalledOnce();
    },
  );
  it("recovers download and installer failures", async () => {
    const r = rig();
    await r.updates.act("check");
    r.driver.download = () => Promise.reject(new Error("offline"));
    expect((await r.updates.act("download")).phase).toBe("error");
    r.driver.download = () => Promise.resolve();
    await r.updates.act("check");
    await r.updates.act("download");
    r.driver.install = () => Promise.reject(new Error("installer refused"));
    expect((await r.updates.act("restart")).phase).toBe("ready");
    expect(r.guards.releaseDrafts).toHaveBeenCalled();
  });
});
describe("update IPC", () => {
  it("accepts only the three literal actions", () => {
    expect(["check", "download", "restart"].every(isUpdateAction)).toBe(true);
    for (const value of [null, {}, ["restart"], "install", 0]) expect(isUpdateAction(value)).toBe(false);
  });
  it("requires all windows, ignores foreign senders and stale acknowledgements", async () => {
    let callback!: (sender: number, value: unknown) => void;
    let nonce = "";
    const unlisten = vi.fn();
    const pending = prepareDrafts({
      ids: [1, 2],
      send: (n) => {
        nonce = n;
      },
      listen: (cb) => {
        callback = cb;
        return unlisten;
      },
    });
    callback(1, { nonce: "stale", ready: true });
    callback(99, { nonce, ready: true });
    callback(1, { nonce, ready: true });
    expect(unlisten).not.toHaveBeenCalled();
    callback(2, { nonce, ready: true });
    await pending;
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("fails closed on a hung renderer", async () => {
    vi.useFakeTimers();
    const pending = prepareDrafts({ ids: [1], send: () => undefined, listen: () => () => undefined });
    const assertion = expect(pending).rejects.toThrow("renderer unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});
