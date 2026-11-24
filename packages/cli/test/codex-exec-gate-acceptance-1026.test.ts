/**
 * ORCA's gate in Codex's executor path (#1026) against the real Codex ACP adapter and the real
 * Codex it depends on, with the scripted model stand-in, so no account, key or model spend is
 * involved. `codex-exec-gate-acceptance.yml` installs the pinned pair and runs this with
 * `ORCA_CODEX_ADAPTER` set to the adapter's entry point; without it there is nothing to run.
 *
 * No hook is installed here, and Codex runs in the adapter's full-access mode with no sandbox
 * and no asks of its own, so whether a call runs is decided by the gate alone. Each effect is
 * a file in the workspace, read independently of anything Codex or the gate says, and each
 * decision is read from the gate's own record of that request.
 *
 * What is observed on the installed pair:
 * - with `CODEX_EXEC_SERVER_URL` pointing at the gate, every shell command, every byte typed
 *   into a running command, every patch and every image read arrives at the gate, and one the
 *   gate refuses does not happen;
 * - typed input (`write_stdin`), which no hook ever sees, is refused unless a rule names it;
 * - a grant revoked mid-session refuses the very next call;
 * - when ORCA's part fails, the call fails: the policy cannot be decided, the gate is closed,
 *   the gate never admitted the runtime, or the connection does not carry the session's
 *   token. Nothing runs anywhere else, because this Codex has no other executor. When only
 *   the executor behind the gate is killed, Codex connects again, and reaches a new one only
 *   through the gate, which decides every request as before;
 * - the Codex behaviour this rests on, pinned so a change is noticed: a local MCP server does
 *   not start without a local executor.
 *
 * Nothing here wires the gate into ORCA's sessions or claims a support tier.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  CODEX_HOOK_VERIFIED_PAIRS,
  LocalHost,
  codexExecGateDecider,
  openAcpSession,
  openCodexExecGate,
  permissionPolicyPath,
  readPermissionPolicyFile,
  replacePermissionPolicyFile,
  spawnCodexExecServer,
  type AgentSession,
  type ClaudeHookContext,
  type CodexExecGate,
  type CodexExecGateCall,
  type CodexExecGateDecision,
  type CodexExecGateRecord,
  type OpenSessionOptions,
} from "@orca/agents";
import { modelStandIn, patch, script, shell, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

const ADAPTER = process.env["ORCA_CODEX_ADAPTER"];
/** The Codex the adapter runs: the platform package installed beside it. */
const RUNTIME =
  ADAPTER === undefined
    ? ""
    : join(
        ADAPTER,
        "..",
        "..",
        "..",
        "..",
        "@openai",
        "codex-linux-x64",
        "vendor",
        "x86_64-unknown-linux-musl",
        "bin",
        "codex",
      );

/** A 1x1 PNG, for `view_image`. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Decide = (call: CodexExecGateCall, signal: AbortSignal) => Promise<CodexExecGateDecision>;

describe.skipIf(ADAPTER === undefined)("ORCA's exec gate in the real Codex (#1026)", () => {
  let model: ModelStandIn;
  let root: string;
  let configDir: string;
  let workspace: string;
  let codexHome: string;

  beforeAll(async () => {
    model = await modelStandIn();
  });
  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
  });

  let gate: CodexExecGate | undefined;
  let session: AgentSession | undefined;
  let records: CodexExecGateRecord[] = [];
  /** The pid of each executor ORCA started behind the gate. */
  let executors: number[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-1026-acceptance-"));
    configDir = join(root, "config");
    workspace = join(root, "work");
    codexHome = join(root, "codex-home");
    await mkdir(join(configDir, ".orca"), { recursive: true });
    await mkdir(workspace);
    await mkdir(codexHome);
    model.outputs.length = 0;
    records = [];
    executors = [];
    asks.length = 0;
    onTestFailed(() =>
      console.error(
        `tool outputs Codex sent the model:\n${model.outputs.join("\n")}\n` +
          `what the gate recorded:\n${records.map((r) => JSON.stringify(r)).join("\n")}`,
      ),
    );
    return async () => {
      await session?.close().catch(() => undefined);
      await gate?.close();
      session = undefined;
      gate = undefined;
      // Codex may still be writing its home as the session closes.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    };
  });

  /** Codex pointed at the stand-in, with no sandbox and no approvals of its own. */
  const codexConfig = (extra: Record<string, unknown> = {}) => ({
    model: "gpt-5.5",
    model_provider: "standin",
    model_providers: {
      standin: { name: "standin", base_url: model.url, wire_api: "responses", env_key: "ORCA_1026_KEY" },
    },
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
    ...extra,
  });

  const agentEnv = (env: Record<string, string>): Record<string, string> => ({
    CODEX_HOME: codexHome,
    CODEX_CONFIG: JSON.stringify(codexConfig()),
    INITIAL_AGENT_MODE: "agent-full-access",
    ORCA_1026_KEY: "sk-orca-1026-test",
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
    ...env,
  });

  /** What ORCA's session layer hands the hook, here handed to the gate's decider. */
  const context = (permissions: ClaudeHookContext["permissions"]): ClaudeHookContext => ({
    version: 1,
    agentId: "codex",
    permissions,
    permissionFiles: [permissionPolicyPath(configDir)],
    workspaceCwd: workspace,
    protectedPaths: {
      readOnly: [permissionPolicyPath(configDir), join(configDir, ".orca")],
      noAccess: [join(configDir, "auth")],
    },
  });

  /** Every permission ask that reaches ORCA's human channel; each one is refused. */
  const asks: string[] = [];
  const askPermission: NonNullable<OpenSessionOptions["askPermission"]> = async (req) => {
    asks.push(req.toolCall.title ?? "");
    return req.options.find((o) => o.kind === "reject_once")?.optionId;
  };

  const exists = (name: string) =>
    readFile(join(workspace, name), "utf8").then(
      (t) => t,
      () => undefined,
    );

  const startExecutor = () => {
    const backend = spawnCodexExecServer({
      program: RUNTIME,
      env: { ...process.env, ...agentEnv({}) },
      cwd: workspace,
    });
    if (backend.pid !== undefined) executors.push(backend.pid);
    return backend;
  };

  /** A Codex session whose only executor is ORCA's gate, deciding by `permissions`. */
  async function gated(
    permissions: ClaudeHookContext["permissions"] = { rules: [] },
    more: { decide?: Decide; admit?: boolean; env?: Record<string, string>; url?: (url: string) => string } = {},
  ): Promise<AgentSession> {
    const byPolicy = codexExecGateDecider(context(permissions));
    gate = await openCodexExecGate({
      decide: more.decide ?? ((call) => byPolicy(call)),
      onRecord: (record) => records.push(record),
      decisionTimeoutMs: 2000,
      admissionWaitMs: 2000,
    });
    if (more.admit !== false) gate.admit(startExecutor);
    session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "codex",
        command: process.execPath,
        args: [ADAPTER],
        env: agentEnv({ CODEX_EXEC_SERVER_URL: more.url ? more.url(gate.url) : gate.url, ...more.env }),
        // Codex asks ORCA nothing in this mode; were it to, nothing here would allow it.
        permissions: { default: "ask", rules: [] },
      }),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    return session;
  }

  const recorded = (method: string, outcome: CodexExecGateRecord["outcome"]) =>
    records.filter((r) => r.method === method && r.outcome === outcome);
  const told = (pattern: RegExp) => model.outputs.some((o) => pattern.test(o));

  const ALLOW_MARK = { match: { kind: "execute", titlePattern: "^echo orca-1026 >> " }, decision: "allow" } as const;
  const typing: Step[] = [
    { tool: "exec_command", args: { cmd: "cat > typed.txt", tty: true, yield_time_ms: 500 } },
    { tool: "write_stdin", args: { session_id: "$SID", chars: "typed-1026\n\u0004", yield_time_ms: 500 } },
  ];
  const ALLOW_CAT = { match: { kind: "execute", titlePattern: "^cat > typed\\.txt$" }, decision: "allow" } as const;

  /* --------------------------------- the runs --------------------------------- */

  it("puts the image pinned for the adapter behind the gate", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as { version: string };
    const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === pkg.version);
    const digest = createHash("sha256")
      .update(await readFile(RUNTIME))
      .digest("hex");
    expect(digest).toBe(pair?.images[`${process.platform}-${process.arch}`]);
  });

  it("runs a command ORCA allows and not one a rule denies or the policy asks about", async () => {
    const s = await gated({
      rules: [ALLOW_MARK, { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" }],
    });
    await gate!.initialized(30_000);
    await s.prompt(
      script(
        shell("echo orca-1026 >> allowed.txt"),
        shell("echo denied >> denied.txt"),
        shell("echo asked >> asked.txt"),
      ),
    );
    expect(await exists("allowed.txt")).toBe("orca-1026\n");
    expect(await exists("denied.txt")).toBeUndefined();
    expect(await exists("asked.txt")).toBeUndefined();
    expect(asks).toEqual([]);
    // The model is told it was ORCA, in ORCA's words.
    expect(told(/Denied by ORCA: ORCA's permission policy/)).toBe(true);
    expect(told(/Blocked by ORCA: its policy asks a person first/)).toBe(true);
    // Each decision is the gate's own record of that request, tied to the model's call.
    const [allowed] = recorded("process/start", "forwarded");
    expect(allowed).toMatchObject({
      basis: "policy",
      subject: {
        kind: "execute",
        title: "echo orca-1026 >> allowed.txt",
        cwd: workspace,
        toolCallId: expect.stringMatching(/^call_/),
      },
    });
    expect(allowed!.subject!.argv!.at(-1)).toBe("echo orca-1026 >> allowed.txt");
    expect(recorded("process/start", "refused").map((r) => [r.basis, r.subject?.title])).toEqual([
      ["policy:deny", "echo denied >> denied.txt"],
      ["policy:ask", "echo asked >> asked.txt"],
    ]);
  }, 180_000);

  it("refuses what is typed into a running command unless a rule names it", async () => {
    const s = await gated({ rules: [ALLOW_CAT, { match: { kind: "execute" }, decision: "allow" }] });
    await s.prompt(script(...typing));
    // The command ran; what was typed into it never arrived, whatever the command rules allow.
    expect(await exists("typed.txt")).toBe("");
    const [refused] = recorded("process/write", "refused");
    expect(refused).toMatchObject({ basis: "policy:ask", subject: { bytes: 12 } });
    expect(JSON.stringify(records)).not.toContain("typed-1026");
    expect(told(/Blocked by ORCA/)).toBe(true);
  }, 180_000);

  it("passes typed input a rule names", async () => {
    const s = await gated({
      rules: [ALLOW_CAT, { match: { kind: "execute", titlePattern: '^write_stdin: "typed-1026' }, decision: "allow" }],
    });
    await s.prompt(script(...typing));
    expect(await exists("typed.txt")).toContain("typed-1026");
    expect(recorded("process/write", "forwarded")).toHaveLength(1);
  }, 180_000);

  it("applies a patch inside the workspace, and not one outside it or on ORCA's own files", async () => {
    const s = await gated();
    await s.prompt(script(patch("*** Add File: patched.txt", "+orca-1026")));
    expect(await exists("patched.txt")).toBe("orca-1026\n");
    expect(recorded("fs/writeFile", "forwarded").map((r) => r.subject?.paths)).toEqual([
      [join(workspace, "patched.txt")],
    ]);

    const outside = join(root, "outside.txt");
    await s.prompt(script(patch(`*** Add File: ${outside}`, "+x")));
    expect(await readFile(outside, "utf8").catch(() => undefined)).toBeUndefined();

    const sidecar = permissionPolicyPath(configDir);
    await s.prompt(script(patch(`*** Add File: ${sidecar}`, "+{}")));
    expect(await readFile(sidecar, "utf8").catch(() => undefined)).toBeUndefined();
    expect(recorded("fs/writeFile", "refused").map((r) => [r.basis, r.subject?.paths])).toEqual([
      ["policy:ask", [outside]],
      ["protected:deny", [sidecar]],
    ]);

    // Deleting goes through the gate too.
    await s.prompt(script(patch("*** Delete File: patched.txt")));
    expect(await exists("patched.txt")).toBeUndefined();
    expect(recorded("fs/remove", "forwarded")).toHaveLength(1);
  }, 240_000);

  it("reads an image inside the workspace and not a file outside it", async () => {
    await writeFile(join(workspace, "in.png"), PNG);
    const outside = join(root, "out.png");
    await writeFile(outside, PNG);
    const s = await gated();
    await s.prompt(script({ tool: "view_image", args: { path: join(workspace, "in.png") } }));
    await s.prompt(script({ tool: "view_image", args: { path: outside } }));
    const reads = records.filter((r) => r.method === "fs/readFile" && r.subject?.paths?.[0]?.endsWith(".png"));
    expect(reads.map((r) => [r.outcome, r.subject?.paths?.[0]])).toEqual([
      ["forwarded", join(workspace, "in.png")],
      ["refused", outside],
    ]);
    // Only the first image's bytes reached the model.
    expect(model.outputs.filter((o) => o.includes("data:image/png;base64"))).toHaveLength(1);
  }, 180_000);

  it("refuses the very next call once the grant is revoked", async () => {
    const s = await gated({ rules: [ALLOW_MARK] });
    await s.prompt(script(shell("echo orca-1026 >> revoked.txt")));
    expect(await exists("revoked.txt")).toBe("orca-1026\n");
    const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
    await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
      ...doc,
      agents: { codex: { rules: [{ match: { kind: "execute", command: "echo" }, decision: "ask" }] } },
    });
    await s.prompt(script(shell("echo orca-1026 >> revoked.txt")));
    expect(await exists("revoked.txt")).toBe("orca-1026\n");
    expect(recorded("process/start", "refused")).toHaveLength(1);
    expect(asks).toEqual([]);
  }, 180_000);

  it("starts the executor's own shell, not one at a path the model names", async () => {
    // Codex 0.171 does not use the model's `shell` with a remote executor. Were it to, the
    // gate would decide the whole command line, since only a system shell's script is read
    // as the command (the unit tests); this pins what the installed Codex sends.
    const fake = join(workspace, "bash");
    await writeFile(fake, "#!/bin/sh\necho ran >> fake-shell.txt\n", { mode: 0o755 });
    const s = await gated({ rules: [ALLOW_MARK] });
    await s.prompt(script({ tool: "exec_command", args: { cmd: "echo orca-1026 >> x.txt", shell: fake } }));
    expect(await exists("fake-shell.txt")).toBeUndefined();
    const starts = records.filter((r) => r.method === "process/start");
    expect(starts.length).toBeGreaterThan(0);
    for (const r of starts) expect(r.subject?.argv?.[0]).not.toBe(fake);
  }, 180_000);

  it("fails the call when ORCA cannot decide it", async () => {
    let mode: "throw" | "hang" = "throw";
    const s = await gated(undefined, {
      decide: (call) => {
        if (call.check === "protected" || call.toolCall.kind !== "execute")
          return Promise.resolve({ allow: true, basis: "test" });
        if (mode === "throw") return Promise.reject(new Error("the policy could not be read"));
        return new Promise<CodexExecGateDecision>(() => undefined);
      },
    });
    await s.prompt(script(shell("echo ran >> threw.txt")));
    expect(await exists("threw.txt")).toBeUndefined();
    expect(told(/Blocked by ORCA: ORCA could not check this call/)).toBe(true);
    mode = "hang";
    await s.prompt(script(shell("echo ran >> hung.txt")));
    expect(await exists("hung.txt")).toBeUndefined();
    expect(told(/Blocked by ORCA: ORCA could not decide this call in time/)).toBe(true);
    expect(recorded("process/start", "forwarded")).toHaveLength(0);
  }, 180_000);

  it("decides every later call again when the executor behind the gate is killed", async () => {
    const s = await gated({
      rules: [
        { match: { kind: "execute", titlePattern: "^echo ran >> (before|after)\\.txt$" }, decision: "allow" },
        { match: { kind: "execute", titlePattern: "^echo denied" }, decision: "deny" },
      ],
    });
    await s.prompt(script(shell("echo ran >> before.txt")));
    expect(await exists("before.txt")).toBe("ran\n");
    expect(executors).toHaveLength(1);
    process.kill(executors[0]!, "SIGKILL");
    await s.prompt(script(shell("echo ran >> after.txt"), shell("echo denied >> denied.txt")));
    // Codex connects again. It reaches a new executor only through the gate, which starts one
    // and decides each request as before: nothing ran on the strength of the old connection.
    expect(
      records.some((r) => r.method === "connection" && r.outcome === "closed" && /SIGKILL/.test(r.reason ?? "")),
    ).toBe(true);
    expect(executors.length).toBeGreaterThan(1);
    expect(await exists("after.txt")).toBe("ran\n");
    expect(await exists("denied.txt")).toBeUndefined();
    const later = records.filter((r) => r.method === "process/start" && r.connection > 1);
    expect(later.map((r) => [r.outcome, r.basis, r.subject?.title])).toEqual([
      ["forwarded", "policy", "echo ran >> after.txt"],
      ["refused", "policy:deny", "echo denied >> denied.txt"],
    ]);
  }, 180_000);

  it("fails every later call when the gate is closed", async () => {
    const s = await gated({ default: "allow", rules: [] });
    await s.prompt(script(shell("echo ran >> before.txt")));
    expect(await exists("before.txt")).toBe("ran\n");
    await gate!.close();
    await s.prompt(
      script(shell("echo ran >> after.txt"), patch("*** Add File: after-patch.txt", "+x"), {
        tool: "view_image",
        args: { path: join(workspace, "before.txt") },
      }),
    );
    expect(await exists("after.txt")).toBeUndefined();
    expect(await exists("after-patch.txt")).toBeUndefined();
    // Each call failed for want of an executor, and said so.
    expect(model.outputs).toHaveLength(4);
    expect(model.outputs[1]).toMatch(/exec-server connection attempt failed/);
    expect(model.outputs[2]).toMatch(/Failed to write file/);
    expect(model.outputs[3]).toMatch(/exec-server connection attempt failed/);
  }, 180_000);

  it("runs nothing when ORCA never admitted the runtime", async () => {
    const s = await gated({ default: "allow", rules: [] }, { admit: false });
    await s.prompt(script(shell("echo ran >> unadmitted.txt"), patch("*** Add File: unadmitted-patch.txt", "+x")));
    expect(await exists("unadmitted.txt")).toBeUndefined();
    expect(await exists("unadmitted-patch.txt")).toBeUndefined();
    expect(executors).toEqual([]);
    expect(records.some((r) => r.outcome === "forwarded")).toBe(false);
  }, 180_000);

  it("runs nothing when the agent's connection does not carry the session's token", async () => {
    const s = await gated(
      { default: "allow", rules: [] },
      { url: (url) => `${url.slice(0, url.lastIndexOf("/"))}/guessed` },
    );
    await s.prompt(script(shell("echo ran >> wrong-token.txt")));
    expect(await exists("wrong-token.txt")).toBeUndefined();
    expect(executors).toEqual([]);
    expect(records.every((r) => r.method === "connection" && r.outcome === "refused")).toBe(true);
  }, 180_000);

  it("does not start a local MCP server, which would run outside the gate", async () => {
    const server = join(root, "mcp-touch.mjs");
    const started = join(root, "mcp-started.txt");
    await writeFile(
      server,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
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
    model.tools.clear();
    const s = await gated(
      { default: "allow", rules: [] },
      {
        env: {
          CODEX_CONFIG: JSON.stringify(
            codexConfig({
              model: "gpt-5",
              mcp_servers: { t: { command: process.execPath, args: [server], default_tools_approval_mode: "approve" } },
            }),
          ),
        },
      },
    );
    await s.prompt(script({ tool: "touch", namespace: "mcp__t", args: { file: join(workspace, "mcp.txt") } }));
    expect(await exists("mcp.txt")).toBeUndefined();
    expect(await readFile(started, "utf8").catch(() => undefined)).toBeUndefined();
    expect([...model.tools].filter((t) => t.includes("touch") || t.startsWith("mcp__"))).toEqual([]);
  }, 180_000);
});
