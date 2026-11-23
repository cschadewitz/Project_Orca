/**
 * Cline CLI ACP: ORCA's provider guard, offline (#711).
 *
 * ORCA's real `openAcpSession`, wrapped by the real `withProviderGuards`, is driven against
 * `ScriptedClinePeer`, an in-memory Cline-shaped agent. These pin ORCA's half: what a launch
 * must look like, what a permission ask is rewritten to before the policy reads it, and what the
 * session refuses. The installed Cline is exercised by `cline-acp-711.acceptance.test.ts`.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec } from "@orca/core";
import {
  CLINE_CLI_VERIFIED_IMAGES,
  CLINE_CLI_VERIFIED_VERSIONS,
  clineImageProblems,
  clinePlatform,
  clineFileProblems,
  clineGuard,
  clineProfileProblems,
  isClineAgent,
  normalizeClinePermissionRequest,
  openAcpSession,
  providerGuards,
  withProviderGuards,
  type AgentSession,
} from "@orca/agents";
import {
  CLINE_INITIALIZE_RESULT,
  CLINE_VERSION,
  ScriptedClinePeer,
  clineConfigOptions,
  outcome,
  scriptedClineHost,
} from "./fixtures/cline-acp.js";

/** The executable in these tests is a placeholder file: its digest is the verified one. */
const pinnedImage = {
  platform: "linux-x64",
  digest: async () => CLINE_CLI_VERIFIED_IMAGES[CLINE_VERSION]!["linux-x64"]!,
};

let root: string;
let workspace: string;
let home: string;
let configDir: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-cline-711-"));
  workspace = join(root, "work");
  home = join(root, "home");
  configDir = join(root, "cline-config");
  await Promise.all([workspace, home, configDir].map((d) => mkdir(d, { recursive: true })));
  await mkdir(join(workspace, ".git"));
  bin = join(root, "bin", "cline");
  await mkdir(join(root, "bin"));
  await writeFile(bin, "placeholder");
});

function spec(over: Partial<Record<keyof AgentSpec, unknown>> = {}): AgentSpec {
  return AgentSpecSchema.parse({
    id: "cline",
    command: bin,
    args: ["--acp", "--config", configDir],
    env: { CLINE_SESSION_BACKEND_MODE: "local", CLINE_NO_AUTO_UPDATE: "1", HOME: home },
    ...over,
  });
}

const open: AgentSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
});

async function connect(
  peer: ScriptedClinePeer,
  extra: Partial<Parameters<typeof openAcpSession>[0]> = {},
  agent: AgentSpec = spec(),
) {
  const fake = scriptedClineHost(peer);
  const opened = withProviderGuards(openAcpSession, [clineGuard(() => home, pinnedImage)]);
  const session = await opened({ host: fake.host, agent, cwd: workspace, exitGraceMs: 50, ...extra });
  open.push(session);
  return { session, ...fake };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("recognition", () => {
  it("is the registered guard for a cline executable and nothing else", () => {
    expect(providerGuards().map((g) => g.id)).toContain("cline");
    expect(isClineAgent(spec())).toBe(true);
    expect(isClineAgent(spec({ command: "C:\\Tools\\cline.exe" }))).toBe(true);
    expect(isClineAgent(spec({ command: "/usr/bin/npx", args: ["cline@3.0.75", "--acp"] }))).toBe(true);
    expect(isClineAgent(spec({ command: "/usr/bin/codex-acp" }))).toBe(false);
    expect(isClineAgent(spec({ command: "/usr/bin/clinestuff" }))).toBe(false);
    expect(CLINE_CLI_VERIFIED_VERSIONS).toEqual([CLINE_VERSION]);
  });
});

describe("launch profile", () => {
  it("accepts the documented profile", () => {
    expect(clineProfileProblems(spec(), {}, "local")).toEqual([]);
    expect(
      clineProfileProblems(
        spec({ args: ["--acp", `--config=${configDir}`, "--thinking", "--reasoning-effort", "low"] }),
        {},
        "local",
      ),
    ).toEqual([]);
  });

  it.each([
    [{ args: ["--acp", "--config", "/c", "--yolo"] }, "args: --yolo approves tools without asking ORCA"],
    [{ args: ["--acp", "--config", "/c", "-y"] }, "args: -y approves tools without asking ORCA"],
    [
      { args: ["--acp", "--config", "/c", "--auto-approve", "true"] },
      "args: --auto-approve approves tools without asking ORCA",
    ],
    [{ args: ["--acp", "--config", "/c", "--hooks-dir", "/h"] }, "args: --hooks-dir is not supported"],
    [{ args: ["--acp", "--config", "/c", "--data-dir", "/d"] }, "args: --data-dir is not supported"],
    [{ args: ["--acp", "--config", "/c", "--worktree"] }, "args: --worktree is not supported"],
    [{ args: ["--config", "/c"] }, "args: --acp is missing"],
    [{ args: ["--acp"] }, "args: add --config"],
    [{ args: ["--acp", "--config", "relative/dir"] }, "args: add --config"],
    [{ command: "cline" }, "command: give the cline executable as an absolute path"],
    [
      { command: "/usr/bin/npx", args: ["cline@3.0.75", "--acp", "--config", "/c"] },
      "command: start the cline executable itself",
    ],
    [{ mcpServers: [{ name: "t", command: "/bin/t" }] }, "mcpServers: Cline ignores MCP servers"],
  ])("refuses %j", (over, problem) => {
    expect(clineProfileProblems(spec(over), {}, "local").join("\n")).toContain(problem);
  });

  it("refuses another host", () => {
    expect(clineProfileProblems(spec(), {}, "ssh").join("\n")).toContain(
      "host: Cline is supported on this computer only",
    );
  });

  it("requires the local backend and auto-update off, whoever sets them", () => {
    const env = { HOME: home };
    expect(clineProfileProblems(spec({ env }), {}, "local")).toEqual([
      'env: set CLINE_SESSION_BACKEND_MODE to "local"',
      'env: set CLINE_NO_AUTO_UPDATE to "1"',
    ]);
    expect(
      clineProfileProblems(spec({ env }), { CLINE_SESSION_BACKEND_MODE: "local", CLINE_NO_AUTO_UPDATE: "1" }, "local"),
    ).toEqual([]);
    expect(
      clineProfileProblems(
        spec({ env: { ...env, CLINE_SESSION_BACKEND_MODE: "hub", CLINE_NO_AUTO_UPDATE: "1" } }),
        {},
        "local",
      ),
    ).toEqual(['env: set CLINE_SESSION_BACKEND_MODE to "local"']);
  });

  it("refuses every other CLINE_ variable, configured or inherited", () => {
    const configured = spec({
      env: { CLINE_SESSION_BACKEND_MODE: "local", CLINE_NO_AUTO_UPDATE: "1", CLINE_DATA_DIR: "/elsewhere" },
    });
    expect(clineProfileProblems(configured, {}, "local")).toEqual([
      "env: CLINE_DATA_DIR is not supported; it moves Cline's state, settings or servers outside what ORCA checked",
    ]);
    expect(clineProfileProblems(spec(), { CLINE_MCP_SETTINGS_PATH: "/x.json" }, "local")).toEqual([
      "env: CLINE_MCP_SETTINGS_PATH is not supported (inherited from the daemon's environment); it moves Cline's state, settings or servers outside what ORCA checked",
    ]);
    // Provider and model choices are fine.
    expect(clineProfileProblems(spec(), { CLINE_PROVIDER: "openai-compatible", CLINE_MODEL: "m" }, "local")).toEqual(
      [],
    );
  });

  it("takes the API key only as a secret reference", () => {
    const base = { CLINE_SESSION_BACKEND_MODE: "local", CLINE_NO_AUTO_UPDATE: "1" };
    expect(clineProfileProblems(spec({ env: { ...base, CLINE_API_KEY: "sk-literal" } }), {}, "local")).toEqual([
      "env: CLINE_API_KEY is written into ORCA's config; refer to it as a secret instead",
    ]);
    expect(
      clineProfileProblems(spec({ env: { ...base, CLINE_API_KEY: { secret: "cline-key" } } }), {}, "local"),
    ).toEqual([]);
    expect(clineProfileProblems(spec({ env: base }), { CLINE_API_KEY: "sk-ambient" }, "local")[0]).toContain(
      "CLINE_API_KEY is inherited from the daemon's environment",
    );
  });
});

describe("code Cline would run without asking", () => {
  it("finds nothing in a clean launch", () => {
    expect(clineFileProblems(configDir, workspace, home)).toEqual([]);
  });

  it.each([
    [".cline/hooks", "hooks"],
    [".clinerules/hooks", "hooks"],
    [".cline/plugins", "plugins"],
  ])("refuses a workspace %s", async (dir, what) => {
    await mkdir(join(workspace, dir), { recursive: true });
    await writeFile(join(workspace, dir, "PreToolUse"), "#!/bin/sh\n");
    expect(clineFileProblems(configDir, workspace, home)).toEqual([
      `files: ${join(workspace, dir)} holds Cline ${what}, which run without asking ORCA`,
    ]);
  });

  it("looks up to the repository root, as Cline does", async () => {
    const sub = join(workspace, "packages", "a");
    await mkdir(sub, { recursive: true });
    await mkdir(join(workspace, ".cline", "hooks"), { recursive: true });
    await writeFile(join(workspace, ".cline", "hooks", "x"), "");
    expect(clineFileProblems(configDir, sub, home)).toHaveLength(1);
  });

  it("refuses hooks and plugins in the config directory and the home directory", async () => {
    for (const dir of [
      join(configDir, "plugins"),
      join(home, "Documents", "Cline", "Hooks"),
      join(home, ".agents", "plugins"),
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "x.js"), "");
    }
    // The config directory's `plugins` is refused twice: as plugins, and as an entry beside `data`.
    expect(clineFileProblems(configDir, workspace, home)).toHaveLength(4);
  });

  it("refuses Cline's own MCP servers, and an unreadable settings file", async () => {
    const settings = join(configDir, "data", "settings");
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: {} }));
    expect(clineFileProblems(configDir, workspace, home)).toEqual([]);
    await writeFile(join(settings, "cline_mcp_settings.json"), JSON.stringify({ mcpServers: { s: { command: "x" } } }));
    expect(clineFileProblems(configDir, workspace, home)[0]).toContain("configures MCP servers for Cline");
    await writeFile(join(settings, "cline_mcp_settings.json"), "{not json");
    expect(clineFileProblems(configDir, workspace, home)).toHaveLength(1);
  });
});

describe("Cline's config directory, deny by default", () => {
  it("accepts its state under data and the settings ORCA checks", async () => {
    const settings = join(configDir, "data", "settings");
    await mkdir(join(configDir, "data", "sessions"), { recursive: true });
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, "providers.json"), "{}");
    await writeFile(join(settings, "global-settings.json"), JSON.stringify({ telemetryOptOut: true }));
    expect(clineFileProblems(configDir, workspace, home)).toEqual([]);
  });

  it.each(["rules", "skills", "workflows", "agents", "cron", "tasks", "notes.txt"])(
    "refuses %s beside data",
    async (entry) => {
      await mkdir(join(configDir, entry), { recursive: true });
      expect(clineFileProblems(configDir, workspace, home)).toEqual([
        `files: ${join(configDir, entry)} is not something ORCA lets Cline load; remove it`,
      ]);
    },
  );

  it("refuses a settings file it does not check, and a global toolAutoApprove", async () => {
    const settings = join(configDir, "data", "settings");
    await mkdir(settings, { recursive: true });
    await writeFile(join(settings, "connectors.json"), "{}");
    await writeFile(join(settings, "global-settings.json"), JSON.stringify({ toolAutoApprove: true }));
    expect(clineFileProblems(configDir, workspace, home)).toEqual([
      `files: ${join(settings, "connectors.json")} is a Cline setting ORCA does not check; remove it`,
      `files: ${join(settings, "global-settings.json")} turns toolAutoApprove on; turn it off`,
    ]);
  });

  it("refuses Cline's default directory and one inside the workspace", async () => {
    const shared = join(home, ".cline");
    await mkdir(join(shared, "data"), { recursive: true });
    expect(clineFileProblems(shared, workspace, home)[0]).toContain("is Cline's own default directory");
    expect(clineFileProblems(home, workspace, home)[0]).toContain("is Cline's own default directory");
    const inside = join(workspace, "cline-config");
    await mkdir(inside);
    expect(clineFileProblems(inside, workspace, home)[0]).toContain("is inside the workspace");
    expect(clineFileProblems(configDir, workspace, home)).toEqual([]);
  });

  it("refuses a config directory that is not there", () => {
    expect(clineFileProblems(join(root, "missing"), workspace, home)[0]).toContain("cannot be read");
  });
});

describe("the executable", () => {
  it("opens only a verified build for this platform", async () => {
    const fake = join(root, "cline");
    await writeFile(fake, "not cline");
    expect(await clineImageProblems(fake, "linux-x64")).toEqual([
      expect.stringContaining("is not a Cline CLI build ORCA has verified"),
    ]);
    const pinned = CLINE_CLI_VERIFIED_IMAGES[CLINE_VERSION]!["linux-x64"]!;
    const bin2 = join(root, "cline2");
    await writeFile(bin2, "pretend");
    expect(await clineImageProblems(bin2, "linux-x64", async () => pinned)).toEqual([]);
    expect(await clineImageProblems(bin2, "plan9-mips", async () => pinned)).toEqual([
      "platform: ORCA has verified no Cline CLI build for plan9-mips",
    ]);
    expect((await clineImageProblems(join(root, "absent"), "linux-x64"))[0]).toContain("cannot be read");
    expect(clinePlatform("win32", "x64")).toBe("windows-x64");
    expect(Object.keys(CLINE_CLI_VERIFIED_IMAGES)).toEqual([...CLINE_CLI_VERIFIED_VERSIONS]);
  });

  it("refuses a swapped binary before starting anything", async () => {
    const peer = new ScriptedClinePeer();
    const fake = scriptedClineHost(peer);
    const opened = withProviderGuards(openAcpSession, [
      clineGuard(() => home, { platform: "linux-x64", digest: async () => "0".repeat(64) }),
    ]);
    await writeFile(join(root, "placeholder"), "");
    await expect(
      opened({
        host: fake.host,
        agent: spec({ command: join(root, "placeholder").replace("placeholder", "cline") }),
        cwd: workspace,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});

describe("what an ask says", () => {
  const ask = (title: string, rawInput: unknown, kind: acp.ToolKind = "other"): acp.RequestPermissionRequest => ({
    sessionId: "s",
    toolCall: { toolCallId: "t", title, kind, rawInput },
    options: [],
  });
  const cwd = "/w";

  it("gives an edit its file", () => {
    expect(
      normalizeClinePermissionRequest(ask("editor: a.txt", { path: "a.txt", new_text: "x" }, "edit"), cwd).toolCall,
    ).toMatchObject({
      kind: "edit",
      locations: [{ path: "/w/a.txt" }],
    });
    expect(
      normalizeClinePermissionRequest(ask("editor: /abs/b", { path: "/abs/b", new_text: "" }, "edit"), cwd).toolCall
        .locations,
    ).toEqual([{ path: "/abs/b" }]);
  });

  it.each([
    [{ files: [{ path: "/w/a" }, { path: "b", start_line: 2 }] }, ["/w/a", "/w/b"]],
    [{ files: "/w/a" }, ["/w/a"]],
    [{ file_paths: ["/w/a", "/w/c"] }, ["/w/a", "/w/c"]],
    [{ paths: [{ file_path: "/w/a" }] }, ["/w/a"]],
    [
      ["/w/a", "/w/b"],
      ["/w/a", "/w/b"],
    ],
    ["/w/a", ["/w/a"]],
    [{ path: "/w/a" }, ["/w/a"]],
  ])("gives a read its files: %j", (input, paths) => {
    expect(normalizeClinePermissionRequest(ask("read_files", input, "read"), cwd).toolCall).toMatchObject({
      kind: "read",
      locations: paths.map((path) => ({ path })),
    });
  });

  it.each([
    [{ commands: ["git status", "rm -rf build"] }, "git status ; rm -rf build"],
    [{ commands: [{ command: "rm", args: ["-rf", "my dir"] }] }, "rm -rf 'my dir'"],
    [{ command: "ls" }, "ls"],
    [{ cmd: "ls -la" }, "ls -la"],
    ["echo hi", "echo hi"],
    [[{ command: "ls" }], "ls"],
  ])("gives a command its text: %j", (input, command) => {
    const tc = normalizeClinePermissionRequest(ask("run_commands: x", input, "execute"), cwd).toolCall;
    expect(tc.kind).toBe("execute");
    expect((tc.rawInput as { command: string }).command).toBe(command);
  });

  it("gives a patch its files", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: /w/new.ts\n+z\n*** End Patch";
    expect(normalizeClinePermissionRequest(ask("apply_patch", { input: patch }), cwd).toolCall).toMatchObject({
      kind: "edit",
      locations: [{ path: "/w/src/a.ts" }, { path: "/w/new.ts" }],
    });
    expect(normalizeClinePermissionRequest(ask("apply_patch", "*** Delete File: old.ts"), cwd).toolCall).toMatchObject({
      kind: "delete",
      locations: [{ path: "/w/old.ts" }],
    });
  });

  it("reports what it cannot read, and a sub-agent, as kind other", () => {
    expect(normalizeClinePermissionRequest(ask("editor", { new_text: "x" }, "edit"), cwd).toolCall.kind).toBe("other");
    expect(
      normalizeClinePermissionRequest(ask("read_files", { files: [{ nope: 1 }] }, "read"), cwd).toolCall.kind,
    ).toBe("other");
    expect(normalizeClinePermissionRequest(ask("run_commands", { commands: [] }, "execute"), cwd).toolCall.kind).toBe(
      "other",
    );
    expect(normalizeClinePermissionRequest(ask("apply_patch", { input: "garbage" }), cwd).toolCall.kind).toBe("other");
    expect(normalizeClinePermissionRequest(ask("spawn_agent: review", { task: "x" }, "think"), cwd).toolCall.kind).toBe(
      "other",
    );
  });

  it("leaves other tools, and a request that already has locations, as they are", () => {
    const search = ask("search_codebase: foo", { queries: ["foo"] }, "search");
    expect(normalizeClinePermissionRequest(search, cwd)).toBe(search);
    const located = { ...ask("editor", { path: "x" }, "edit") };
    located.toolCall = { ...located.toolCall, locations: [{ path: "/w/y" }] };
    expect(normalizeClinePermissionRequest(located, cwd)).toBe(located);
  });
});

describe("the session, through ORCA's policy", () => {
  function onPrompt(peer: ScriptedClinePeer, run: (p: ScriptedClinePeer) => Promise<unknown>) {
    const answers: ReturnType<typeof outcome>[] = [];
    peer.handle("session/prompt", (m, p) => {
      void run(p).then((r) => {
        for (const a of [r].flat()) answers.push(outcome(a as Parameters<typeof outcome>[0]));
        p.reply(m.id!, { stopReason: "end_turn" });
      });
    });
    return answers;
  }

  it("allows an edit inside the workspace once, by the default policy", async () => {
    const peer = new ScriptedClinePeer();
    const answers = onPrompt(peer, (p) =>
      p.askTool("editor", { path: "notes.txt", new_text: "hi" }, "notes.txt", "edit"),
    );
    const { session } = await connect(peer);
    await session.prompt("go");
    expect(answers).toEqual([{ outcome: "selected", optionId: "allow_once" }]);
  });

  it("refuses an edit that would plant a Cline hook for the next session", async () => {
    const peer = new ScriptedClinePeer();
    const answers = onPrompt(peer, (p) =>
      p.askTool(
        "editor",
        { path: ".cline/hooks/PreToolUse", new_text: "#!/bin/sh" },
        ".cline/hooks/PreToolUse",
        "edit",
      ),
    );
    const { session } = await connect(peer);
    await session.prompt("go");
    expect(answers).toEqual([{ outcome: "selected", optionId: "reject_once" }]);
  });

  it("refuses a read of Cline's own credentials", async () => {
    const peer = new ScriptedClinePeer();
    const answers = onPrompt(peer, (p) =>
      p.askTool(
        "read_files",
        { files: [{ path: join(configDir, "data", "settings", "providers.json") }] },
        "providers.json",
        "read",
      ),
    );
    const { session } = await connect(peer);
    await session.prompt("go");
    expect(answers).toEqual([{ outcome: "selected", optionId: "reject_once" }]);
  });

  it("asks about a command with its text, and answers 'always' as once", async () => {
    const peer = new ScriptedClinePeer();
    const answers = onPrompt(peer, (p) =>
      p.askTool("run_commands", { commands: ["touch made.txt"] }, "touch made.txt", "execute"),
    );
    const seen: acp.RequestPermissionRequest[] = [];
    const { session } = await connect(peer, {
      askPermission: async (request) => {
        seen.push(request);
        return "allow_always";
      },
    });
    await session.prompt("go");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolCall).toMatchObject({ kind: "execute", rawInput: { command: "touch made.txt" } });
    expect(answers).toEqual([{ outcome: "selected", optionId: "allow_once" }]);
  });

  it("refuses a sub-agent, and any tool outside Cline's own, without asking anyone", async () => {
    for (const tool of ["spawn_agent", "ux_verifier", "team_spawn_teammate", "reviewer", ""]) {
      const peer = new ScriptedClinePeer();
      const answers = onPrompt(peer, (p) => p.askTool(tool, { task: "x" }, "x", "think"));
      const asked = vi.fn(async () => "allow_once");
      // Even a rule that allows everything does not reach it.
      const { session } = await connect(peer, { askPermission: asked }, spec({ permissions: { default: "allow" } }));
      await session.prompt("go");
      expect(asked).not.toHaveBeenCalled();
      expect(answers).toEqual([{ outcome: "selected", optionId: "reject_once" }]);
      await session.close();
    }
  });

  it("fails the handshake for another version or another agent", async () => {
    for (const agentInfo of [
      { name: "cline", version: "3.0.76" },
      { name: "not-cline", version: CLINE_VERSION },
      undefined,
    ]) {
      const peer = new ScriptedClinePeer({ initialize: { ...CLINE_INITIALIZE_RESULT, agentInfo } });
      const fake = scriptedClineHost(peer);
      const opened = withProviderGuards(openAcpSession, [clineGuard(() => home, pinnedImage)]);
      await expect(opened({ host: fake.host, agent: spec(), cwd: workspace, exitGraceMs: 50 })).rejects.toThrow(
        /ORCA opens only Cline CLI 3\.0\.75/,
      );
      expect(peer.sent("session/new")).toHaveLength(0);
    }
  });

  it("refuses a session that opens with auto-approve on", async () => {
    const peer = new ScriptedClinePeer({ autoApprove: true });
    await expect(connect(peer)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("never turns auto-approve on, and ends a session that reports it on", async () => {
    const peer = new ScriptedClinePeer();
    peer.handle("session/prompt", () => undefined);
    const { session, kill } = await connect(peer);
    await expect(session.setConfigOption("auto_approve", true)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(session.setConfigOption("auto_approve", "true")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(peer.sent("session/set_config_option")).toHaveLength(0);
    await session.setConfigOption("auto_approve", false);
    await session.setConfigOption("mode", "plan");
    peer.update({ sessionUpdate: "config_option_update", configOptions: clineConfigOptions(true) });
    await settle();
    await expect(session.prompt("go")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await settle();
    expect(kill).toHaveBeenCalled();
  });

  it("refuses before starting anything when the launch is wrong", async () => {
    await mkdir(join(workspace, ".cline", "plugins"), { recursive: true });
    await writeFile(join(workspace, ".cline", "plugins", "p.js"), "");
    const peer = new ScriptedClinePeer();
    const fake = scriptedClineHost(peer);
    const opened = withProviderGuards(openAcpSession, [clineGuard(() => home, pinnedImage)]);
    await expect(opened({ host: fake.host, agent: spec(), cwd: workspace })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(
      opened({ host: fake.host, agent: spec({ args: ["--acp", "--config", configDir, "--yolo"] }), cwd: root }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
