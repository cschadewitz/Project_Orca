/**
 * The Claude Agent SDK driver (#1120) against a real Claude Code, with a scripted local
 * stand-in for the model, so no account, key or model spend is involved.
 * `claude-sdk-acceptance.yml` installs a pinned Claude Code outside the workspace and runs this
 * with `ORCA_CLAUDE_SDK_CLAUDE` set to its executable; without it there is nothing to run.
 *
 * Sessions open through the same session factory a shipped daemon uses, with the agent's own
 * `env` pointing Claude Code at the stand-in (`ANTHROPIC_BASE_URL`, a fake key) and at an
 * empty config directory, so neither the runner's nor anybody's login is read.
 *
 * What is observed on the real Claude Code:
 * - the launch checks pass, a turn runs and ends on Claude's result, with the text reported;
 * - Claude Code's own model list reaches the session's `model` option, and choosing a model
 *   or an effort changes what Claude Code sends the model;
 * - ORCA's permission answers (#1122) with nobody to answer: a Read inside the workspace runs,
 *   Bash is asked and denied before it runs (the marker file never appears), Grep is denied, a
 *   Read outside the workspace is asked by Claude Code and answered no; ORCA's in-process hook
 *   (#1123) records one telemetry line for each of those calls;
 * - with a person answering: a Bash they allow runs, once, and the next identical one is asked
 *   again; one they decline does not run and the model is told why; a rule's ask reaches them
 *   for a read Claude would have run by itself;
 * - a closed session resumed by its id (#1121) continues its transcript: the model sees the
 *   earlier turn; a required resume of an unknown id is refused as a failed load;
 * - a checkout's `.claude/settings.json` and `settings.local.json` do not load (#1126): its
 *   hooks do not run and its permission rules do not apply;
 * - an ORCA-run MCP server is served to Claude in process (#1125): the person is asked about the
 *   tool call once, ORCA's relay runs the real server, and a checkout's `.mcp.json` does not load;
 * - with `nativeToolHook: experimental` the pinned Claude Code is attested and opens (#1124), and
 *   a copy of it one byte longer, reporting the same version, is refused;
 * - cancel ends a turn as `cancelled`, and close leaves no Claude Code process behind.
 */
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, configOptionValues, type HookTelemetryLine } from "@orca/core";
import { LocalHost, type AgentSession, type SessionUpdateEvent } from "@orca/agents";
import { makeSessionFactory } from "../src/bootstrap.js";

const CLAUDE = process.env["ORCA_CLAUDE_SDK_CLAUDE"];

type Block = { type: string; text?: string; content?: unknown; is_error?: boolean };
type Message = { role: string; content: string | Block[] };
interface Request {
  model: string;
  messages: Message[];
  tools?: { name: string }[];
  output_config?: { effort?: string };
  thinking?: unknown;
}

/**
 * A Messages endpoint. A prompt holding `CALL:{...}` is answered with that tool call; anything
 * after a tool result, or any other prompt, with "done: " and the last tool result's text. A
 * prompt holding `SLOW` is answered only after a long wait (or never, when the turn is cancelled
 * and the request goes away). Every request body is kept.
 */
function modelStandIn(): Promise<{ server: Server; url: string; requests: Request[] }> {
  const requests: Request[] = [];
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
      const request = JSON.parse(body) as Request;
      const blocks = (m: Message): Block[] =>
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const userText = request.messages
        .filter((m) => m.role === "user")
        .flatMap(blocks)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      // Claude Code's side requests (titles, summaries) carry no tools: answer them plainly.
      const main = (request.tools?.length ?? 0) > 0;
      if (main) requests.push(request);
      const last = request.messages[request.messages.length - 1]!;
      const result = blocks(last).find((b) => b.type === "tool_result");
      const calls = [...userText.matchAll(/CALL:(\{.*\})/g)];
      const call =
        main && !result && calls.length
          ? (JSON.parse(calls[calls.length - 1]![1]!) as { name: string; input: unknown })
          : undefined;
      const resultText = result
        ? typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content)
        : "";
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
              model: request.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      ];
      let stop = "end_turn";
      if (call) {
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
        const text = `done: ${resultText}`.slice(0, 2000);
        events.push(
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
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
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      };
      if (main && /\bSLOW\b/.test(userText) && !result) setTimeout(send, 60_000).unref();
      else send();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }),
    ),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(CLAUDE !== undefined && process.platform !== "win32")(
  "Claude Agent SDK driver on a real Claude Code (#1120)",
  () => {
    let root: string;
    let workspace: string;
    let outside: string;
    let model: Awaited<ReturnType<typeof modelStandIn>>;

    beforeAll(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-acceptance-")));
      workspace = join(root, "workspace");
      outside = join(root, "outside");
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      await mkdir(join(root, "claude-config"), { recursive: true });
      await writeFile(join(workspace, "notes.txt"), "orca-1120-inside\n");
      await writeFile(join(outside, "secret.txt"), "orca-1120-outside\n");
      model = await modelStandIn();
    });
    afterAll(async () => {
      model.server.close();
      // Claude Code can still be writing its own config as a closed session exits.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    const open = (
      extra: Partial<Parameters<ReturnType<typeof makeSessionFactory>>[0]> = {},
      permissions?: unknown,
      agentExtra: Record<string, unknown> = {},
    ): Promise<AgentSession> => {
      const factory = makeSessionFactory({ configDir: join(root, "orca"), storeDir: ".orca" }, () =>
        Promise.reject(new Error("ACP opened")),
      );
      const agent = AgentSpecSchema.parse({
        id: "claude",
        driver: "claude-agent-sdk",
        command: CLAUDE,
        env: {
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: "sk-orca-1120-test",
          CLAUDE_CONFIG_DIR: join(root, "claude-config"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        ...(permissions ? { permissions } : {}),
        ...agentExtra,
      });
      return factory({ host: new LocalHost({ id: "local", type: "local" }), agent, cwd: workspace, ...extra });
    };

    const texts = (events: SessionUpdateEvent[]) =>
      events.filter((e) => e.summary.kind === "agent_message_chunk").map((e) => e.summary.text ?? "");

    it("runs a turn, and a chosen model and effort reach what Claude Code sends", async () => {
      const session = await open();
      try {
        const events: SessionUpdateEvent[] = [];
        session.onUpdate((e) => events.push(e));
        const modelOption = session.configOptions.find((o) => o.category === "model")!;
        const offered = configOptionValues(modelOption).map((o) => o.value);
        expect(offered).toContain("sonnet");

        expect((await session.prompt("hello")).stopReason).toBe("end_turn");
        expect(texts(events).join("")).toContain("done");

        const before = model.requests.length;
        await session.setConfigOption(modelOption.id, "sonnet");
        const effort = session.configOptions.find((o) => o.category === "thought_level");
        expect(effort).toBeDefined();
        await session.setConfigOption(effort!.id, "low");
        expect((await session.prompt("hello again")).stopReason).toBe("end_turn");
        const sent = model.requests.slice(before);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((r) => /sonnet/.test(r.model))).toBe(true);
        expect(sent.some((r) => r.output_config?.effort === "low")).toBe(true);
      } finally {
        await session.close();
      }
      await session.terminated;
    });

    it("runs a Read in the workspace; denies Bash, Grep and a Read outside it; the hook records each (#1123)", async () => {
      const session = await open({}, undefined, { diagnostics: { toolCalls: "keep" } });
      const lines: HookTelemetryLine[] = [];
      session.hookTelemetry!.attach((l) => {
        lines.push(...l);
        return Promise.resolve();
      });
      try {
        const events: SessionUpdateEvent[] = [];
        session.onUpdate((e) => events.push(e));
        const call = (name: string, input: unknown) => `CALL:${JSON.stringify({ name, input })}`;

        await session.prompt(call("Read", { file_path: join(workspace, "notes.txt") }));
        expect(texts(events).join("")).toContain("orca-1120-inside");

        await session.prompt(call("Bash", { command: `echo x > ${join(workspace, "marker.txt")}`, description: "m" }));
        await expect(readFile(join(workspace, "marker.txt"), "utf8")).rejects.toThrow(/ENOENT/);

        await session.prompt(call("Grep", { pattern: "orca", path: workspace }));
        await session.prompt(call("Read", { file_path: join(outside, "secret.txt") }));

        const updates = events.filter((e) => e.summary.kind === "tool_call_update").map((e) => e.summary.status);
        expect(updates).toEqual(["completed", "failed", "failed", "failed"]);
        expect(texts(events).join("")).not.toContain("orca-1120-outside");
      } finally {
        await session.close();
      }
      // ORCA's in-process hook saw every call real Claude made, and recorded what it decided.
      // (This Claude Code has no Grep tool: it refuses that call before any hook, and runs nothing.)
      expect(lines.map((l) => [l.tool, l.decision, l.rule])).toEqual([
        ["Read", "allow", "policy"],
        ["Bash", "ask", "policy"],
        ["Read", "ask", "policy"],
      ]);
      for (const line of lines) expect(line.toolUseId).toMatch(/^toolu_/);
    });

    it("asks the person, allows once only, and tells the model when they decline", async () => {
      const asked: string[] = [];
      let answer = "allow";
      const session = await open(
        {
          askPermission: (request) => {
            asked.push(request.toolCall.title ?? "");
            return Promise.resolve(
              request.options.find((o) => o.kind === (answer === "allow" ? "allow_once" : "reject_once"))!.optionId,
            );
          },
        },
        { rules: [{ match: { kind: "read", titlePattern: "^Read notes\\.txt$" }, decision: "ask" }] },
      );
      try {
        const events: SessionUpdateEvent[] = [];
        session.onUpdate((e) => events.push(e));
        const call = (name: string, input: unknown) => `CALL:${JSON.stringify({ name, input })}`;
        const marker = join(workspace, "allowed.txt");
        const bash = call("Bash", { command: `echo x >> ${marker}`, description: "m" });

        await session.prompt(bash);
        expect(await readFile(marker, "utf8")).toBe("x\n");
        // Allowed once: Claude remembers nothing, and the same command is asked again.
        await session.prompt(bash);
        expect(await readFile(marker, "utf8")).toBe("x\nx\n");
        expect(asked.filter((t) => t.startsWith("echo x"))).toHaveLength(2);

        answer = "reject";
        const before = model.requests.length;
        await session.prompt(
          call("Bash", { command: `echo y > ${join(workspace, "declined.txt")}`, description: "m" }),
        );
        await expect(readFile(join(workspace, "declined.txt"), "utf8")).rejects.toThrow(/ENOENT/);
        // The model is told the person declined it.
        const told = JSON.stringify(model.requests.slice(before).map((r) => r.messages.at(-1)));
        expect(told).toContain("The person declined this tool call.");

        // A read Claude would run by itself still reaches the person when a rule asks about it.
        await session.prompt(call("Read", { file_path: join(workspace, "notes.txt") }));
        expect(asked.at(-1)).toBe("Read notes.txt");
        expect(texts(events).join("")).not.toContain("orca-1120-inside");
      } finally {
        await session.close();
      }
    });

    it("resumes a closed session's transcript, and refuses a required resume of an unknown one (#1121)", async () => {
      const first = await open();
      let id: string;
      try {
        expect((await first.prompt("remember orca-1121-alpha")).stopReason).toBe("end_turn");
        id = first.acpSessionId;
      } finally {
        await first.close();
      }
      await first.terminated;

      const continuity: unknown[] = [];
      const resumed = await open({
        resumeSessionId: id,
        requireContextRecovery: true,
        onSessionContinuity: (c) => continuity.push(c),
      });
      try {
        expect(continuity).toEqual([{ mode: "loaded", reason: "load-supported" }]);
        expect(resumed.acpSessionId).toBe(id);
        const before = model.requests.length;
        expect((await resumed.prompt("and now orca-1121-beta")).stopReason).toBe("end_turn");
        const sent = JSON.stringify(model.requests.slice(before).map((r) => r.messages));
        // The model sees the earlier turn before the new one.
        expect(sent).toContain("orca-1121-alpha");
        expect(sent.indexOf("orca-1121-alpha")).toBeLessThan(sent.indexOf("orca-1121-beta"));
      } finally {
        await resumed.close();
      }

      const refused = await open({ resumeSessionId: crypto.randomUUID(), requireContextRecovery: true }).then(
        () => undefined,
        (e: unknown) => e as { code?: string; details?: unknown },
      );
      expect(refused?.code).toBe("AGENT_PROTOCOL");
      expect(refused?.details).toEqual({ contextRecoveryReason: "load-failed" });
    });

    it("loads none of a checkout's Claude settings: its hooks do not run, its rules do not apply (#1126)", async () => {
      const checkout = join(root, "checkout");
      const hookMarker = join(root, "project-hook-ran");
      await mkdir(join(checkout, ".claude"), { recursive: true });
      await writeFile(join(checkout, "notes.txt"), "orca-1126-checkout\n");
      const settings = {
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `touch ${hookMarker}` }] }] },
        permissions: { deny: ["Read"] },
      };
      await writeFile(join(checkout, ".claude", "settings.json"), JSON.stringify(settings));
      await writeFile(join(checkout, ".claude", "settings.local.json"), JSON.stringify(settings));
      const session = await open({ cwd: checkout });
      try {
        const events: SessionUpdateEvent[] = [];
        session.onUpdate((e) => events.push(e));
        await session.prompt(
          `CALL:${JSON.stringify({ name: "Read", input: { file_path: join(checkout, "notes.txt") } })}`,
        );
        // A loaded `deny: Read` would have refused this; a loaded hook would have left its marker.
        expect(texts(events).join("")).toContain("orca-1126-checkout");
        await expect(readFile(hookMarker, "utf8")).rejects.toThrow(/ENOENT/);
      } finally {
        await session.close();
      }
    });

    it("serves ORCA's MCP server to Claude in process, and no other MCP config loads (#1125)", async () => {
      const serverLog = join(root, "mcp-server.log");
      const script = join(root, "mcp-server.cjs");
      await writeFile(
        script,
        `const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.SERVER_LOG, (m.method || "response") + "\\n");
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real", version: "1" } } });
  else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "t", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call")
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "orca-1125-served token=" + process.env.MCP_TOKEN }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`,
      );
      // A checkout's own MCP config, which must not load.
      const checkout = join(root, "mcp-checkout");
      await mkdir(checkout, { recursive: true });
      await writeFile(
        join(checkout, ".mcp.json"),
        JSON.stringify({ mcpServers: { "orca-1125-project": { command: "/bin/true" } } }),
      );
      // A credential only the server is given, which it echoes back: it must not reach Claude.
      const token = "orca-1125-synthetic-mcp-credential";
      const tokenFile = join(root, "mcp-token");
      await writeFile(tokenFile, `${token}\n`);
      const asked: string[] = [];
      const session = await open(
        {
          cwd: checkout,
          secrets: { "mcp-token": { host: "local", provider: "file", path: tokenFile } },
          authorizeSecretUse: () => Promise.resolve(),
          askPermission: (request) => {
            asked.push(request.toolCall.title ?? "");
            return Promise.resolve(request.options.find((o) => o.kind === "allow_once")!.optionId);
          },
        },
        undefined,
        {
          mcpServers: [
            {
              name: "orca-tools",
              command: process.execPath,
              args: [script],
              env: { SERVER_LOG: serverLog, MCP_TOKEN: { secret: "mcp-token" } },
            },
          ],
        },
      );
      try {
        const events: SessionUpdateEvent[] = [];
        session.onUpdate((e) => events.push(e));
        const before = model.requests.length;
        await session.prompt(`CALL:${JSON.stringify({ name: "mcp__orca-tools__touch", input: {} })}`);
        expect(texts(events).join("")).toContain("orca-1125-served");
        expect(asked).toEqual(["orca-tools: touch"]);
        expect(await readFile(serverLog, "utf8")).toContain("tools/call");
        const sent = JSON.stringify(model.requests.slice(before));
        expect(sent).not.toContain("orca-1125-project");
        // The server had its credential, and the answer Claude saw had it taken out.
        expect(sent).toContain("orca-1125-served token=[REDACTED]");
        expect(sent).not.toContain(token);
        expect(JSON.stringify(events)).not.toContain(token);
      } finally {
        await session.close();
      }
      // Nor did it reach Claude's saved transcript.
      expect(await filesContaining(join(root, "claude-config"), token)).toEqual([]);
    });

    it("attests the pinned Claude Code it starts, and refuses another image of the same version (#1124)", async () => {
      // nativeToolHook: experimental requires the attested pair: the pinned Claude Code verifies.
      const session = await open({}, undefined, { nativeToolHook: "experimental" });
      try {
        expect((await session.prompt("hello")).stopReason).toBe("end_turn");
      } finally {
        await session.close();
      }
      // The same version, one byte longer: `claude --version` still says the pinned version.
      const altered = join(root, "altered-claude");
      await copyFile(CLAUDE!, altered);
      await appendFile(altered, Buffer.from([0]));
      await chmod(altered, 0o755);
      try {
        await expect(open({}, undefined, { nativeToolHook: "experimental", command: altered })).rejects.toThrow(
          /not one ORCA verified: the image it runs is not the one ORCA verified for Claude Code/,
        );
      } finally {
        await rm(altered, { force: true });
      }
    });

    it("cancels a turn, and close leaves no Claude Code behind", async () => {
      const session = await open();
      const before = new Set(model.requests);
      const turn = session.prompt("SLOW");
      const end = Date.now() + 30_000;
      while (![...model.requests].some((r) => !before.has(r)) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 100));
      await session.cancel();
      expect((await turn).stopReason).toBe("cancelled");
      const pids = await claudePids(root);
      expect(pids.length).toBeGreaterThan(0);
      await session.close();
      await session.terminated;
      for (const pid of pids) expect(alive(pid)).toBe(false);
    });
  },
);

/** Files under `dir` whose text holds `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const hits: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    if ((await readFile(path, "utf8").catch(() => "")).includes(needle)) hits.push(path);
  }
  return hits;
}

/** Processes whose command line names this test's config directory: the session's Claude Code. */
async function claudePids(root: string): Promise<number[]> {
  const { readdir } = await import("node:fs/promises");
  const pids: number[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
    if (environ.includes(join(root, "claude-config"))) pids.push(Number(entry));
  }
  return pids;
}
