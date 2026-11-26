/**
 * ORCA's pre-tool hook on the Codex app-server route (#1161), against the real pinned
 * `codex app-server` and the shared model stand-in, when ORCA_CODEX_BIN names the pinned Codex
 * (skipped otherwise). The hook is the one the ACP route installs (#705), unchanged: the same
 * command, fail-closed line, trust hash, probe and context file, installed here through ORCA's
 * own `-c` session flags and checked with the app-server's `hooks/list`. The cases are the ACP
 * route's acceptance cases that apply to this driver (it takes no MCP servers, #1163):
 *
 * - Codex lists exactly ORCA's hook, trusted, and the session opens only once the hook has
 *   blocked the startup probe in the environment that app-server gives its hooks;
 * - a call ORCA allows runs, one a configured rule denies does not, one ORCA would ask about
 *   does not and nobody is asked, a rule added mid-session applies to the very next call, and a
 *   patch that touches ORCA's own files does not apply;
 * - hosted web search is not offered to the model;
 * - another hook beside ORCA's refuses the session before any thread starts.
 *
 * Codex's own runner still lets a call through when a hook fails to run; the fail-closed line
 * narrows that, as on the ACP route. Nothing here is a tier claim.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import {
  LocalHost,
  nativeToolHookSession,
  openCodexAppServerSession,
  permissionPolicyPath,
  readPermissionPolicyFile,
  replacePermissionPolicyFile,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { orcaProtectedPaths } from "../src/bootstrap.js";
import { codexAppServerSessionOptions } from "../src/codex-app-server-factory.js";
import { modelStandIn, patch, script, shell, type ModelStandIn } from "./codex-model-stand-in.js";

type AskRequest = Parameters<NonNullable<OpenSessionOptions["askPermission"]>>[0];
const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("ORCA's hook on the Codex app-server route, against the real pinned Codex", () => {
  let model: ModelStandIn;
  let hookScript: string;
  let root: string;
  let configDir: string;
  let workspace: string;
  let codexHome: string;
  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("codex-app-server-hook-1161", { entries: { hook: entry } })?.["hook"];
    if (!built) throw new Error("the hook program could not be built for this run");
    hookScript = built;
  });
  afterAll(() => model?.server.close());
  beforeEach(async () => {
    // Not under /tmp: Codex's workspace-write sandbox can write /tmp and $TMPDIR, so ORCA's files
    // there would overlap a writable root and the session would be refused (#1160).
    root = await realpath(await mkdtemp(join(homedir(), ".orca-1161-")));
    configDir = join(root, "config");
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(configDir);
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      [
        `model = "gpt-5.5"`,
        `model_provider = "standin"`,
        `[model_providers.standin]`,
        `name = "standin"`,
        `base_url = "${model.url}"`,
        `wire_api = "responses"`,
        `env_key = "ORCA_1161_KEY"`,
      ].join("\n") + "\n",
    );
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const asked: AskRequest[] = [];
  const open = async (permissions: unknown = { rules: [] }, args: string[] = []): Promise<AgentSession> => {
    const agent = AgentSpecSchema.parse({
      id: "codex",
      command: CODEX,
      args,
      driver: "codex-app-server",
      env: { CODEX_HOME: codexHome, ORCA_1161_KEY: "sk-orca-1161-test", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      permissions,
    });
    const layout = { configDir, storeDir: ".orca" };
    const protectedPaths = orcaProtectedPaths(layout);
    const hook = nativeToolHookSession({
      agentId: agent.id,
      permissions: agent.permissions,
      permissionFiles: [permissionPolicyPath(configDir)],
      workspaceCwd: workspace,
      protectedPaths,
      contextDir: join(configDir, "hook-context"),
      runtime: process.execPath,
      script: hookScript,
      agentEnv: { ...process.env, ...(agent.env as Record<string, string>) },
    });
    const { env } = await hook.prepare();
    const session = await openCodexAppServerSession({
      ...codexAppServerSessionOptions(
        {
          host: new LocalHost({ id: "local", type: "local" }),
          agent,
          cwd: workspace,
          env,
          logger: silentLogger,
          permissionFiles: [permissionPolicyPath(configDir)],
          protectedPaths,
          askPermission: async (req) => (asked.push(req), "decline"),
        },
        "0.0.0-test",
      ),
      nativeToolHook: hook.codexAppServer(),
    }).catch(async (error: unknown) => {
      await hook.cleanup();
      throw error;
    });
    expect(hook.status()).toBe("codex");
    const close = session.close.bind(session);
    session.close = async () => {
      await close();
      await hook.cleanup();
    };
    return session;
  };
  const exists = (name: string) =>
    readFile(join(workspace, name), "utf8").then(
      (t) => t,
      () => undefined,
    );

  it("runs a call ORCA allows and blocks one a configured rule denies", async () => {
    asked.length = 0;
    const session = await open({
      rules: [
        { match: { kind: "execute", titlePattern: "^echo orca-1161 >> " }, decision: "allow" },
        { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" },
      ],
    });
    try {
      await session.prompt(script(shell("echo orca-1161 >> allowed.txt"), shell("echo denied >> denied.txt")), {
        timeoutMs: 60_000,
      });
      expect(await exists("allowed.txt")).toBe("orca-1161\n");
      expect(await exists("denied.txt")).toBeUndefined();
      expect(asked).toEqual([]);
      expect(model.outputs.some((o) => o.includes("Denied by ORCA"))).toBe(true);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("offers the model the hooked tools, and not hosted web search", async () => {
    model.tools.clear();
    const session = await open();
    try {
      await session.prompt(script(), { timeoutMs: 60_000 });
      expect([...model.tools]).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]));
      expect([...model.tools]).not.toContain("web_search");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("blocks a call ORCA would ask about, without asking anybody", async () => {
    asked.length = 0;
    const session = await open({ default: "ask", rules: [] });
    try {
      await session.prompt(script(shell("echo asked >> asked.txt")), { timeoutMs: 60_000 });
      expect(await exists("asked.txt")).toBeUndefined();
      expect(asked).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("blocks the very next call once a rule is added to the live permission file", async () => {
    asked.length = 0;
    const session = await open({
      rules: [{ match: { kind: "execute", titlePattern: "^echo orca-1161 >> revoked\\.txt$" }, decision: "allow" }],
    });
    try {
      await session.prompt(script(shell("echo orca-1161 >> revoked.txt")), { timeoutMs: 60_000 });
      expect(await exists("revoked.txt")).toBe("orca-1161\n");
      const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
      await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
        ...doc,
        agents: { codex: { rules: [{ match: { kind: "execute", command: "echo" }, decision: "ask" }] } },
      });
      await session.prompt(script(shell("echo orca-1161 >> revoked.txt")), { timeoutMs: 60_000 });
      expect(await exists("revoked.txt")).toBe("orca-1161\n");
      expect(asked).toEqual([]);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("applies a patch ORCA allows, and not one that touches ORCA's own files", async () => {
    const session = await open({ rules: [{ match: { kind: "edit", scope: "workspace" }, decision: "allow" }] });
    try {
      await session.prompt(script(patch("*** Add File: patched.txt", "+orca-1161")), { timeoutMs: 60_000 });
      expect(await exists("patched.txt")).toBe("orca-1161\n");
      await session.prompt(
        script(patch("*** Add File: second.txt", "+x", `*** Add File: ${permissionPolicyPath(configDir)}`, "+{}")),
        { timeoutMs: 60_000 },
      );
      expect(await exists("second.txt")).toBeUndefined();
      expect(await readFile(permissionPolicyPath(configDir), "utf8").catch(() => undefined)).toBeUndefined();
    } finally {
      await session.close();
    }
  }, 180_000);

  it("refuses the session when another hook would run beside ORCA's", async () => {
    const other = "cat >/dev/null; exit 0";
    const error = (await open({ rules: [] }, [
      "-c",
      `hooks.PostToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(other)},timeout=30}]}]`,
    ]).catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.details).toMatchObject({ setting: "hooks" });
    expect(error.message).toMatch(/Codex would run the hook postToolUse \(sessionFlags\)/);
  }, 120_000);
});
