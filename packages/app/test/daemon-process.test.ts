import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_DAEMON_FILE,
  DaemonStartError,
  findBundledDaemon,
  startBundledDaemon,
  type BundledDaemonOptions,
  type DaemonExit,
  type SpawnDaemon,
} from "../src/main/daemon-process.js";

/**
 * A child process that never was: the signals it was sent, the output it produced, and an
 * `exit` a test fires when it wants one. Everything `daemon-process.ts` touches and nothing
 * else, so a test never needs a real daemon, a real port or a real wait.
 */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }

  say(stream: "stdout" | "stderr", text: string): void {
    this[stream].emit("data", Buffer.from(text));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The seams, wired to a fake clock so the poll loop costs nothing and cannot flake. */
function harness(
  options: {
    ports?: number[];
    /** One entry per poll, in order; the last one repeats. `true` means "hello answered". */
    probes?: (boolean | ((child: FakeChild) => boolean))[];
  } = {},
) {
  const children: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const ports = [...(options.ports ?? [7001])];
  const probes = [...(options.probes ?? [true])];
  let clock = 0;

  const spawn: SpawnDaemon = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<SpawnDaemon>;
  };

  const seams: Partial<BundledDaemonOptions> = {
    spawn,
    findPort: async () => ports.shift() ?? 7999,
    probe: async () => {
      const next = probes.length > 1 ? probes.shift()! : probes[0];
      return typeof next === "function" ? next(children[children.length - 1]!) : !!next;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  return { children, calls, seams, clock: () => clock };
}

const start = (seams: Partial<BundledDaemonOptions>, extra: Partial<BundledDaemonOptions> = {}) =>
  startBundledDaemon({ entry: "/res/daemon/orca-daemon.mjs", cwd: "/home/casey", ...seams, ...extra });

it("closed validation captures one uncertain child without retry or timeout escalation", async () => {
  const h = harness({ probes: [false] }),
    captured = vi.fn();
  await expect(
    start(h.seams, {
      closedUpdate: { attempt: "attempt", token: "one-use" },
      args: ["--read-only", "--no-resume"],
      attempts: 5,
      startTimeoutMs: 2,
      onChild: captured,
      env: {
        ORCA_MANAGED_UPDATE_CONTROL: "ordinary-control",
        ORCA_MANAGED_UPDATE_ADDON: "ordinary-addon",
        ORCA_FIRST_RUN_LAUNCH: "old",
      },
    }),
  ).rejects.toBeInstanceOf(DaemonStartError);
  expect(h.calls).toHaveLength(1);
  expect(captured).toHaveBeenCalledWith(h.children[0]);
  expect(h.children[0]!.signals).toEqual([]);
  expect(h.calls[0]!.env).toMatchObject({
    ORCA_UPDATE_ATTEMPT: "attempt",
    ORCA_UPDATE_LAUNCH: "one-use",
    ORCA_MANAGED_UPDATE_CONTROL: undefined,
    ORCA_MANAGED_UPDATE_ADDON: undefined,
    ORCA_FIRST_RUN_LAUNCH: undefined,
  });
});

it("a closed validation stop sends one ordinary signal and never escalates", async () => {
  const h = harness();
  const daemon = await start(h.seams, {
    closedUpdate: { attempt: "attempt", token: "one-use" },
    args: ["--read-only", "--no-resume"],
  });
  expect(daemon.child).toBe(h.children[0]);
  await daemon.stop();
  expect(h.children[0]!.signals).toEqual(["SIGTERM"]);
});

it("closed validation refuses unsafe flags before spawn; ordinary children strip inherited update permits", async () => {
  const h = harness();
  await expect(
    start(h.seams, { closedUpdate: { attempt: "attempt", token: "one-use" }, args: ["--read-only"] }),
  ).rejects.toThrow("without resume");
  expect(h.calls).toHaveLength(0);
  await start(h.seams, { env: { ORCA_UPDATE_ATTEMPT: "old", ORCA_UPDATE_LAUNCH: "old" } });
  expect(h.calls[0]!.env).toMatchObject({ ORCA_UPDATE_ATTEMPT: undefined, ORCA_UPDATE_LAUNCH: undefined });
});

describe("findBundledDaemon", () => {
  const expected = join("/resources", "daemon", BUNDLED_DAEMON_FILE);
  const exists = (path: string) => path === expected;

  it("takes the first root that has one, and ignores roots that do not exist", () => {
    expect(findBundledDaemon(["/nope", "/resources", "/other"], exists)).toBe(expected);
  });

  it("skips an undefined root, because process.resourcesPath is undefined outside a package", () => {
    expect(findBundledDaemon([undefined, "/resources"], exists)).toBe(expected);
  });

  it("answers undefined when nothing is bundled, so the app falls back to a daemon already running", () => {
    expect(findBundledDaemon(["/nope", undefined], exists)).toBeUndefined();
  });
});

describe("starting the bundled daemon", () => {
  it.each(["spawn", "exit", "deadline"] as const)(
    "emits only the actual %s startup category, without private source data",
    async (boundary) => {
      const privateText = "/private/token-file secret=synthetic-do-not-export";
      const h = harness({
        probes: [
          boundary === "exit"
            ? (child) => {
                child.say("stderr", privateText);
                child.exit(1);
                return false;
              }
            : false,
        ],
      });
      if (boundary === "spawn")
        h.seams.spawn = () => {
          throw new Error(privateText);
        };
      const observer = vi.fn();
      await expect(
        start(h.seams, { attempts: 1, startTimeoutMs: 1, pollIntervalMs: 1, onStartupDiagnostic: observer }),
      ).rejects.toThrow();
      const expected =
        boundary === "spawn"
          ? "startup_spawn_failed"
          : boundary === "exit"
            ? "startup_exited_before_handshake"
            : "startup_handshake_timeout";
      expect(observer.mock.calls).toEqual([[expected]]);
    },
  );

  it("emits spawn failure once for asynchronous error followed by exit", async () => {
    const h = harness({
      probes: [
        (child) => {
          child.emit("error", new Error("synthetic private output"));
          child.exit(1);
          return false;
        },
      ],
    });
    const observer = vi.fn();
    await expect(start(h.seams, { attempts: 1, onStartupDiagnostic: observer })).rejects.toThrow();
    expect(observer.mock.calls).toEqual([["startup_spawn_failed"]]);
  });

  it("preserves successful startup and post-handshake exit without emitting startup failure", async () => {
    const h = harness();
    const observer = vi.fn();
    await start(h.seams, { onStartupDiagnostic: observer });
    h.children[0]!.exit(1);
    expect(observer).not.toHaveBeenCalled();
  });

  it("preserves rejection and retries when the optional observer throws", async () => {
    const h = harness({
      probes: [
        (child) => {
          child.exit(1);
          return false;
        },
        true,
      ],
    });
    const observer = vi.fn(() => {
      throw new Error("observer failed");
    });
    const daemon = await start(h.seams, { attempts: 2, onStartupDiagnostic: observer });
    expect(daemon.url).toBe("http://127.0.0.1:7999");
    expect(h.calls).toHaveLength(2);
    expect(observer).toHaveBeenCalledOnce();
  });

  it("serves on the port it was given and reports that URL", async () => {
    const h = harness({ ports: [7123] });
    const daemon = await start(h.seams);

    expect(daemon.url).toBe("http://127.0.0.1:7123");
    expect(daemon.pid).toBe(4242);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual([
      "/res/daemon/orca-daemon.mjs",
      "--cwd",
      "/home/casey",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "7123",
    ]);
  });

  it("runs the bundle under Electron-as-Node, from the workspace it serves", async () => {
    const h = harness();
    await start(h.seams, {
      execPath: "/Applications/ORCA.app/Contents/MacOS/ORCA",
      cwd: "/work",
      env: { PATH: "/bin" },
    });

    expect(h.calls[0]!.command).toBe("/Applications/ORCA.app/Contents/MacOS/ORCA");
    expect(h.calls[0]!.cwd).toBe("/work");
    expect(h.calls[0]!.env).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("appends extra arguments after `serve`, which is how a later flag such as --read-only gets there", async () => {
    const h = harness();
    await start(h.seams, { args: ["--read-only"], configPath: "/work/orca.config.yaml" });

    const { args } = h.calls[0]!;
    expect(args.slice(0, 5)).toEqual([
      "/res/daemon/orca-daemon.mjs",
      "--cwd",
      "/home/casey",
      "--config",
      "/work/orca.config.yaml",
    ]);
    expect(args[args.length - 1]).toBe("--read-only");
    expect(args.indexOf("--read-only")).toBeGreaterThan(args.indexOf("serve"));
  });

  it("retries on a fresh port when a start fails, because a free port can be taken before the daemon binds it", async () => {
    const h = harness({
      ports: [7001, 7002],
      // First attempt: the daemon dies on the first poll. Second: it answers.
      probes: [
        (child) => {
          child.say("stderr", "listen EADDRINUSE: address already in use 127.0.0.1:7001\n");
          child.exit(1);
          return false;
        },
        true,
      ],
    });

    const daemon = await start(h.seams, { attempts: 2 });

    expect(daemon.url).toBe("http://127.0.0.1:7002");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.args).toContain("7001");
    expect(h.calls[1]!.args).toContain("7002");
  });

  it("fails with what the daemon said when it exits before answering", async () => {
    const h = harness({
      probes: [
        (child) => {
          child.say("stderr", "error [CONFIG_INVALID]: orca.config.yaml: workspace.repo is required\n");
          child.exit(1);
          return false;
        },
      ],
    });

    const failure = await start(h.seams, { attempts: 1 }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain("exited with code 1");
    expect((failure as DaemonStartError).output).toContain("workspace.repo is required");
  });

  it("gives up, and kills it, when it starts but never answers", async () => {
    const h = harness({ probes: [false] });

    const failure = await start(h.seams, { attempts: 1, startTimeoutMs: 1_000, pollIntervalMs: 250 }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toContain("did not answer hello");
    // Not left running: a daemon nobody can talk to still holds the port.
    expect(h.children[0]!.signals).toEqual(["SIGKILL"]);
  });

  it("reports a daemon that dies on its own, and does not report one it was asked to stop", async () => {
    const h = harness();
    const exits: DaemonExit[] = [];
    const daemon = await start(h.seams, { onExit: (e) => exits.push(e) });
    const child = h.children[0]!;

    child.say("stdout", "orca daemon listening\n");
    child.exit(null, "SIGSEGV");
    expect(exits).toHaveLength(1);
    expect(exits[0]!.signal).toBe("SIGSEGV");
    expect(exits[0]!.output).toContain("orca daemon listening");

    exits.length = 0;
    const second = await start(harness().seams, { onExit: (e) => exits.push(e) });
    await second.stop();
    expect(exits).toHaveLength(0);
    expect(daemon.url).toBe("http://127.0.0.1:7001");
  });

  it("forwards every line the daemon writes, once, without the newline", async () => {
    const h = harness();
    const lines: string[] = [];
    await start(h.seams, { onLog: (l) => lines.push(l) });

    h.children[0]!.say("stdout", "first\nsec");
    h.children[0]!.say("stderr", "ond\nthird\n");

    expect(lines).toEqual(["first", "second", "third"]);
  });
});

describe("stopping the bundled daemon", () => {
  it("asks with SIGTERM and returns once it is gone", async () => {
    const h = harness();
    const daemon = await start(h.seams);
    const child = h.children[0]!;

    const stopped = daemon.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.exit(0);
    await stopped;
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored, rather than holding the quit open", async () => {
    const h = harness();
    const daemon = await start(h.seams, { stopTimeoutMs: 2_000 });
    const child = h.children[0]!;

    // The fake clock means the two grace periods pass instantly; the child never exits.
    await daemon.stop();

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does nothing the second time, and nothing at all for a daemon that is already gone", async () => {
    const h = harness();
    const daemon = await start(h.seams);
    const child = h.children[0]!;

    child.exit(0);
    await daemon.stop();
    await daemon.stop();

    expect(child.signals).toEqual([]);
  });
});
