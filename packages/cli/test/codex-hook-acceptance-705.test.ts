/**
 * ORCA's pre-tool hook against the real Codex ACP adapter and the real Codex it depends on
 * (#705), with a scripted local stand-in for the model (an OpenAI Responses endpoint), so no
 * account, key or model spend is involved. `codex-hook-acceptance.yml` installs the pinned
 * adapter and runs this with `ORCA_CODEX_ADAPTER` set to its entry point; without it there is
 * nothing to run.
 *
 * The stand-in is told what to call by the prompt (`SCRIPT:` and a base64 list of tool
 * calls). Each effect is a file the call writes in the workspace, read independently of
 * anything the agent or ORCA says. Codex runs in the adapter's full-access mode, with no sandbox and no asks of its own, so whether a
 * call runs is decided by the hook alone.
 *
 * What is observed:
 * - the session factory installs the hook through the adapter's `CODEX_CONFIG`, trusted,
 *   and Codex runs it on every shell call, patch and MCP tool call: an ORCA allow runs, a configured deny
 *   does not, an ORCA ask does not (Codex cannot pause for a person) and nothing reaches
 *   ORCA's human channel, a revoked grant blocks the very next call, and a patch that touches
 *   ORCA's own files does not apply;
 * - an agent whose own `CODEX_CONFIG` already sets hooks is refused before any call;
 * - ORCA finds the Codex the adapter actually started among the agent's own processes and
 *   accepts the session only when the image that process runs is the one pinned for the
 *   adapter in `CODEX_HOOK_VERIFIED_PAIRS`; pointed at another Codex (`CODEX_PATH`,
 *   `ORCA_CODEX_OTHER_RUNTIME`), the session is refused before any call;
 * - Codex's own behaviour, pinned so a change is noticed, which is why ORCA answers only with
 *   exit 0, or exit 2 with its reason on stderr: a hook that exits 1, or exits 2 with nothing
 *   on stderr, lets the call through; and text typed into a running command (`write_stdin`)
 *   is never shown to the hook.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  CODEX_HOOK_KEY,
  CODEX_HOOK_VERIFIED_ADAPTERS,
  CODEX_HOOK_VERIFIED_PAIRS,
  CODEX_HOOK_VERIFIED_PLATFORMS,
  LocalHost,
  codexHookEnvironment,
  codexHookShell,
  codexHookTrustHash,
  codexRuntimeProcess,
  openAcpSession,
  processImageDigest,
  permissionPolicyPath,
  readPermissionPolicyFile,
  replacePermissionPolicyFile,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { makeSessionFactory } from "../src/bootstrap.js";
import { modelStandIn, patch, script, shell, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

const ADAPTER = process.env["ORCA_CODEX_ADAPTER"];
/** A Codex executable that is not the one paired with the adapter (the workflow installs 0.170.0). */
const OTHER_RUNTIME = process.env["ORCA_CODEX_OTHER_RUNTIME"];

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/* ---------------------------------- the setup ---------------------------------- */

describe.skipIf(ADAPTER === undefined)("the hook in the real Codex (#705)", () => {
  let model: ModelStandIn;
  let hookScript: string;
  let root: string;
  let configDir: string;
  let workspace: string;
  let codexHome: string;

  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("codex-pre-tool-hook-acceptance-705", { entries: { hook: entry } })?.["hook"];
    if (!built) throw new Error("the hook program could not be built for this run");
    hookScript = built;
  });

  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-705-acceptance-"));
    configDir = join(root, "config");
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(configDir);
    await mkdir(workspace);
    await mkdir(codexHome);
    // What Codex reported back for each call is the only account of why a call did not run.
    model.outputs.length = 0;
    onTestFailed(() => console.error(`tool outputs Codex sent the model:\n${model.outputs.join("\n")}`));
    // Codex may still be writing its home as the session closes.
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Codex pointed at the stand-in, with no sandbox and no approvals of its own. */
  const codexConfig = (extra: Record<string, unknown> = {}) => ({
    model: "gpt-5.5",
    model_provider: "standin",
    model_providers: {
      standin: { name: "standin", base_url: model.url, wire_api: "responses", env_key: "ORCA_705_KEY" },
    },
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    ...extra,
  });

  /** `hook: false`: a spec that does not opt into ORCA's hook, for pinning Codex's own behaviour. */
  const agent = (permissions: unknown = { rules: [] }, env: Record<string, string> = {}, hook = true) =>
    AgentSpecSchema.parse({
      id: "codex",
      command: process.execPath,
      args: [ADAPTER],
      env: {
        CODEX_HOME: codexHome,
        CODEX_CONFIG: JSON.stringify(codexConfig()),
        // The adapter picks each turn's sandbox and approvals from its session mode, not from
        // CODEX_CONFIG, and starts in "Auto review" (a workspace sandbox, with Codex's own
        // reviewer deciding escalations). Full access leaves whether a call runs to the hook.
        INITIAL_AGENT_MODE: "agent-full-access",
        ORCA_705_KEY: "sk-orca-705-test",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
        ...env,
      },
      permissions,
      ...(hook ? { nativeToolHook: "experimental" } : {}),
    });

  const exists = (name: string) =>
    readFile(join(workspace, name), "utf8").then(
      (t) => t,
      () => undefined,
    );

  /** Every permission ask that reaches ORCA's human channel; each one is refused. */
  const asks: string[] = [];
  const askPermission: OpenSessionOptions["askPermission"] = async (req) => {
    asks.push(req.toolCall.title ?? "");
    return req.options.find((o) => o.kind === "reject_once")?.optionId;
  };

  const factorySession = (permissions?: unknown, env?: Record<string, string>): Promise<AgentSession> =>
    makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
      runtime: process.execPath,
      script: hookScript,
    })({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(permissions, env),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });

  const ALLOW_MARK = { match: { kind: "execute", titlePattern: "^echo orca-705 >> " }, decision: "allow" };

  /* --------------------------------- the runs --------------------------------- */

  it("runs an adapter version and a platform ORCA installs the hook on", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(CODEX_HOOK_VERIFIED_ADAPTERS).toContain(pkg.version);
    expect(CODEX_HOOK_VERIFIED_PLATFORMS).toContain(process.platform);
  });

  it("runs a call ORCA allows and blocks one a configured rule denies", async () => {
    asks.length = 0;
    const session = await factorySession({
      rules: [ALLOW_MARK, { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" }],
    });
    try {
      await session.prompt(script(shell("echo orca-705 >> allowed.txt"), shell("echo denied >> denied.txt")));
      expect(await exists("allowed.txt")).toBe("orca-705\n");
      expect(await exists("denied.txt")).toBeUndefined();
      expect(asks).toEqual([]);
      // It was ORCA's hook that stopped the denied call, and no sandbox of Codex's was in play.
      expect(model.outputs.some((o) => o.includes("Denied by ORCA"))).toBe(true);
      expect(model.outputs.join("\n")).not.toContain("bwrap");
    } finally {
      await session.close();
    }
  }, 180_000);

  it("offers the model the hooked tools, and not hosted web search", async () => {
    model.tools.clear();
    const session = await factorySession();
    try {
      await session.prompt(script());
      expect([...model.tools]).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]));
      expect([...model.tools]).not.toContain("web_search");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("blocks a call ORCA would ask about, without asking anybody", async () => {
    asks.length = 0;
    const session = await factorySession();
    try {
      await session.prompt(script(shell("echo asked >> asked.txt")));
      expect(await exists("asked.txt")).toBeUndefined();
      expect(asks).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("blocks the very next call once the grant is revoked", async () => {
    asks.length = 0;
    // ORCA allows the command by a configured rule (it no longer keeps standing shell grants,
    // #702), so Codex runs it without asking anybody.
    const session = await factorySession({
      rules: [{ match: { kind: "execute", titlePattern: "^echo orca-705 >> revoked\\.txt$" }, decision: "allow" }],
    });
    try {
      await session.prompt(script(shell("echo orca-705 >> revoked.txt")));
      expect(await exists("revoked.txt")).toBe("orca-705\n");
      expect(asks).toEqual([]);

      // A rule added to the live permission file mid-session applies to the very next call.
      const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
      await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
        ...doc,
        agents: { codex: { rules: [{ match: { kind: "execute", command: "echo" }, decision: "ask" }] } },
      });

      await session.prompt(script(shell("echo orca-705 >> revoked.txt")));
      // In Codex an ask is a block: the file is unchanged, and nobody was asked.
      expect(await exists("revoked.txt")).toBe("orca-705\n");
      expect(asks).toEqual([]);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("applies a patch ORCA allows, and not one that touches ORCA's own files", async () => {
    const session = await factorySession({
      rules: [{ match: { kind: "edit", scope: "workspace" }, decision: "allow" }],
    });
    try {
      await session.prompt(script(patch("*** Add File: patched.txt", "+orca-705")));
      expect(await exists("patched.txt")).toBe("orca-705\n");
      // Inside the workspace, and also ORCA's sidecar: the whole patch is refused.
      await session.prompt(
        script(patch("*** Add File: second.txt", "+x", `*** Add File: ${permissionPolicyPath(configDir)}`, "+{}")),
      );
      expect(await exists("second.txt")).toBeUndefined();
      expect(await readFile(permissionPolicyPath(configDir), "utf8").catch(() => undefined)).toBeUndefined();
    } finally {
      await session.close();
    }
  }, 180_000);

  it("checks an MCP tool call by its server and tool", async () => {
    // A stdio MCP server with one tool that writes the file it is given.
    const server = join(root, "mcp-touch.mjs");
    await writeFile(
      server,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "touch", version: "1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "write a file", inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } }] } });
  else if (m.method === "tools/call") { writeFileSync(m.params.arguments.file, "mcp"); out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } }); }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
      "utf8",
    );
    // A model Codex does not defer MCP tools for, so the stand-in can call one directly.
    const env = {
      CODEX_CONFIG: JSON.stringify(
        codexConfig({
          model: "gpt-5",
          mcp_servers: { t: { command: process.execPath, args: [server], default_tools_approval_mode: "approve" } },
        }),
      ),
    };
    const call = (file: string): Step => ({
      tool: "touch",
      namespace: "mcp__t",
      args: { file: join(workspace, file) },
    });
    const session = await factorySession(
      {
        rules: [{ match: { titlePattern: "^t: touch$" }, decision: "allow" }],
      },
      env,
    );
    try {
      await session.prompt(script(call("mcp-allowed.txt")));
      expect(await exists("mcp-allowed.txt")).toBe("mcp");
    } finally {
      await session.close();
    }
    const denied = await factorySession({ rules: [{ match: { titlePattern: "^t: touch$" }, decision: "deny" }] }, env);
    try {
      await denied.prompt(script(call("mcp-denied.txt")));
      expect(await exists("mcp-denied.txt")).toBeUndefined();
    } finally {
      await denied.close();
    }
  }, 180_000);

  it("runs the Codex image pinned for the adapter, as ORCA finds it among the agent's processes", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as { version: string };
    const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === pkg.version);
    const found: { pid: number; agentPid: number }[] = [];
    const session = await makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
      runtime: process.execPath,
      script: hookScript,
      codexProcess: async (agentPid) => {
        const r = await codexRuntimeProcess(agentPid);
        if ("pid" in r) found.push({ pid: r.pid, agentPid: agentPid! });
        return r;
      },
    })({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(),
      cwd: workspace,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    try {
      // The session is open, so that Codex is still running: the image ORCA accepted it on is
      // the one pinned for this adapter, read from the process itself.
      expect(found).toHaveLength(1);
      expect(await processImageDigest(found[0]!.pid, found[0]!.agentPid)).toEqual({
        sha256: pair?.images[`${process.platform}-${process.arch}`],
      });
    } finally {
      await session.close();
    }
  }, 120_000);

  it.skipIf(OTHER_RUNTIME === undefined)(
    "refuses the session, before any call, when the adapter runs another Codex",
    async () => {
      const pinned = CODEX_HOOK_VERIFIED_PAIRS.flatMap((p) => Object.values(p.images));
      expect(pinned).not.toContain(await sha256(OTHER_RUNTIME!));
      await expect(factorySession(undefined, { CODEX_PATH: OTHER_RUNTIME! })).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        message: expect.stringMatching(/is not the one ORCA verified[\s\S]*remove nativeToolHook/),
      });
      expect(await readdir(join(configDir, ".orca", "private-execution", "tool-hooks")).catch(() => [])).toEqual([]);
    },
    120_000,
  );

  it("refuses an agent whose own CODEX_CONFIG already sets hooks", async () => {
    await expect(
      factorySession(undefined, { CODEX_CONFIG: JSON.stringify(codexConfig({ hooks: { PreToolUse: [] } })) }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED", message: expect.stringContaining("already sets hooks") });
  }, 120_000);

  /* ------------------------- Codex's own behaviour, pinned ------------------------- */

  /** A session with a hook of the test's choosing in place of ORCA's, trusted the same way. */
  const rawSession = (command: string) =>
    openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(
        { default: "allow", rules: [] },
        {
          CODEX_CONFIG: JSON.stringify(
            codexConfig({
              hooks: {
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }],
                state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, 30) } },
              },
            }),
          ),
        },
        // The test installs its own hook; ORCA's is not involved, so the spec does not ask for it.
        false,
      ),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });

  it("runs its hooks in the shell and environment ORCA's startup probe uses", async () => {
    const out = join(root, "hook-shell");
    // The shell Codex starts the hook in records what it was started with: its initial
    // environment (before any login profile ran), its program and arguments, and its parent.
    const command = `cat /proc/$$/environ > '${out}.env'; tr '\\0' '\\n' < /proc/$$/cmdline > '${out}.argv'; readlink /proc/$$/exe > '${out}.exe'; echo $PPID > '${out}.ppid'; cat >/dev/null; exit 0`;
    const session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(
        { default: "allow", rules: [] },
        {
          CODEX_CONFIG: JSON.stringify(
            codexConfig({
              hooks: {
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }],
                state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, 30) } },
              },
            }),
          ),
          // Codex does not take its hook shell from $SHELL; this one is never run.
          SHELL: "/nonexistent-orca-705/sh",
          ORCA_705_PLAIN: "1",
          BASH_ENV: "/nonexistent-orca-705",
          LD_LIBRARY_PATH: "/nonexistent-orca-705",
        },
        false,
      ),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    try {
      await session.prompt(script(shell("echo ran >> ran.txt")));
      const codex = Number((await readFile(`${out}.ppid`, "utf8")).trim());
      // Read while that Codex still runs, as the factory reads it at startup.
      const read = await codexHookEnvironment(codex);
      if ("error" in read) throw new Error(read.error);
      const given = new Map(
        (await readFile(`${out}.env`, "utf8"))
          .split("\0")
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
      );
      // What the recording shell sets itself is not what it was given.
      for (const own of ["PWD", "OLDPWD", "SHLVL", "_"]) {
        given.delete(own);
        delete read[own];
      }
      expect(Object.fromEntries(given)).toEqual(read);
      expect(read["PATH"]).toMatch(/codex-path:/);
      // And it runs the hook in the shell ORCA's probe uses: the login shell, with -c.
      const shellUsed = codexHookShell();
      if ("error" in shellUsed) throw new Error(shellUsed.error);
      expect((await readFile(`${out}.argv`, "utf8")).split("\n").slice(0, 2)).toEqual([
        shellUsed.program,
        ...shellUsed.args,
      ]);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("blocks a call only on exit 2 with a reason on stderr", async () => {
    for (const [name, command, ran] of [
      ["exit-1", "cat >/dev/null; echo no >&2; exit 1", true],
      ["exit-2-quiet", "cat >/dev/null; exit 2", true],
      ["exit-2", "cat >/dev/null; echo no >&2; exit 2", false],
    ] as const) {
      const session = await rawSession(command);
      try {
        await session.prompt(script(shell(`echo ran >> ${name}.txt`)));
        expect([name, (await exists(`${name}.txt`)) !== undefined]).toEqual([name, ran]);
      } finally {
        await session.close();
      }
    }
  }, 180_000);

  it("does not show the hook what is typed into a running command", async () => {
    const seen = join(root, "hook-saw.txt");
    const session = await rawSession(`cat >> '${seen}'; echo >> '${seen}'; exit 0`);
    try {
      await session.prompt(
        script(
          { tool: "exec_command", args: { cmd: "cat > typed.txt", tty: true, yield_time_ms: 500 } },
          { tool: "write_stdin", args: { session_id: "$SID", chars: "typed-705\n\u0004", yield_time_ms: 500 } },
        ),
      );
      expect(await exists("typed.txt")).toContain("typed-705");
      const frames = (await readFile(seen, "utf8")).split("\n").filter((l) => l.trim() !== "");
      expect(frames.map((f) => (JSON.parse(f) as { tool_name: string }).tool_name)).toEqual(["Bash"]);
    } finally {
      await session.close();
    }
  }, 180_000);
});
