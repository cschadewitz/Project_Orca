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
 * It runs on Linux against each adapter version in `CLAUDE_HOOK_VERIFIED_ADAPTERS`, which are
 * the only versions and the only platform ORCA installs the hook on.
 */
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import {
  CLAUDE_HOOK_VERIFIED_ADAPTERS,
  CLAUDE_HOOK_VERIFIED_PLATFORMS,
  LocalHost,
  claudePreToolHookSettings,
  openAcpSession,
  permissionPolicyPath,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { makeSessionFactory } from "../src/bootstrap.js";

const ADAPTER = process.env["ORCA_CLAUDE_ADAPTER"];
const COMMAND = "echo orca-704 >> marker.txt";
const CALL = `CALL:${JSON.stringify({ name: "Bash", input: { command: COMMAND, description: "mark" } })}`;

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

describe.skipIf(ADAPTER === undefined)("the hook in the real Claude Code (#704)", () => {
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
    return () => rm(root, { recursive: true, force: true });
  });

  const agent = (permissions: unknown = { rules: [] }) =>
    AgentSpecSchema.parse({
      id: "claude",
      command: process.execPath,
      args: [ADAPTER],
      env: {
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

  const factorySession = (permissions?: unknown): Promise<AgentSession> =>
    makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
      runtime: process.execPath,
      script: hookScript,
    })({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: agent(permissions),
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

  it("checks a remembered call every time, and asks through ORCA once the grant is revoked", async () => {
    asks.length = 0;
    await recordAlwaysDecision({
      file: permissionPolicyPath(configDir),
      agentId: "claude",
      request: {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: COMMAND, kind: "execute" },
        options: [{ optionId: "a", name: "Always", kind: "allow_always" }],
      },
      decision: "allow",
      workspaceCwd: workspace,
    });
    const session = await factorySession();
    try {
      await session.prompt(CALL);
      await session.prompt(CALL);
      expect(await marks()).toBe(2);
      // Claude remembered the grant, so neither call asked anybody.
      expect(asks).toEqual([]);

      const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
      await replacePermissionPolicyFile(permissionPolicyPath(configDir), { ...doc, agents: { claude: { rules: [] } } });

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
