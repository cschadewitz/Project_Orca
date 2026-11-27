/**
 * Claude Code on an SSH host through the Claude Agent SDK (#1130): the SDK and the bridge stay
 * here, only `claude` runs there, started over the host's SSH configuration.
 *
 * `ssh` here is a stand-in that records its arguments, drops everything up to `--` and runs
 * the remote command line (joined, as ssh sends it) with the local shell, with nothing of the daemon's environment beyond
 * `PATH` and `HOME` (as a login shell on another machine would start). `claude` there is the
 * SDK stand-in (fixtures/claude-sdk-stand-in.mjs) behind a script that also answers
 * `--version` and `auth status`, so no account and no model are involved.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostSpecSchema, OrcaError, silentLogger, type PermissionPolicy } from "@orca/core";
import {
  SshHost,
  claudeSdkPermissionBridge,
  claudeSdkRemoteEnvironment,
  claudeSdkRemoteScript,
  claudeSdkSshPreflight,
  claudeSdkRemoteEnvInput,
  claudeSdkRemoteStopScript,
  claudeSdkRemoteToken,
  claudeSdkSshLaunch,
  openClaudeSdkSession,
  type AgentSession,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));

let dir: string;
let ws: string;
let sshLog: string;
let host: SshHost;
const sessions: AgentSession[] = [];

const SIGNED_IN = `echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0`;
const SIGNED_OUT = `echo '{"loggedIn":false}'; exit 0`;

/** The remote `claude`: the probes from `auth`, everything else the SDK stand-in. */
async function remoteClaude(auth: string): Promise<string> {
  const path = join(dir, "remote-bin", "claude");
  await mkdir(join(dir, "remote-bin"), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
${auth}
fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
  );
  await chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-remote-")));
  ws = join(dir, "remote-ws");
  await mkdir(ws);
  sshLog = join(dir, "ssh.log");
  const ssh = join(dir, "ssh");
  await writeFile(
    ssh,
    `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "${sshLog}"; echo >> "${sshLog}"
case "$*" in *orca_relay*) ;; *orca_reap*) [ -e "${dir}/no-stop" ] && exit 255 ;; esac
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec env -i PATH="${join(dir, "remote-bin")}:/usr/bin:/bin" HOME="${dir}" bash -c "$*"
`,
  );
  await chmod(ssh, 0o755);
  host = new SshHost(
    HostSpecSchema.parse({
      id: "build-box",
      type: "ssh",
      host: "build-box.invalid",
      sshBinary: ssh,
      remoteShell: "bash -c",
    }) as never,
  );
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

const agent = { id: "claude-sdk", command: "claude", env: {} as Record<string, string> };

describe("the remote command line (#1130)", () => {
  const token = "0123456789abcdef0123456789abcdef";
  /** Run a remote script with the local shell, as the stand-in ssh would, with `input` on stdin. */
  function runScript(script: string, input: string): { code: number | null; stdout: string } {
    const r = spawnSync("bash", ["-c", script], { input, env: { PATH: process.env.PATH ?? "", HOME: dir } });
    return { code: r.status, stdout: r.stdout.toString("utf8") };
  }

  it("holds names, the directory, the command and its arguments, all quoted, and no value", () => {
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "/opt/claude code/claude",
      args: ["--print", "it's $HOME"],
      cwd: "/work/o'brien",
      names: ["FOO"],
      withheld: ["TOKEN"],
      token,
    });
    expect(script).toContain("unset TOKEN || exit 125");
    expect(script).toContain(`cd '/work/o'\\''brien' || exit 125`);
    expect(script).toContain(`export "$orca_k"\n  exec '/opt/claude code/claude' --print 'it'\\''s $HOME'\n) < <(`);
    expect(script).toContain("case $orca_n in FOO) ;;");
    expect(script).not.toMatch(/\benv [A-Z]/);
  });

  it("reads exactly the environment from stdin, values intact, and hands the rest of stdin on", () => {
    const value = "a b\n$(touch x)\n'\"é ";
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: ["-c", `printf '%s|%s|' "$FOO" "$BAR"; cat`],
      cwd: ws,
      names: ["FOO", "BAR"],
      token,
    });
    const r = runScript(script, `${claudeSdkRemoteEnvInput({ FOO: value, BAR: "" })}rest of stdin`);
    expect(r).toEqual({ code: 0, stdout: `${value}||rest of stdin` });
  });

  it("refuses a name it was not told of, a line without the end, and an unknown command", () => {
    const script = (names: string[], command = "sh") =>
      claudeSdkRemoteScript({ agentId: "a", hostId: "h", command, args: ["-c", "echo ran"], cwd: ws, names, token });
    expect(runScript(script(["FOO"]), claudeSdkRemoteEnvInput({ BAR: "x" }))).toEqual({ code: 125, stdout: "" });
    expect(runScript(script(["FOO"]), "FOO eA==\n")).toEqual({ code: 125, stdout: "" });
    expect(runScript(script([], "orca-no-such-claude"), claudeSdkRemoteEnvInput({}))).toEqual({
      code: 127,
      stdout: "",
    });
  });

  it("refuses a variable name the remote shell would read as something else, and a malformed token", () => {
    for (const name of ["A;rm", "1X", "A B", ""])
      expect(() =>
        claudeSdkRemoteScript({
          agentId: "a",
          hostId: "h",
          command: "claude",
          args: [],
          cwd: "/",
          names: [name],
          token,
        }),
      ).toThrow(/cannot be set on host 'h'/);
    expect(() =>
      claudeSdkRemoteScript({
        agentId: "a",
        hostId: "h",
        command: "claude",
        args: [],
        cwd: "/",
        names: [],
        withheld: ["$(x)"],
        token,
      }),
    ).toThrow(/cannot be set/);
    expect(() => claudeSdkRemoteStopScript("../x")).toThrow(/token/);
  });

  /** Start a launch of `args` under bash, as the stand-in ssh would, its stdin left open. */
  function launch(t: string, args: string[], heartbeat?: { intervalMs: number; timeoutS: number; graceS: number }) {
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args,
      cwd: ws,
      names: [],
      token: t,
      heartbeat,
    });
    const child = spawn("bash", ["-c", script], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.write(claudeSdkRemoteEnvInput({}));
    return child;
  }
  /** `sh -c` that ignores the end of its input and SIGTERM, with a `sleep` it started; both pids in `file`. */
  const stubborn = (file: string) => [
    "-c",
    `trap '' TERM; sleep 600 & echo "$$ $!" > ${file}; while :; do sleep 1; done`,
  ];
  async function pidsIn(file: string): Promise<[number, number]> {
    await until(async () => (await readFile(file, "utf8").catch(() => "")).trim().split(" ").length === 2);
    return (await readFile(file, "utf8")).trim().split(" ").map(Number) as [number, number];
  }

  it("a stop kills every process of the launch, found by its marker, and confirms it", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    const child = launch(t, stubborn(pids));
    const [shell, sleeper] = await pidsIn(pids);
    expect(alive(shell) && alive(sleeper)).toBe(true);
    expect(runScript(claudeSdkRemoteStopScript(t), "").code).toBe(0);
    expect(alive(shell) || alive(sleeper)).toBe(false);
    child.stdin.end();
    // A second stop finds nothing to do.
    expect(runScript(claudeSdkRemoteStopScript(t), "").code).toBe(0);
  });

  it("never signals a process it cannot show is the launch's: another launch's, or one with no marker", async () => {
    const mine = claudeSdkRemoteToken();
    const theirs = claudeSdkRemoteToken();
    const child = launch(theirs, stubborn(join(dir, "theirs")));
    const [shell, sleeper] = await pidsIn(join(dir, "theirs"));
    const stranger = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      expect(runScript(claudeSdkRemoteStopScript(mine), "").code).toBe(0);
      expect(alive(shell) && alive(sleeper) && alive(stranger.pid!)).toBe(true);
    } finally {
      stranger.kill("SIGKILL");
      runScript(claudeSdkRemoteStopScript(theirs), "");
      child.stdin.end();
    }
  });

  it("stops everything by itself when ORCA's heartbeat stops arriving, with no connection back", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    // Input stays open and silent, as a connection to an unreachable daemon would.
    const child = launch(t, stubborn(pids), { intervalMs: 500, timeoutS: 1, graceS: 0 });
    const [shell, sleeper] = await pidsIn(pids);
    await until(() => Promise.resolve(!alive(shell) && !alive(sleeper)), 10_000);
    await until(() => Promise.resolve(child.exitCode !== null), 10_000);
    child.stdin.end();
  });

  it("stops a claude that stopped reading, though ORCA's heartbeat still arrives: the relay stuck writing cannot hold it", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    const child = launch(t, stubborn(pids), { intervalMs: 300, timeoutS: 2, graceS: 1 });
    const [shell, sleeper] = await pidsIn(pids);
    child.stdin.on("error", () => undefined);
    // More than any pipe holds, then the heartbeat as a live ORCA would keep sending it.
    const line = `${"x".repeat(1023)}\n`;
    for (let i = 0; i < 1024; i++) child.stdin.write(line);
    const beat = setInterval(() => child.stdin.write("ORCA-CLAUDE-SDK-PING\n"), 300);
    try {
      await until(() => Promise.resolve(!alive(shell) && !alive(sleeper)), 15_000);
    } finally {
      clearInterval(beat);
      child.stdin.destroy();
    }
  });

  it("keeps claude while the heartbeat arrives, and stops it a grace after its input ends", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    const child = launch(t, stubborn(pids), { intervalMs: 300, timeoutS: 1, graceS: 1 });
    const [shell, sleeper] = await pidsIn(pids);
    const beat = setInterval(() => child.stdin.write("ORCA-CLAUDE-SDK-PING\n"), 300);
    await new Promise((r) => setTimeout(r, 2_500));
    clearInterval(beat);
    expect(alive(shell) && alive(sleeper)).toBe(true);
    child.stdin.end();
    await until(() => Promise.resolve(!alive(shell) && !alive(sleeper)), 10_000);
  });

  it("starts nothing once a stop came first", async () => {
    const t = claudeSdkRemoteToken();
    const marker = join(dir, "ran");
    expect(runScript(claudeSdkRemoteStopScript(t), "").code).toBe(0);
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: ["-c", `sleep 0.3; touch ${marker}`],
      cwd: ws,
      names: [],
      token: t,
    });
    expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(137);
    await new Promise((r) => setTimeout(r, 500));
    await expect(readFile(marker)).rejects.toThrow();
  });

  const stateDir = () => join(dir, ".cache", "orca", "claude-sdk");
  const stateOf = async (t: string) => (await readFile(join(stateDir(), `${t}.state`), "utf8")).trim();
  async function setState(t: string, state: string): Promise<void> {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(join(stateDir(), `${t}.state`), `${state}\n`);
  }
  /** Field 22 of /proc/<pid>/stat: the start time that, with the pid, names one process. */
  const startTime = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  };
  /**
   * A launch held inside admission: a `grep` first on its PATH blocks while the state is
   * `admitted` and the `hold` file exists, so the remote shell stops in the middle of its check
   * for the marker, holding the lock. The admitted process, which never calls grep, goes on.
   */
  async function heldLaunch(t: string, pids: string) {
    const bin = join(dir, "hold-bin");
    await mkdir(bin, { recursive: true });
    const realGrep = spawnSync("sh", ["-c", "command -v grep"]).stdout.toString("utf8").trim();
    const hold = join(dir, "hold");
    const held = join(dir, "held");
    await writeFile(hold, "");
    await writeFile(
      join(bin, "grep"),
      `#!/bin/sh
if [ -e "${hold}" ]; then
  for f in "$HOME"/.cache/orca/claude-sdk/*.state; do
    case "$(cat "$f" 2>/dev/null)" in admitted*) : > "${held}"; while [ -e "${hold}" ]; do sleep 0.05; done ;; esac
  done
fi
exec ${realGrep} "$@"
`,
    );
    await chmod(join(bin, "grep"), 0o755);
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: stubborn(pids),
      cwd: ws,
      names: [],
      token: t,
    });
    const child = spawn("bash", ["-c", script], {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.write(claudeSdkRemoteEnvInput({}));
    const exited = new Promise<number | null>((r) => child.once("exit", (code, signal) => r(signal ? 128 : code)));
    await until(async () => (await readFile(held).catch(() => undefined)) !== undefined);
    expect(await stateOf(t)).toMatch(/^admitted \d+ \d+$/);
    return { child, exited, release: () => rm(hold, { force: true }) };
  }
  const stop = (t: string) =>
    new Promise<number | null>((r) => {
      const c = spawn("bash", ["-c", claudeSdkRemoteStopScript(t)], {
        env: { PATH: process.env.PATH ?? "", HOME: dir },
        stdio: "ignore",
      });
      c.once("exit", (code) => r(code));
    });

  it("a stop during admission waits for the lock, then stops claude: stopped, and nothing left", async () => {
    const t = claudeSdkRemoteToken();
    const { child, exited, release } = await heldLaunch(t, join(dir, "pids"));
    let stopped: number | null | undefined;
    const stopping = stop(t).then((code) => (stopped = code));
    await new Promise((r) => setTimeout(r, 700));
    expect(stopped).toBeUndefined();
    await release();
    expect(await stopping).toBe(0);
    expect(markedBy(t)).toEqual([]);
    expect(await stateOf(t)).toBe("stopped");
    expect(await exited).toBe(137);
    await new Promise((r) => setTimeout(r, 500));
    expect(markedBy(t)).toEqual([]);
    child.stdin.end();
  });

  it("a remote shell that died after admitting claude: the stop watches the admitted process and stops it", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    const { child, exited, release } = await heldLaunch(t, pids);
    // The admitted process goes on to become claude while the shell that admitted it is gone.
    child.kill("SIGKILL");
    await exited;
    await release();
    const [shell, sleeper] = await pidsIn(pids);
    expect(markedBy(t)).toEqual(expect.arrayContaining([shell, sleeper]));
    expect(await stop(t)).toBe(0);
    expect(markedBy(t)).toEqual([]);
    expect(await stateOf(t)).toBe("stopped");
    child.stdin.end();
  });

  it("before admission nothing may start claude: stopped at once, and the launch never starts", async () => {
    const t = claudeSdkRemoteToken();
    await setState(t, "starting");
    expect(await stop(t)).toBe(0);
    expect(await stateOf(t)).toBe("stopped");
    const marker = join(dir, "ran");
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: ["-c", `touch ${marker}`],
      cwd: ws,
      names: [],
      token: t,
    });
    expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(137);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("keeps a stop unconfirmed while the admitted process neither goes nor takes the marker, and never signals it", async () => {
    const t = claudeSdkRemoteToken();
    const other = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      const named = `${other.pid} ${startTime(other.pid!)}`;
      await setState(t, `admitted ${named}`);
      expect(await stop(t)).toBe(4);
      expect(await stateOf(t)).toBe(`stopping ${named}`);
      expect(alive(other.pid!)).toBe(true);
      // A launch asked to stop does not start while that is unconfirmed.
      const script = claudeSdkRemoteScript({
        agentId: "a",
        hostId: "h",
        command: "true",
        args: [],
        cwd: ws,
        names: [],
        token: t,
      });
      expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(137);
      // Once it is gone, the next stop confirms.
      other.kill("SIGKILL");
      await until(() => Promise.resolve(!alive(other.pid!)));
      expect(await stop(t)).toBe(0);
      expect(await stateOf(t)).toBe("stopped");
    } finally {
      other.kill("SIGKILL");
    }
  }, 30_000);

  it("takes a pid with another start time for another process: it is not the admitted one", async () => {
    const t = claudeSdkRemoteToken();
    const other = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      await setState(t, `admitted ${other.pid} 1`);
      expect(await stop(t)).toBe(0);
      expect(await stateOf(t)).toBe("stopped");
      expect(alive(other.pid!)).toBe(true);
    } finally {
      other.kill("SIGKILL");
    }
  });

  it("fails closed on a state record it cannot read: the stop stays unconfirmed and no launch starts", async () => {
    const records = ["admitted 12", "", "running x 1\n", "done extra\n", "admitted 12 34 56\n", "maybe\n"];
    for (const record of records) {
      const t = claudeSdkRemoteToken();
      await mkdir(stateDir(), { recursive: true });
      await writeFile(join(stateDir(), `${t}.state`), record);
      expect(await stop(t), JSON.stringify(record)).toBe(6);
      expect(await readFile(join(stateDir(), `${t}.state`), "utf8")).toBe(record);
      const script = claudeSdkRemoteScript({
        agentId: "a",
        hostId: "h",
        command: "true",
        args: [],
        cwd: ws,
        names: [],
        token: t,
      });
      expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(125);
    }
    // One that cannot be read at all (a directory where the record belongs).
    const t = claudeSdkRemoteToken();
    await mkdir(join(stateDir(), `${t}.state`), { recursive: true });
    expect(await stop(t)).toBe(6);
  });

  it("kills what carries the marker even when the record is unreadable, and still reports it unconfirmed", async () => {
    const t = claudeSdkRemoteToken();
    const pids = join(dir, "pids");
    const child = launch(t, stubborn(pids));
    const [shell, sleeper] = await pidsIn(pids);
    await writeFile(join(stateDir(), `${t}.state`), "garbage");
    expect(await stop(t)).toBe(6);
    expect(alive(shell) || alive(sleeper)).toBe(false);
    expect(markedBy(t)).toEqual([]);
    child.stdin.end();
  });

  it("propagates a state it cannot write: no stopped, no launch, unconfirmed", async () => {
    const t = claudeSdkRemoteToken();
    // A directory where the new record is written first: every write fails.
    await mkdir(join(stateDir(), `${t}.state.new`), { recursive: true });
    expect(await stop(t)).toBe(6);
    await expect(readFile(join(stateDir(), `${t}.state`))).rejects.toThrow();
    const marker = join(dir, "ran");
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: ["-c", `touch ${marker}`],
      cwd: ws,
      names: [],
      token: t,
    });
    expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(125);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("writes done only after the end, under the lock, and a later stop confirms it", async () => {
    const t = claudeSdkRemoteToken();
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "sh",
      args: ["-c", "exit 3"],
      cwd: ws,
      names: [],
      token: t,
    });
    expect(runScript(script, claudeSdkRemoteEnvInput({})).code).toBe(3);
    const state = join(dir, ".cache", "orca", "claude-sdk", `${t}.state`);
    expect((await readFile(state, "utf8")).trim()).toBe("done");
    expect(runScript(claudeSdkRemoteStopScript(t), "").code).toBe(0);
    expect((await readFile(state, "utf8")).trim()).toBe("done");
  });

  it("carries the agent's literal env and ORCA's, without credentials ORCA would carry, and refuses a secret reference", () => {
    expect(
      claudeSdkRemoteEnvironment(
        { id: "a", env: { ANTHROPIC_MODEL: "mine", FOO: "1" } },
        { ORCA_RUN: "r", ANTHROPIC_API_KEY: "daemon", CLAUDE_CODE_USE_BEDROCK: "1", HIDDEN: "x" },
        ["HIDDEN"],
      ),
    ).toEqual({ ORCA_RUN: "r", ANTHROPIC_MODEL: "mine", FOO: "1" });
    const refused = (() => {
      try {
        claudeSdkRemoteEnvironment({ id: "a", env: { TOKEN: { secret: "t" } } });
      } catch (e) {
        return e as OrcaError;
      }
    })();
    expect(refused?.code).toBe("NOT_SUPPORTED");
    expect(refused?.message).toMatch(/secrets are read only on ORCA's own machine/);
  });
});

describe("preflight on an SSH host (#1130)", () => {
  it("asks that machine's claude for its version and sign-in, over the host's ssh", async () => {
    await remoteClaude(SIGNED_IN);
    const preflight = await claudeSdkSshPreflight({ host, agent, cwd: ws, orcaEnv: { ORCA_RUN: "r" } });
    expect(preflight).toMatchObject({ executable: "claude", version: "2.1.332", env: { ORCA_RUN: "r" } });
    const lines = (await readFile(sshLog, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^-T -o BatchMode=yes .*build-box\.invalid -- bash -c /);
  });

  it("refuses a claude that is not signed in there, with guidance that names the host", async () => {
    await remoteClaude(SIGNED_OUT);
    const error = (await claudeSdkSshPreflight({ host, agent, cwd: ws }).catch((e: unknown) => e)) as OrcaError;
    expect(error).toBeInstanceOf(OrcaError);
    expect(error.message).toMatch(/claude auth login/);
    expect(error.message).toMatch(/build-box/);
  });

  it("refuses a host without claude, naming the host", async () => {
    const error = (await claudeSdkSshPreflight({ host, agent, cwd: ws }).catch((e: unknown) => e)) as OrcaError;
    expect(error).toBeInstanceOf(OrcaError);
    expect(error.message).toMatch(/--version on host build-box exited with 127/);
  });
});

describe("a session on an SSH host (#1130)", () => {
  async function open(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
    await remoteClaude(SIGNED_IN);
    const log = join(dir, "stand-in.log");
    const preflight = await claudeSdkSshPreflight({ host, agent, cwd: ws, orcaEnv: { STAND_IN_LOG: log, ...env } });
    const session = await openClaudeSdkSession({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
      hostId: host.id,
      cwd: ws,
      preflight,
      remote: claudeSdkSshLaunch(host, "claude-sdk"),
      startupTimeoutMs: 10_000,
      exitGraceMs: 2_000,
      ...extra,
    });
    sessions.push(session);
    return { session, log };
  }

  it("runs a turn with claude started there, in that directory, with none of the daemon's environment", async () => {
    process.env.ORCA_TEST_DAEMON_ONLY = "leak";
    try {
      const { session, log } = await open();
      const outcome = await session.prompt("hello");
      expect(outcome.stopReason).toBe("end_turn");
      const start = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { argv?: string[]; cwd?: string; env?: Record<string, string> })
        .find((l) => l.argv)!;
      expect(start.cwd).toBe(ws);
      expect(start.argv).toContain("--permission-mode=default");
      expect(start.env?.ORCA_TEST_DAEMON_ONLY).toBeUndefined();
      // The SDK's own variables cross; the session's environment is what ORCA set.
      expect(start.env?.STAND_IN_LOG).toBe(log);
      const ssh = (await readFile(sshLog, "utf8")).trim().split("\n");
      expect(ssh).toHaveLength(3);
    } finally {
      delete process.env.ORCA_TEST_DAEMON_ONLY;
    }
  });

  /** The stand-in's own pid and its descendant's, from its log. */
  async function started(log: string): Promise<{ pid: number; descendant: number }> {
    await until(async () => (await readFile(log, "utf8").catch(() => "")).includes('"descendant"'));
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid?: number; descendant?: number });
    return { pid: lines.find((l) => l.pid)!.pid!, descendant: lines.find((l) => l.descendant)!.descendant! };
  }

  it("close stops claude there and what it started, even one that ignores the end of its input", async () => {
    const { session, log } = await open({ exitGraceMs: 300 }, { STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" });
    await session.prompt("hello");
    const { pid, descendant } = await started(log);
    await session.close();
    // Closed means stopped there: no waiting after close.
    expect(alive(pid)).toBe(false);
    expect(alive(descendant)).toBe(false);
    await session.terminated;
  });

  it("a claude that ends by itself takes what it started with it", async () => {
    const { session, log } = await open({}, { STAND_IN_DESCENDANT: "1" });
    await session.prompt("hello");
    const { pid, descendant } = await started(log);
    await session.close();
    expect(alive(pid)).toBe(false);
    expect(alive(descendant)).toBe(false);
  });

  it("reports a stop it cannot confirm, rather than closure, when the host cannot be reached for it", async () => {
    const { session } = await open();
    await session.prompt("hello");
    sessions.splice(sessions.indexOf(session), 1);
    await writeFile(join(dir, "no-stop"), "");
    const closing = (await session.close().then(
      () => undefined,
      (e: unknown) => e,
    )) as OrcaError | undefined;
    expect(closing).toBeInstanceOf(OrcaError);
    expect(closing?.details).toMatchObject({ reason: "remote-cleanup-unconfirmed", host: "build-box" });
    await expect(session.terminated).rejects.toThrow(/could not confirm that Claude Code stopped on host build-box/);
  });

  it("refuses to attest a claude on another machine, so a required attestation refuses the session", async () => {
    await remoteClaude(SIGNED_IN);
    const before = await readFile(sshLog, "utf8").catch(() => "");
    await expect(
      openClaudeSdkSession({
        agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
        hostId: host.id,
        cwd: ws,
        preflight: { executable: "claude", env: {} },
        remote: claudeSdkSshLaunch(host, "claude-sdk"),
        runtimeAttestation: { required: true },
      }),
    ).rejects.toThrow(/runs on host build-box, where ORCA cannot attest it/);
    // Nothing was started.
    expect(await readFile(sshLog, "utf8").catch(() => "")).toBe(before);
  });

  it("reports an unattested result when attestation is not required", async () => {
    const results: unknown[] = [];
    await open({ runtimeAttestation: { onResult: (r: unknown) => results.push(r) } });
    const end = Date.now() + 5_000;
    while (results.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(results).toEqual([
      { verified: false, reason: "Claude Code runs on host build-box, where ORCA does not attest it" },
    ]);
  });
});

describe("the bridge for a remote workspace (#1130)", () => {
  const allowFetch: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "fetch" }, decision: "allow" }] };
  const input = { url: "https://example.com/a", prompt: "p" };
  const hookFor = (remoteWorkspace: boolean) =>
    claudeSdkPermissionBridge({
      agent: { id: "claude-sdk" },
      sessionId: "sess_x",
      cwd: ws,
      liveTurn: () => ({ id: "turn-1", signal: new AbortController().signal }),
      parentOf: () => undefined,
      loadPolicy: () => Promise.resolve(allowFetch),
      remoteWorkspace,
      logger: silentLogger,
    }).preToolUse(
      { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: input, tool_use_id: "t1", cwd: ws } as never,
      "t1",
      { signal: new AbortController().signal },
    );

  it("takes no call to run inside the workspace, even where the same path exists on ORCA's machine", async () => {
    expect(await hookFor(false)).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await hookFor(true)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "ask",
        permissionDecisionReason: "This tool call runs outside the run's workspace, so no workspace grant covers it.",
      },
    });
  });
});

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every process whose environment carries launch `token`'s marker. */
function markedBy(token: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || !alive(Number(entry))) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`ORCA_CLAUDE_SDK_LAUNCH=${token}`))
        found.push(Number(entry));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

/** Running, not a zombie waiting for a parent that does not reap (a container's init). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}
