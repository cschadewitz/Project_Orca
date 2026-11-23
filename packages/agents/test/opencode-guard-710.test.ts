/**
 * #710 OpenCode provider guard: the launch checks and session wrapper in
 * `providers/opencode.ts`, with synthetic files and an injected digest. No OpenCode process is
 * started here; the installed binary is exercised by `opencode-acceptance-710.test.ts` in CI.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, OrcaError, type AgentSpec } from "@orca/core";
import {
  OPENCODE_IMAGES,
  openCodeBoundedAnswer,
  guardOpenCodeSession,
  isOpenCodeAgent,
  openCodeConfigProblems,
  openCodeGuard,
  openCodePolicyProblems,
  openCodeProfileDirProblems,
  openCodeProfileProblems,
  providerGuardFor,
  openCodeSlashCommand,
  withProviderGuards,
  type AgentHost,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";

const packet = new URL("../../../docs/preparation/opencode-acp-710/", import.meta.url);
const LINUX = OPENCODE_IMAGES["linux-x64"]!.sha256;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function isolatedConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("opencode.isolated.json", packet), "utf8")) as Record<string, unknown>;
}

/** A profile root with a stand-in executable and the reviewed config, and the agent that uses it. */
async function profile(overrides: Partial<Record<string, unknown>> = {}, config?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "orca-opencode-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  const command = join(root, "bin", "opencode");
  await writeFile(command, "stand-in, never executed");
  await chmod(command, 0o755);
  const cfg = config ?? (await isolatedConfig());
  const configPath = join(root, "opencode.isolated.json");
  await writeFile(configPath, JSON.stringify(cfg));
  const agent = AgentSpecSchema.parse({
    id: "opencode",
    command,
    args: ["acp", "--hostname", "127.0.0.1", "--port", "0", "--pure", "--log-level", "WARN"],
    env: {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg", "config"),
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: "",
      OPENCODE_CONFIG_CONTENT: "",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PURE: "1",
      OPENCODE_PERMISSION: JSON.stringify(cfg.permission),
    },
    permissions: { rules: [{ match: { kind: "think", titlePattern: "^task$" }, decision: "deny" }] },
    ...overrides,
  });
  return { root, command, configPath, agent };
}

function host(type: "local" | "ssh" = "local"): AgentHost {
  return {
    id: "local",
    spec:
      type === "local"
        ? { id: "local", type }
        : { id: "local", type, host: "h", sshArgs: [], sshBinary: "ssh", remoteShell: "bash -lc", connectTimeoutMs: 1 },
  } as unknown as AgentHost;
}

function options(agent: AgentSpec, extra: Partial<OpenSessionOptions> = {}): OpenSessionOptions {
  return { host: host(), agent, cwd: "/ws", ...extra };
}

const guard = (digest = LINUX, managed: string[] = []) =>
  openCodeGuard({
    digest: async () => digest,
    platform: "linux",
    arch: "x64",
    managedConfig: async () => managed,
  });

async function refusal(promise: Promise<unknown>): Promise<OrcaError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrcaError);
  return error as OrcaError;
}

describe("which agents are OpenCode", () => {
  it("matches the opencode executable and package runners that would fetch it", () => {
    const spec = (command: string, args: string[] = []) => AgentSpecSchema.parse({ id: "a", command, args });
    expect(isOpenCodeAgent(spec("/opt/oc/bin/opencode", ["acp"]))).toBe(true);
    expect(isOpenCodeAgent(spec("C:\\oc\\opencode.exe", ["acp"]))).toBe(true);
    expect(isOpenCodeAgent(spec("npx", ["-y", "opencode-ai@1.19.4", "acp"]))).toBe(true);
    expect(isOpenCodeAgent(spec("bunx", ["@opencode/cli", "acp"]))).toBe(true);
    expect(isOpenCodeAgent(spec("codex-acp"))).toBe(false);
    expect(isOpenCodeAgent(spec("npx", ["@zed-industries/claude-code-acp"]))).toBe(false);
    expect(providerGuardFor(spec("/x/opencode"))?.id).toBe("opencode");
    expect(providerGuardFor(spec("/x/claude-code-acp"))).toBeUndefined();
  });
});

describe("launch profile", () => {
  it("accepts the reviewed profile on an admitted platform", async () => {
    const { agent } = await profile();
    expect(openCodeProfileProblems(agent, {}, "local", "linux", "x64")).toEqual([]);
    expect(openCodeProfileProblems(agent, {}, "local", "darwin", "arm64")).toEqual([]);
    expect(openCodePolicyProblems(agent)).toEqual([]);
  });

  it("refuses the hazards one by one", async () => {
    const { agent } = await profile();
    const problems = (
      patch: Partial<AgentSpec>,
      ambient: Record<string, string> = {},
      hostType: "local" | "ssh" = "local",
    ) => openCodeProfileProblems({ ...agent, ...patch }, ambient, hostType, "linux", "x64").join("\n");
    expect(problems({ command: "opencode" })).toMatch(/absolute path/);
    expect(problems({ command: "npx", args: ["opencode-ai", "acp"] })).toMatch(/not a package runner/);
    expect(problems({}, {}, "ssh")).toMatch(/this computer only/);
    expect(problems({ args: ["acp", "--hostname", "127.0.0.1", "--port", "0"] })).toMatch(/--pure is missing/);
    expect(problems({ args: ["acp", "--hostname", "0.0.0.0", "--port", "0", "--pure"] })).toMatch(/loopback/);
    expect(problems({ args: ["acp", "--hostname", "127.0.0.1", "--port", "4096", "--pure"] })).toMatch(/--port 0/);
    expect(problems({ args: ["acp", "--hostname=127.0.0.1", "--port=0", "--pure", "--cwd", "/x"] })).toMatch(
      /--cwd is not supported/,
    );
    expect(problems({ args: ["run", "--hostname", "127.0.0.1", "--port", "0", "--pure"] })).toMatch(/acp subcommand/);
    expect(
      problems({ mcpServers: [{ name: "s", command: "x", args: [], env: {} }] as AgentSpec["mcpServers"] }),
    ).toMatch(/MCP servers/);
    expect(problems({ env: { ...agent.env, OPENCODE_PURE: "0" } })).toMatch(/OPENCODE_PURE/);
    expect(problems({ env: { ...agent.env, OPENCODE_CONFIG_DIR: "/home/me/.opencode" } })).toMatch(
      /OPENCODE_CONFIG_DIR/,
    );
    // The profile blanks it; a profile that does not inherits the daemon's.
    const { OPENCODE_CONFIG_CONTENT: _c, ...unblanked } = agent.env;
    expect(problems({ env: unblanked }, { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' })).toMatch(
      /OPENCODE_CONFIG_CONTENT/,
    );
    expect(problems({}, { OPENCODE_EXPERIMENTAL: "1" })).toMatch(/OPENCODE_EXPERIMENTAL is not supported/);
    const { HOME: _home, ...noHome } = agent.env;
    // Inheriting the daemon's HOME is exactly what reads the person's own ~/.opencode.
    expect(problems({ env: noHome }, { HOME: "/home/me" })).toMatch(/set HOME/);
    const { OPENCODE_PERMISSION: _p, ...noPermission } = agent.env;
    expect(problems({ env: noPermission })).toMatch(/OPENCODE_PERMISSION/);
  });

  it("admits only the platforms the acceptance suite runs on", async () => {
    const { agent } = await profile();
    for (const [platform, arch] of [
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ] as const)
      expect(openCodeProfileProblems(agent, {}, "local", platform, arch).join("\n")).toMatch(/is supported on/);
  });

  it("requires ORCA's own policy to deny the subagent launch the #140 defaults would allow", () => {
    const bare = AgentSpecSchema.parse({ id: "o", command: "/x/opencode" });
    expect(openCodePolicyProblems(bare)).toHaveLength(1);
    const askAll = AgentSpecSchema.parse({ id: "o", command: "/x/opencode", permissions: { default: "ask" } });
    expect(openCodePolicyProblems(askAll)).toHaveLength(1);
    const denyAll = AgentSpecSchema.parse({ id: "o", command: "/x/opencode", permissions: { default: "deny" } });
    expect(openCodePolicyProblems(denyAll)).toEqual([]);
  });
});

describe("OpenCode's own configuration", () => {
  it("accepts the reviewed isolated file", async () => {
    const cfg = await isolatedConfig();
    expect(openCodeConfigProblems(cfg, JSON.stringify(cfg.permission))).toEqual([]);
  });

  it("refuses native allows, a misplaced wildcard and missing denies", async () => {
    const cfg = await isolatedConfig();
    const check = (permission: Record<string, unknown>) =>
      openCodeConfigProblems({ ...cfg, permission }, JSON.stringify(permission)).join("\n");
    const p = cfg.permission as Record<string, unknown>;
    expect(check({ ...p, bash: { "git *": "allow", "*": "ask" } })).toMatch(/allows something natively/);
    expect(check({ read: "ask", ...p })).toMatch(/must start with "\*"/);
    expect(check({ ...p, "*": "allow" })).toMatch(/allows something natively/);
    expect(check({ ...p, task: "ask" })).toMatch(/permission.task must be "deny"/);
    const { webfetch: _w, ...noFetch } = p;
    expect(check(noFetch)).toMatch(/permission.webfetch must be "deny"/);
  });

  it("checks the effective ordered ruleset, so a later rule cannot reopen a mandatory denial", async () => {
    const cfg = await isolatedConfig();
    const p = cfg.permission as Record<string, unknown>;
    const env = (permission: unknown) => JSON.stringify(permission);
    const check = (patch: Record<string, unknown>, permission: unknown = p) =>
      openCodeConfigProblems({ ...cfg, ...patch, permission }, env(permission)).join("\n");
    // A wildcard key written after the denial matches it and wins (last match).
    expect(check({}, { ...p, "t*": "ask" })).toMatch(/permission.task must be "deny", and no later rule/);
    expect(check({}, { ...p, "web?etch": "ask" })).toMatch(/permission.webfetch/);
    // A pattern map whose `*` is deny but a later pattern asks opens that pattern.
    expect(check({}, { ...p, external_directory: { "*": "deny", "/tmp/*": "ask" } })).toMatch(
      /permission.external_directory/,
    );
    // A pattern map that denies every pattern keeps the denial.
    expect(check({}, { ...p, task: { "*": "deny", general: "deny" } })).toBe("");
    // The build agent's own block is applied after the top-level one.
    const agent = cfg.agent as Record<string, unknown>;
    expect(check({ agent: { ...agent, build: { permission: { "*": "ask" } } } })).toMatch(/permission.task/);
    expect(check({ agent: { ...agent, build: { permission: { websearch: "ask" } } } })).toMatch(/permission.websearch/);
    // Another agent's block does not change build's ruleset, but may not allow anything either.
    expect(check({ agent: { ...agent, plan: { disable: true, permission: { "*": "ask" } } } })).toBe("");
    expect(check({ agent: { ...agent, plan: { permission: { edit: "allow" } } } })).toMatch(/agent.plan.permission/);
    // Unreviewed actions and shapes are refused.
    expect(check({}, { ...p, bash: "maybe" })).toMatch(/unreviewed action 'maybe'/);
    expect(check({}, { ...p, bash: ["ask"] })).toMatch(/permission.bash must be/);
  });

  it("refuses settings it has not reviewed, such as the legacy tools map", async () => {
    const cfg = await isolatedConfig();
    const permission = JSON.stringify(cfg.permission);
    const problems = (patch: Record<string, unknown>) =>
      openCodeConfigProblems({ ...cfg, ...patch }, permission).join("\n");
    expect(problems({ tools: { bash: true } })).toMatch(/tools is not a reviewed setting/);
    expect(problems({ mode: { build: {} } })).toMatch(/mode is not a reviewed setting/);
    const agent = cfg.agent as Record<string, unknown>;
    expect(problems({ agent: { ...agent, build: { tools: { bash: true } } } })).toMatch(
      /agent.build.tools is not a reviewed setting/,
    );
  });

  it("refuses a permission layer that differs from the file, and code that runs without an ask", async () => {
    const cfg = await isolatedConfig();
    const permission = JSON.stringify(cfg.permission);
    expect(openCodeConfigProblems(cfg, JSON.stringify({ "*": "ask" })).join()).toMatch(/differs/);
    expect(openCodeConfigProblems(cfg, "{not json").join()).toMatch(/not JSON/);
    expect(openCodeConfigProblems(cfg, undefined).join()).toMatch(/set OPENCODE_PERMISSION/);
    const problems = (patch: Record<string, unknown>) =>
      openCodeConfigProblems({ ...cfg, ...patch }, permission).join("\n");
    expect(problems({ plugin: ["oc-plugin"] })).toMatch(/plugin must be \[\]/);
    expect(problems({ mcp: { s: { type: "local", command: ["x"] } } })).toMatch(/mcp must be \{\}/);
    expect(problems({ formatter: {} })).toMatch(/formatter must be false/);
    expect(problems({ lsp: true })).toMatch(/lsp must be false/);
    expect(problems({ share: "auto" })).toMatch(/share/);
    expect(problems({ autoupdate: true })).toMatch(/autoupdate/);
    expect(problems({ default_agent: "plan" })).toMatch(/default_agent/);
    expect(problems({ command: { x: { template: "!rm -rf /" } } })).toMatch(/command must be \{\}/);
    expect(problems({ agent: { build: { permission: { bash: "allow" } } } })).toMatch(/agent.build.permission/);
    expect(openCodeConfigProblems([], permission)).toEqual(["OPENCODE_CONFIG: the file is not a JSON object"]);
  });
});

describe("the profile's own configuration directories", () => {
  async function dirs() {
    const root = await mkdtemp(join(tmpdir(), "orca-opencode-dirs-"));
    roots.push(root);
    const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg") };
    await mkdir(join(env.XDG_CONFIG_HOME, "opencode", "node_modules"), { recursive: true });
    await mkdir(env.HOME, { recursive: true });
    return { root, env };
  }

  it("allows what OpenCode seeds and installs for itself, and nothing else", async () => {
    const { env } = await dirs();
    const cfg = join(env.XDG_CONFIG_HOME, "opencode");
    await writeFile(join(cfg, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
    for (const f of ["package.json", "bun.lock", ".gitignore"]) await writeFile(join(cfg, f), "{}");
    expect(await openCodeProfileDirProblems(env)).toEqual([]);
    await mkdir(join(cfg, "agents"));
    await mkdir(join(env.HOME, ".opencode", "commands"), { recursive: true });
    await writeFile(join(cfg, "config.json"), JSON.stringify({ permission: { "*": "allow" } }));
    const problems = (await openCodeProfileDirProblems(env)).join("\n");
    expect(problems).toMatch(/opencode\/agents is not allowed/);
    expect(problems).toMatch(/\.opencode\/commands is not allowed/);
    expect(problems).toMatch(/config.json sets permission/);
  });

  it("checks every entry's type, links, owner and write access, and counts only absence as empty", async () => {
    const { root, env } = await dirs();
    const cfg = join(env.XDG_CONFIG_HOME, "opencode");
    await writeFile(join(root, "elsewhere.json"), JSON.stringify({ $schema: "x" }));
    await symlink(join(root, "elsewhere.json"), join(cfg, "opencode.json"));
    await mkdir(join(cfg, "package.json"));
    await writeFile(join(cfg, "bun.lock"), "{}");
    await chmod(join(cfg, "bun.lock"), 0o666);
    const problems = (await openCodeProfileDirProblems(env)).join("\n");
    expect(problems).toMatch(/opencode.json is a symbolic link/);
    expect(problems).toMatch(/package.json is not a file/);
    expect(problems).toMatch(/bun.lock can be written by other users/);
    // The directory itself: writable by others, then not a directory at all.
    await rm(cfg, { recursive: true });
    await mkdir(cfg);
    await chmod(cfg, 0o777);
    expect((await openCodeProfileDirProblems(env)).join()).toMatch(/opencode can be written by other users/);
    await rm(cfg, { recursive: true });
    await writeFile(cfg, "not a directory");
    expect((await openCodeProfileDirProblems(env)).join()).toMatch(/opencode is not a directory/);
  });

  it("refuses a config file that is a link or writable by others", async () => {
    const { root, agent, configPath } = await profile();
    await chmod(configPath, 0o666);
    expect((await refusal(guard().prepare(options(agent)))).message).toMatch(/OPENCODE_CONFIG .* can be written/);
    await chmod(configPath, 0o644);
    const linked = join(root, "linked.json");
    await symlink(configPath, linked);
    const viaLink = { ...agent, env: { ...agent.env, OPENCODE_CONFIG: linked } };
    expect((await refusal(guard().prepare(options(viaLink)))).message).toMatch(/is a symbolic link/);
  });

  it("refuses a launch whose profile carries its own agents", async () => {
    const { agent } = await profile();
    await mkdir(join(agent.env.XDG_CONFIG_HOME as string, "opencode", "agent"), { recursive: true });
    expect((await refusal(guard().prepare(options(agent)))).message).toMatch(/is not allowed/);
  });
});

describe("the environment the process receives", () => {
  it("refuses control variables given as secret references, which cannot be checked", async () => {
    const { agent } = await profile();
    for (const variable of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_PURE", "OPENCODE_PERMISSION", "HOME"]) {
      const spec = { ...agent, env: { ...agent.env, [variable]: { secret: "s" } } };
      expect(openCodeProfileProblems(spec, {}, "local", "linux", "x64").join()).toMatch(
        new RegExp(`${variable} comes from a secret`),
      );
    }
  });

  it("checks the daemon environment less exactly what the host withholds for secrets", async () => {
    const { agent } = await profile();
    const env = { ...agent.env } as Record<string, unknown>;
    delete env.OPENCODE_CONFIG_CONTENT;
    const bare = { ...agent, env } as AgentSpec;
    const daemon = { OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}' };
    const withEnv = openCodeGuard({
      digest: async () => LINUX,
      platform: "linux",
      arch: "x64",
      managedConfig: async () => [],
      environment: () => daemon,
    });
    // Inherited, it adds an unreviewed layer.
    expect((await refusal(withEnv.prepare(options(bare)))).message).toMatch(/OPENCODE_CONFIG_CONTENT must be empty/);
    // Defined as a secret delivered by env on this host, the host withholds it, so it never arrives.
    const secrets = { c: { host: "local", provider: "env" as const, name: "OPENCODE_CONFIG_CONTENT" } };
    await expect(withEnv.prepare(options(bare, { secrets }))).resolves.toBeDefined();
  });
});

describe("prepare", () => {
  it("opens the reviewed build and turns an 'always' answer into 'once'", async () => {
    const { agent } = await profile();
    const ask = vi.fn(async () => "always");
    const prepared = await guard().prepare(options(agent, { askPermission: ask }));
    const request: acp.RequestPermissionRequest = {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "edit a.txt", kind: "edit" },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    };
    expect(await prepared.askPermission!(request)).toBe("once");
    expect(ask).toHaveBeenCalledOnce();
  });

  it("refuses another build, a writable executable, a managed config and an unreadable config file", async () => {
    const { agent, command, configPath } = await profile();
    expect((await refusal(guard("0".repeat(64)).prepare(options(agent)))).code).toBe("NOT_SUPPORTED");
    expect((await refusal(guard(LINUX, ["/etc/opencode"]).prepare(options(agent)))).message).toMatch(
      /managed OpenCode configuration/,
    );
    await writeFile(configPath, "{ // jsonc\n}");
    expect((await refusal(guard().prepare(options(agent)))).message).toMatch(/not plain JSON/);
    await rm(configPath);
    expect((await refusal(guard().prepare(options(agent)))).message).toMatch(/cannot be read/);
    await writeFile(configPath, JSON.stringify(await isolatedConfig()));
    await chmod(command, 0o777);
    expect((await refusal(guard().prepare(options(agent)))).message).toMatch(/writable by other users/);
  });

  it("checks the session's own env the way the host lays it over the agent's", async () => {
    const { agent } = await profile();
    expect((await refusal(guard().prepare(options(agent, { env: { OPENCODE_PURE: "" } })))).message).toMatch(
      /OPENCODE_PURE/,
    );
  });

  it("hashes the executable once per file identity", async () => {
    const { agent } = await profile();
    const digest = vi.fn(async () => LINUX);
    const g = openCodeGuard({ digest, platform: "linux", arch: "x64", managedConfig: async () => [] });
    await g.prepare(options(agent));
    await g.prepare(options(agent));
    expect(digest).toHaveBeenCalledOnce();
  });

  it("refuses before the agent is opened, and leaves other agents alone", async () => {
    const { agent } = await profile({ args: ["acp"] });
    const open = vi.fn(async () => ({}) as AgentSession);
    await refusal(withProviderGuards(open, [guard()])(options(agent)));
    expect(open).not.toHaveBeenCalled();
    const other = AgentSpecSchema.parse({ id: "c", command: "/x/codex-acp" });
    await withProviderGuards(open, [guard()])(options(other));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("session", () => {
  function fakeSession(mode = "build") {
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, durationMs: 1 }));
    const setConfigOption = vi.fn(async () => []);
    const close = vi.fn(async () => undefined);
    const session = {
      agentId: "opencode",
      configOptions: [{ id: "mode", name: "Mode", type: "select", currentValue: mode, options: [] }],
      prompt,
      setConfigOption,
      close,
    } as unknown as AgentSession;
    return { session, prompt, setConfigOption, close };
  }

  it("recognises a prompt OpenCode would run as a command, as OpenCode joins it", () => {
    expect(openCodeSlashCommand("/init")).toBe(true);
    expect(openCodeSlashCommand("  /review x")).toBe(true);
    expect(
      openCodeSlashCommand([
        { type: "text", text: " " },
        { type: "text", text: "/compact" },
      ]),
    ).toBe(true);
    expect(openCodeSlashCommand("fix /etc/hosts parsing")).toBe(false);
  });

  it("refuses slash prompts and other modes, and passes everything else through", async () => {
    const inner = fakeSession();
    const s = guardOpenCodeSession(inner.session);
    await expect(s.prompt("/init")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(inner.prompt).not.toHaveBeenCalled();
    await s.prompt("hello");
    expect(inner.prompt).toHaveBeenCalledOnce();
    await expect(s.setConfigOption("mode", "plan")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await s.setConfigOption("model", "stand-in/m");
    expect(inner.setConfigOption).toHaveBeenCalledWith("model", "stand-in/m");
  });

  it("leaves the wrapper's methods assignable, as the hook path in the session factory needs", async () => {
    const inner = fakeSession();
    const s = guardOpenCodeSession(inner.session);
    const close = vi.fn(async () => undefined);
    s.close = close;
    await s.close();
    expect(close).toHaveBeenCalledOnce();
    s.prompt = inner.prompt;
  });

  it("closes a session that opens in another mode", () => {
    const inner = fakeSession("plan");
    expect(() => guardOpenCodeSession(inner.session)).toThrow(/mode 'plan'/);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("never widens a rejection or invents an option", () => {
    const req = (kinds: acp.PermissionOptionKind[]): acp.RequestPermissionRequest => ({
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: kinds.map((kind) => ({ optionId: kind, kind, name: kind })),
    });
    expect(openCodeBoundedAnswer(req(["allow_always", "reject_once"]), "allow_always")).toBeUndefined();
    expect(openCodeBoundedAnswer(req(["allow_once", "reject_once"]), "reject_once")).toBe("reject_once");
    expect(openCodeBoundedAnswer(req(["allow_once"]), undefined)).toBeUndefined();
  });

  it("sends only one-time answers, and cancels when no one-time option is offered", () => {
    const req = (kinds: acp.PermissionOptionKind[]): acp.RequestPermissionRequest => ({
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: kinds.map((kind) => ({ optionId: kind, kind, name: kind })),
    });
    const all: acp.PermissionOptionKind[] = ["allow_once", "allow_always", "reject_once", "reject_always"];
    expect(openCodeBoundedAnswer(req(all), "allow_always")).toBe("allow_once");
    expect(openCodeBoundedAnswer(req(all), "reject_always")).toBe("reject_once");
    expect(openCodeBoundedAnswer(req(all), "allow_once")).toBe("allow_once");
    // No one-time reject on offer: cancel, never fall back to the persistent rejection.
    expect(openCodeBoundedAnswer(req(["allow_once", "reject_always"]), "reject_always")).toBeUndefined();
    // An answer that is not one of the request's options is not passed through.
    expect(openCodeBoundedAnswer(req(all), "made-up")).toBeUndefined();
  });
});
