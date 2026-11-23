/**
 * #710 OpenCode provider guard: the launch checks and session wrapper in
 * `providers/opencode.ts`, with synthetic files and an injected digest. No OpenCode process is
 * started here; the installed binary is exercised by `opencode-acceptance-710.test.ts` in CI.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
