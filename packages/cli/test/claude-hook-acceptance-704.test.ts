/**
 * ORCA's Claude pre-tool hook against the real Claude ACP adapter and the real Claude Code
 * (#704), with a scripted local stand-in for the model so that no account, key or model
 * spend is involved. `claude-hook-acceptance.yml` installs the pinned adapter and runs this
 * with `ORCA_CLAUDE_ADAPTER` set to its entry point; without it there is nothing to run.
 *
 * Every call here is one Bash command that appends a line to a marker file in the
 * workspace, and Claude Code is told by its own user settings to allow exactly that command
 * without asking: the natively remembered grant ORCA could not see before the hook. The
 * marker's line count is the effect, read independently of anything the agent or ORCA says.
 *
 * What is observed:
 * - a remembered call still goes through ORCA's policy: allowed, it runs twice without a
 *   permission ask; denied by a configured rule, it does not run;
 * - once the ORCA grant is revoked, the next identical call is asked about through
 *   `session/request_permission`, and refusing that ask means it does not run;
 * - a hook that cannot start, crashes, exits with a code other than 0 or 2, times out, or
 *   prints JSON Claude Code cannot validate blocks the call (`onFailure: "block"` on the
 *   installed Claude Code);
 * - stdout that is not JSON at all, with exit 0, is read as plain text and the call goes
 *   ahead. That is Claude Code's behaviour and is pinned here so a change is noticed; ORCA's
 *   hook program cannot produce it: its output guard keeps anything but its answer off stdout
 *   and blocks instead, which is observed here too, through the real Claude Code.
 *
 * - the session's Claude Code names its process at session start, and ORCA, checking that
 *   process is under the agent it started and hashing the image it runs, accepts the session
 *   only when that is the image pinned in `CLAUDE_HOOK_VERIFIED_PAIRS`; pointed at another
 *   Claude Code (`CLAUDE_CODE_EXECUTABLE`, `ORCA_CLAUDE_OTHER_RUNTIME`), the session is
 *   refused before it is given any work. Both variables are required: the suite is exact.
 *
 * It runs on Linux against the pairs in `CLAUDE_HOOK_VERIFIED_PAIRS`, which are the only
 * adapter and Claude Code versions, and the only platform, ORCA installs the hook with.
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  CLAUDE_HOOK_VERIFIED_ADAPTERS,
  CLAUDE_HOOK_VERIFIED_PAIRS,
  CLAUDE_HOOK_VERIFIED_PLATFORMS,
  LocalHost,
  claudePreToolHookSettings,
  openAcpSession,
  permissionPolicyPath,
  readPermissionPolicyFile,
  replacePermissionPolicyFile,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { makeSessionFactory } from "../src/bootstrap.js";

const ADAPTER = process.env["ORCA_CLAUDE_ADAPTER"];
/** A Claude Code executable that is not the one paired with the adapter (the workflow installs 2.1.329). */
const OTHER_RUNTIME = process.env["ORCA_CLAUDE_OTHER_RUNTIME"];
const COMMAND = "echo orca-704 >> marker.txt";
const CALL = `CALL:${JSON.stringify({ name: "Bash", input: { command: COMMAND, description: "mark" } })}`;

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** The Claude Code the adapter runs by default: the binary of the SDK it depends on exactly. */
function bundledRuntime(adapterPkg: string): string {
  const req = createRequire(join(adapterPkg, "package.json"));
  const sdk = join(req.resolve("@anthropic-ai/claude-agent-sdk"), "..");
  return createRequire(join(sdk, "package.json")).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  );
}

/* ------------------------------ the model stand-in ------------------------------ */

type Block = { type: string; text?: string };
type Message = { role: string; content: string | Block[] };

/**
 * A Messages endpoint that answers a prompt containing `CALL:{...}` with that tool call, and
 * anything that follows a tool result with "done". Streams, as Claude Code asks it to.
 */
function modelStandIn(): Promise<{ server: Server; url: string }> {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const request = JSON.parse(body) as { messages: Message[]; tools?: unknown[] };
      const blocks = (m: Message): Block[] =>
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const last = request.messages[request.messages.length - 1]!;
      const afterResult = blocks(last).some((b) => b.type === "tool_result");
      const text = request.messages
        .filter((m) => m.role === "user")
        .flatMap(blocks)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      const calls = [...text.matchAll(/CALL:(\{.*\})/g)];
      const call = calls.length
        ? (JSON.parse(calls[calls.length - 1]![1]!) as { name: string; input: unknown })
        : undefined;
      const id = `msg_${++n}`;
      const events: [string, unknown][] = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      ];
      let stop = "end_turn";
      if (!afterResult && call && request.tools?.length) {
        stop = "tool_use";
        events.push(
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: `toolu_${n}`, name: call.name, input: {} },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
            },
          ],
        );
      } else {
        events.push(
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
          ],
        );
      }
      events.push(
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
        ],
        ["message_stop", { type: "message_stop" }],
      );
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

/* ---------------------------------- the setup ---------------------------------- */

describe.skipIf(ADAPTER === undefined || OTHER_RUNTIME === undefined)("the hook in the real Claude Code (#704)", () => {
  let model: { server: Server; url: string };
  let hookScript: string;
  /** ORCA's output guard with something printing on stdout before an "allow" answer. */
  let strayScript: string;
  let root: string;
  let configDir: string;
  let workspace: string;
  let claudeConfig: string;

  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const stray = fileURLToPath(
      new URL("../../agents/test/fixtures/hook-output-guard/stray-write.ts", import.meta.url),
    );
    const built = childBundle("claude-pre-tool-hook-acceptance-704", { entries: { hook: entry, stray } });
    if (!built?.["hook"] || !built["stray"]) throw new Error("the hook program could not be built for this run");
    hookScript = built["hook"];
    strayScript = built["stray"];
  });

  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-704-acceptance-"));
    configDir = join(root, "config");
    workspace = join(root, "work");
    claudeConfig = join(root, "claude-config");
    await mkdir(configDir);
    await mkdir(workspace);
    await mkdir(claudeConfig);
    // Claude Code's own remembered grant for exactly the marker command.
    await writeFile(
      join(claudeConfig, "settings.json"),
      JSON.stringify({ permissions: { allow: [`Bash(${COMMAND})`] } }),
      "utf8",
    );
    // Claude Code can still be writing its own config as a closed session exits.
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const agent = (permissions: unknown = { rules: [] }, env: Record<string, string> = {}) =>
    AgentSpecSchema.parse({
      id: "claude",
      command: process.execPath,
      args: [ADAPTER],
      env: {
        ...env,
        ANTHROPIC_BASE_URL: model.url,
        ANTHROPIC_API_KEY: "sk-orca-704-test",
        CLAUDE_CONFIG_DIR: claudeConfig,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      permissions,
      nativeToolHook: "on",
    });

  const marks = async () =>
    (await readFile(join(workspace, "marker.txt"), "utf8").catch(() => "")).split("\n").filter((l) => l !== "").length;

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

  /* --------------------------------- the runs --------------------------------- */

  it("runs an adapter version and a platform ORCA installs the hook on", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER!, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(CLAUDE_HOOK_VERIFIED_ADAPTERS).toContain(pkg.version);
    expect(CLAUDE_HOOK_VERIFIED_PLATFORMS).toContain(process.platform);
  });

  it("runs the verified adapter with the Claude Code image pinned for it, and the factory admits it", async () => {
    const adapterPkg = join(ADAPTER!, "..", "..");
    const pkg = JSON.parse(await readFile(join(adapterPkg, "package.json"), "utf8")) as { version: string };
    const pair = CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === pkg.version);
    expect(pair?.images[`${process.platform}-${process.arch}`]).toBe(await sha256(bundledRuntime(adapterPkg)));
    // The factory finds the session's runtime process itself and hashes its image.
    const session = await factorySession();
    await session.close();
  });

  it("refuses the session, before any work, when the adapter runs another Claude Code", async () => {
    const pinned = CLAUDE_HOOK_VERIFIED_PAIRS.flatMap((p) => Object.values(p.images));
    expect(pinned).not.toContain(await sha256(OTHER_RUNTIME!));
    await expect(factorySession(undefined, { CLAUDE_CODE_EXECUTABLE: OTHER_RUNTIME! })).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(/is not the one ORCA verified[\s\S]*nativeToolHook: on/),
    });
    expect(await marks()).toBe(0);
    // Nothing of the refused session is left in ORCA's private directory.
    expect(await readdir(join(configDir, ".orca", "private-execution", "tool-hooks")).catch(() => [])).toEqual([]);
  });

  it("checks a remembered call every time, and asks through ORCA once a rule is added", async () => {
    asks.length = 0;
    // ORCA allows the command by a configured rule (it no longer keeps standing shell grants,
    // #702); Claude Code allows it by its own remembered grant.
    const session = await factorySession({
      rules: [{ match: { kind: "execute", titlePattern: "^echo orca-704" }, decision: "allow" }],
    });
    try {
      await session.prompt(CALL);
      await session.prompt(CALL);
      expect(await marks()).toBe(2);
      // Claude remembered the grant, so neither call asked anybody.
      expect(asks).toEqual([]);

      // A rule added to the live permission file mid-session applies to the very next call.
      const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
      await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
        ...doc,
        agents: { claude: { rules: [{ match: { kind: "execute", command: "echo" }, decision: "ask" }] } },
      });

      await session.prompt(CALL);
      // The hook's "ask" arrived at ORCA as a permission request, was refused, and nothing ran.
      expect(asks).toEqual([COMMAND]);
      expect(await marks()).toBe(2);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("blocks a remembered call that a configured rule denies, without asking", async () => {
    asks.length = 0;
    const session = await factorySession({
      rules: [{ match: { kind: "execute", titlePattern: "^echo orca-704" }, decision: "deny" }],
    });
    try {
      await session.prompt(CALL);
      expect(await marks()).toBe(0);
      expect(asks).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it.each([
    ["cannot start", { command: join(tmpdir(), "orca-704-no-such-hook"), args: [] }],
    ["crashes", { command: process.execPath, args: ["-e", "process.exit(1)"] }],
    ["times out", { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutSeconds: 2 }],
    ["exits with another code", { command: process.execPath, args: ["-e", "process.exit(3)"] }],
    [
      "prints a decision Claude Code does not know",
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'maybe'}}))",
        ],
      },
    ],
    [
      "prints JSON of the wrong shape",
      { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({hookSpecificOutput:5}))"] },
    ],
  ])(
    "blocks a remembered call when the hook %s",
    async (_what, hook) => {
      asks.length = 0;
      const session = await openAcpSession({
        host: new LocalHost({ id: "local", type: "local" }),
        agent: agent({ default: "allow", rules: [] }),
        cwd: workspace,
        askPermission,
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
        sessionMeta: async () => ({ claudeCode: { options: { settings: claudePreToolHookSettings(hook) } } }),
      });
      try {
        await session.prompt(CALL);
        expect(await marks()).toBe(0);
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it("blocks a remembered call when something in ORCA's hook program prints on stdout", async () => {
    const session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent({ default: "allow", rules: [] }),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
      sessionMeta: async () => ({
        claudeCode: {
          options: { settings: claudePreToolHookSettings({ command: process.execPath, args: [strayScript] }) },
        },
      }),
    });
    try {
      await session.prompt(CALL);
      expect(await marks()).toBe(0);
    } finally {
      await session.close();
    }
  }, 120_000);

  /**
   * Claude Code's own behaviour, pinned so a change in it is noticed: stdout that does not
   * parse as JSON is read as plain text, not as a failure, so a program that exits 0 with
   * garbage lets the call through. ORCA's hook program cannot do that: its output guard
   * (`bin/hook-output-guard.ts`) turns any stdout but its answer into exit 2, as the test
   * above shows through this same Claude Code.
   */
  it.each([
    ["truncated JSON", `process.stdout.write('{"continue": ')`],
    ["text", "process.stdout.write('garbage')"],
  ])(
    "lets the call through when a hook exits 0 printing %s",
    async (_what, script) => {
      const session = await openAcpSession({
        host: new LocalHost({ id: "local", type: "local" }),
        agent: agent({ default: "allow", rules: [] }),
        cwd: workspace,
        askPermission,
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
        sessionMeta: async () => ({
          claudeCode: {
            options: { settings: claudePreToolHookSettings({ command: process.execPath, args: ["-e", script] }) },
          },
        }),
      });
      try {
        await session.prompt(CALL);
        expect(await marks()).toBe(1);
      } finally {
        await session.close();
      }
    },
    120_000,
  );

  it.each([
    ["allowed by ORCA's policy, runs", { default: "allow", rules: [] }, 1],
    [
      "denied by an ORCA rule, does not run",
      { default: "allow", rules: [{ match: { kind: "other", titlePattern: "^marker: mark$" }, decision: "deny" }] },
      0,
    ],
  ] as const)(
    "serves the agent's MCP servers through ORCA, and a relayed tool %s; Claude Code never sees the command or its secret",
    async (_, permissions, runs) => {
      asks.length = 0;
      const secret = "orca-704-relay-secret";
      const serverFile = join(root, "mcp-server.cjs");
      const serverLog = join(root, "mcp-server.log");
      // A stdio MCP server of the 2025-06-18 era, with one tool that marks the workspace.
      await writeFile(
        serverFile,
        `const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(serverLog)}, (m.method || "response") + "\\n");
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "marker", version: "1" } } });
  else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "mark", description: "mark", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") {
    if (process.env.MARKER_TOKEN === ${JSON.stringify(secret)}) fs.appendFileSync("marker.txt", "mcp\\n");
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "marked" }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`,
      );
      // Claude Code allows the tool by its own settings, so the only gate is ORCA's.
      await writeFile(
        join(claudeConfig, "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__marker__mark"] } }),
        "utf8",
      );
      const spec = AgentSpecSchema.parse({
        ...agent(permissions, { ENABLE_TOOL_SEARCH: "false" }),
        mcpServers: [{ name: "marker", command: process.execPath, args: [serverFile], env: { MARKER_TOKEN: secret } }],
      });
      const session = await makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
        runtime: process.execPath,
        script: hookScript,
      })({
        host: new LocalHost({ id: "local", type: "local" }),
        agent: spec,
        cwd: workspace,
        askPermission,
        logger: silentLogger,
        handshakeTimeoutMs: 60_000,
      });
      try {
        await session.prompt(`CALL:${JSON.stringify({ name: "mcp__marker__mark", input: {} })}`);
        expect(await marks()).toBe(runs);
        expect(asks).toEqual([]);
      } finally {
        await session.close();
      }
      const log = (await readFile(serverLog, "utf8")).split("\n");
      expect(log).toEqual(expect.arrayContaining(["initialize", "notifications/initialized", "tools/list"]));
      // A denied call is stopped before it reaches the server at all.
      expect(log.includes("tools/call")).toBe(runs === 1);
      // Claude Code's own record of its MCP servers names the ORCA-served one and nothing else.
      const files = await readdir(claudeConfig, { recursive: true });
      for (const f of files) {
        const text = await readFile(join(claudeConfig, f), "utf8").catch(() => "");
        expect(text).not.toContain(secret);
        expect(text).not.toContain("mcp-server.cjs");
      }
    },
    120_000,
  );

  it("runs the remembered call when the hook defers, so the failures above are the hook's", async () => {
    const session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent({ default: "allow", rules: [] }),
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
      sessionMeta: async () => ({
        claudeCode: {
          options: { settings: claudePreToolHookSettings({ command: process.execPath, args: ["-e", "0"] }) },
        },
      }),
    });
    try {
      await session.prompt(CALL);
      expect(await marks()).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);
});
