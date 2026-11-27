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
 *   Read outside the workspace is asked by Claude Code and answered no;
 * - with a person answering: a Bash they allow runs, once, and the next identical one is asked
 *   again; one they decline does not run and the model is told why; a rule's ask reaches them
 *   for a read Claude would have run by itself;
 * - cancel ends a turn as `cancelled`, and close leaves no Claude Code process behind.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, configOptionValues } from "@orca/core";
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

    it("runs a Read in the workspace; denies Bash, Grep and a Read outside it", async () => {
      const session = await open();
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
