/**
 * Copilot CLI provider guard (#709): launch-profile refusals, the version pin, slash-command
 * prompts, allow-all/autopilot options and bounded "always" answers. No Copilot runs here; the
 * same checks against the real Copilot CLI are in copilot-cli-acceptance-709.test.ts.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec, type SessionConfigOption } from "@orca/core";
import {
  COPILOT_CLI_VERIFIED_VERSIONS,
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

const VERSION = COPILOT_CLI_VERIFIED_VERSIONS[0]!;
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

describe("version", () => {
  it("parses copilot --version", () => {
    expect(parseCopilotCliVersion("GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates.\n")).toBe(
      "1.0.114",
    );
    expect(parseCopilotCliVersion("something else")).toBeUndefined();
  });

  async function options(command: string): Promise<OpenSessionOptions> {
    return {
      host: new LocalHost({ id: "local", type: "local" }),
      agent: good({ command }),
      cwd: tmpdir(),
    };
  }
  async function executable(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orca-copilot-version-"));
    const path = join(dir, "copilot");
    await writeFile(path, "x");
    return path;
  }

  it("opens a verified version and refuses any other before the agent starts", async () => {
    const open = vi.fn(async () => fakeSession());
    const ok = withProviderGuards(open, [
      copilotCliGuard({ probe: async () => `GitHub Copilot CLI ${VERSION}.`, environment: () => ({}) }),
    ]);
    await ok(await options(await executable()));
    expect(open).toHaveBeenCalledOnce();

    const other = withProviderGuards(open, [
      copilotCliGuard({ probe: async () => "GitHub Copilot CLI 1.0.115.", environment: () => ({}) }),
    ]);
    await expect(other(await options(await executable()))).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("1.0.115"),
    });
    const silent = withProviderGuards(open, [copilotCliGuard({ probe: async () => "", environment: () => ({}) })]);
    await expect(silent(await options(await executable()))).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    const broken = withProviderGuards(open, [
      copilotCliGuard({
        probe: async () => {
          throw new Error("ENOENT");
        },
        environment: () => ({}),
      }),
    ]);
    await expect(broken(await options(await executable()))).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    expect(open).toHaveBeenCalledOnce();
  });

  it("refuses a bad profile without asking the executable anything", async () => {
    const probe = vi.fn(async () => `GitHub Copilot CLI ${VERSION}.`);
    const open = vi.fn(async () => fakeSession());
    const opts = await options(await executable());
    await expect(
      withProviderGuards(open, [copilotCliGuard({ probe, environment: () => ({}) })])({
        ...opts,
        agent: good({ args: ["--acp", "--yolo"] }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(probe).not.toHaveBeenCalled();
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
      copilotCliGuard({ probe: async () => `GitHub Copilot CLI ${VERSION}.`, environment: () => ({}) }),
    ])({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: good({ command: join(dir, "copilot") }),
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
