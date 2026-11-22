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
  type ServerUpdaterPaths,
} from "../src/server-update.js";
import { ServerUpdater, type ServerConnection } from "../src/main/server-update.js";

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
    // After the command may have started, a lost session or a signal is unknown, never "nothing changed".
    [{ kind: "signalled", signal: "SIGHUP" }, [], { status: "unknown", reason: "connection-lost" }],
    [{ kind: "refused", refusal: "unreachable" }, [], { status: "unknown", reason: "connection-lost" }],
    [{ kind: "refused", refusal: "ssh-failed" }, [], { status: "unknown", reason: "connection-lost" }],
    [{ kind: "refused", refusal: "host-key-changed" }, [], { status: "unreachable", refusal: "host-key-changed" }],
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
  const WORKSPACE = "9b2b3c5e-3c0e-4f6a-9a59-6c1b8e6f0a11";
  const target = { profile: "lab", epoch: 4, hostKey: "SHA256:abc", workspaceId: WORKSPACE };
  const request = { ...target, version: "0.8.0" };
  const paths = { adapter: deployment.adapter, manifest: deployment.manifest };

  function rig(
    options: {
      version?: string;
      declared?: ManagedDeployment | undefined;
      approved?: { adapter: string; manifest: string } | undefined;
      profile?: boolean;
      hellos?: (() => Promise<{ orcaVersion: string; workspaceId?: string }>)[];
    } = {},
  ) {
    let finish: (exit: RemoteCommandExit) => void = () => {};
    let printer: (stream: "stdout" | "stderr", line: string) => void = () => {};
    const kill = vi.fn();
    const progress: ServerUpdateProgress[] = [];
    const state = {
      connection: { epoch: 4, profile: "lab", hostKey: "SHA256:abc", workspaceId: WORKSPACE } as ServerConnection,
      approved: ("approved" in options ? options.approved : paths) as ServerUpdaterPaths | undefined,
    };
    if (options.profile === false) state.connection = { epoch: 4 };
    const hellos = [...(options.hellos ?? [async () => ({ orcaVersion: "0.8.0", workspaceId: WORKSPACE })])];
    const run = vi.fn((_command: readonly string[], onLine: typeof printer) => {
      if (options.profile === false) return undefined;
      printer = onLine;
      const command: RemoteCommand = { exit: new Promise((resolve) => (finish = resolve)), kill };
      return { command };
    });
    const hello = vi.fn(() => (hellos.length > 1 ? hellos.shift()! : hellos[0]!)());
    const approve = vi.fn((_profile: string, approved: ServerUpdaterPaths) => {
      state.approved = approved;
    });
    const updater = new ServerUpdater({
      version: options.version ?? "0.8.0",
      connection: () => state.connection,
      declared: () => ("declared" in options ? options.declared : deployment),
      approved: () => state.approved,
      approve,
      run,
      hello,
      onProgress: (line) => progress.push(line),
      confirm: { attempts: 3, delayMs: 1 },
      sleep: () => Promise.resolve(),
    });
    return {
      updater,
      state,
      run,
      hello,
      approve,
      kill,
      progress,
      finish: (exit: RemoteCommandExit) => finish(exit),
      print: (...a: Parameters<typeof printer>) => printer(...a),
    };
  }

  it("shows main's view of the profile connection, and nothing for any other", () => {
    expect(rig().updater.read()).toEqual({ ...target, declared: paths, approved: paths });
    expect(rig({ approved: undefined, declared: undefined }).updater.read()).toEqual(target);
    expect(rig({ profile: false }).updater.read()).toBeUndefined();
  });

  it("approves only what the server reports now, on the connection the person saw", () => {
    const r = rig({ approved: undefined });
    expect(r.updater.approve({ ...target, adapter: "/tmp/evil.py", manifest: paths.manifest })).toMatchObject({
      ok: false,
    });
    expect(r.updater.approve({ ...target, epoch: 5, ...paths })).toMatchObject({ ok: false });
    expect(r.approve).not.toHaveBeenCalled();
    expect(r.updater.approve({ ...target, ...paths })).toEqual({ ok: true });
    expect(r.approve).toHaveBeenCalledExactlyOnceWith("lab", paths);
  });

  it("runs the approved updater once however often it is asked, and confirms with a fresh hello", async () => {
    const r = rig();
    const first = r.updater.update(request);
    const second = r.updater.update(request);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(r.run).toHaveBeenCalledExactlyOnceWith(serverUpdateCommand(paths, "0.8.0"), expect.any(Function));
    r.print("stdout", "/opt/orca/releases/0.8.0");
    r.finish({ kind: "exited", code: 0 });
    expect(await first).toEqual({ status: "updated", version: "0.8.0" });
    expect(r.hello).toHaveBeenCalledOnce();
    expect(r.progress).toEqual([{ stream: "stdout", line: "/opt/orca/releases/0.8.0" }]);
  });

  it("waits out a restart, but never reports an update the server has not confirmed", async () => {
    const restarting = rig({
      hellos: [
        () => Promise.reject(new Error("restarting")),
        async () => ({ orcaVersion: "0.7.1", workspaceId: WORKSPACE }),
        async () => ({ orcaVersion: "0.8.0", workspaceId: WORKSPACE }),
      ],
    });
    const pending = restarting.updater.update(request);
    await Promise.resolve();
    restarting.finish({ kind: "exited", code: 0 });
    expect(await pending).toEqual({ status: "updated", version: "0.8.0" });

    const stuck = rig({ hellos: [async () => ({ orcaVersion: "0.7.1", workspaceId: WORKSPACE })] });
    const never = stuck.updater.update(request);
    await Promise.resolve();
    stuck.finish({ kind: "exited", code: 0 });
    expect(await never).toEqual({ status: "unknown", reason: "not-confirmed", serverVersion: "0.7.1" });
    expect(stuck.hello).toHaveBeenCalledTimes(3);

    // Another workspace answering is not this server confirming.
    const other = rig({ hellos: [async () => ({ orcaVersion: "0.8.0", workspaceId: "other" })] });
    const elsewhere = other.updater.update(request);
    await Promise.resolve();
    other.finish({ kind: "exited", code: 0 });
    expect(await elsewhere).toEqual({ status: "unknown", reason: "not-confirmed" });

    // Nor is another server behind the same profile.
    const moved = rig();
    const gone = moved.updater.update(request);
    await Promise.resolve();
    moved.state.connection = { ...moved.state.connection, hostKey: "SHA256:other" };
    moved.finish({ kind: "exited", code: 0 });
    expect(await gone).toEqual({ status: "unknown", reason: "not-confirmed" });
    expect(moved.hello).not.toHaveBeenCalled();
  });

  it("reports a session lost after the updater started as unknown, unless the server then confirms", async () => {
    const lost = rig({ hellos: [() => Promise.reject(new Error("down"))] });
    const pending = lost.updater.update(request);
    await Promise.resolve();
    lost.finish({ kind: "refused", refusal: "unreachable" });
    expect(await pending).toEqual({ status: "unknown", reason: "connection-lost" });

    const landed = rig();
    const done = landed.updater.update(request);
    await Promise.resolve();
    landed.finish({ kind: "signalled", signal: "SIGHUP" });
    expect(await done).toEqual({ status: "updated", version: "0.8.0" });
  });

  it("reads the outcome from the last lines it kept", async () => {
    const r = rig();
    const pending = r.updater.update(request);
    await Promise.resolve();
    r.print("stderr", "orca-release: Busy: update.lock; held by the timer");
    for (let i = 0; i < SERVER_UPDATE_MAX_LINES; i++) r.print("stdout", `line ${i}`);
    r.finish({ kind: "exited", code: 1 });
    // The lock line fell out of the bounded window, so the exit code speaks.
    expect(await pending).toEqual({ status: "failed", detail: "The updater exited with 1.", restored: false });
    expect(r.progress).toHaveLength(SERVER_UPDATE_MAX_LINES + 1);
  });

  it.each<[string, Parameters<typeof rig>[0], Partial<typeof request>, RegExp]>([
    ["a development build", { version: "0.8.0-dev" }, { version: "0.8.0-dev" }, /not a release build/],
    ["another version than the app's", {}, { version: "0.9.0" }, /its own version, 0\.8\.0/],
    ["a connection that is not a profile", { profile: false }, {}, /SSH profile/],
    ["another profile", {}, { profile: "other" }, /connection changed/],
    ["another connection", {}, { epoch: 5 }, /connection changed/],
    ["another host key", {}, { hostKey: "SHA256:zzz" }, /connection changed/],
    ["another workspace", {}, { workspaceId: "6f2b3c5e-3c0e-4f6a-9a59-6c1b8e6f0a11" }, /connection changed/],
    ["no approval", { approved: undefined }, {}, /Approve this server's updater first/],
    ["an unmanaged daemon", { declared: undefined }, {}, /other than you approved/],
    [
      "a daemon that now points elsewhere",
      { declared: { ...deployment, adapter: "/tmp/orca-release.py" } },
      {},
      /other than you approved/,
    ],
  ])("runs nothing for %s", async (_name, options, change, reason) => {
    const r = rig(options);
    expect(await r.updater.update({ ...request, ...change })).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(reason),
    });
    expect(r.run).not.toHaveBeenCalled();
  });

  it("reports a tunnel that cannot start the updater in the app's words, and rethrows anything else", async () => {
    const r = rig();
    r.run.mockImplementationOnce(() => {
      throw new TunnelRefusal("host-key-missing");
    });
    expect(await r.updater.update(request)).toEqual({
      status: "unreachable",
      refusal: "host-key-missing",
      message: new TunnelRefusal("host-key-missing").message,
    });
    r.run.mockImplementationOnce(() => {
      throw new Error("bug");
    });
    await expect(r.updater.update(request)).rejects.toThrow("bug");
  });

  it("hangs up on quit, only while it runs, and stops waiting for confirmation", async () => {
    const r = rig({ hellos: [() => Promise.reject(new Error("down"))] });
    const pending = r.updater.update(request);
    await Promise.resolve();
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
    r.finish({ kind: "signalled", signal: "SIGTERM" });
    expect(await pending).toEqual({ status: "unknown", reason: "connection-lost" });
    expect(r.hello).not.toHaveBeenCalled();
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
  });
});
