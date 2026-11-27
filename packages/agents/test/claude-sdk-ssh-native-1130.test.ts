/**
 * Claude Code on an SSH host through the Claude Agent SDK (#1130), over a real SSH connection:
 * a throwaway loopback sshd, the real `ssh` client and the default `bash -lc` remote shell.
 * `claude` there is the SDK stand-in behind a script that also answers `--version` and
 * `auth status`. Both ends are on this machine, so a scan of every process's argument list
 * covers the client and the server side, and a process the remote side started can be checked
 * gone. Skipped without `/usr/sbin/sshd`, unless ORCA_REQUIRE_SSHD=1 (the Claude Agent SDK
 * acceptance workflow sets it).
 */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HostSpecSchema, OrcaError } from "@orca/core";
import { loopbackSshd, type LoopbackSshd } from "@orca/testing/two-daemons";
import {
  CLAUDE_SDK_REMOTE_HEARTBEAT,
  SshHost,
  claudeSdkSshLaunch,
  claudeSdkSshPreflight,
  openClaudeSdkSession,
  type AgentSession,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const SECRET = "native-claude-sdk-value-7a3f";

let sshd: LoopbackSshd | undefined;
let dir: string;
let claude: string;
let host: SshHost;
const sessions: AgentSession[] = [];

beforeAll(async () => {
  sshd = await loopbackSshd({ commands: true });
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-ssh-")));
  claude = join(dir, "claude");
  await writeFile(
    claude,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi
exec "${process.execPath}" "${STAND_IN}" "$@"
`,
  );
  await chmod(claude, 0o755);
  if (sshd)
    host = new SshHost(
      HostSpecSchema.parse({
        id: "loopback",
        type: "ssh",
        host: "127.0.0.1",
        user: sshd.user,
        sshArgs: sshd.sshArgs.slice(0, -1),
      }) as never,
      { sftp: false },
    );
}, 60_000);
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await sshd?.close();
  await rm(dir, { recursive: true, force: true });
});

const agent = (env: Record<string, string> = {}) => ({ id: "claude-sdk", command: claude, env });

const FAST = { intervalMs: 500, timeoutS: 2, graceS: 1 };

async function open(
  log: string,
  env: Record<string, string>,
  extra: Record<string, unknown> = {},
  on: SshHost = host,
  heartbeat = CLAUDE_SDK_REMOTE_HEARTBEAT,
) {
  const preflight = await claudeSdkSshPreflight({
    host: on,
    agent: agent(env),
    cwd: dir,
    orcaEnv: { STAND_IN_LOG: log },
  });
  const session = await openClaudeSdkSession({
    agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
    hostId: on.id,
    cwd: dir,
    preflight,
    remote: claudeSdkSshLaunch(on, "claude-sdk", undefined, heartbeat),
    startupTimeoutMs: 15_000,
    exitGraceMs: 500,
    ...extra,
  });
  sessions.push(session);
  return session;
}

/** Every process's argv on this machine, read from /proc. */
async function allArgv(): Promise<{ pid: number; ppid: number; argv: string }[]> {
  const out: { pid: number; ppid: number; argv: string }[] = [];
  for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p))) {
    const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").then(
      (c) => c.split("\0").join(" "),
      () => "",
    );
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    out.push({ pid: Number(pid), ppid, argv });
  }
  return out;
}

/** The stand-in's own pid and its descendant's, from its log. */
async function started(log: string): Promise<{ pid: number; descendant: number; env: Record<string, string> }> {
  await until(async () => (await readFile(log, "utf8").catch(() => "")).includes('"descendant"'));
  const lines = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { pid?: number; descendant?: number; env?: Record<string, string> });
  const start = lines.find((l) => l.pid)!;
  return { pid: start.pid!, descendant: lines.find((l) => l.descendant)!.descendant!, env: start.env! };
}

describe("Claude Code over a real sshd (#1130)", () => {
  it("hands claude its environment without a value in any argument list on either side", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const log = join(dir, "env.log");
    const needles = [SECRET, Buffer.from(SECRET).toString("base64")];
    const leaks: string[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        for (const p of await allArgv()) if (needles.some((n) => p.argv.includes(n))) leaks.push(p.argv);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    try {
      const session = await open(log, { ANTHROPIC_API_KEY: SECRET, STAND_IN_DESCENDANT: "1" });
      expect((await session.prompt("hello")).stopReason).toBe("end_turn");
      const { env } = await started(log);
      expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
      await session.close();
    } finally {
      sampling = false;
      await sampler;
    }
    expect(leaks).toEqual([]);
  }, 60_000);

  it("close stops claude there and what it started, even one that ignores the end of its input", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const log = join(dir, "close.log");
    const session = await open(log, { STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" });
    await session.prompt("hello");
    const { pid, descendant } = await started(log);
    await session.close();
    expect(alive(pid)).toBe(false);
    expect(alive(descendant)).toBe(false);
  }, 60_000);

  it("a lost connection does not leave claude running there: the stop reaches it over a new one", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const log = join(dir, "lost.log");
    const session = await open(log, { STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" });
    await session.prompt("hello");
    const { pid, descendant } = await started(log);
    // ORCA's own ssh, the session's connection, killed as a dropped link would end it.
    const ssh = (await allArgv()).filter((p) => p.ppid === process.pid && p.argv.includes("orca_env"));
    expect(ssh).toHaveLength(1);
    process.kill(ssh[0]!.pid, "SIGKILL");
    await session.terminated;
    expect(alive(pid)).toBe(false);
    expect(alive(descendant)).toBe(false);
  }, 60_000);

  it("an unreachable controller: the host stops claude by itself, with no connection back", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const log = join(dir, "silent.log");
    const session = await open(log, { STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" }, {}, host, FAST);
    await session.prompt("hello");
    const { pid, descendant } = await started(log);
    // ORCA's ssh frozen: the connection stays up and nothing arrives, no EOF and no stop.
    const ssh = (await allArgv()).filter((p) => p.ppid === process.pid && p.argv.includes("orca_relay"));
    expect(ssh).toHaveLength(1);
    process.kill(ssh[0]!.pid, "SIGSTOP");
    try {
      await until(() => Promise.resolve(!alive(pid) && !alive(descendant)), 15_000);
    } finally {
      process.kill(ssh[0]!.pid, "SIGKILL");
    }
    await session.terminated;
  }, 60_000);

  it("a cleanup connection that cannot be made: close reports it unconfirmed, and the host still stops claude", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const own = (await loopbackSshd({ commands: true }))!;
    const box = new SshHost(
      HostSpecSchema.parse({
        id: "doomed",
        type: "ssh",
        host: "127.0.0.1",
        user: own.user,
        sshArgs: own.sshArgs.slice(0, -1),
        connectTimeoutMs: 2_000,
      }) as never,
      { sftp: false },
    );
    try {
      const log = join(dir, "unreachable.log");
      const session = await open(log, { STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" }, {}, box, FAST);
      sessions.splice(sessions.indexOf(session), 1);
      await session.prompt("hello");
      const { pid, descendant } = await started(log);
      // No new connection can be made any more; the session's own stays up.
      const listener = (await allArgv()).filter((p) => p.ppid === process.pid && /sshd -D -f/.test(p.argv));
      // This test's sshd: the listener whose files sit beside its client configuration.
      const root = dirname(own.sshArgs[1]!);
      const mine = listener.filter((l) => l.argv.includes(root));
      expect(mine).toHaveLength(1);
      process.kill(mine[0]!.pid, "SIGKILL");
      const error = (await session.close().then(
        () => undefined,
        (e: unknown) => e,
      )) as OrcaError | undefined;
      expect(error).toBeInstanceOf(OrcaError);
      expect(error?.details).toMatchObject({ reason: "remote-cleanup-unconfirmed", host: "doomed" });
      await expect(session.terminated).rejects.toThrow(/could not confirm/);
      // The host's own stop: the session's connection ended, so after the grace nothing runs.
      await until(() => Promise.resolve(!alive(pid) && !alive(descendant)), 15_000);
    } finally {
      await own.close().catch(() => undefined);
    }
  }, 90_000);

  it("a cancelled open leaves nothing running there", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const log = join(dir, "cancel.log");
    const ac = new AbortController();
    const opening = open(
      log,
      { STAND_IN_STARTUP: "silent", STAND_IN_STUBBORN: "1", STAND_IN_DESCENDANT: "1" },
      { signal: ac.signal },
    );
    const { pid, descendant } = await started(log);
    ac.abort();
    const error = (await opening.catch((e: unknown) => e)) as OrcaError & { terminated?: Promise<void> };
    expect(error).toBeInstanceOf(OrcaError);
    await until(() => Promise.resolve(!alive(pid) && !alive(descendant)), 15_000);
  }, 60_000);
});

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 25));
  }
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
