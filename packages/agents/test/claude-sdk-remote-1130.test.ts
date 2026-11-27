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
import { realpathSync } from "node:fs";
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
  claudeSdkSshSpawner,
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
printf '%s\\n' "$*" >> "${sshLog}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec env -i PATH="${join(dir, "remote-bin")}:/usr/bin:/bin" HOME="${dir}" sh -c "$*"
`,
  );
  await chmod(ssh, 0o755);
  host = new SshHost(
    HostSpecSchema.parse({
      id: "build-box",
      type: "ssh",
      host: "build-box.invalid",
      sshBinary: ssh,
      remoteShell: "sh -c",
    }) as never,
  );
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

const agent = { id: "claude-sdk", command: "claude", env: {} as Record<string, string> };

describe("the remote command line (#1130)", () => {
  it("changes to the directory, unsets the withheld names and sets only what it was given, all quoted", () => {
    const script = claudeSdkRemoteScript({
      agentId: "a",
      hostId: "h",
      command: "/opt/claude code/claude",
      args: ["--print", "it's $HOME"],
      cwd: "/work/o'brien",
      env: { FOO: "a b $(x)" },
      withheld: ["TOKEN"],
    });
    expect(script).toBe(
      `unset TOKEN && cd '/work/o'\\''brien' && exec env FOO='a b $(x)' '/opt/claude code/claude' --print 'it'\\''s $HOME'`,
    );
  });

  it("refuses a variable name the remote shell would read as something else", () => {
    for (const name of ["A;rm", "1X", "A B", ""])
      expect(() =>
        claudeSdkRemoteScript({
          agentId: "a",
          hostId: "h",
          command: "claude",
          args: [],
          cwd: "/",
          env: { [name]: "v" },
        }),
      ).toThrow(/cannot be set on host 'h'/);
    expect(() =>
      claudeSdkRemoteScript({
        agentId: "a",
        hostId: "h",
        command: "claude",
        args: [],
        cwd: "/",
        env: {},
        withheld: ["$(x)"],
      }),
    ).toThrow(/cannot be set/);
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
    for (const line of lines) expect(line).toMatch(/^-T -o BatchMode=yes .*build-box\.invalid -- sh -c /);
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
  async function open(extra: Record<string, unknown> = {}) {
    await remoteClaude(SIGNED_IN);
    const log = join(dir, "stand-in.log");
    const preflight = await claudeSdkSshPreflight({ host, agent, cwd: ws, orcaEnv: { STAND_IN_LOG: log } });
    const session = await openClaudeSdkSession({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
      hostId: host.id,
      cwd: ws,
      preflight,
      remote: { hostId: host.id, spawn: claudeSdkSshSpawner(host, "claude-sdk") },
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

  it("close ends ssh and the claude it started", async () => {
    const { session, log } = await open();
    await session.prompt("hello");
    const pid = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { pid?: number })
      .find((l) => l.pid)!.pid!;
    await session.close();
    await session.terminated;
    const end = Date.now() + 5_000;
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(alive(pid)).toBe(false);
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
        remote: { hostId: host.id, spawn: claudeSdkSshSpawner(host, "claude-sdk") },
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
