/**
 * The session factory installs ORCA's Claude pre-tool hook (#704): it hands every local
 * session of an opted-in agent a `sessionMeta` that, once the agent turns out to be the Claude
 * ACP adapter at a verified version, writes the hook's context file into the store's private
 * directory and returns the settings that run the hook with it. Every opted-in session it
 * cannot guard is refused, never opened without the hook. The real adapter and Claude Code are in
 * `claude-hook-acceptance-704.test.ts`; this is the wiring around them, with no agent.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, SshHostSchema, silentLogger, type Logger } from "@orca/core";
import {
  CLAUDE_HOOK_VERIFIED_ADAPTERS,
  CLAUDE_HOOK_VERIFIED_PAIRS,
  CODEX_HOOK_KEY,
  CODEX_HOOK_VERIFIED_ADAPTERS,
  CODEX_HOOK_VERIFIED_PAIRS,
  LocalHost,
  runClaudeRuntimeAttestation,
  codexHookTrustHash,
  codexPreToolHookCommand,
  SshHost,
  permissionPolicyPath,
  type AgentHost,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { makeSessionFactory, NATIVE_TOOL_HOOK_EXPERIMENTAL, orcaProtectedPaths } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const AGENT_PID = 4242;
const RUNTIME_PID = 4343;
const PINNED = CLAUDE_HOOK_VERIFIED_PAIRS[0]!.images["linux-x64"]!;
const CODEX_PID = 4444;
const CODEX_PINNED = CODEX_HOOK_VERIFIED_PAIRS[0]!.images["linux-x64"]!;
const CLAUDE = { name: "@agentclientprotocol/claude-agent-acp", version: CLAUDE_HOOK_VERIFIED_ADAPTERS[0]! };

/** A factory over a fake `open` that calls `sessionMeta` the way `openAcpSession` does. */
async function setup(
  agentInfo: { name: string; version: string } | undefined,
  agent: Record<string, unknown> = {},
  /** `null`: a build with no hook program. */
  script: string | null = "/opt/orca/claude-pre-tool-hook.mjs",
  platform: NodeJS.Platform = "linux",
  /**
   * The runtime process the session-start attestation names, and the digest of the image
   * ORCA finds that process running (`error`: ORCA cannot attest it); `null`, nothing (the
   * attestation never ran, as on the Codex path, which has no session-start hook).
   */
  runtime: { pid: number; image: { sha256: string } | { error: string } } | null = {
    pid: RUNTIME_PID,
    image: { sha256: PINNED },
  },
  codexOpts: {
    /** The adapter's ACP extension method, which the Codex path asks for its hook listing. */
    ext?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    /** The Codex process ORCA finds under the agent, and the digest of the image it runs. */
    codex?: { pid: number; image: { sha256: string } | { error: string } } | { error: string } | undefined;
    /** The program the hook command runs; the real `node` where the test runs the hook. */
    runtimeBin?: string;
    /** The environment ORCA reads off the Codex process for its startup probe. */
    environment?: (pid: number) => Promise<NodeJS.ProcessEnv | { error: string }>;
    /** The shell ORCA runs its startup probe in, as Codex would run the hook. */
    shell?: () => { program: string; args: string[] } | { error: string };
  } = {},
) {
  const ext =
    codexOpts.ext ??
    (async (method: string) => {
      throw new Error(`no ${method}`);
    });
  const codex = codexOpts.codex ?? { pid: CODEX_PID, image: { sha256: CODEX_PINNED } };
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
      seen.meta = await options.sessionMeta?.(agentInfo, ext, AGENT_PID);
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
          { pid: runtime.pid },
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
      runtime: codexOpts.runtimeBin ?? "/usr/bin/node",
      script: script ?? undefined,
      platform,
      arch: "x64",
      // ORCA's own evidence, faked: only the attested process under the agent ORCA started.
      imageDigest: async (pid, agentPid) => {
        if (agentPid !== AGENT_PID) return { error: "not under the agent" };
        if (runtime && pid === runtime.pid) return runtime.image;
        if ("pid" in codex && pid === codex.pid) return codex.image;
        return { error: "not under the agent" };
      },
      codexProcess: async (pid) => (pid === AGENT_PID ? codex : { error: "not the agent" }),
      codexEnvironment:
        codexOpts.environment ??
        (async (pid) =>
          "pid" in codex && pid === codex.pid ? { ...process.env } : { error: "not the Codex process" }),
      codexShell: codexOpts.shell ?? (() => ({ program: "/bin/sh", args: ["-c"] })),
    },
  );
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (msg, fields) => {
      warnings.push({ msg, ...(fields ? { fields } : {}) });
    },
    child: () => logger,
  };
  const open = (host: AgentHost = new LocalHost({ id: "local", type: "local" })) =>
    factory({
      host,
      logger,
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
  /** The context files left behind; none, once a session is refused or closed. */
  const left = () =>
    readdir(hookDir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
  return {
    dir,
    open,
    seen,
    hookDir,
    left,
    resolveClosed,
    opened: () => opened,
    closedByFactory: () => closedByFactory,
    warnings,
  };
}

describe("installing the hook", () => {
  it("writes a private context file and hands the adapter the settings that run the hook with it", async () => {
    const t = await setup(CLAUDE);
    const session = await t.open();
    // Every hooked session says the hook is experimental and not guard-qualified.
    expect(t.warnings).toEqual([{ msg: NATIVE_TOOL_HOOK_EXPERIMENTAL, fields: { agent: "claude" } }]);
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
      // A fresh key per session, for the Codex startup probe's receipt.
      probeKey: expect.stringMatching(/^[0-9a-f]{64}$/),
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
    // ORCA serves a Claude session's MCP servers itself (#704); a Codex session keeps its own.
    const relay = t.seen.options?.relayMcpServers;
    expect(typeof relay).toBe("function");
    if (typeof relay === "function") {
      expect(relay(CLAUDE)).toBe(true);
      expect(relay({ name: "@agentclientprotocol/codex-acp", version: "2.9.0" })).toBe(false);
      expect(relay(undefined)).toBe(false);
    }
    // The session's host services wait on the factory's admission.
    expect(t.seen.options?.admission).toBeInstanceOf(Promise);
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
    expect(await t.left()).toEqual([]);
  });

  it.each([
    ["did not report itself", null, "did not report itself"],
    ["runs another image", { pid: RUNTIME_PID, image: { sha256: "0".repeat(64) } }, "is not the one ORCA verified"],
    [
      "is not a process under the agent ORCA started",
      { pid: RUNTIME_PID, image: { error: "process 4343 is not running under the agent ORCA started" } },
      "could not attest",
    ],
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
    expect(await t.left()).toEqual([]);
  });

  it("refuses a session when the build has no hook program, before anything starts", async () => {
    const t = await setup(CLAUDE, {}, null);
    await expect(t.open()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(t.opened()).toBe(0);
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

describe("installing the hook in Codex (#705)", () => {
  const CODEX = { name: "@agentclientprotocol/codex-acp", version: CODEX_HOOK_VERIFIED_ADAPTERS[0]! };
  const entry = fileURLToPath(new URL("../../agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
  const script = childBundle("codex-hook-wiring-705", { entries: { hook: entry } })?.["hook"];

  /** What the Codex adapter would list for the `CODEX_CONFIG` the factory handed it. */
  const listing =
    (seen: { options?: OpenSessionOptions }, change: Record<string, unknown> = {}) =>
    async (method: string) => {
      expect(method).toBe("_codex/hooks/list");
      const config = JSON.parse(seen.options!.env!["CODEX_CONFIG"]!) as {
        hooks: { PreToolUse: { hooks: { command: string }[] }[] };
      };
      const command = config.hooks.PreToolUse[0]!.hooks[0]!.command;
      return {
        hooks: [
          {
            key: CODEX_HOOK_KEY,
            eventName: "preToolUse",
            command,
            matcher: "*",
            enabled: true,
            trustStatus: "trusted",
            ...change,
          },
        ],
      };
    };

  const codexSetup = async (
    change: Record<string, unknown> = {},
    opts: {
      info?: { name: string; version: string };
      script?: string;
      codex?: { pid: number; image: { sha256: string } | { error: string } } | { error: string };
      environment?: (pid: number) => Promise<NodeJS.ProcessEnv | { error: string }>;
      shell?: () => { program: string; args: string[] } | { error: string };
    } = {},
  ) => {
    const seen: { options?: OpenSessionOptions } = {};
    const t = await setup(
      opts.info ?? CODEX,
      { id: "codex", command: "codex-acp", env: { CODEX_CONFIG: JSON.stringify({ model: "m" }) } },
      opts.script ?? script!,
      "linux",
      // Codex has no session-start hook: nothing reports a runtime process in.
      null,
      {
        ext: (method, params) => {
          if (t.seen.options) seen.options = t.seen.options;
          return listing(
            seen,
            change,
          )(method).then((r) => {
            expect(params).toEqual({ cwd: join(t.dir, "work") });
            return r;
          });
        },
        codex: opts.codex,
        runtimeBin: process.execPath,
        ...(opts.environment ? { environment: opts.environment } : {}),
        ...(opts.shell ? { shell: opts.shell } : {}),
      },
    );
    await mkdir(join(t.dir, "work"), { recursive: true });
    return t;
  };

  it.skipIf(script === undefined || process.platform === "win32")(
    "hands Codex the trusted hook at spawn, and opens once Codex lists it and it blocks when run",
    async () => {
      const t = await codexSetup();
      const session = await t.open();
      expect(t.seen.meta).toBeUndefined();
      const config = JSON.parse(t.seen.options!.env!["CODEX_CONFIG"]!) as Record<string, unknown>;
      expect(config["model"]).toBe("m");
      const [file] = await t.left();
      const command = codexPreToolHookCommand(process.execPath, script!, join(t.hookDir, file!));
      expect(config["hooks"]).toEqual({
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }],
        state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, 30) } },
      });
      await session.close();
      expect(await t.left()).toEqual([]);
    },
  );

  it.skipIf(script === undefined || process.platform === "win32")(
    "refuses unless Codex lists the hook in force",
    async () => {
      for (const change of [
        { trustStatus: "untrusted" },
        { enabled: false },
        { command: "something else" },
        { key: "other" },
      ]) {
        const t = await codexSetup(change);
        await expect(t.open()).rejects.toMatchObject({
          code: "NOT_SUPPORTED",
          message: expect.stringContaining("nativeToolHook: on"),
        });
        expect(await t.left()).toEqual([]);
      }
    },
  );

  it.skipIf(process.platform === "win32")("refuses when the hook does not block as Codex would run it", async () => {
    const t = await codexSetup({}, { script: join(tmpdir(), "orca-705-no-such-hook.mjs") });
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("did not block"),
    });
    expect(await t.left()).toEqual([]);
  });

  it.skipIf(script === undefined || process.platform === "win32")(
    "runs its startup check in the environment read off the Codex process, not the daemon's",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "orca-705-env-"));
      dirs.push(dir);
      const shell = join(dir, "sh");
      const seenEnv = join(dir, "seen");
      // A shell that notes the variable only Codex's environment has, and the arguments it was
      // given, then runs the real one.
      await writeFile(shell, `#!/bin/sh\nprintf '%s %s' "$ONLY_IN_CODEX" "$1" > '${seenEnv}'\nexec /bin/sh "$@"\n`, {
        mode: 0o755,
      });
      const asked: number[] = [];
      const t = await codexSetup(
        {},
        {
          environment: async (pid) => {
            asked.push(pid);
            return { ...process.env, ONLY_IN_CODEX: "from-codex" };
          },
          shell: () => ({ program: shell, args: ["-c"] }),
        },
      );
      const session = await t.open();
      expect(asked).toEqual([CODEX_PID]);
      expect(await readFile(seenEnv, "utf8")).toBe("from-codex -c");
      await session.close();
    },
  );

  it("refuses when ORCA does not know which shell Codex would run the hook in", async () => {
    const t = await codexSetup({}, { shell: () => ({ error: "this account's login shell is /usr/bin/fish" }) });
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(/could not run its startup check[\s\S]*fish[\s\S]*nativeToolHook: on/),
    });
    expect(await t.left()).toEqual([]);
  });

  it("refuses when the Codex process's environment cannot be read", async () => {
    const t = await codexSetup(
      {},
      { environment: async () => ({ error: "the Codex process's environment cannot be read (EACCES)" }) },
    );
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(/could not run its startup check[\s\S]*EACCES[\s\S]*nativeToolHook: on/),
    });
    expect(await t.left()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "says how the startup check failed, in the refusal and its details",
    async () => {
      const t = await codexSetup({}, { script: join(tmpdir(), "orca-705-no-such-hook.mjs") });
      const error = (await t.open().then(
        () => ({ message: "it opened" }),
        (e: unknown) => e,
      )) as { message: string; details?: Record<string, unknown> };
      expect(error.details?.["probe"]).toMatchObject({
        outcome: "exit",
        exitCode: 1,
        receipt: "absent",
        shell: expect.any(String),
      });
      expect(error.message).toMatch(/did not block[\s\S]*exit 1/);
    },
  );

  it.each([
    [
      "runs another image",
      { pid: CODEX_PID, image: { sha256: "0".repeat(64) } },
      "is not the one ORCA verified with adapter",
    ],
    [
      "cannot be attested",
      { pid: CODEX_PID, image: { error: "process 4444 is not running under the agent ORCA started" } },
      "could not attest",
    ],
    ["cannot be found", { error: "no Codex app-server runs under the adapter" }, "could not tell which Codex"],
  ] as const)("refuses when the Codex the adapter runs %s", async (_what, codex, why) => {
    const t = await codexSetup({}, { codex });
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(new RegExp(`${why}[\\s\\S]*nativeToolHook: on`)),
    });
    expect(await t.left()).toEqual([]);
  });

  it("refuses a Codex adapter version the acceptance test does not run", async () => {
    const t = await codexSetup({}, { info: { name: CODEX.name, version: "2.8.0" } });
    await expect(t.open()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("verified the hook only with"),
    });
  });
});
