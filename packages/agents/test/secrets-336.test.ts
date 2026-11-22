/**
 * Secret references at the execution boundary (#336): read on the session's own host, at each
 * open, refused rather than borrowed from anywhere else, and never put on a command line.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, HostSpecSchema, type Logger, type SecretsConfig } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  redactingLogger,
  resolveSessionSecrets,
  SshHost,
  type AgentHost,
  type AgentSession,
} from "@orca/agents";

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of sessions.splice(0)) await s.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-secrets-"));
  dirs.push(dir);
  return dir;
};

const local = () => new LocalHost({ id: "local", type: "local" });
const agent = (env: object, mcpServers: object[] = []) =>
  AgentSpecSchema.parse({ id: "claude", command: "claude", env, mcpServers });

describe("resolveSessionSecrets", () => {
  const secrets: SecretsConfig = {
    token: { host: "local", provider: "env", name: "ORCA_TEST_TOKEN" },
    remote: { host: "build-box", provider: "env", name: "ORCA_TEST_TOKEN" },
  };

  it("resolves the agent's references into its secret env and its servers' env, and keeps literals", async () => {
    vi.stubEnv("ORCA_TEST_TOKEN", "tok-1234567890");
    const out = await resolveSessionSecrets(
      local(),
      agent({ PLAIN: "1", TOKEN: { secret: "token" } }, [
        { name: "gh", command: "gh-mcp", env: { GH: { secret: "token" }, MODE: "ro" } },
      ]),
      secrets,
    );
    expect(out.agent.env).toEqual({ PLAIN: "1" });
    expect(out.secretEnv).toEqual({ TOKEN: "tok-1234567890" });
    expect(out.agent.mcpServers[0]!.env).toEqual({ MODE: "ro", GH: "tok-1234567890" });
    // Read once per open, even when two variables name it.
    expect(out.values).toEqual(["tok-1234567890"]);
  });

  it("refuses a reference bound to another host, even when this host has the same variable", async () => {
    vi.stubEnv("ORCA_TEST_TOKEN", "local-value-must-not-be-used");
    const read = vi.fn();
    const host = Object.assign(local(), { readSecret: read });
    await expect(resolveSessionSecrets(host, agent({ T: { secret: "remote" } }), secrets)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { secret: "remote", reason: "wrong-host", hostId: "local" },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an undefined secret and a host that cannot read one", async () => {
    await expect(resolveSessionSecrets(local(), agent({ T: { secret: "nope" } }), secrets)).rejects.toMatchObject({
      details: { reason: "undefined" },
    });
    const bare = { id: "local" } as unknown as AgentHost;
    await expect(resolveSessionSecrets(bare, agent({ T: { secret: "token" } }), secrets)).rejects.toMatchObject({
      details: { reason: "unsupported" },
    });
  });

  it("reads nothing when there are no references", async () => {
    const read = vi.fn();
    const host = Object.assign(local(), { readSecret: read });
    const out = await resolveSessionSecrets(host, agent({ A: "1" }), undefined);
    expect(out).toMatchObject({ secretEnv: {}, values: [] });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("LocalHost.readSecret", () => {
  it("reads the daemon's environment, and refuses a variable that is unset or empty", async () => {
    vi.stubEnv("ORCA_TEST_TOKEN", "abc");
    expect(await local().readSecret("t", { provider: "env", name: "ORCA_TEST_TOKEN" })).toBe("abc");
    vi.stubEnv("ORCA_TEST_TOKEN", "");
    await expect(local().readSecret("t", { provider: "env", name: "ORCA_TEST_TOKEN" })).rejects.toMatchObject({
      message: "secret 't' is unavailable: environment variable ORCA_TEST_TOKEN is not set on host 'local'",
      details: { secret: "t", reason: "missing" },
    });
  });

  it("reads a file whole, drops one trailing newline, and refuses a missing file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "token"), "line one\nline two\n\n");
    expect(await local().readSecret("t", { provider: "file", path: join(dir, "token") })).toBe("line one\nline two\n");
    await expect(local().readSecret("t", { provider: "file", path: join(dir, "absent") })).rejects.toMatchObject({
      details: { reason: "missing" },
    });
  });
});

/**
 * An `ssh` stand-in: records its arguments, then runs the remote command the way sshd does,
 * by joining everything after `--` into one string for a shell.
 */
async function fakeSsh(dir: string): Promise<string> {
  const bin = join(dir, "ssh");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${join(dir, "argv")}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec /bin/sh -c "$*"
`,
  );
  await chmod(bin, 0o755);
  return bin;
}
const sshHost = (sshBinary: string) =>
  new SshHost(
    HostSpecSchema.parse({
      id: "build-box",
      type: "ssh",
      host: "build.example",
      sshBinary,
      remoteShell: "sh -c",
    }) as never,
    { sftp: false },
  );

describe("SshHost secrets", () => {
  it("delivers values on stdin, never in either command line, and the agent still gets the rest of stdin", async () => {
    const dir = await tempDir();
    const host = sshHost(await fakeSsh(dir));
    const value = "s3cr3t 'quoted' $(not-run) \\ end";
    const out = join(dir, "seen");
    const script = `require("node:readline").createInterface({ input: process.stdin }).once("line", (input) => { require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ token: process.env.TOKEN, other: process.env.OTHER, plain: process.env.PLAIN, input })); process.exit(0); });`;
    const proc = await host.spawnAgent(
      AgentSpecSchema.parse({ id: "a", command: process.execPath, args: ["-e", script], env: { PLAIN: "p" } }),
      { cwd: dir, secretEnv: { TOKEN: value, OTHER: "second-value" } },
    );
    const writer = proc.stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "ping" } as never);
    await proc.exited;
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
      token: value,
      other: "second-value",
      plain: "p",
      input: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });
    const argv = await readFile(join(dir, "argv"), "utf8");
    expect(argv).not.toContain("s3cr3t");
    expect(argv).not.toContain(Buffer.from(value).toString("base64"));
    expect(argv).not.toContain("second-value");
  });

  it("refuses a variable name that is not one before connecting", async () => {
    const host = sshHost("orca-no-such-ssh-binary");
    expect(() =>
      host.spawnAgent(AgentSpecSchema.parse({ id: "a", command: "x" }), { cwd: "/", secretEnv: { "A;rm": "v" } }),
    ).toThrow(/cannot carry a secret/);
  });

  it("reads a remote variable or file after the marker, ignoring profile output", async () => {
    const host = sshHost("unused");
    const exec = vi
      .spyOn(host, "exec")
      .mockResolvedValue({ code: 0, stdout: "welcome banner\n__orca_secret_value__\nremote-value\n", stderr: "" });
    expect(await host.readSecret("t", { provider: "env", name: "TOKEN" })).toBe("remote-value");
    expect(exec.mock.calls[0]![0]).toContain("printenv TOKEN");
    await host.readSecret("t", { provider: "file", path: "/etc/orca/it's" });
    expect(exec.mock.calls[1]![0]).toContain("cat -- '/etc/orca/it'\\''s'");
  });

  it("refuses an unset remote value or a failed read, with no local fallback", async () => {
    vi.stubEnv("TOKEN", "local-value-must-not-be-used");
    const host = sshHost("unused");
    const exec = vi.spyOn(host, "exec").mockResolvedValue({ code: 1, stdout: "__orca_secret_value__\n", stderr: "" });
    await expect(host.readSecret("t", { provider: "env", name: "TOKEN" })).rejects.toMatchObject({
      message: "secret 't' is unavailable: environment variable TOKEN is not set on host 'build-box'",
      details: { reason: "missing", hostId: "build-box" },
    });
    exec.mockResolvedValue({ code: 255, stdout: "", stderr: "connection refused" });
    await expect(host.readSecret("t", { provider: "file", path: "/x" })).rejects.toMatchObject({
      details: { reason: "missing" },
    });
  });
});

/** An ACP agent that reports what it was started with: its env, and the MCP env it was given. */
const reportingAgent = (out: string) => `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: m.params.protocolVersion, agentCapabilities: {}, agentInfo: { name: "r", version: "0" } });
  else if (m.method === "session/new") {
    require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ token: process.env.TOKEN, mcp: m.params.mcpServers, argv: process.argv }));
    reply(m.id, { sessionId: "s1" });
  }
});
setInterval(() => {}, 1000);
`;

describe("openAcpSession with secret references", () => {
  it("reads at every open, so a rotated value is used next time, and hands the values over for redaction", async () => {
    const dir = await tempDir();
    const file = join(dir, "token");
    const out = join(dir, "seen");
    const secrets: SecretsConfig = { token: { host: "local", provider: "file", path: file } };
    const spec = AgentSpecSchema.parse({
      id: "r",
      command: process.execPath,
      args: ["-e", reportingAgent(out)],
      env: { TOKEN: { secret: "token" } },
      mcpServers: [{ name: "gh", command: "gh-mcp", env: { GH_TOKEN: { secret: "token" } } }],
    });
    const lines: string[] = [];
    const logger: Logger = {
      log: (_l, m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      debug: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      info: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      error: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
      child: () => logger,
    };
    for (const value of ["first-value-111", "rotated-value-222"]) {
      await writeFile(file, `${value}\n`);
      const handed: string[][] = [];
      const session = await openAcpSession({
        host: local(),
        agent: spec,
        cwd: dir,
        secrets,
        logger,
        onSecretValues: (v) => handed.push([...v]),
      });
      sessions.push(session);
      const seen = JSON.parse(await readFile(out, "utf8")) as {
        token: string;
        mcp: { env: { name: string; value: string }[] }[];
        argv: string[];
      };
      expect(seen.token).toBe(value);
      expect(seen.mcp[0]!.env).toEqual([{ name: "GH_TOKEN", value }]);
      expect(seen.argv.join(" ")).not.toContain(value);
      expect(handed).toEqual([[value]]);
    }
    expect(lines.join("\n")).not.toMatch(/first-value-111|rotated-value-222/);
  });

  it("refuses before anything is spawned when a value cannot be read", async () => {
    const host = local();
    const spawn = vi.spyOn(host, "spawnAgent");
    await expect(
      openAcpSession({
        host,
        agent: AgentSpecSchema.parse({ id: "r", command: "never", env: { TOKEN: { secret: "token" } } }),
        cwd: process.cwd(),
        secrets: { token: { host: "local", provider: "file", path: "/nonexistent/orca/token" } },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", details: { secret: "token", reason: "missing" } });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("redactingLogger", () => {
  it("redacts messages, fields and child bindings, and is the logger itself with no values", () => {
    const seen: unknown[] = [];
    const inner: Logger = {
      log: (...a) => seen.push(a),
      debug: (...a) => seen.push(a),
      info: (...a) => seen.push(a),
      warn: (...a) => seen.push(a),
      error: (...a) => seen.push(a),
      child: (f) => (seen.push(["child", f]), inner),
    };
    expect(redactingLogger(inner, [])).toBe(inner);
    const log = redactingLogger(inner, ["pw-123"]);
    log.info("got pw-123", { v: "pw-123" });
    log.log("warn", "pw-123");
    log.debug("pw-123");
    log.warn("pw-123");
    log.error("pw-123");
    log.child({ k: "pw-123" }).info("x");
    expect(JSON.stringify(seen)).not.toContain("pw-123");
  });
});
