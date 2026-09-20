/**
 * Re-pointing a running app at another store (#164): the five things a switch has to do,
 * in order, and the gate every bridge call waits on while it happens.
 *
 * The daemon, the client and the stream are all seams here, because what is being tested is
 * the *order* — a read answered by the daemon that is being killed, or a status bar still
 * claiming the old daemon's capabilities, are both bugs a real daemon would only make
 * intermittently.
 */
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../src/client/daemon-client.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import { NoBundledDaemonError, Workspace, storeRoot, type WorkspaceDeps } from "../src/main/workspace.js";

/** What the test watches: every step of a switch, in the order it happened. */
type Step = string;

interface Rig {
  workspace: Workspace;
  steps: Step[];
}

function rig(options: { bundled?: boolean; explicitUrl?: string } = {}): Rig {
  const steps: Step[] = [];
  let port = 0;

  const deps: WorkspaceDeps = {
    findEntry: () => (options.bundled === false ? undefined : "/resources/daemon/orca-daemon.mjs"),
    start: ({ cwd, readOnly }) => {
      port += 1;
      const url = `http://127.0.0.1:${6000 + port}`;
      steps.push(`start ${cwd}${readOnly ? " --read-only" : ""}`);
      const daemon: BundledDaemon = {
        url,
        pid: port,
        stop: () => {
          steps.push(`stop ${url}`);
          return Promise.resolve();
        },
      };
      return Promise.resolve(daemon);
    },
    client: (url) => {
      steps.push(`client ${url}`);
      return { url } as DaemonClient;
    },
    subscribe: (client) => {
      steps.push(`subscribe ${client.url}`);
      return { close: () => steps.push(`unsubscribe ${client.url}`) } as unknown as DaemonSubscription;
    },
    onSwitch: (fileMode) => steps.push(`reset ${fileMode ? "file" : "live"}`),
    onSnapshot: (snapshot) => steps.push(`snapshot ${snapshot.path} ${snapshot.readOnly ? "ro" : "rw"}`),
    ...(options.explicitUrl !== undefined ? { explicitUrl: options.explicitUrl } : {}),
    defaultUrl: "http://127.0.0.1:6722",
    defaultPath: () => "/home/casey",
  };

  return { workspace: new Workspace(deps), steps };
}

describe("Workspace", () => {
  it("connects to the bundled daemon over the default workspace", async () => {
    const { workspace, steps } = rig();
    await workspace.connect();

    expect(steps).toEqual([
      // A client for the default URL exists from the constructor, so a call that arrives
      // before `whenReady` has somewhere to go rather than finding a hole.
      "client http://127.0.0.1:6722",
      "reset live",
      "start /home/casey",
      "client http://127.0.0.1:6001",
      "subscribe http://127.0.0.1:6001",
      "snapshot /home/casey rw",
    ]);
    expect(workspace.snapshot).toEqual({ path: "/home/casey", readOnly: false, source: "default" });
  });

  it("leaves a daemon somebody else is running alone", async () => {
    const { workspace, steps } = rig({ explicitUrl: "http://remote:6722" });
    await workspace.connect();

    // No `start`: ORCA_DAEMON_URL is a person saying which store is on screen.
    expect(steps.some((step) => step.startsWith("start"))).toBe(false);
    expect(workspace.client.url).toBe("http://remote:6722");
    expect(workspace.snapshot.source).toBe("env");
  });

  it("opens a chosen store read-only, and does it in an order nothing can read through", async () => {
    const { workspace, steps } = rig();
    await workspace.connect();
    steps.length = 0;

    await workspace.open("/work/other");

    expect(steps).toEqual([
      // The old stream first, so nothing arrives from a store nobody is looking at; then
      // the machine, so the status bar stops claiming the old daemon; then the old daemon.
      "unsubscribe http://127.0.0.1:6001",
      "reset file",
      "stop http://127.0.0.1:6001",
      "start /work/other --read-only",
      "client http://127.0.0.1:6002",
      "subscribe http://127.0.0.1:6002",
      "snapshot /work/other ro",
    ]);
    expect(workspace.snapshot).toEqual({ path: "/work/other", readOnly: true, source: "chosen" });
  });

  it("holds every call until the switch has settled, then answers from the new daemon", async () => {
    const { workspace } = rig();
    await workspace.connect();

    /* A call that arrives *during* the switch, which is the whole point of `ready()`: it
       is started before the switch has settled and must not read the client it would have
       read a moment earlier. */
    const opening = workspace.open("/work/other");
    let sawUrl: string | undefined;
    const call = workspace.ready().then(() => {
      sawUrl = workspace.client.url;
    });
    await Promise.all([opening, call]);

    // Not the daemon that was being killed while the call was in flight.
    expect(sawUrl).toBe("http://127.0.0.1:6002");
  });

  it("goes back to a writable daemon on the default workspace", async () => {
    const { workspace } = rig();
    await workspace.connect();
    await workspace.open("/work/other");

    expect(await workspace.connectLive()).toEqual({ path: "/home/casey", readOnly: false, source: "default" });
  });

  it("refuses to open a store when this build has no daemon to open it with", async () => {
    const { workspace } = rig({ bundled: false });
    await expect(workspace.open("/work/other")).rejects.toBeInstanceOf(NoBundledDaemonError);
    // And says what to do instead, rather than leaving a window that did nothing.
    await expect(workspace.open("/work/other")).rejects.toThrow("orca serve --read-only --cwd /work/other");
  });

  it("stays open on a daemon that would not start, and says so", async () => {
    const steps: string[] = [];
    const workspace = new Workspace({
      findEntry: () => "/resources/daemon/orca-daemon.mjs",
      start: () => Promise.reject(new Error("port in use")),
      client: (url) => ({ url }) as DaemonClient,
      subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
      onSwitch: () => {},
      onSnapshot: () => {},
      onError: (message) => steps.push(message),
      defaultUrl: "http://127.0.0.1:6722",
      defaultPath: () => "/home/casey",
    });

    await workspace.connect();

    expect(steps).toHaveLength(1);
    // It falls back to looking for a daemon on the default port rather than rejecting: a
    // window that opens disconnected beats a window that never opens.
    expect(workspace.client.url).toBe("http://127.0.0.1:6722");
  });

  it("stops the daemon it started when the app goes", async () => {
    const { workspace, steps } = rig();
    await workspace.connect();
    steps.length = 0;

    await workspace.close();

    expect(steps).toEqual(["unsubscribe http://127.0.0.1:6001", "stop http://127.0.0.1:6001"]);
  });
});

describe("storeRoot", () => {
  it("takes the workspace above a store a person pointed at directly", () => {
    expect(storeRoot("/work/project/.orca")).toBe("/work/project");
    expect(storeRoot("/work/project/.orca/")).toBe("/work/project");
    expect(storeRoot("C:\\work\\project\\.orca")).toBe("C:\\work\\project");
  });

  it("leaves an ordinary workspace alone", () => {
    expect(storeRoot("/work/project")).toBe("/work/project");
    expect(storeRoot("/work/.orca-backup")).toBe("/work/.orca-backup");
  });
});
