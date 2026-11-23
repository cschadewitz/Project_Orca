/**
 * The session factory installs ORCA's Claude pre-tool hook (#704): it hands every local
 * session a `sessionMeta` that, once the agent turns out to be the Claude ACP adapter at a
 * qualified version, writes the hook's context file into the store's private directory and
 * returns the settings that run the hook with it. The real adapter and Claude Code are in
 * `claude-hook-acceptance-704.test.ts`; this is the wiring around them, with no agent.
 */
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, SshHostSchema } from "@orca/core";
import {
  CLAUDE_HOOK_MIN_ADAPTER,
  LocalHost,
  SshHost,
  permissionPolicyPath,
  versionAtLeast,
  type AgentHost,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { makeSessionFactory, orcaProtectedPaths } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const CLAUDE = { name: "@agentclientprotocol/claude-agent-acp", version: CLAUDE_HOOK_MIN_ADAPTER };

/** A factory over a fake `open` that calls `sessionMeta` the way `openAcpSession` does. */
async function setup(
  agentInfo: { name: string; version: string } | undefined,
  agent: Record<string, unknown> = {},
  /** `null`: a build with no hook program. */
  script: string | null = "/opt/orca/claude-pre-tool-hook.mjs",
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-wiring-"));
  dirs.push(dir);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const seen: { options?: OpenSessionOptions; meta?: Record<string, unknown> | undefined } = {};
  const factory = makeSessionFactory(
    { configDir: dir, storeDir: ".orca" },
    async (options) => {
      seen.options = options;
      seen.meta = await options.sessionMeta?.(agentInfo);
      return { closed, close: async () => undefined } as unknown as AgentSession;
    },
    { runtime: "/usr/bin/node", script: script ?? undefined },
  );
  const open = (host: AgentHost = new LocalHost({ id: "local", type: "local" })) =>
    factory({
      host,
      agent: AgentSpecSchema.parse({
        id: "claude",
        command: "claude-agent-acp",
        nativeToolHook: "on",
        permissions: { rules: [{ match: { kind: "execute", titlePattern: "^ls$" }, decision: "allow" }] },
        ...agent,
      }),
      cwd: join(dir, "work"),
    });
  const hookDir = join(dir, ".orca", "private-execution", "tool-hooks");
  return { dir, open, seen, hookDir, resolveClosed };
}

describe("installing the hook", () => {
  it("writes a private context file and hands the adapter the settings that run the hook with it", async () => {
    const t = await setup(CLAUDE);
    const session = await t.open();
    const files = await readdir(t.hookDir);
    expect(files).toHaveLength(1);
    const file = join(t.hookDir, files[0]!);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      agentId: "claude",
      permissions: { rules: [{ match: { kind: "execute", titlePattern: "^ls$" }, decision: "allow" }] },
      permissionFiles: [permissionPolicyPath(t.dir)],
      workspaceCwd: join(t.dir, "work"),
      protectedPaths: orcaProtectedPaths({ configDir: t.dir, storeDir: ".orca" }),
    });
    // The context lives under a directory no agent may read (C4-01).
    expect(orcaProtectedPaths({ configDir: t.dir, storeDir: ".orca" }).noAccess).toContain(
      join(t.dir, ".orca", "private-execution"),
    );
    expect(t.seen.meta).toEqual({
      claudeCode: {
        options: {
          settings: {
            hooks: {
              PreToolUse: [
                {
                  matcher: "*",
                  hooks: [
                    {
                      type: "command",
                      command: "/usr/bin/node",
                      args: ["/opt/orca/claude-pre-tool-hook.mjs", file],
                      timeout: 10,
                      onFailure: "block",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    await session.close();
    expect(await readdir(t.hookDir)).toEqual([]);
  });

  it("removes the context file when the agent's connection ends without a close", async () => {
    const t = await setup(CLAUDE);
    await t.open();
    expect(await readdir(t.hookDir)).toHaveLength(1);
    t.resolveClosed();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readdir(t.hookDir)).toEqual([]);
  });

  it("sends nothing to an agent that is not the Claude adapter", async () => {
    const t = await setup({ name: "orca-scripted-agent", version: "1.0.0" });
    await t.open();
    expect(t.seen.meta).toBeUndefined();
    await expect(readdir(t.hookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an adapter older than the qualified minimum, and says how to opt out", async () => {
    const t = await setup({ name: CLAUDE.name, version: "0.95.0" });
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("nativeToolHook: on"),
    });
    await expect(readdir(t.hookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Claude session when the build has no hook program", async () => {
    const t = await setup(CLAUDE, {}, null);
    await expect(t.open()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("installs nothing unless the agent opts in, or for one on another host", async () => {
    for (const choice of [{ nativeToolHook: "off" }, { nativeToolHook: undefined }]) {
      const off = await setup(CLAUDE, choice);
      await off.open();
      expect(off.seen.options?.sessionMeta).toBeUndefined();
    }

    const remote = await setup(CLAUDE);
    await remote.open(new SshHost(SshHostSchema.parse({ id: "box", type: "ssh", host: "box.example" })));
    expect(remote.seen.options?.sessionMeta).toBeUndefined();
  });
});

describe("versionAtLeast", () => {
  it.each([
    ["0.109.1", "0.109.1", true],
    ["0.110.0", "0.109.1", true],
    ["1.0.0", "0.109.1", true],
    ["0.109.0", "0.109.1", false],
    ["0.95.9", "0.109.1", false],
    ["0.109.1-beta.1", "0.109.1", true],
    ["garbage", "0.109.1", false],
  ])("%s >= %s is %s", (v, min, expected) => {
    expect(versionAtLeast(v, min)).toBe(expected);
  });
});
