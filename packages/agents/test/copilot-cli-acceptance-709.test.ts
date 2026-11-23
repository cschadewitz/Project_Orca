/**
 * ORCA against the real GitHub Copilot CLI over ACP (#709, support levels A and B), with a
 * scripted local stand-in for the model, so no GitHub account, Copilot plan, key or model
 * spend is involved: Copilot's own bring-your-own-model mode (`COPILOT_OFFLINE=true`,
 * `COPILOT_PROVIDER_BASE_URL`) points it at the stand-in. `copilot-cli-acceptance.yml`
 * installs the pinned Copilot and runs this with `ORCA_COPILOT_CLI` set to its executable;
 * without it there is nothing to run.
 *
 * Every session is opened the way the daemon opens one: `openAcpSession` behind the Copilot
 * provider guard. Each tool call is a shell command or file write in a fresh workspace, and
 * what it did is read from the workspace afterwards, independently of anything Copilot or
 * ORCA reports. Copilot's own state directory is fresh per test too, and is read afterwards
 * for saved approvals.
 *
 * The prompt carries `SCRIPT:[...]`, one entry per model call in that conversation: either
 * `{ "tools": [{ "name", "args" }] }` (tool calls) or `{ "text" }` (a reply). After the
 * script runs out the stand-in replies with the tool results it was given.
 */
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec } from "@orca/core";
import {
  COPILOT_CLI_VERIFIED_VERSIONS,
  LocalHost,
  copilotCliGuard,
  openAcpSession,
  parseCopilotCliVersion,
  probeCopilotCliVersion,
  withProviderGuards,
  type AgentSession,
  type OpenSessionOptions,
  type SessionUpdateEvent,
} from "@orca/agents";

const COPILOT = process.env["ORCA_COPILOT_CLI"];

/* ------------------------------ the model stand-in ------------------------------ */

type Step = { tools?: { name: string; args: unknown }[]; text?: string; status?: number };
type ChatMessage = { role: string; content?: unknown };

function textOf(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((c: { text?: string }) => c.text ?? "").join("");
  return "";
}

/** An OpenAI chat-completions endpoint that plays the script in the conversation's prompt. */
async function modelStandIn(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const request = JSON.parse(body || "{}") as { model?: string; messages?: ChatMessage[] };
      const messages = request.messages ?? [];
      // The latest prompt that carries a script, and the model calls made since it.
      const at = messages.findLastIndex((m) => m.role === "user" && textOf(m).includes("SCRIPT:"));
      const scripted = at >= 0 ? /SCRIPT:(\[.*\])/.exec(textOf(messages[at]!)) : null;
      const steps = scripted ? (JSON.parse(scripted[1]!) as Step[]) : [{ text: "ok" }];
      const turn = messages.slice(Math.max(at, 0)).filter((m) => m.role === "assistant").length;
      const step: Step = steps[turn] ?? {
        text: `results: ${messages
          .filter((m) => m.role === "tool")
          .map((m) => textOf(m).slice(0, 200))
          .join(" | ")}`,
      };
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = `chatcmpl-${turn}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (step.tools) {
        chunk({
          role: "assistant",
          content: null,
          tool_calls: step.tools.map((t, i) => ({
            index: i,
            id: `call_${turn}_${i}`,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          })),
        });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: step.text ?? "ok" });
        chunk({}, "stop");
      }
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

/* ------------------------------ helpers ------------------------------ */

let model: { server: Server; url: string };
const roots: string[] = [];

beforeAll(async () => {
  if (COPILOT) model = await modelStandIn();
});
afterAll(async () => {
  model?.server.close();
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => undefined);
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

interface Opened {
  session: AgentSession;
  workspace: string;
  home: string;
  asks: acp.RequestPermissionRequest[];
  updates: SessionUpdateEvent[];
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  name: "bash",
  args: { command, description: "scripted", ...extra },
});
const script = (...steps: Step[]) => `SCRIPT:${JSON.stringify(steps)}`;

/** The profile docs/agents/copilot-cli.md gives, plus the stand-in model. */
function profile(home: string, permissions?: unknown): AgentSpec {
  return AgentSpecSchema.parse({
    id: "copilot",
    command: COPILOT,
    args: ["--acp", "--stdio", "--no-auto-update", "--disable-builtin-mcps", "--no-ask-user"],
    env: {
      COPILOT_HOME: home,
      COPILOT_AUTO_UPDATE: "false",
      COPILOT_ALLOW_ALL: "false",
      COPILOT_OFFLINE: "true",
      COPILOT_PROVIDER_BASE_URL: model.url,
      COPILOT_MODEL: "orca-stand-in",
      // No login: the stand-in is the provider. Keep Copilot's login-shell probe out of the run.
      COPILOT_DISABLE_LOGIN_SHELL_ENV: "1",
    },
    ...(permissions ? { permissions } : {}),
  });
}

async function openCopilot(
  answer: (r: acp.RequestPermissionRequest) => string | undefined,
  opts: { permissions?: unknown; guarded?: boolean } = {},
): Promise<Opened> {
  const root = await mkdtemp(join(tmpdir(), "orca-copilot-accept-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "copilot-home");
  await mkdir(workspace);
  await writeFile(join(workspace, "existing.txt"), "hello\n");
  const asks: acp.RequestPermissionRequest[] = [];
  const options: OpenSessionOptions = {
    host: new LocalHost({ id: "local", type: "local" }),
    agent: profile(home, opts.permissions),
    cwd: workspace,
    handshakeTimeoutMs: 60_000,
    askPermission: async (request) => {
      asks.push(request);
      return answer(request);
    },
  };
  const open =
    opts.guarded === false
      ? openAcpSession
      : withProviderGuards(openAcpSession, [copilotCliGuard({ environment: () => ({}) })]);
  const session = await open(options);
  const updates: SessionUpdateEvent[] = [];
  session.onUpdate((e) => updates.push(e));
  return { session, workspace, home, asks, updates };
}

const pick = (kind: string) => (r: acp.RequestPermissionRequest) => r.options.find((o) => o.kind === kind)?.optionId;

/** Saved approvals Copilot would apply without asking: none may appear. */
async function savedApprovals(home: string): Promise<string[]> {
  const names = await readdir(home).catch(() => [] as string[]);
  return names.filter((n) => n === "permissions-config.json" || n === "settings.json");
}

/* ------------------------------ the suite ------------------------------ */

describe.skipIf(!COPILOT)("Copilot CLI over ACP, real executable (#709)", { timeout: 120_000 }, () => {
  it("is the pinned version", async () => {
    const version = parseCopilotCliVersion(await probeCopilotCliVersion(COPILOT!, process.env));
    expect(COPILOT_CLI_VERIFIED_VERSIONS).toContain(version);
  });

  describe("A: connectivity", () => {
    it("opens a session, streams a reply and ends the turn", async () => {
      const o = await openCopilot(() => undefined);
      try {
        expect(o.session.acpSessionId).not.toBe("");
        expect(o.session.acpSessionId).not.toBe(o.session.id);
        expect(o.session.configOptions.find((c) => c.id === "allow_all")).toMatchObject({ currentValue: "off" });
        const turn = await o.session.prompt(script({ text: "hello from the stand-in" }));
        expect(turn.stopReason).toBe("end_turn");
        const text = o.updates
          .filter((u) => u.raw.sessionUpdate === "agent_message_chunk")
          .map((u) => u.summary.text)
          .join("");
        expect(text).toContain("hello from the stand-in");
        expect(o.updates.every((u) => u.sessionId === o.session.acpSessionId)).toBe(true);
        // The session takes a second turn.
        expect((await o.session.prompt(script({ text: "again" }))).stopReason).toBe("end_turn");
      } finally {
        await o.session.close();
      }
    });

    it("reports a model error as a message and ends the turn; the session stays usable", async () => {
      const o = await openCopilot(() => undefined);
      try {
        const turn = await o.session.prompt(script({ status: 400 }));
        expect(turn.stopReason).toBe("end_turn");
        const text = o.updates.map((u) => u.summary.text ?? "").join("");
        expect(text).toMatch(/error/i);
        expect((await o.session.prompt(script({ text: "after" }))).stopReason).toBe("end_turn");
      } finally {
        await o.session.close();
      }
    });

    it("cancels a running command: the turn stops and the command's effect never happens", async () => {
      const o = await openCopilot(pick("allow_once"));
      try {
        const turn = o.session.prompt(script({ tools: [bash("sleep 6; touch late-marker", { initial_wait: 30 })] }));
        await expect.poll(() => o.asks.length, { timeout: 30_000 }).toBe(1);
        await sleep(1_500);
        await o.session.cancel();
        expect((await turn).stopReason).toBe("cancelled");
        await sleep(8_000);
        expect(await exists(join(o.workspace, "late-marker"))).toBe(false);
      } finally {
        await o.session.close();
      }
    });
  });

  describe("B: controlled approval", () => {
    it("offers once, always and deny, and a denied command does not run", async () => {
      const o = await openCopilot(pick("reject_once"));
      try {
        await o.session.prompt(script({ tools: [bash("touch denied-marker")] }));
        expect(o.asks).toHaveLength(1);
        expect(o.asks[0]!.options.map((x) => [x.optionId, x.kind])).toEqual([
          ["allow_once", "allow_once"],
          ["allow_always", "allow_always"],
          ["reject_once", "reject_once"],
        ]);
        expect(o.asks[0]!.toolCall).toMatchObject({ kind: "execute", rawInput: { command: "touch denied-marker" } });
        expect(await exists(join(o.workspace, "denied-marker"))).toBe(false);
      } finally {
        await o.session.close();
      }
    });

    it("an allowed command runs", async () => {
      const o = await openCopilot(pick("allow_once"));
      try {
        await o.session.prompt(script({ tools: [bash("touch allowed-marker")] }));
        expect(o.asks).toHaveLength(1);
        expect(await exists(join(o.workspace, "allowed-marker"))).toBe(true);
      } finally {
        await o.session.close();
      }
    });

    it("a configured deny rule refuses without asking anybody, and nothing runs", async () => {
      const o = await openCopilot(pick("allow_once"), {
        permissions: { rules: [{ match: { kind: "execute" }, decision: "deny" }] },
      });
      try {
        await o.session.prompt(script({ tools: [bash("touch ruled-marker")] }));
        expect(o.asks).toHaveLength(0);
        expect(await exists(join(o.workspace, "ruled-marker"))).toBe(false);
      } finally {
        await o.session.close();
      }
    });

    it("an 'always' answer is sent as 'once': the next command is asked about again and nothing is saved", async () => {
      const o = await openCopilot(pick("allow_always"));
      try {
        await o.session.prompt(
          script({ tools: [bash("touch always-1")] }, { tools: [bash("touch always-2")] }, { text: "done" }),
        );
        expect(o.asks.map((a) => (a.toolCall.rawInput as { command: string }).command)).toEqual([
          "touch always-1",
          "touch always-2",
        ]);
        expect(await exists(join(o.workspace, "always-1"))).toBe(true);
        expect(await exists(join(o.workspace, "always-2"))).toBe(true);
        expect(await savedApprovals(o.home)).toEqual([]);
      } finally {
        await o.session.close();
      }
    });

    it("a file write is asked about and a denied write leaves no file", async () => {
      const o = await openCopilot(pick("reject_once"), { permissions: { default: "ask" } });
      try {
        const path = join(o.workspace, "new.txt");
        await o.session.prompt(script({ tools: [{ name: "create", args: { path, file_text: "x" } }] }));
        expect(o.asks).toHaveLength(1);
        expect(o.asks[0]!.toolCall.kind).toBe("edit");
        expect(await exists(path)).toBe(false);
      } finally {
        await o.session.close();
      }
    });

    it("a subagent's command is asked about in this session, and denied it does not run", async () => {
      const o = await openCopilot(pick("reject_once"));
      try {
        const sub = script({ tools: [bash("touch sub-marker")] });
        await o.session.prompt(
          script({
            tools: [
              {
                name: "task",
                args: { description: "sub work", name: "sub", prompt: `SUB ${sub}`, agent_type: "general-purpose" },
              },
            ],
          }),
        );
        expect(o.asks.map((a) => a.sessionId)).toEqual([o.session.acpSessionId]);
        expect(await exists(join(o.workspace, "sub-marker"))).toBe(false);
      } finally {
        await o.session.close();
      }
    });

    it("ORCA refuses a prompt that starts with a slash command", async () => {
      const o = await openCopilot(pick("reject_once"));
      try {
        await expect(o.session.prompt("/allow-all on")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
        await expect(o.session.setConfigOption("allow_all", "on")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
        // Still asked about afterwards.
        await o.session.prompt(script({ tools: [bash("touch after-slash")] }));
        expect(o.asks).toHaveLength(1);
        expect(await exists(join(o.workspace, "after-slash"))).toBe(false);
      } finally {
        await o.session.close();
      }
    });
  });

  describe("known routes outside ORCA's asks (pinned so a change is noticed)", () => {
    it("without the guard, '/allow-all on' in a prompt turns asks off and the next command runs unasked", async () => {
      const o = await openCopilot(pick("reject_once"), { guarded: false });
      try {
        await o.session.prompt("/allow-all on");
        await o.session.prompt(script({ tools: [bash("touch unasked-marker")] }));
        expect(o.asks).toHaveLength(0);
        expect(await exists(join(o.workspace, "unasked-marker"))).toBe(true);
      } finally {
        await o.session.close();
      }
    });

    it("a command Copilot calls read-only runs without an ask", async () => {
      const o = await openCopilot(pick("reject_once"));
      try {
        await o.session.prompt(script({ tools: [bash("cat existing.txt")] }));
        expect(o.asks).toHaveLength(0);
        const results = o.updates.map((u) => JSON.stringify(u.raw)).join("");
        expect(results).toContain("hello");
      } finally {
        await o.session.close();
      }
    });
  });
});
