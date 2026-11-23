/**
 * The session factory installs ORCA's Claude pre-tool hook (#704): it hands every local
 * session of an opted-in agent a `sessionMeta` that, once the agent turns out to be the Claude
 * ACP adapter at a verified version, writes the hook's context file into the store's private
 * directory and returns the settings that run the hook with it. Every opted-in session it
 * cannot guard is refused, never opened without the hook. The real adapter and Claude Code are in
 * `claude-hook-acceptance-704.test.ts`; this is the wiring around them, with no agent.
 */
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, SshHostSchema } from "@orca/core";
import {
  CLAUDE_HOOK_VERIFIED_ADAPTERS,
  LocalHost,
  runClaudeRuntimeAttestation,
  SshHost,
  permissionPolicyPath,
  type AgentHost,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { makeSessionFactory, orcaProtectedPaths } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const CLAUDE = { name: "@agentclientprotocol/claude-agent-acp", version: CLAUDE_HOOK_VERIFIED_ADAPTERS[0]! };

/** A factory over a fake `open` that calls `sessionMeta` the way `openAcpSession` does. */
async function setup(
  agentInfo: { name: string; version: string } | undefined,
  agent: Record<string, unknown> = {},
  /** `null`: a build with no hook program. */
  script: string | null = "/opt/orca/claude-pre-tool-hook.mjs",
  platform: NodeJS.Platform = "linux",
  /**
   * What the runtime reports when the session starts: the executable that ran the
   * attestation and the version it says it is; `null`, nothing (the attestation never ran).
   */
  runtime: { executable: string; version: string } | null = { executable: "/opt/claude/claude", version: "2.1.330" },
) {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-wiring-"));
  dirs.push(dir);
  let opened = 0;
  let closedByFactory = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const seen: { options?: OpenSessionOptions; meta?: Record<string, unknown> | undefined } = {};
  const factory = makeSessionFactory(
    { configDir: dir, storeDir: ".orca" },
    async (options) => {
      opened++;
      seen.options = options;
      seen.meta = await options.sessionMeta?.(agentInfo);
      // Claude Code runs the session-start attestation before `session/new` returns.
      const attest = (
        seen.meta as {
          claudeCode?: { options?: { settings?: { hooks?: { SessionStart?: { hooks: { args: string[] }[] }[] } } } };
        }
      )?.claudeCode?.options?.settings?.hooks?.SessionStart?.[0]?.hooks[0]?.args;
      if (attest && runtime) {
        const r = await runClaudeRuntimeAttestation(
          attest.slice(1),
          JSON.stringify({ hook_event_name: "SessionStart" }),
          {
            pid: 1,
            executable: async () => runtime.executable,
          },
        );
        expect(r.exitCode).toBe(0);
      }
      return {
        closed,
        close: async () => {
          closedByFactory++;
        },
      } as unknown as AgentSession;
    },
    {
      runtime: "/usr/bin/node",
      script: script ?? undefined,
      platform,
      runtimeVersion: async (executable) =>
        runtime && executable === runtime.executable && !executable.startsWith("/opt/other/")
          ? { version: runtime.version }
          : { error: "no such program" },
    },
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
  return { dir, open, seen, hookDir, resolveClosed, opened: () => opened, closedByFactory: () => closedByFactory };
}

describe("installing the hook", () => {
  it("writes a private context file and hands the adapter the settings that run the hook with it", async () => {
    const t = await setup(CLAUDE);
    const session = await t.open();
    const files = (await readdir(t.hookDir)).filter((f) => !f.endsWith(".runtime.json"));
    expect(files).toHaveLength(1);
    const file = join(t.hookDir, files[0]!);
    expect(await readdir(t.hookDir)).toContain(`${files[0]!}.runtime.json`);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      agentId: "claude",
      permissions: { rules: [{ match: { kind: "execute", titlePattern: "^ls$" }, decision: "allow" }] },
      permissionFiles: [permissionPolicyPath(t.dir)],
      workspaceCwd: join(t.dir, "work"),
      protectedPaths: {
        ...orcaProtectedPaths({ configDir: t.dir, storeDir: ".orca" }),
        // The hook program itself is read-only to the agent's native tools.
        readOnly: [
          ...orcaProtectedPaths({ configDir: t.dir, storeDir: ".orca" }).readOnly,
          "/opt/orca/claude-pre-tool-hook.mjs",
        ],
      },
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
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "/usr/bin/node",
                      args: ["/opt/orca/claude-pre-tool-hook.mjs", "--attest", file],
                      timeout: 10,
                    },
                  ],
                },
              ],
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
    expect(await readdir(t.hookDir)).toHaveLength(2);
    t.resolveClosed();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readdir(t.hookDir)).toEqual([]);
  });

  it.each([
    ["another adapter", { name: "orca-scripted-agent", version: "1.0.0" }, "does not take ORCA's hook"],
    ["an agent that does not say who it is", undefined, "did not say"],
    [
      "a Claude adapter older than the verified one",
      { name: "@agentclientprotocol/claude-agent-acp", version: "0.95.0" },
      "verified the hook only with",
    ],
    [
      "a Claude adapter newer than the verified one",
      { name: "@agentclientprotocol/claude-agent-acp", version: "9.0.0" },
      "verified the hook only with",
    ],
  ])("refuses %s, writes nothing, and says how to opt out", async (_what, info, why) => {
    const t = await setup(info);
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(new RegExp(`${why}[\\s\\S]*nativeToolHook: on`)),
    });
    await expect(readdir(t.hookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["did not report itself", null, "did not report itself"],
    [
      "is another Claude Code",
      { executable: "/opt/claude/claude", version: "2.1.329" },
      "Claude Code 2.1.329 under adapter",
    ],
    ["cannot say its version", { executable: "/opt/other/claude", version: "2.1.330" }, "could not read the version"],
  ] as const)("refuses the started session, before any work, when the runtime %s", async (_what, runtime, why) => {
    const t = await setup(CLAUDE, {}, "/opt/orca/claude-pre-tool-hook.mjs", "linux", runtime);
    await expect(t.open()).rejects.toMatchObject({ code: "NOT_SUPPORTED", message: expect.stringContaining(why) });
    expect(t.opened()).toBe(1);
    expect(t.closedByFactory()).toBe(1);
    expect(await readdir(t.hookDir)).toEqual([]);
  });

  it("refuses a platform the acceptance test does not cover", async () => {
    const t = await setup(CLAUDE, {}, "/opt/orca/claude-pre-tool-hook.mjs", "win32");
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("not win32"),
    });
    await expect(readdir(t.hookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Claude session when the build has no hook program", async () => {
    const t = await setup(CLAUDE, {}, null);
    await expect(t.open()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("refuses an opted-in agent on another host before anything starts", async () => {
    const remote = await setup(CLAUDE);
    await expect(
      remote.open(new SshHost(SshHostSchema.parse({ id: "box", type: "ssh", host: "box.example" }))),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED", message: expect.stringContaining("nativeToolHook: on") });
    expect(remote.opened()).toBe(0);
  });

  it("installs nothing and refuses nothing unless the agent opts in", async () => {
    for (const choice of [{ nativeToolHook: "off" }, { nativeToolHook: undefined }]) {
      for (const info of [CLAUDE, { name: "orca-scripted-agent", version: "1.0.0" }, undefined]) {
        const off = await setup(info, choice);
        await off.open();
        expect(off.seen.options?.sessionMeta).toBeUndefined();
      }
      const remote = await setup(CLAUDE, choice);
      await remote.open(new SshHost(SshHostSchema.parse({ id: "box", type: "ssh", host: "box.example" })));
      expect(remote.seen.options?.sessionMeta).toBeUndefined();
    }
  });
});
