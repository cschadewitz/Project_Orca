/**
 * Secret references at the execution boundary (#336): checked against the catalog, read by
 * the host as part of starting the agent, refused rather than borrowed from anywhere else,
 * never on a command line, never inherited without a reference, and redacted from errors.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, HostSpecSchema, OrcaError, type Logger, type SecretsConfig } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  planSessionSecrets,
  redactError,
  redactingLogger,
  SshHost,
  type AgentHost,
  type AgentProcessHandle,
  type AgentSession,
} from "@orca/agents";

const dirs: string[] = [];
const sessions: AgentSession[] = [];
const procs: AgentProcessHandle[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of sessions.splice(0)) await s.close();
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-secrets-"));
  dirs.push(dir);
  return dir;
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const waitFor = async (path: string) => {
  for (let i = 0; i < 300; i++) {
    if (await exists(path)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${path} never appeared`);
};

const local = () => new LocalHost({ id: "local", type: "local" });
const agent = (env: object, mcpServers: object[] = []) =>
  AgentSpecSchema.parse({ id: "claude", command: "claude", env, mcpServers });

/** A node agent that writes the named variables to `out`, then echoes the first line it is sent. */
const envReporter = (out: string, names: string[]) =>
  `const pick = Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]));` +
  `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(pick));` +
  `require("node:readline").createInterface({ input: process.stdin }).once("line", (l) => { process.stdout.write(l + "\\n"); });`;

async function firstMessage(proc: AgentProcessHandle): Promise<unknown> {
  const reader = proc.stream.readable.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value;
}

describe("planSessionSecrets", () => {
  const secrets: SecretsConfig = {
    token: { host: "local", provider: "env", name: "ORCA_TEST_TOKEN" },
    other: { host: "local", provider: "env", name: "ORCA_OTHER_TOKEN" },
    file: { host: "local", provider: "file", path: "/etc/orca/file" },
    remote: { host: "build-box", provider: "env", name: "ORCA_REMOTE_TOKEN" },
  };

  it("splits literals from references, plans one read per secret, and withholds every env source on this host", () => {
    const plan = planSessionSecrets(
      local(),
      agent({ PLAIN: "1", TOKEN: { secret: "token" }, AGAIN: { secret: "token" } }, [
        { name: "gh", command: "gh-mcp", env: { GH: { secret: "file" }, MODE: "ro" } },
      ]),
      secrets,
    );
    expect(plan.agent.env).toEqual({ PLAIN: "1" });
    expect(plan.agent.mcpServers[0]!.env).toEqual({ MODE: "ro" });
    expect(plan.deliveries).toEqual([
      { id: "token", source: { provider: "env", name: "ORCA_TEST_TOKEN" }, env: ["TOKEN", "AGAIN"] },
      { id: "file", source: { provider: "file", path: "/etc/orca/file" }, env: [] },
    ]);
    expect(plan.mcpSecrets).toEqual([{ server: 0, name: "GH", secret: "file" }]);
    // `other` is not referenced and still withheld; `remote` belongs to another host's environment.
    expect(plan.withheldEnv).toEqual(["ORCA_TEST_TOKEN", "ORCA_OTHER_TOKEN"]);
  });

  it("refuses a reference bound to another host, an undefined one, and a host that cannot deliver", () => {
    expect(() => planSessionSecrets(local(), agent({ T: { secret: "remote" } }), secrets)).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        details: { secret: "remote", reason: "wrong-host", hostId: "local" },
      }),
    );
    expect(() => planSessionSecrets(local(), agent({ T: { secret: "nope" } }), secrets)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "undefined" }) }),
    );
    const bare = { id: "local" } as unknown as AgentHost;
    expect(() => planSessionSecrets(bare, agent({ T: { secret: "token" } }), secrets)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "unsupported" }) }),
    );
    expect(planSessionSecrets(bare, agent({ A: "1" }), undefined)).toMatchObject({ deliveries: [], withheldEnv: [] });
  });
});

describe("LocalHost delivery", () => {
  it("delivers a value only under the variables that reference it, and withholds its source", async () => {
    vi.stubEnv("ORCA_TEST_TOKEN", "tok-1234567890");
    vi.stubEnv("ORCA_UNRELATED", "kept");
    const dir = await tempDir();
    const out = join(dir, "seen");
    const proc = await local().spawnAgent(
      AgentSpecSchema.parse({
        id: "a",
        command: process.execPath,
        args: ["-e", envReporter(out, ["TOKEN", "ORCA_TEST_TOKEN", "ORCA_UNRELATED"])],
      }),
      {
        cwd: dir,
        secrets: [{ id: "token", source: { provider: "env", name: "ORCA_TEST_TOKEN" }, env: ["TOKEN"] }],
        withheldEnv: ["ORCA_TEST_TOKEN"],
      },
    );
    procs.push(proc);
    expect(proc.secretValues).toEqual(new Map([["token", "tok-1234567890"]]));
    await waitFor(out);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
      TOKEN: "tok-1234567890",
      ORCA_TEST_TOKEN: null,
      ORCA_UNRELATED: "kept",
    });
  });

  it("reads a file whole and drops one trailing newline; refuses a missing or empty source without spawning", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "token"), "line one\nline two\n\n");
    const out = join(dir, "seen");
    const spec = AgentSpecSchema.parse({ id: "a", command: process.execPath, args: ["-e", envReporter(out, ["T"])] });
    const file = (path: string) => [{ id: "t", source: { provider: "file" as const, path }, env: ["T"] }];
    const proc = await local().spawnAgent(spec, { cwd: dir, secrets: file(join(dir, "token")) });
    procs.push(proc);
    expect(proc.secretValues?.get("t")).toBe("line one\nline two\n");
    await waitFor(out);
    await rm(out);

    await expect(local().spawnAgent(spec, { cwd: dir, secrets: file(join(dir, "absent")) })).rejects.toMatchObject({
      message: `secret 't' is unavailable: file ${join(dir, "absent")} does not exist or cannot be read on host 'local'`,
      details: { reason: "missing" },
    });
    vi.stubEnv("ORCA_TEST_TOKEN", "");
    await expect(
      local().spawnAgent(spec, {
        cwd: dir,
        secrets: [{ id: "t", source: { provider: "env", name: "ORCA_TEST_TOKEN" }, env: ["T"] }],
      }),
    ).rejects.toMatchObject({
      message: "secret 't' is unavailable: environment variable ORCA_TEST_TOKEN is not set on host 'local'",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await exists(out)).toBe(false);
  });
});

/**
 * An `ssh` stand-in: records its arguments, prints a login banner, then runs the remote command
 * the way sshd does, by joining everything after `--` into one string for a shell.
 */
async function fakeSsh(dir: string): Promise<string> {
  const bin = join(dir, "ssh");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${join(dir, "argv")}"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
printf 'Welcome to the build box (no newline)'
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

describe("SshHost delivery", () => {
  it("reads and delivers in the agent's own connection, never in argv, and ACP still flows both ways", async () => {
    const dir = await tempDir();
    const host = sshHost(await fakeSsh(dir));
    const value = "s3cr3t 'quoted' $(not-run) \\ end";
    await writeFile(join(dir, "file-secret"), "from a file\r\n");
    const out = join(dir, "seen");
    vi.stubEnv("ORCA_REMOTE_TOKEN", value);
    vi.stubEnv("ORCA_REMOTE_OTHER", "withheld-value");
    const proc = await host.spawnAgent(
      AgentSpecSchema.parse({
        id: "a",
        command: process.execPath,
        args: ["-e", envReporter(out, ["TOKEN", "FROM_FILE", "PLAIN", "ORCA_REMOTE_TOKEN", "ORCA_REMOTE_OTHER"])],
        env: { PLAIN: "p" },
      }),
      {
        cwd: dir,
        secrets: [
          { id: "token", source: { provider: "env", name: "ORCA_REMOTE_TOKEN" }, env: ["TOKEN"] },
          { id: "file", source: { provider: "file", path: join(dir, "file-secret") }, env: ["FROM_FILE"] },
          { id: "mcp-only", source: { provider: "file", path: join(dir, "file-secret") }, env: [] },
        ],
        withheldEnv: ["ORCA_REMOTE_TOKEN", "ORCA_REMOTE_OTHER"],
      },
    );
    procs.push(proc);
    expect(proc.secretValues).toEqual(
      new Map([
        ["token", value],
        ["file", "from a file"],
        ["mcp-only", "from a file"],
      ]),
    );
    const writer = proc.stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "ping" } as never);
    writer.releaseLock();
    expect(await firstMessage(proc)).toEqual({ jsonrpc: "2.0", method: "ping" });
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
      TOKEN: value,
      FROM_FILE: "from a file",
      PLAIN: "p",
      ORCA_REMOTE_TOKEN: null,
      ORCA_REMOTE_OTHER: null,
    });
    const argv = await readFile(join(dir, "argv"), "utf8");
    for (const needle of ["s3cr3t", Buffer.from(value).toString("base64"), "from a file", "withheld-value"])
      expect(argv).not.toContain(needle);
  });

  it("drops exactly one trailing newline from a remote file, as a local host does", async () => {
    const dir = await tempDir();
    const host = sshHost(await fakeSsh(dir));
    await writeFile(join(dir, "s"), "two\n\n");
    const proc = await host.spawnAgent(AgentSpecSchema.parse({ id: "a", command: "true" }), {
      cwd: dir,
      secrets: [{ id: "s", source: { provider: "file", path: join(dir, "s") }, env: [] }],
    });
    procs.push(proc);
    expect(proc.secretValues?.get("s")).toBe("two\n");
  });

  it("refuses a missing remote value before the agent starts, with no local fallback", async () => {
    const dir = await tempDir();
    const host = sshHost(await fakeSsh(dir));
    const out = join(dir, "seen");
    const spec = AgentSpecSchema.parse({ id: "a", command: process.execPath, args: ["-e", envReporter(out, [])] });
    await expect(
      host.spawnAgent(spec, {
        cwd: dir,
        secrets: [{ id: "t", source: { provider: "env", name: "ORCA_UNSET_REMOTE" }, env: ["T"] }],
      }),
    ).rejects.toMatchObject({
      message: "secret 't' is unavailable: environment variable ORCA_UNSET_REMOTE is not set on host 'build-box'",
      details: { reason: "missing", hostId: "build-box" },
    });
    await expect(
      host.spawnAgent(spec, {
        cwd: dir,
        secrets: [{ id: "f", source: { provider: "file", path: join(dir, "absent") }, env: ["F"] }],
      }),
    ).rejects.toMatchObject({ details: { secret: "f", reason: "missing" } });
    expect(await exists(out)).toBe(false);
  });

  it("refuses a variable name that is not one before connecting, and a connection that ends early", async () => {
    await expect(
      sshHost("orca-no-such-ssh-binary").spawnAgent(AgentSpecSchema.parse({ id: "a", command: "x" }), {
        cwd: "/",
        secrets: [{ id: "t", source: { provider: "env", name: "OK" }, env: ["A;rm"] }],
      }),
    ).rejects.toThrow(/cannot carry a secret/);
    const dir = await tempDir();
    const bin = join(dir, "ssh");
    await writeFile(bin, "#!/bin/sh\nexit 255\n");
    await chmod(bin, 0o755);
    await expect(
      sshHost(bin).spawnAgent(AgentSpecSchema.parse({ id: "a", command: "x" }), {
        cwd: "/",
        secrets: [{ id: "t", source: { provider: "env", name: "OK" }, env: ["T"] }],
      }),
    ).rejects.toMatchObject({ code: "AGENT_TRANSPORT", message: expect.stringMatching(/ended \(exit 255\)/) });
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

/** An agent that prints its credential to stderr and fails the handshake. */
const leakingAgent = `
process.stderr.write("auth failed for " + process.env.TOKEN + "\\n");
setTimeout(() => process.exit(3), 50);
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
    const record = (m: string, f?: object) => lines.push(`${m} ${JSON.stringify(f ?? {})}`);
    const logger: Logger = {
      log: (_l, m, f) => record(m, f),
      debug: record,
      info: record,
      warn: record,
      error: record,
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

  it("redacts the value from a failed handshake's error and stderr tail", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "token"), "leaky-value-333\n");
    const error = await openAcpSession({
      host: local(),
      agent: AgentSpecSchema.parse({
        id: "leaky",
        command: process.execPath,
        args: ["-e", leakingAgent],
        env: { TOKEN: { secret: "token" } },
      }),
      cwd: dir,
      secrets: { token: { host: "local", provider: "file", path: join(dir, "token") } },
    }).then(
      () => undefined,
      (e: unknown) => e as OrcaError,
    );
    expect(error).toBeInstanceOf(OrcaError);
    const shown = JSON.stringify({ ...error!.toJSON(), stack: error!.stack, cause: String(error!.cause) });
    expect(shown).toContain("[REDACTED]");
    expect(shown).not.toContain("leaky-value-333");
  });

  it("keeps a configured env secret out of an agent that does not reference it (the ping path included)", async () => {
    vi.stubEnv("ORCA_TEST_TOKEN", "daemon-held-444");
    const dir = await tempDir();
    const out = join(dir, "seen");
    const opened = openAcpSession({
      host: local(),
      agent: AgentSpecSchema.parse({
        id: "plain",
        command: process.execPath,
        args: ["-e", envReporter(out, ["ORCA_TEST_TOKEN"])],
      }),
      cwd: dir,
      secrets: { token: { host: "local", provider: "env", name: "ORCA_TEST_TOKEN" } },
      handshakeTimeoutMs: 300,
    });
    await waitFor(out);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ ORCA_TEST_TOKEN: null });
    await opened.then(
      (s) => s.close(),
      () => undefined,
    );
  });

  it("refuses before anything is spawned when a value cannot be read", async () => {
    await expect(
      openAcpSession({
        host: local(),
        agent: AgentSpecSchema.parse({ id: "r", command: "never", env: { TOKEN: { secret: "token" } } }),
        cwd: process.cwd(),
        secrets: { token: { host: "local", provider: "file", path: "/nonexistent/orca/token" } },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", details: { secret: "token", reason: "missing" } });
  });
});

describe("redaction helpers", () => {
  it("redactingLogger redacts messages, fields and child bindings, reading the values when it logs", () => {
    const seen: unknown[] = [];
    const inner: Logger = {
      log: (...a) => seen.push(a),
      debug: (...a) => seen.push(a),
      info: (...a) => seen.push(a),
      warn: (...a) => seen.push(a),
      error: (...a) => seen.push(a),
      child: (f) => (seen.push(["child", f]), inner),
    };
    const values: string[] = [];
    const log = redactingLogger(inner, () => values);
    values.push("pw-123");
    log.info("got pw-123", { v: "pw-123" });
    log.log("warn", "pw-123");
    log.debug("pw-123");
    log.warn("pw-123");
    log.error("pw-123");
    log.child({ k: "pw-123" }).info("x");
    expect(JSON.stringify(seen)).not.toContain("pw-123");
  });

  it("redactError rewrites message, stack, details and the cause chain in place", () => {
    const cause = new Error("inner pw-123");
    const error = new OrcaError("AGENT_PROTOCOL", "outer pw-123", { stderr: "pw-123\n" }, { cause });
    expect(redactError(error, ["pw-123"])).toBe(error);
    expect(error.message).toBe("outer [REDACTED]");
    expect(error.details).toEqual({ stderr: "[REDACTED]\n" });
    expect(cause.message).toBe("inner [REDACTED]");
    expect(String(error.stack)).not.toContain("pw-123");
    expect(redactError("plain pw-123", ["pw-123"])).toBe("plain pw-123");
  });
});
