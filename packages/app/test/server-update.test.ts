/**
 * Updating a remote server from the app (#879): the command it runs, how the updater's exit
 * reads, and the main process's one-at-a-time runner. The server side of these messages is
 * `tools/deploy/orca-release.py`; the ssh side is `SshTunnel.exec` (protocol tests).
 */
import { describe, expect, it, vi } from "vitest";
import type { ManagedDeployment } from "@orca/protocol";
import { TunnelRefusal, type RemoteCommand, type RemoteCommandExit } from "@orca/protocol/remote-access";
import {
  classifyServerUpdate,
  SERVER_UPDATE_MAX_LINES,
  serverBehind,
  serverUpdateCommand,
  updaterError,
  type ServerUpdateProgress,
} from "../src/server-update.js";
import { ServerUpdater } from "../src/main/server-update.js";

const deployment: ManagedDeployment = {
  kind: "managed",
  adapter: "/opt/orca/orca-release.py",
  manifest: "/etc/orca/deployment.json",
  ring: "preview",
};
const err = (line: string): ServerUpdateProgress => ({ stream: "stderr", line });
const explain = (code: string) => `explained ${code}`;

describe("the command", () => {
  it("is the updater an operator would type, for this app's release", () => {
    expect(serverUpdateCommand(deployment, "0.8.0-rc.2")).toEqual([
      "python3",
      "/opt/orca/orca-release.py",
      "--deployment",
      "/etc/orca/deployment.json",
      "update",
      "--bundle",
      "v0.8.0-rc.2",
    ]);
  });
  it.each(["0.8.0-dev", "v0.8.0", "0.8", "0.8.0; reboot"])("refuses %j", (version) => {
    expect(() => serverUpdateCommand(deployment, version)).toThrow(/Not a release version/);
  });
});

describe("reading the updater's exit", () => {
  it("takes the last orca-release line from stderr only", () => {
    expect(updaterError([err("orca-release: first"), { stream: "stdout", line: "orca-release: no" }])).toBe("first");
    expect(updaterError([err("orca-release: one"), err("noise"), err("orca-release:  two ")])).toBe("two");
    expect(updaterError([err("plain")])).toBeUndefined();
  });

  it.each<[RemoteCommandExit, ServerUpdateProgress[], object]>([
    [{ kind: "exited", code: 0 }, [], { status: "updated", version: "0.8.0" }],
    [
      { kind: "refused", refusal: "auth-failed" },
      [],
      { status: "unreachable", refusal: "auth-failed", message: "explained auth-failed" },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Busy: update.lock; another update is running")],
      { status: "another-update", detail: "Busy: update.lock; another update is running" },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Busy: admission.lock; work is starting")],
      { status: "work-running", detail: "Busy: admission.lock; work is starting" },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Daemon busy: 2 runs active")],
      { status: "work-running", detail: "Daemon busy: 2 runs active" },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Unmanaged ORCA process blocks activation: 4242")],
      { status: "work-running" },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Activation failed; previous release restored and healthy: health check")],
      { status: "failed", restored: true },
    ],
    [
      { kind: "exited", code: 1 },
      [err("orca-release: Bundle signer does not match the pinned signer")],
      { status: "failed", restored: false, detail: "Bundle signer does not match the pinned signer" },
    ],
    [{ kind: "exited", code: 3 }, [], { status: "failed", detail: "The updater exited with 3.", restored: false }],
    [{ kind: "signalled", signal: "SIGHUP" }, [], { status: "failed", detail: "The updater stopped (SIGHUP)." }],
  ])("reads %j", (exit, lines, outcome) => {
    expect(classifyServerUpdate(exit, lines, "0.8.0", explain)).toMatchObject(outcome);
  });
});

describe("serverBehind", () => {
  it.each([
    ["0.7.1", "0.8.0", true],
    ["0.8.0-rc.1", "0.8.0-rc.2", true],
    ["0.8.0-rc.2", "0.8.0", true],
    ["0.8.0", "0.8.0", false],
    ["0.8.0", "0.8.0-rc.2", false],
    ["0.9.0", "0.8.0", false],
    ["0.10.0", "0.9.9", false],
    ["dev", "0.8.0", false],
    ["0.8.0", "dev", false],
  ])("%s behind %s: %s", (server, app, behind) => {
    expect(serverBehind(server, app)).toBe(behind);
  });
});

describe("ServerUpdater", () => {
  function rig(options: { version?: string; deployment?: ManagedDeployment | undefined; profile?: boolean } = {}) {
    let finish: (exit: RemoteCommandExit) => void = () => {};
    let printer: (stream: "stdout" | "stderr", line: string) => void = () => {};
    const kill = vi.fn();
    const progress: ServerUpdateProgress[] = [];
    const run = vi.fn((_command: readonly string[], onLine: typeof printer) => {
      if (options.profile === false) return undefined;
      printer = onLine;
      const command: RemoteCommand = { exit: new Promise((resolve) => (finish = resolve)), kill };
      return { command };
    });
    const updater = new ServerUpdater({
      version: options.version ?? "0.8.0",
      deployment: () => ("deployment" in options ? options.deployment : deployment),
      run,
      onProgress: (line) => progress.push(line),
    });
    return {
      updater,
      run,
      kill,
      progress,
      finish: (exit: RemoteCommandExit) => finish(exit),
      print: (...a: Parameters<typeof printer>) => printer(...a),
    };
  }

  it("runs the server's updater once however often it is asked, and streams its lines", async () => {
    const r = rig();
    const first = r.updater.update();
    const second = r.updater.update();
    expect(second).toBe(first);
    expect(r.run).toHaveBeenCalledExactlyOnceWith(serverUpdateCommand(deployment, "0.8.0"), expect.any(Function));
    r.print("stdout", "/opt/orca/releases/0.8.0");
    r.finish({ kind: "exited", code: 0 });
    expect(await first).toEqual({ status: "updated", version: "0.8.0" });
    expect(r.progress).toEqual([{ stream: "stdout", line: "/opt/orca/releases/0.8.0" }]);
    // Done: the next ask is a new attempt.
    void r.updater.update();
    expect(r.run).toHaveBeenCalledTimes(2);
  });

  it("reads the outcome from the last lines it kept", async () => {
    const r = rig();
    const pending = r.updater.update();
    r.print("stderr", "orca-release: Busy: update.lock; held by the timer");
    for (let i = 0; i < SERVER_UPDATE_MAX_LINES; i++) r.print("stdout", `line ${i}`);
    r.finish({ kind: "exited", code: 1 });
    // The lock line fell out of the bounded window, so the exit code speaks.
    expect(await pending).toEqual({ status: "failed", detail: "The updater exited with 1.", restored: false });
    expect(r.progress).toHaveLength(SERVER_UPDATE_MAX_LINES + 1);
  });

  it("offers nothing for an unmanaged server, a development build, or a connection that is not a profile", async () => {
    expect(await rig({ deployment: undefined }).updater.update()).toMatchObject({ status: "unavailable" });
    const dev = rig({ version: "0.8.0-dev" });
    expect(await dev.updater.update()).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("0.8.0-dev"),
    });
    expect(dev.run).not.toHaveBeenCalled();
    expect(await rig({ profile: false }).updater.update()).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("SSH profile"),
    });
  });

  it("reports a tunnel that cannot run it in the app's words, and rethrows anything else", async () => {
    const refused = new ServerUpdater({
      version: "0.8.0",
      deployment: () => deployment,
      run: () => {
        throw new TunnelRefusal("host-key-missing");
      },
      onProgress: () => {},
    });
    expect(await refused.update()).toEqual({
      status: "unreachable",
      refusal: "host-key-missing",
      message: new TunnelRefusal("host-key-missing").message,
    });
    const broken = new ServerUpdater({
      version: "0.8.0",
      deployment: () => deployment,
      run: () => {
        throw new Error("bug");
      },
      onProgress: () => {},
    });
    await expect(broken.update()).rejects.toThrow("bug");
    const r = rig();
    const pending = r.updater.update();
    r.finish({ kind: "refused", refusal: "unreachable" });
    expect(await pending).toEqual({
      status: "unreachable",
      refusal: "unreachable",
      message: new TunnelRefusal("unreachable").message,
    });
  });

  it("hangs up on quit, and only while it runs", async () => {
    const r = rig();
    r.updater.stop();
    expect(r.kill).not.toHaveBeenCalled();
    const pending = r.updater.update();
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
    r.finish({ kind: "signalled", signal: "SIGTERM" });
    await pending;
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
  });
});
