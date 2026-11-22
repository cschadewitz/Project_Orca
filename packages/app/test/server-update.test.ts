/**
 * Updating a remote server from the app (#879): the command it runs, how the updater's exit
 * reads, and the main process's one-at-a-time runner. The server side of these messages is
 * `tools/deploy/orca-release.py`; the ssh side is `SshTunnel.exec` (protocol tests).
 */
import { describe, expect, it, vi } from "vitest";
import type { ManagedDeployment } from "@orca/protocol";
import {
  RemoteCommandRefused,
  TunnelRefusal,
  type RemoteCommand,
  type RemoteCommandExit,
} from "@orca/protocol/remote-access";
import {
  classifyServerUpdate,
  SERVER_UPDATE_MAX_LINES,
  serverBehind,
  serverUpdateCommand,
  updaterError,
  type ServerUpdateProgress,
} from "../src/server-update.js";
import { ServerUpdater, type SavedApproval, type ServerConnection } from "../src/main/server-update.js";

const deployment: ManagedDeployment = {
  kind: "managed",
  adapter: "/opt/orca/orca-release.py",
  manifest: "/etc/orca/deployment.json",
  ring: "preview",
};
const err = (line: string): ServerUpdateProgress => ({ stream: "stderr", line });
const explain = (code: string) => `explained ${code}`;

describe("the command", () => {
  it("is the updater an operator would type, for this app's release, from the release confirmed", () => {
    expect(serverUpdateCommand(deployment, "0.8.0-rc.2", "0.7.1")).toEqual([
      "python3",
      "/opt/orca/orca-release.py",
      "--deployment",
      "/etc/orca/deployment.json",
      "update",
      "--bundle",
      "v0.8.0-rc.2",
      "--expect-current",
      "0.7.1",
    ]);
    expect(serverUpdateCommand(deployment, "0.8.0", "0.8.0-beta.1")).toContain("0.8.0-beta.1");
  });
  it.each(["0.8.0-dev", "v0.8.0", "0.8", "0.8.0; reboot"])("refuses %j", (version) => {
    expect(() => serverUpdateCommand(deployment, version, "0.7.1")).toThrow(/Not a release version/);
    expect(() => serverUpdateCommand(deployment, "0.8.0", version)).toThrow(/Not a release version/);
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
      [err("orca-release: Server moved: it runs 0.8.0, not the 0.7.1 this update was confirmed against")],
      { status: "moved", detail: "Server moved: it runs 0.8.0, not the 0.7.1 this update was confirmed against" },
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
  const paths = { adapter: deployment.adapter, manifest: deployment.manifest };
  const SERVER = { hostKey: "SHA256:abc", workspaceId: WORKSPACE };

  function rig(
    options: {
      version?: string;
      serverVersion?: string;
      declared?: ManagedDeployment | undefined;
      approved?: SavedApproval | undefined;
      profile?: boolean;
      hellos?: (() => Promise<{ orcaVersion: string; workspaceId?: string }>)[];
    } = {},
  ) {
    let finish: (exit: RemoteCommandExit) => void = () => {};
    let printer: (stream: "stdout" | "stderr", line: string) => void = () => {};
    let ids = 0;
    const kill = vi.fn();
    const progress: ServerUpdateProgress[] = [];
    const state = {
      connection: { epoch: 4, profile: "lab", ...SERVER } as ServerConnection,
      serverVersion: options.serverVersion ?? "0.7.1",
      declared: "declared" in options ? options.declared : deployment,
      approved: "approved" in options ? options.approved : { ...paths, ...SERVER },
    };
    if (options.profile === false) state.connection = { epoch: 4 };
    const hellos = [...(options.hellos ?? [async () => ({ orcaVersion: "0.8.0", workspaceId: WORKSPACE })])];
    const run = vi.fn<(command: readonly string[], onLine: typeof printer) => { command: RemoteCommand } | undefined>(
      (_command, onLine) => {
        printer = onLine;
        const command: RemoteCommand = { exit: new Promise((resolve) => (finish = resolve)), kill };
        return { command };
      },
    );
    const hello = vi.fn(() => (hellos.length > 1 ? hellos.shift()! : hellos[0]!)());
    const approve = vi.fn((_profile: string, approved: SavedApproval) => {
      state.approved = approved;
    });
    const updater = new ServerUpdater({
      version: options.version ?? "0.8.0",
      connection: () => state.connection,
      serverVersion: () => state.serverVersion,
      declared: () => state.declared,
      approved: () => state.approved,
      approve,
      run,
      hello,
      onProgress: (line) => progress.push(line),
      confirm: { attempts: 3, delayMs: 1 },
      sleep: () => Promise.resolve(),
      id: () => `preview-${++ids}`,
    });
    const preview = () => updater.read()!.id;
    return {
      updater,
      state,
      run,
      hello,
      approve,
      kill,
      progress,
      preview,
      finish: (exit: RemoteCommandExit) => finish(exit),
      print: (...a: Parameters<typeof printer>) => printer(...a),
    };
  }

  it("previews the profile connection's server from main's own view, and nothing for any other", () => {
    expect(rig().updater.read()).toEqual({
      id: "preview-1",
      profile: "lab",
      epoch: 4,
      ...SERVER,
      serverVersion: "0.7.1",
      targetVersion: "0.8.0",
      declared: paths,
      approved: paths,
    });
    expect(rig({ profile: false }).updater.read()).toBeUndefined();
  });

  it.each<[string, Parameters<typeof rig>[0], RegExp]>([
    ["a development build", { version: "0.8.0-dev" }, /not a release build/],
    ["a server already on the release", { serverVersion: "0.8.0" }, /already runs 0\.8\.0/],
    ["a newer server", { serverVersion: "0.9.0" }, /already runs 0\.9\.0/],
    ["a server on a version the updater never recorded", { serverVersion: "0.7.1-dev" }, /not a release the updater/],
    ["an unmanaged daemon", { declared: undefined }, /not installed by the managed server updater/],
    ["no approval", { approved: undefined }, /Approve this server's updater first/],
    ["an approval made on another host key", { approved: { ...paths, ...SERVER, hostKey: "SHA256:old" } }, /Approve/],
    [
      "an approval made on another workspace",
      { approved: { ...paths, ...SERVER, workspaceId: "6f2b3c5e-3c0e-4f6a-9a59-6c1b8e6f0a11" } },
      /Approve/,
    ],
    [
      "a daemon that now points elsewhere",
      { declared: { ...deployment, adapter: "/srv/other/orca-release.py" } },
      /somewhere other than you approved/,
    ],
  ])("blocks and runs nothing for %s", async (_name, options, reason) => {
    const r = rig(options);
    const preview = r.updater.read()!;
    expect(preview.blocked).toMatch(reason);
    expect(await r.updater.update({ preview: preview.id })).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(reason),
    });
    expect(r.run).not.toHaveBeenCalled();
  });

  it("approves only paths the person entered that match the server's report, bound to that server", () => {
    const r = rig({ approved: undefined });
    const preview = r.preview();
    expect(
      r.updater.approve({ preview, adapter: "/srv/orca/orca-release.py", manifest: paths.manifest }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("not where this server says"),
    });
    expect(r.updater.approve({ preview, adapter: "/opt/orca/run.py", manifest: paths.manifest })).toMatchObject({
      ok: false,
      message: expect.stringContaining("orca-release.py"),
    });
    expect(r.updater.approve({ preview, adapter: paths.adapter, manifest: "/etc/orca/deployment" })).toMatchObject({
      ok: false,
      message: expect.stringContaining(".json"),
    });
    expect(r.updater.approve({ preview: "never-shown", ...paths })).toMatchObject({ ok: false });
    expect(r.approve).not.toHaveBeenCalled();
    expect(r.updater.approve({ preview, ...paths })).toEqual({ ok: true });
    expect(r.approve).toHaveBeenCalledExactlyOnceWith("lab", { ...paths, ...SERVER });

    const anonymous = rig({ approved: undefined });
    anonymous.state.connection = { epoch: 4, profile: "lab" };
    expect(anonymous.updater.approve({ preview: anonymous.preview(), ...paths })).toMatchObject({
      ok: false,
      message: expect.stringContaining("not identified itself"),
    });
  });

  it.each<[string, (r: ReturnType<typeof rig>) => void]>([
    ["another connection", (r) => (r.state.connection = { ...r.state.connection, epoch: 5 })],
    ["another host key", (r) => (r.state.connection = { ...r.state.connection, hostKey: "SHA256:zzz" })],
    ["another server version", (r) => (r.state.serverVersion = "0.7.2")],
    ["another hint", (r) => (r.state.declared = { ...deployment, manifest: "/etc/orca/other.json" })],
  ])("refuses a preview once the server shows %s", async (_name, change) => {
    const r = rig();
    const preview = r.preview();
    change(r);
    expect(await r.updater.update({ preview })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("changed since this was shown"),
    });
    expect(r.updater.approve({ preview, ...paths })).toMatchObject({ ok: false });
    expect(r.run).not.toHaveBeenCalled();
  });

  it("remembers only the last few previews", async () => {
    const r = rig();
    const first = r.preview();
    for (let i = 0; i < 8; i++) r.preview();
    expect(await r.updater.update({ preview: first })).toMatchObject({ status: "unavailable" });
  });

  it("runs the approved updater once however often it is asked, and confirms with a fresh hello", async () => {
    const r = rig();
    const preview = r.preview();
    const first = r.updater.update({ preview });
    expect(r.updater.update({ preview })).toBe(first);
    expect(r.run).toHaveBeenCalledExactlyOnceWith(serverUpdateCommand(paths, "0.8.0", "0.7.1"), expect.any(Function));
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
    const pending = restarting.updater.update({ preview: restarting.preview() });
    restarting.finish({ kind: "exited", code: 0 });
    expect(await pending).toEqual({ status: "updated", version: "0.8.0" });

    const stuck = rig({ hellos: [async () => ({ orcaVersion: "0.7.1", workspaceId: WORKSPACE })] });
    const never = stuck.updater.update({ preview: stuck.preview() });
    stuck.finish({ kind: "exited", code: 0 });
    expect(await never).toEqual({ status: "unknown", reason: "not-confirmed", serverVersion: "0.7.1" });
    expect(stuck.hello).toHaveBeenCalledTimes(3);

    // Another workspace answering is not this server confirming.
    const other = rig({ hellos: [async () => ({ orcaVersion: "0.8.0", workspaceId: "other" })] });
    const elsewhere = other.updater.update({ preview: other.preview() });
    other.finish({ kind: "exited", code: 0 });
    expect(await elsewhere).toEqual({ status: "unknown", reason: "not-confirmed" });

    // Nor is another server behind the same profile, before the hello...
    const moved = rig();
    const gone = moved.updater.update({ preview: moved.preview() });
    moved.state.connection = { ...moved.state.connection, hostKey: "SHA256:other" };
    moved.finish({ kind: "exited", code: 0 });
    expect(await gone).toEqual({ status: "unknown", reason: "not-confirmed" });
    expect(moved.hello).not.toHaveBeenCalled();

    // ...or while it was in flight.
    let swap: () => void = () => {};
    const racing = rig({
      hellos: [
        async () => {
          swap();
          return { orcaVersion: "0.8.0", workspaceId: WORKSPACE };
        },
      ],
    });
    swap = () => (racing.state.connection = { ...racing.state.connection, hostKey: "SHA256:other" });
    const raced = racing.updater.update({ preview: racing.preview() });
    racing.finish({ kind: "exited", code: 0 });
    expect(await raced).toEqual({ status: "unknown", reason: "not-confirmed" });
  });

  it("reports a session lost after the updater started as unknown, unless the server then confirms", async () => {
    const lost = rig({ hellos: [() => Promise.reject(new Error("down"))] });
    const pending = lost.updater.update({ preview: lost.preview() });
    lost.finish({ kind: "refused", refusal: "unreachable" });
    expect(await pending).toEqual({ status: "unknown", reason: "connection-lost" });

    const landed = rig();
    const done = landed.updater.update({ preview: landed.preview() });
    landed.finish({ kind: "signalled", signal: "SIGHUP" });
    expect(await done).toEqual({ status: "updated", version: "0.8.0" });
  });

  it("reads the outcome from the last lines it kept", async () => {
    const r = rig();
    const pending = r.updater.update({ preview: r.preview() });
    r.print("stderr", "orca-release: Busy: update.lock; held by the timer");
    for (let i = 0; i < SERVER_UPDATE_MAX_LINES; i++) r.print("stdout", `line ${i}`);
    r.finish({ kind: "exited", code: 1 });
    // The lock line fell out of the bounded window, so the exit code speaks.
    expect(await pending).toEqual({ status: "failed", detail: "The updater exited with 1.", restored: false });
    expect(r.progress).toHaveLength(SERVER_UPDATE_MAX_LINES + 1);
  });

  it("reports a tunnel that cannot start the updater in the app's words, and rethrows anything else", async () => {
    const r = rig();
    r.run.mockImplementationOnce(() => {
      throw new TunnelRefusal("host-key-missing");
    });
    expect(await r.updater.update({ preview: r.preview() })).toEqual({
      status: "unreachable",
      refusal: "host-key-missing",
      message: new TunnelRefusal("host-key-missing").message,
    });
    r.run.mockImplementationOnce(() => undefined);
    expect(await r.updater.update({ preview: r.preview() })).toMatchObject({ status: "unavailable" });
    r.run.mockImplementationOnce(() => {
      throw new RemoteCommandRefused("A remote command word has unsupported characters");
    });
    expect(await r.updater.update({ preview: r.preview() })).toMatchObject({ status: "unavailable" });
    r.run.mockImplementationOnce(() => {
      throw new Error("bug");
    });
    await expect(r.updater.update({ preview: r.preview() })).rejects.toThrow("bug");
  });

  it("hangs up on quit, only while it runs, and stops waiting for confirmation", async () => {
    const r = rig({ hellos: [() => Promise.reject(new Error("down"))] });
    const pending = r.updater.update({ preview: r.preview() });
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
    r.finish({ kind: "signalled", signal: "SIGTERM" });
    expect(await pending).toEqual({ status: "unknown", reason: "connection-lost" });
    expect(r.hello).not.toHaveBeenCalled();
    r.updater.stop();
    expect(r.kill).toHaveBeenCalledOnce();
  });
});
