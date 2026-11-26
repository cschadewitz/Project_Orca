/**
 * The Claude Agent SDK driver's launch boundary (#1118): the person's own `claude`, their own
 * login, and no credential ORCA did not get from the agent's config.
 *
 * Every `claude` here is a small shell script standing in for the CLI, so no account is needed.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError, type AgentSpec } from "@orca/core";
import {
  claudeSdkEnvironment,
  claudeSdkPreflight,
  claudeSdkRequested,
  isClaudeCredentialVariable,
  openAcpSession,
  parseAuthStatus,
  refuseClaudeSdkSessionUntilDriver,
  resolveClaudeExecutable,
  LocalHost,
} from "../src/index.js";

const posix = process.platform !== "win32";

function agent(extra: Record<string, unknown> = {}): AgentSpec {
  return AgentSpecSchema.parse({ id: "claude-sdk", driver: "claude-agent-sdk", ...extra });
}

let dir: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in `claude` that answers `--version` and `auth status --json` from a script body. */
async function fakeClaude(path: string, authStatus: string, extra = ""): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh
${extra}
if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
${authStatus}
fi
exit 9
`,
  );
  await chmod(path, 0o755);
  return path;
}

const LOGGED_IN = `echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'; exit 0`;

describe("config (#1118)", () => {
  it("takes driver: claude-agent-sdk without a command, and leaves the ACP route as it was", () => {
    const a = agent();
    expect(a.command).toBe("");
    expect(claudeSdkRequested(a)).toBe(true);
    const acp = AgentSpecSchema.parse({ id: "x", command: "claude-agent-acp" });
    expect(acp.driver).toBeUndefined();
    expect(claudeSdkRequested(acp)).toBe(false);
    expect(AgentSpecSchema.safeParse({ id: "x" }).success).toBe(false);
  });

  it("refuses args, the ACP hook, the Codex gate and orca-daemon with the SDK driver", () => {
    const issues = (extra: Record<string, unknown>) => {
      const r = AgentSpecSchema.safeParse({ id: "c", driver: "claude-agent-sdk", ...extra });
      return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    };
    expect(issues({ args: ["--dangerously-skip-permissions"] })).toContain("args");
    expect(issues({ nativeToolHook: "experimental" })).toContain("nativeToolHook");
    expect(issues({ codexExecGate: "experimental" })).toContain("codexExecGate");
    expect(issues({ type: "orca-daemon", profile: "p", workflow: "w" })).toContain("driver");
    expect(issues({ nativeToolHook: "off" })).toEqual([]);
  });
});

describe("environment (#1118)", () => {
  it("takes no Claude or Anthropic variable from the daemon or from ORCA, only from the agent's env", () => {
    const env = claudeSdkEnvironment(
      agent({ env: { ANTHROPIC_API_KEY: "from-agent-config", FOO: "bar" } }),
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        CLAUDE_CONFIG_DIR: "/home/x/.claude-work",
        ANTHROPIC_API_KEY: "daemon-key",
        ANTHROPIC_AUTH_TOKEN: "daemon-token",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        CLAUDE_CODE_OAUTH_TOKEN: "daemon-oauth",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock",
        CLAUDECODE: "1",
        CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/run/token",
      },
      { CLAUDE_CODE_OAUTH_TOKEN: "orca-must-not", ORCA_X: "1" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      CLAUDE_CONFIG_DIR: "/home/x/.claude-work",
      ORCA_X: "1",
      ANTHROPIC_API_KEY: "from-agent-config",
      FOO: "bar",
    });
  });

  it("names the credential variables, and keeps the config dir that chooses the login", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "anthropic_auth_token",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_VERTEX",
    ])
      expect(isClaudeCredentialVariable(name)).toBe(true);
    for (const name of ["CLAUDE_CONFIG_DIR", "PATH", "HOME", "AWS_PROFILE"])
      expect(isClaudeCredentialVariable(name)).toBe(false);
  });

  it("refuses a secret reference until the driver delivers secrets (#1126)", () => {
    expect(() => claudeSdkEnvironment(agent({ env: { ANTHROPIC_API_KEY: { secret: "k" } } }), {})).toThrow(
      /does not deliver secrets yet \(#1126\)/,
    );
  });
});

describe.runIf(posix)("executable (#1118)", () => {
  it("finds claude on PATH by real path when command is left out", async () => {
    const bin = await fakeClaude(join(dir, "bin", "claude"), LOGGED_IN);
    expect(await resolveClaudeExecutable(agent(), { PATH: `relative:${join(dir, "bin")}` }, dir)).toBe(bin);
  });

  it("refuses the SDK's bundled CLI, even through a symlink", async () => {
    const bundled = await fakeClaude(
      join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude"),
      LOGGED_IN,
    );
    execFileSync("ln", ["-s", bundled, join(dir, "claude-link")]);
    await expect(resolveClaudeExecutable(agent({ command: join(dir, "claude-link") }), {}, dir)).rejects.toThrow(
      /bundled CLI/,
    );
  });

  it("says to install Claude Code when nothing runs", async () => {
    await expect(resolveClaudeExecutable(agent(), { PATH: join(dir, "nowhere") }, dir)).rejects.toThrow(
      /not an executable on PATH.*claude auth login/,
    );
    await writeFile(join(dir, "not-exec"), "#!/bin/sh\n");
    await expect(resolveClaudeExecutable(agent({ command: join(dir, "not-exec") }), {}, dir)).rejects.toThrow(
      /not an executable file/,
    );
  });
});

describe.runIf(posix)("login (#1118)", () => {
  it("passes a signed-in claude, and never opens the credentials file", async () => {
    const config = join(dir, "claude-config");
    await mkdir(config);
    // Opening a FIFO for reading blocks until a writer comes: if anything in the preflight
    // opened Claude's credentials, this test would time out instead of passing.
    execFileSync("mkfifo", [join(config, ".credentials.json")]);
    const envLog = join(dir, "env.log");
    const bin = await fakeClaude(join(dir, "bin", "claude"), LOGGED_IN, `env > "${envLog}"`);
    const result = await claudeSdkPreflight({
      agent: agent({ command: bin }),
      cwd: dir,
      baseEnv: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "daemon-key" },
      orcaEnv: { ANTHROPIC_AUTH_TOKEN: "orca-token" },
    });
    expect(result).toMatchObject({
      executable: bin,
      version: "2.1.332",
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    });
    const seen = await readFile(envLog, "utf8");
    expect(seen).toContain(`CLAUDE_CONFIG_DIR=${config}`);
    expect(seen).not.toMatch(/^ANTHROPIC_/m);
    expect(seen).not.toMatch(/^CLAUDE_CODE_/m);
  });

  it("fails an unauthenticated claude with the claude auth login guidance", async () => {
    const bin = await fakeClaude(join(dir, "claude"), `echo '{"loggedIn":false}'; exit 1`);
    const error = await claudeSdkPreflight({ agent: agent({ command: bin }), cwd: dir, baseEnv: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrcaError);
    expect((error as OrcaError).message).toMatch(/not signed in.*Run `claude auth login`/);
    expect((error as OrcaError).details).toMatchObject({ reason: "claude-not-logged-in" });
  });

  it("fails, never passes, a claude that hangs or answers something else", async () => {
    const hang = await fakeClaude(join(dir, "hang"), `exec sleep 30`);
    const started = Date.now();
    await expect(
      claudeSdkPreflight({ agent: agent({ command: hang }), cwd: dir, baseEnv: {}, timeoutMs: 300 }),
    ).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const prose = await fakeClaude(join(dir, "prose"), `echo "Logged in"; exit 0`);
    await expect(claudeSdkPreflight({ agent: agent({ command: prose }), cwd: dir, baseEnv: {} })).rejects.toThrow(
      /gave no answer ORCA can read/,
    );
  });

  it("never takes signed in from a probe that failed or was interrupted", async () => {
    const SIGNED_IN = `echo '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'`;
    const cases: [string, string, RegExp][] = [
      ["nonzero", `${SIGNED_IN}; exit 3`, /said signed in but exited with 3/],
      ["hang", `${SIGNED_IN}; exec sleep 30`, /did not answer in time/],
      ["signal", `${SIGNED_IN}; kill -9 $$`, /was ended by SIGKILL/],
      ["flood", `${SIGNED_IN}; yes x | head -c 200000`, /printed more than ORCA reads/],
    ];
    for (const [name, body, message] of cases) {
      const bin = await fakeClaude(join(dir, name), body);
      const error = await claudeSdkPreflight({
        agent: agent({ command: bin }),
        cwd: dir,
        baseEnv: {},
        timeoutMs: 1_000,
      }).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(OrcaError);
      expect((error as OrcaError).message, name).toMatch(message);
      expect((error as OrcaError).details, name).not.toHaveProperty("reason");
    }
    const cancelled = await fakeClaude(join(dir, "cancelled"), `${SIGNED_IN}; exec sleep 30`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      claudeSdkPreflight({ agent: agent({ command: cancelled }), cwd: dir, baseEnv: {}, signal: controller.signal }),
    ).rejects.toThrow(/was cancelled/);
  });

  it("keeps none of the CLI's own text in an error or the result", async () => {
    const SENTINEL = "SENTINEL-7f3a-do-not-disclose";
    const noisy = await fakeClaude(
      join(dir, "noisy"),
      `echo "${SENTINEL} diagnostic" >&2; echo "${SENTINEL} not json"; exit 2`,
      `if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code) ${SENTINEL}"; echo "${SENTINEL}" >&2; exit 0; fi`,
    );
    const error = await claudeSdkPreflight({ agent: agent({ command: noisy }), cwd: dir, baseEnv: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OrcaError);
    const e = error as OrcaError;
    expect(e.message + JSON.stringify(e.details)).not.toContain(SENTINEL);
    expect(e.details).toMatchObject({ exitCode: 2 });

    const odd = await fakeClaude(
      join(dir, "odd"),
      `echo '{"loggedIn":true,"authMethod":"${SENTINEL} x","apiProvider":"firstParty"}'; exit 0`,
      `if [ "$1" = "--version" ]; then echo "2.1.332 (Claude Code) ${SENTINEL}"; exit 0; fi`,
    );
    const ok = await claudeSdkPreflight({ agent: agent({ command: odd }), cwd: dir, baseEnv: {} });
    expect(ok).toMatchObject({ version: "2.1.332", authMethod: "unknown", apiProvider: "firstParty" });
    const refusal = await refuseClaudeSdkSessionUntilDriver({
      agent: agent({ command: odd }),
      cwd: dir,
      baseEnv: {},
    }).catch((x: unknown) => x as OrcaError);
    expect(refusal.message + JSON.stringify(refusal.details)).not.toContain(SENTINEL);

    const noVersion = await fakeClaude(
      join(dir, "noversion"),
      LOGGED_IN,
      `if [ "$1" = "--version" ]; then echo "${SENTINEL}"; exit 0; fi`,
    );
    const versionError = (await claudeSdkPreflight({
      agent: agent({ command: noVersion }),
      cwd: dir,
      baseEnv: {},
    }).then(
      () => undefined,
      (x: unknown) => x,
    )) as OrcaError;
    expect(versionError.message).toMatch(/printed no Claude Code version/);
    expect(versionError.message + JSON.stringify(versionError.details)).not.toContain(SENTINEL);
  });

  it("refuses the session after the checks, naming the driver issue", async () => {
    const bin = await fakeClaude(join(dir, "claude"), LOGGED_IN);
    await expect(
      refuseClaudeSdkSessionUntilDriver({ agent: agent({ command: bin }), cwd: dir, baseEnv: {} }),
    ).rejects.toThrow(/session driver is not built yet \(#1120\)/);
  });
});

describe("auth status parsing (#1118)", () => {
  it("reads only a JSON object with a boolean loggedIn", () => {
    expect(parseAuthStatus('{"loggedIn":true}')).toEqual({ loggedIn: true });
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeUndefined();
    expect(parseAuthStatus("[true]")).toBeUndefined();
    expect(parseAuthStatus("")).toBeUndefined();
    expect(parseAuthStatus("{nope")).toBeUndefined();
  });
});

describe("ACP route (#1118)", () => {
  it("never opens a driver: claude-agent-sdk agent over ACP", async () => {
    await expect(
      openAcpSession({
        agent: agent({ command: "/bin/true" }),
        host: new LocalHost({ id: "local", type: "local" }),
        cwd: dir,
      }),
    ).rejects.toThrow(/not ACP/);
  });
});
