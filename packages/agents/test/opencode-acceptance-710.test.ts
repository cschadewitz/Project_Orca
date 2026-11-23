/**
 * #710 OpenCode acceptance against the installed binary (tiers A and B).
 *
 * Runs only when `ORCA_OPENCODE_BIN` names the verified OpenCode 1.19.4 executable, which
 * `.github/workflows/opencode-acceptance.yml` downloads, checks against the pinned npm
 * integrity and extracts without running any package script. Set `ORCA_REQUIRE_OPENCODE=1`
 * (the workflow does) to fail instead of skipping when it is missing.
 *
 * The model is a scripted stand-in: a local OpenAI-compatible endpoint on loopback that answers
 * each turn with the tool calls the prompt names (`SCRIPT [...]`), then with text once every
 * call has a result. No account, key or model spend is involved. Everything else is real:
 * ORCA's `openAcpSession` on a `LocalHost`, wrapped by the OpenCode provider guard, starting the
 * real `opencode acp` in an isolated profile, and every effect is observed on disk (or at the
 * stand-in, for web fetches) rather than taken from what OpenCode reports.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type AgentSpec, type PermissionRule } from "@orca/core";
import {
  LocalHost,
  OPENCODE_VERIFIED_VERSION,
  openAcpSession,
  openCodeGuard,
  withProviderGuards,
  type AgentSession,
  type SessionUpdateEvent,
} from "@orca/agents";

const BIN = process.env.ORCA_OPENCODE_BIN;
if (!BIN && process.env.ORCA_REQUIRE_OPENCODE === "1")
  throw new Error("ORCA_REQUIRE_OPENCODE=1 but ORCA_OPENCODE_BIN is not set");
const packet = new URL("../../../docs/preparation/opencode-acp-710/", import.meta.url);

interface ToolStep {
  tool: string;
  args: Record<string, unknown>;
}

/** What the stand-in model saw: every request, and any hit on its fetch canary. */
const seen = { requests: [] as Record<string, unknown>[], canary: 0 };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
  return "";
}

/** The steps of the latest scripted user message, and how many results have come back since. */
function nextStep(messages: { role: string; content: unknown }[]): ToolStep | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const match = /SCRIPT (\[.*\])/s.exec(textOf(m.content));
    if (!match) return undefined;
    const steps = JSON.parse(match[1]!) as ToolStep[];
    const done = messages.slice(i + 1).filter((x) => x.role === "tool").length;
    return steps[done];
  }
  return undefined;
}

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "chatcmpl-standin",
    object: "chat.completion.chunk",
    created: 0,
    model: "scripted",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as Record<string, unknown>;
}

function standIn(): Server {
  let call = 0;
  return createServer((req, res) => {
    if (req.url?.startsWith("/canary")) {
      seen.canary++;
      res.end("canary");
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    void body(req).then((b) => {
      seen.requests.push(b);
      const tools = Array.isArray(b.tools) && b.tools.length > 0;
      const step = tools ? nextStep((b.messages ?? []) as { role: string; content: unknown }[]) : undefined;
      const chunks = step
        ? [
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${++call}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
              null,
            ),
            chunk({}, "tool_calls"),
          ]
        : [chunk({ role: "assistant", content: tools ? "done" : "Stand-in title" }, null), chunk({}, "stop")];
      if (b.stream === false) {
        const message = step
          ? {
              role: "assistant",
              content: null,
              tool_calls: (chunks[0]!.choices[0]!.delta as { tool_calls: unknown }).tool_calls,
            }
          : { role: "assistant", content: tools ? "done" : "Stand-in title" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-standin",
            object: "chat.completion",
            created: 0,
            model: "scripted",
            choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-standin", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
}

const script = (...steps: ToolStep[]) => `SCRIPT ${JSON.stringify(steps)}`;
const bash = (command: string, workdir?: string): ToolStep => ({
  tool: "bash",
  args: { command, description: "scripted", ...(workdir ? { workdir } : {}) },
});

describe.skipIf(!BIN)(`OpenCode ${OPENCODE_VERIFIED_VERSION}, installed binary, scripted stand-in model`, () => {
  let server: Server;
  let base: string;
  let root: string;
  let isolated: Record<string, unknown>;
  const sessions: AgentSession[] = [];

  beforeAll(async () => {
    server = standIn();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    // The real path: on macOS the temp directory is reached through a link (/var -> /private/var),
    // and OpenCode treats a path given through it as outside the project, which it denies natively.
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-opencode-accept-")));
    isolated = JSON.parse(await readFile(new URL("opencode.isolated.json", packet), "utf8")) as Record<string, unknown>;
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  /** A fresh profile and workspace, and the agent spec that starts OpenCode in it. */
  async function agentIn(
    name: string,
    rules: PermissionRule[] = [],
  ): Promise<{ agent: AgentSpec; ws: string; dir: string }> {
    const dir = join(root, name);
    const ws = join(dir, "ws");
    for (const d of ["home", "xdg/config", "xdg/data", "xdg/state", "xdg/cache", "ws"])
      await mkdir(join(dir, d), { recursive: true });
    // The reviewed isolated config, with the stand-in as the only provider.
    const config = {
      ...isolated,
      enabled_providers: ["standin"],
      model: "standin/scripted",
      small_model: "standin/scripted",
      provider: {
        standin: {
          npm: "@ai-sdk/openai-compatible",
          name: "Scripted stand-in",
          options: { baseURL: `${base}/v1`, apiKey: "stand-in" },
          models: { scripted: { name: "Scripted", tool_call: true, limit: { context: 100000, output: 4096 } } },
        },
      },
    };
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const agent = AgentSpecSchema.parse({
      id: `opencode-${name}`,
      command: BIN,
      args: ["acp", "--hostname", "127.0.0.1", "--port", "0", "--pure", "--log-level", "WARN"],
      env: {
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: join(dir, "xdg/config"),
        XDG_DATA_HOME: join(dir, "xdg/data"),
        XDG_STATE_HOME: join(dir, "xdg/state"),
        XDG_CACHE_HOME: join(dir, "xdg/cache"),
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: "",
        OPENCODE_CONFIG_CONTENT: "",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_PURE: "1",
        OPENCODE_PERMISSION: JSON.stringify(isolated.permission),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENCODE_API_KEY: "",
      },
      permissions: {
        default: "ask",
        rules: [{ match: { kind: "think", titlePattern: "^task$" }, decision: "deny" }, ...rules],
      },
      turnTimeoutMs: 120_000,
    });
    return { agent, ws, dir };
  }

  type Human = (req: acp.RequestPermissionRequest) => Promise<string | undefined>;
  const pick = (kind: acp.PermissionOptionKind) => async (req: acp.RequestPermissionRequest) =>
    req.options.find((o) => o.kind === kind)?.optionId;

  async function open(
    agent: AgentSpec,
    ws: string,
    human: Human,
    guarded = true,
  ): Promise<{
    session: AgentSession;
    asks: acp.RequestPermissionRequest[];
    decisions: string[];
    updates: SessionUpdateEvent[];
  }> {
    const asks: acp.RequestPermissionRequest[] = [];
    const decisions: string[] = [];
    const updates: SessionUpdateEvent[] = [];
    const opener = guarded ? withProviderGuards(openAcpSession, [openCodeGuard()]) : openAcpSession;
    const session = await opener({
      host: new LocalHost({ id: "local", type: "local" }),
      agent,
      cwd: ws,
      handshakeTimeoutMs: 60_000,
      askPermission: async (req) => {
        asks.push(req);
        return human(req);
      },
      onPermission: (p) => decisions.push(p.decision),
    });
    sessions.push(session);
    session.onUpdate((e) => updates.push(e));
    return { session, asks, decisions, updates };
  }

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it("connects: guard admits the build, handshake, streaming and a turn ends", async () => {
    const { agent, ws } = await agentIn("connect");
    const before = seen.requests.length;
    const { session, updates } = await open(agent, ws, pick("reject_once"));
    expect(session.acpSessionId).toMatch(/^ses/);
    const result = await session.prompt(script());
    expect(result.stopReason).toBe("end_turn");
    expect(seen.requests.length).toBeGreaterThan(before);
    expect(updates.some((u) => u.raw.sessionUpdate === "agent_message_chunk")).toBe(true);
  }, 180_000);

  it("explicit denial: a rejected shell command does not run", async () => {
    const { agent, ws } = await agentIn("deny");
    const { session, asks } = await open(agent, ws, pick("reject_once"));
    await session.prompt(script(bash("touch denied.txt")));
    expect(asks.map((a) => a.toolCall.kind)).toEqual(["execute"]);
    expect(await exists(join(ws, "denied.txt"))).toBe(false);
  }, 180_000);

  it("rule-matched allow answers once: every repeat is decided again, and changed arguments are not covered", async () => {
    const { agent, ws } = await agentIn("rule", [
      { match: { kind: "execute", titlePattern: "^echo a >> log\\.txt$" }, decision: "allow" },
    ]);
    const { session, asks, decisions } = await open(agent, ws, pick("reject_once"));
    await session.prompt(script(bash("echo a >> log.txt"), bash("echo a >> log.txt"), bash("echo b >> log.txt")));
    expect(decisions.filter((d) => d.startsWith("allow"))).toHaveLength(2);
    // Only the changed command reached a person, and they rejected it.
    expect(asks.map((a) => a.toolCall.title)).toEqual(["echo b >> log.txt"]);
    expect(await readFile(join(ws, "log.txt"), "utf8")).toBe("a\na\n");
  }, 180_000);

  it("a person's 'always' is narrowed to 'once', so OpenCode keeps asking", async () => {
    const { agent, ws } = await agentIn("always");
    const { session, asks } = await open(agent, ws, pick("allow_always"));
    await session.prompt(script(bash("echo x >> always.txt"), bash("echo x >> always.txt")));
    expect(asks).toHaveLength(2);
    expect(await readFile(join(ws, "always.txt"), "utf8")).toBe("x\nx\n");
  }, 180_000);

  it("CONTROL (no provider guard): OpenCode's native 'always' skips the second ask", async () => {
    const { agent, ws } = await agentIn("always-unguarded");
    const { session, asks } = await open(agent, ws, pick("allow_always"), false);
    await session.prompt(script(bash("echo x >> always.txt"), bash("echo x >> always.txt")));
    expect(asks).toHaveLength(1);
    expect(await readFile(join(ws, "always.txt"), "utf8")).toBe("x\nx\n");
  }, 180_000);

  it("file edits ask, a rejected write leaves no file, and an allowed one writes once", async () => {
    const { agent, ws } = await agentIn("edit");
    let answer: acp.PermissionOptionKind = "reject_once";
    const { session, asks } = await open(agent, ws, (req) => pick(answer)(req));
    await session.prompt(script({ tool: "write", args: { filePath: join(ws, "no.txt"), content: "no" } }));
    expect(asks.at(-1)?.toolCall.kind).toBe("edit");
    expect(await exists(join(ws, "no.txt"))).toBe(false);
    answer = "allow_once";
    await session.prompt(script({ tool: "write", args: { filePath: join(ws, "yes.txt"), content: "yes" } }));
    expect(await readFile(join(ws, "yes.txt"), "utf8")).toBe("yes");
  }, 180_000);

  it("subagents and web fetches are refused natively: no ask, no child, the canary is never hit", async () => {
    const { agent, ws } = await agentIn("native-deny");
    const { session, asks } = await open(agent, ws, pick("allow_once"));
    const canary = seen.canary;
    await session.prompt(
      script(
        { tool: "task", args: { description: "scripted", prompt: "touch child.txt", subagent_type: "general" } },
        { tool: "webfetch", args: { url: `${base}/canary`, format: "text" } },
      ),
    );
    expect(asks).toEqual([]);
    expect(seen.canary).toBe(canary);
    expect(await exists(join(ws, "child.txt"))).toBe(false);
  }, 180_000);

  it("cancellation while an ask is pending: the turn ends cancelled and the command never runs", async () => {
    const { agent, ws } = await agentIn("cancel");
    let late: ((id: string | undefined) => void) | undefined;
    const held: { session?: AgentSession } = {};
    const { session } = await open(agent, ws, (req) => {
      void held.session?.cancel();
      return new Promise((resolve) => {
        late = resolve;
        setTimeout(() => resolve(req.options.find((o) => o.kind === "allow_once")?.optionId), 2_000);
      });
    });
    held.session = session;
    const result = await session.prompt(script(bash("echo late >> late.txt")));
    expect(result.stopReason).toBe("cancelled");
    late?.("once");
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await exists(join(ws, "late.txt"))).toBe(false);
  }, 180_000);

  it("a shell command in another directory: what OpenCode asks and what runs", async () => {
    const { agent, ws, dir } = await agentIn("outside", [
      { match: { kind: "execute", titlePattern: "^touch outside\\.txt$" }, decision: "allow" },
    ]);
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    const { session, asks } = await open(agent, ws, pick("reject_once"));
    await session.prompt(script(bash("touch outside.txt", elsewhere)));
    // OpenCode's external-directory check is denied natively in the profile, so nothing lands
    // outside the workspace even though ORCA's rule allows the command by its title.
    expect(await exists(join(elsewhere, "outside.txt"))).toBe(false);
    expect(asks.map((a) => a.toolCall.kind)).not.toContain("execute");
  }, 180_000);

  it("a slash command is refused before OpenCode sees it", async () => {
    const { agent, ws } = await agentIn("slash");
    const { session } = await open(agent, ws, pick("reject_once"));
    const before = seen.requests.length;
    await expect(session.prompt("/init")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(seen.requests.length).toBe(before);
  }, 180_000);

  it("another build is refused before it starts", async () => {
    const { agent, ws, dir } = await agentIn("other-build");
    const copy = join(dir, "opencode");
    await copyFile(BIN!, copy);
    await chmod(copy, 0o755);
    await appendFile(copy, "\n");
    await expect(open({ ...agent, command: copy }, ws, pick("reject_once"))).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  }, 180_000);
});
