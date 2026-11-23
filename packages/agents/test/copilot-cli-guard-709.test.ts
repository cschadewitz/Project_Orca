/**
 * Copilot CLI provider guard (#709): launch-profile refusals, the version pin, slash-command
 * prompts, allow-all/autopilot options and bounded "always" answers. No Copilot runs here; the
 * same checks against the real Copilot CLI are in copilot-cli-acceptance-709.test.ts.
 */
import { chmod, chown, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec, type SessionConfigOption } from "@orca/core";
import {
  COPILOT_CLI_VERIFIED_BUILDS,
  COPILOT_CLI_VERIFIED_VERSIONS,
  copilotHomeProblems,
  sha256File,
  LocalHost,
  boundedOptionId,
  copilotCliGuard,
  copilotCliProfileProblems,
  guardCopilotSession,
  isCopilotCliAgent,
  parseCopilotCliVersion,
  providerGuardFor,
  startsWithSlashCommand,
  withProviderGuards,
  type AgentSession,
  type OpenSessionOptions,
  type SessionUpdateEvent,
} from "@orca/agents";

const good = (over: Partial<Record<string, unknown>> = {}): AgentSpec =>
  AgentSpecSchema.parse({
    id: "copilot",
    command: "/opt/copilot/1.0.114/copilot",
    args: ["--acp", "--stdio", "--no-auto-update", "--disable-builtin-mcps", "--no-ask-user"],
    env: { COPILOT_HOME: "/opt/copilot/profile", COPILOT_AUTO_UPDATE: "false", COPILOT_ALLOW_ALL: "false" },
    ...over,
  });

describe("recognising Copilot", () => {
  it("matches the copilot executable and package runners that fetch it", () => {
    expect(isCopilotCliAgent(good())).toBe(true);
    expect(isCopilotCliAgent(good({ command: "C:\\Tools\\Copilot.exe" }))).toBe(true);
    expect(isCopilotCliAgent(good({ command: "npx", args: ["@github/copilot@1.0.114", "--acp"] }))).toBe(true);
    expect(isCopilotCliAgent(good({ command: "/usr/bin/codex-acp" }))).toBe(false);
    expect(isCopilotCliAgent(good({ command: "npx", args: ["@github/copilot-language-server", "--acp"] }))).toBe(true);
  });
  it("leaves every other agent to the generic session", async () => {
    expect(providerGuardFor(good({ command: "claude-code-acp" }))).toBeUndefined();
    const open = vi.fn(async () => ({}) as AgentSession);
    await withProviderGuards(open)({ agent: good({ command: "claude-code-acp" }) } as OpenSessionOptions);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("launch profile", () => {
  it("accepts the documented profile", () => {
    expect(copilotCliProfileProblems(good(), {}, "local")).toEqual([]);
  });
  it.each([
    ["--allow-all"],
    ["--allow-all-tools"],
    ["--yolo"],
    ["--allow-tool=shell(git:*)"],
    ["--allow-url"],
    ["--autopilot"],
    ["--add-dir"],
    ["--port"],
  ])("refuses %s", (flag) => {
    const spec = good({ args: [...good().args, flag] });
    expect(copilotCliProfileProblems(spec, {}, "local").join("\n")).toContain(flag.split("=")[0]);
  });
  it("refuses autopilot mode and a profile without --acp or --no-auto-update", () => {
    expect(
      copilotCliProfileProblems(good({ args: ["--acp", "--no-auto-update", "--mode", "autopilot"] }), {}, "local"),
    ).toEqual(["args: --mode autopilot is not supported"]);
    expect(copilotCliProfileProblems(good({ args: ["--stdio"] }), {}, "local")).toEqual([
      "args: --acp is missing",
      "args: --no-auto-update is missing",
    ]);
  });
  it("refuses a package runner, a relative command and another host", () => {
    expect(
      copilotCliProfileProblems(
        good({ command: "npx", args: ["@github/copilot", "--acp", "--no-auto-update"] }),
        {},
        "local",
      )[0],
    ).toMatch(/package runner/);
    expect(copilotCliProfileProblems(good({ command: "copilot" }), {}, "local")[0]).toMatch(/absolute path/);
    expect(copilotCliProfileProblems(good(), {}, "ssh")[0]).toMatch(/this computer only/);
  });
  it("refuses allow-all and autopilot variables, configured or inherited", () => {
    expect(copilotCliProfileProblems(good({ env: { ...good().env, COPILOT_ALLOW_ALL: "true" } }), {}, "local")).toEqual(
      ["env: COPILOT_ALLOW_ALL approves tools without asking ORCA"],
    );
    const { COPILOT_ALLOW_ALL: _, ...withoutAllowAll } = good().env;
    expect(copilotCliProfileProblems(good({ env: withoutAllowAll }), { COPILOT_ALLOW_ALL: "yes" }, "local")).toEqual([
      "env: COPILOT_ALLOW_ALL approves tools without asking ORCA (inherited from the daemon's environment)",
    ]);
    expect(copilotCliProfileProblems(good(), { COPILOT_PLAN_THEN_AUTOPILOT: "1" }, "local")[0]).toMatch(/AUTOPILOT/);
    expect(copilotCliProfileProblems(good(), { COPILOT_ALLOW_ALL: "true" }, "local")).toEqual([]);
  });
  it("needs its own COPILOT_HOME and auto-update off", () => {
    expect(copilotCliProfileProblems(good({ env: { COPILOT_AUTO_UPDATE: "false" } }), {}, "local")[0]).toMatch(
      /COPILOT_HOME/,
    );
    expect(copilotCliProfileProblems(good({ env: { COPILOT_HOME: "/p" } }), {}, "local")[0]).toMatch(
      /COPILOT_AUTO_UPDATE/,
    );
  });
  it("refuses tokens written into the config or inherited, and accepts secret references", () => {
    expect(copilotCliProfileProblems(good({ env: { ...good().env, GH_TOKEN: "ghp_x" } }), {}, "local")[0]).toMatch(
      /GH_TOKEN is written into ORCA's config/,
    );
    expect(copilotCliProfileProblems(good(), { GITHUB_TOKEN: "ghp_y" }, "local")[0]).toMatch(
      /GITHUB_TOKEN is inherited/,
    );
    expect(copilotCliProfileProblems(good(), { GITHUB_TOKEN: "" }, "local")).toEqual([]);
    expect(
      copilotCliProfileProblems(
        good({ env: { ...good().env, COPILOT_PROVIDER_API_KEY: { secret: "byok" } } }),
        {},
        "local",
      ),
    ).toEqual([]);
  });
  it("never puts a token value in a problem", () => {
    const text = copilotCliProfileProblems(
      good({ env: { ...good().env, GH_TOKEN: "ghp_needle" } }),
      { GITHUB_TOKEN: "ghp_needle2" },
      "local",
    ).join();
    expect(text).not.toContain("needle");
  });
});

describe("executable identity and Copilot's profile", () => {
  const LINUX = COPILOT_CLI_VERIFIED_BUILDS.find((b) => b.platform === "linux-x64")!;
  const guard = (over: Partial<Parameters<typeof copilotCliGuard>[0]> = {}) =>
    copilotCliGuard({ digest: async () => LINUX.sha256, platform: "linux-x64", environment: () => ({}), ...over });

  it("parses copilot --version", () => {
    expect(parseCopilotCliVersion("GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates.\n")).toBe(
      "1.0.114",
    );
    expect(parseCopilotCliVersion("something else")).toBeUndefined();
    expect(COPILOT_CLI_VERIFIED_VERSIONS).toEqual(["1.0.114"]);
  });

  async function options(command: string, home?: string): Promise<OpenSessionOptions> {
    home ??= join(await mkdtemp(join(tmpdir(), "orca-copilot-home-")), "profile");
    return {
      host: new LocalHost({ id: "local", type: "local" }),
      agent: good({ command, env: { ...good().env, COPILOT_HOME: home } }),
      cwd: tmpdir(),
    };
  }
  async function executable(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orca-copilot-exe-"));
    const path = join(dir, "copilot");
    await writeFile(path, "x");
    return path;
  }

  it("opens a verified build and refuses any other executable or platform before the agent starts", async () => {
    const open = vi.fn(async () => fakeSession());
    await withProviderGuards(open, [guard()])(await options(await executable()));
    expect(open).toHaveBeenCalledOnce();

    await expect(
      withProviderGuards(open, [guard({ digest: async () => "0".repeat(64) })])(await options(await executable())),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("not a verified Copilot CLI build"),
    });
    await expect(
      withProviderGuards(open, [guard({ platform: "win32-x64" })])(await options(await executable())),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED", message: expect.stringContaining("not on win32-x64") });
    await expect(withProviderGuards(open, [guard()])(await options("/nonexistent/copilot"))).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
    });
    expect(open).toHaveBeenCalledOnce();
  });

  it("hashes the file", async () => {
    const path = await executable();
    expect(await sha256File(path)).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });

  it("refuses a bad profile without hashing anything", async () => {
    const digest = vi.fn(async () => LINUX.sha256);
    const open = vi.fn(async () => fakeSession());
    const opts = await options(await executable());
    await expect(
      withProviderGuards(open, [guard({ digest })])({ ...opts, agent: good({ args: ["--acp", "--yolo"] }) }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(digest).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  async function home(files: Record<string, string>, dirs: Record<string, string[]> = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "orca-copilot-home-"));
    await chmod(root, 0o700);
    for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
    for (const [name, children] of Object.entries(dirs)) {
      await mkdir(join(root, name));
      for (const child of children) await writeFile(join(root, name, child), "{}");
    }
    return root;
  }
  /** config.json as Copilot writes it: two comment lines, then JSON. */
  const config = (extra: Record<string, unknown> = {}) =>
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(
      { firstLaunchAt: "2026-11-23T09:28:01.155Z", ...extra },
      null,
      2,
    )}\n`;

  it("accepts a fresh or signed-in profile and the state Copilot writes during ORCA's sessions", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "orca-copilot-fresh-"));
    await chmod(fresh, 0o700);
    expect(await copilotHomeProblems(join(fresh, "copilot-profile"))).toEqual([]);
    const dir = await home(
      {
        "config.json": config({
          loggedInUsers: [{ host: "https://github.com", login: "x" }],
          lastLoggedInUser: { login: "x" },
        }),
        "settings.json.lock": "",
        "session-store.db": "",
        "settings.json": '{ "banner": "never", "model": "gpt-5" }',
        "permissions-config.json": '{ "locations": { "/w": { "tool_approvals": [], "allowed_directories": [] } } }',
      },
      { logs: ["process.log"], "session-state": ["a"], "installed-plugins": [] },
    );
    expect(await copilotHomeProblems(dir)).toEqual([]);
  });

  it("refuses saved approvals, trust, hooks, MCP servers, plugins, unknown files and shared directories", async () => {
    const dir = await home(
      {
        "config.json": config({ trustedFolders: ["/w"] }),
        "settings.json": '{ "allowedUrls": ["example.com"], "defaultPermissionMode": "allow-all", "banner": "never" }',
        "permissions-config.json": '{ "locations": { "/w": { "tool_approvals": ["shell(touch)"] } } }',
        "mcp-config.json": "{}",
      },
      { hooks: ["a.json"], "installed-plugins": ["p"] },
    );
    expect((await copilotHomeProblems(dir)).sort()).toEqual(
      [
        "COPILOT_HOME config.json sets trustedFolders",
        "COPILOT_HOME settings.json sets allowedUrls",
        "COPILOT_HOME settings.json sets defaultPermissionMode",
        "COPILOT_HOME permissions-config.json holds saved approvals",
        "COPILOT_HOME holds mcp-config.json, which ORCA cannot tell is harmless",
        "COPILOT_HOME holds hooks, which ORCA cannot tell is harmless",
        "COPILOT_HOME has installed plugins",
      ].sort(),
    );
    const broken = await home({ "settings.json": "{ not json" });
    expect(await copilotHomeProblems(broken)).toEqual(["COPILOT_HOME settings.json cannot be read"]);
    if (process.platform !== "win32") {
      const shared = await home({});
      await chmod(shared, 0o777);
      expect(await copilotHomeProblems(shared)).toEqual([`COPILOT_HOME ${shared} can be written by other users`]);
      const link = `${shared}-link`;
      await symlink(shared, link);
      expect((await copilotHomeProblems(link))[0]).toMatch(/symbolic link/);
    }
  });

  it("refuses to start from a profile with problems", async () => {
    const open = vi.fn(async () => fakeSession());
    const dir = await home({ "settings.json": '{ "allowedUrls": ["example.com"] }' });
    await expect(withProviderGuards(open, [guard()])(await options(await executable(), dir))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("settings.json sets allowedUrls"),
    });
    expect(open).not.toHaveBeenCalled();
  });
});

const ALLOW_ONCE = { optionId: "allow_once", kind: "allow_once", name: "Allow once" } as const;
const ALLOW_ALWAYS = { optionId: "allow_always", kind: "allow_always", name: "Always allow" } as const;
const REJECT_ONCE = { optionId: "reject_once", kind: "reject_once", name: "Deny" } as const;
const request = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", title: "touch x" },
  options,
});

describe("answers", () => {
  it("answers Copilot's 'Always allow' with 'Allow once'", () => {
    const offered = request([ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE]);
    expect(boundedOptionId(offered, "allow_always")).toBe("allow_once");
    expect(boundedOptionId(offered, "allow_once")).toBe("allow_once");
    expect(boundedOptionId(offered, "reject_once")).toBe("reject_once");
    expect(boundedOptionId(offered, undefined)).toBeUndefined();
    expect(boundedOptionId(request([ALLOW_ALWAYS, REJECT_ONCE]), "allow_always")).toBeUndefined();
  });
  it("wraps the person's answer on the way out", async () => {
    const ask = vi.fn(async () => "allow_always");
    let seen: OpenSessionOptions | undefined;
    const open = async (o: OpenSessionOptions) => {
      seen = o;
      return fakeSession();
    };
    const dir = await mkdtemp(join(tmpdir(), "orca-copilot-ask-"));
    await writeFile(join(dir, "copilot"), "x");
    await withProviderGuards(open, [
      copilotCliGuard({
        digest: async () => COPILOT_CLI_VERIFIED_BUILDS[0]!.sha256,
        platform: COPILOT_CLI_VERIFIED_BUILDS[0]!.platform,
        environment: () => ({}),
      }),
    ])({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: good({ command: join(dir, "copilot"), env: { ...good().env, COPILOT_HOME: join(dir, "profile") } }),
      cwd: dir,
      askPermission: ask,
    });
    expect(await seen!.askPermission!(request([ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE]))).toBe("allow_once");
  });
});

/* ------------------------------ session guard ------------------------------ */

function option(id: string, currentValue: string): SessionConfigOption {
  return { id, name: id, type: "select", currentValue, options: [] } as unknown as SessionConfigOption;
}

function fakeSession(configOptions: SessionConfigOption[] = [option("allow_all", "off"), option("mode", "#agent")]) {
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  const session = {
    id: "sess",
    agentId: "copilot",
    hostId: "local",
    cwd: "/w",
    acpSessionId: "a",
    closed: Promise.resolve(),
    configOptions,
    prompt: vi.fn(async () => ({ stopReason: "end_turn" as const, durationMs: 1 })),
    onUpdate: (l: (e: SessionUpdateEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setConfigOption: vi.fn(async () => configOptions),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    emit(options: SessionConfigOption[]) {
      session.configOptions = options;
      for (const l of listeners)
        l({
          sessionId: "a",
          raw: { sessionUpdate: "config_option_update", configOptions: [] } as unknown as acp.SessionUpdate,
          summary: { kind: "config_option_update" },
          at: 0,
        });
    },
  };
  return session;
}

describe("session guard", () => {
  it("refuses a prompt that starts with a slash command, before Copilot sees it", async () => {
    const inner = fakeSession();
    const s = guardCopilotSession(inner);
    for (const p of ["/allow-all on", "  /yolo", "/ALLOW-ALL on", [{ type: "text", text: "\n/autopilot on" }]] as const)
      await expect(s.prompt(p as never)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(inner.prompt).not.toHaveBeenCalled();
    await s.prompt("fix the bug in /src/a.ts");
    expect(inner.prompt).toHaveBeenCalledOnce();
    expect(
      startsWithSlashCommand([
        { type: "text", text: "ok" },
        { type: "text", text: "/yolo" },
      ]),
    ).toBe(true);
  });
  it("refuses to turn on allow-all or autopilot", async () => {
    const inner = fakeSession();
    const s = guardCopilotSession(inner);
    await expect(s.setConfigOption("allow_all", "on")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(s.setConfigOption("allow_all", true)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(
      s.setConfigOption("mode", "https://agentclientprotocol.com/protocol/session-modes#autopilot"),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await s.setConfigOption("model", "gpt-5");
    expect(inner.setConfigOption).toHaveBeenCalledExactlyOnceWith("model", "gpt-5");
  });
  it("refuses a session that opens with allow-all on, and closes it", () => {
    const inner = fakeSession([option("allow_all", "on")]);
    expect(() => guardCopilotSession(inner as unknown as AgentSession)).toThrow(/allow_all/);
    expect(inner.close).toHaveBeenCalled();
  });
  it("ends a session that reports autopilot turned on, and fails the next prompt", async () => {
    const inner = fakeSession();
    const s = guardCopilotSession(inner);
    inner.emit([
      option("allow_all", "off"),
      option("mode", "https://agentclientprotocol.com/protocol/session-modes#autopilot"),
    ]);
    await vi.waitFor(() => expect(inner.close).toHaveBeenCalled());
    expect(inner.cancel).toHaveBeenCalled();
    await expect(s.prompt("hello")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
  it("keeps the rest of the session as it was", () => {
    const inner = fakeSession();
    const s = guardCopilotSession(inner);
    expect(s.acpSessionId).toBe("a");
    expect(s.configOptions).toBe(inner.configOptions);
  });
});

describe("the environment Copilot actually receives (#709 review)", () => {
  const LINUX = COPILOT_CLI_VERIFIED_BUILDS.find((b) => b.platform === "linux-x64")!;
  const guard = (environment: Record<string, string> = {}) =>
    copilotCliGuard({ digest: async () => LINUX.sha256, platform: "linux-x64", environment: () => environment });
  async function exe(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orca-copilot-env-"));
    await writeFile(join(dir, "copilot"), "x");
    return join(dir, "copilot");
  }
  const opts = async (over: Partial<OpenSessionOptions> = {}, agent: Partial<Record<string, unknown>> = {}) => ({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: good({
      command: await exe(),
      env: { ...good().env, COPILOT_HOME: join(await mkdtemp(join(tmpdir(), "orca-copilot-home-")), "profile") },
      ...agent,
    }),
    cwd: tmpdir(),
    ...over,
  });

  it("checks the session's own env overrides, not only the agent's config", async () => {
    const open = vi.fn(async () => fakeSession());
    await expect(
      withProviderGuards(open, [guard()])(await opts({ env: { COPILOT_ALLOW_ALL: "true" } })),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("COPILOT_ALLOW_ALL") });
    await expect(
      withProviderGuards(open, [guard()])(await opts({ env: { COPILOT_AUTO_UPDATE: "true" } })),
    ).rejects.toMatchObject({ message: expect.stringContaining("COPILOT_AUTO_UPDATE") });
    await expect(withProviderGuards(open, [guard()])(await opts({ env: { GH_TOKEN: "ghp_x" } }))).rejects.toMatchObject(
      { message: expect.stringContaining("GH_TOKEN is written") },
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("inspects the COPILOT_HOME a session override points at", async () => {
    const dirty = await mkdtemp(join(tmpdir(), "orca-copilot-dirty-"));
    await chmod(dirty, 0o700);
    await writeFile(join(dirty, "settings.json"), JSON.stringify({ allowedUrls: ["example.com"] }));
    const open = vi.fn(async () => fakeSession());
    await expect(
      withProviderGuards(open, [guard()])(await opts({ env: { COPILOT_HOME: dirty } })),
    ).rejects.toMatchObject({ message: expect.stringContaining("settings.json sets allowedUrls") });
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses control variables it cannot read because they come from a secret", () => {
    for (const variable of ["COPILOT_HOME", "COPILOT_ALLOW_ALL", "COPILOT_AUTO_UPDATE"])
      expect(
        copilotCliProfileProblems(good({ env: { ...good().env, [variable]: { secret: "s" } } }), {}, "local").join(),
      ).toContain(`${variable} comes from a secret`);
  });

  it("treats a variable a secret fills as unreadable, even under a session override (#709 review 3)", async () => {
    // The host applies secrets after the session's overrides, so the override is not what runs.
    for (const variable of ["COPILOT_HOME", "COPILOT_ALLOW_ALL", "COPILOT_AUTO_UPDATE"])
      expect(
        copilotCliProfileProblems(good({ env: { ...good().env, [variable]: { secret: "s" } } }), {}, "local", {
          [variable]: variable === "COPILOT_HOME" ? "/opt/copilot/profile" : "false",
        }).join(),
      ).toContain(`${variable} comes from a secret`);
    const open = vi.fn(async () => fakeSession());
    const secrets = { s: { host: "local", provider: "env" as const, name: "SOME_VALUE" } };
    const base = await opts();
    await expect(
      withProviderGuards(open, [guard()])({
        ...base,
        secrets,
        env: { COPILOT_ALLOW_ALL: "false" },
        agent: good({ command: base.agent.command, env: { ...base.agent.env, COPILOT_ALLOW_ALL: { secret: "s" } } }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("COPILOT_ALLOW_ALL comes from a secret") });
    expect(open).not.toHaveBeenCalled();
  });

  it("checks the start itself, with the arguments the host is given (#709 review 3)", async () => {
    const base = await opts();
    const spawned = vi.fn(async () => {
      throw new Error("spawned");
    });
    (base.host as { spawnAgent: unknown }).spawnAgent = spawned;
    const prepared = await guard().prepare(base);
    expect(prepared.host).not.toBe(base.host);
    const start = (over: object) => prepared.host.spawnAgent(base.agent, { cwd: tmpdir(), ...over });

    await expect(start({ env: { COPILOT_ALLOW_ALL: "true" } })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("COPILOT_ALLOW_ALL approves tools"),
    });
    await expect(
      start({ secrets: [{ id: "s", source: { provider: "env", name: "X" }, env: ["COPILOT_AUTO_UPDATE"] }] }),
    ).rejects.toMatchObject({ message: expect.stringContaining("COPILOT_AUTO_UPDATE comes from a secret") });
    const other = join(await mkdtemp(join(tmpdir(), "orca-copilot-home-")), "profile");
    await expect(start({ env: { COPILOT_HOME: other } })).rejects.toMatchObject({
      message: expect.stringContaining("COPILOT_HOME changed"),
    });
    expect(spawned).not.toHaveBeenCalled();

    // The start ORCA checked goes through to the host unchanged.
    await expect(start({})).rejects.toThrow("spawned");
    expect(spawned).toHaveBeenCalledOnce();
  });

  it("treats a daemon variable the host withholds as absent, exactly as the spawn does", async () => {
    const open = vi.fn(async () => fakeSession());
    const secrets = { gh: { host: "local", provider: "env" as const, name: "GITHUB_TOKEN" } };
    await withProviderGuards(open, [guard({ GITHUB_TOKEN: "ghp_x" })])(await opts({ secrets }));
    expect(open).toHaveBeenCalledOnce();
    await expect(withProviderGuards(open, [guard({ GITHUB_TOKEN: "ghp_x" })])(await opts())).rejects.toMatchObject({
      message: expect.stringContaining("GITHUB_TOKEN is inherited"),
    });
  });
});

describe("profile entries are checked for type, ownership and permissions (#709 review)", () => {
  async function profile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "orca-copilot-entries-"));
    await chmod(root, 0o700);
    return root;
  }

  it("treats only a confirmed absence as empty", async () => {
    const root = await profile();
    await writeFile(join(root, "file"), "x");
    expect(await copilotHomeProblems(join(root, "missing"))).toEqual([]);
    expect((await copilotHomeProblems(join(root, "file", "below")))[0]).toMatch(/cannot be inspected \(ENOTDIR\)/);
    expect(await copilotHomeProblems(join(root, "file"))).toEqual([
      `COPILOT_HOME ${join(root, "file")} is not a directory`,
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "calls a missing profile private only where no one else can create it (#709 review 3)",
    async () => {
      const root = await profile();
      expect(await copilotHomeProblems(join(root, "a", "b", "profile"))).toEqual([]);

      const open = await profile();
      await chmod(open, 0o777);
      expect((await copilotHomeProblems(join(open, "profile")))[0]).toMatch(/can be written by other users/);
      // Through a link, the real directory is the one judged.
      const link = join(await profile(), "link");
      await symlink(open, link);
      expect((await copilotHomeProblems(join(link, "profile")))[0]).toContain(await realpath(open));

      const above = await profile();
      await chmod(above, 0o777);
      await mkdir(join(above, "mine"), { mode: 0o700 });
      expect((await copilotHomeProblems(join(above, "mine", "profile")))[0]).toMatch(
        /above COPILOT_HOME .* can be changed by other users/,
      );
    },
  );

  it("refuses a recognised entry of the wrong type or behind a link", async () => {
    const root = await profile();
    await mkdir(join(root, "config.json"));
    await writeFile(join(root, "logs"), "x");
    const elsewhere = join(await profile(), "settings.json");
    await writeFile(elsewhere, "{}");
    await symlink(elsewhere, join(root, "settings.json"));
    await symlink(await profile(), join(root, "session-state"));
    expect(await copilotHomeProblems(root)).toEqual([
      "COPILOT_HOME config.json is not a file",
      "COPILOT_HOME logs is not a directory",
      "COPILOT_HOME session-state is a symbolic link",
      "COPILOT_HOME settings.json is a symbolic link",
    ]);
  });

  it.skipIf(process.platform === "win32")("refuses a recognised entry others can write", async () => {
    const root = await profile();
    await writeFile(join(root, "permissions-config.json"), "{}");
    await chmod(join(root, "permissions-config.json"), 0o666);
    await mkdir(join(root, "logs"));
    await chmod(join(root, "logs"), 0o777);
    expect(await copilotHomeProblems(root)).toEqual([
      "COPILOT_HOME logs can be written by other users",
      "COPILOT_HOME permissions-config.json can be written by other users",
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() !== 0)(
    "refuses an entry that belongs to another user",
    async () => {
      const root = await profile();
      await writeFile(join(root, "config.json"), "{}");
      await chown(join(root, "config.json"), 65534, 65534);
      expect(await copilotHomeProblems(root)).toEqual(["COPILOT_HOME config.json belongs to another user"]);
    },
  );

  it("refuses JSON whose top level is not an object", async () => {
    const root = await profile();
    await writeFile(join(root, "config.json"), "[]");
    await writeFile(join(root, "settings.json"), "null");
    expect(await copilotHomeProblems(root)).toEqual([
      "COPILOT_HOME config.json cannot be read",
      "COPILOT_HOME settings.json cannot be read",
    ]);
  });
});
