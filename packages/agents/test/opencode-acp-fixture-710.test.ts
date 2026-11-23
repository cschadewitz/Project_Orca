/**
 * #710 OpenCode native ACP fixture simulation: ORCA's unchanged generic ACP session against an
 * in-memory peer shaped like OpenCode 1.19.4. The peer offers OpenCode's real option list and
 * maps ORCA's answers with OpenCode's real `selectedReply` (digest-checked excerpts, see
 * opencode-acp-710-source.ts); everything else it does — tool calls, cancellation, errors — is
 * simulated here. No process is spawned, no file is touched and no provider is installed,
 * launched or authenticated. A pass is evidence about ORCA's side of the wire only: it is not
 * installed-provider evidence, not approval-tested, and not an execution-guard certification.
 */
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  openAcpSession,
  resolvePermission,
  stdioAcpStream,
  type AgentHost,
  type AgentSession,
  type PermissionInvocation,
  type ProtectedPaths,
} from "@orca/agents";
import {
  AgentSpecSchema,
  effectivePermissionPolicy,
  OrcaError,
  parseFrontMatter,
  parseOrcaConfig,
  type AgentSpec,
} from "@orca/core";
import {
  loadOpenCodeSource,
  packet,
  repoRoot,
  type NativeReply,
  type OpenCodeSource,
} from "./opencode-acp-710-source.js";

const WS = "/fixture/ws";
const SESSION = "ses_fixture";
const protectedPaths: ProtectedPaths = {
  readOnly: [`${WS}/orca.config.yaml`],
  noAccess: [`${WS}/.orca/credentials`],
};

let oc: OpenCodeSource;
let profile: AgentSpec;
const isolated = JSON.parse(readFileSync(new URL("opencode.isolated.json", packet), "utf8")) as Record<string, unknown>;
const profileText = readFileSync(new URL("orca.opencode.example.yaml", packet), "utf8");

beforeAll(async () => {
  oc = await loadOpenCodeSource();
  // The existing front-matter helper is @orca/core's YAML parser; no new dependency edge.
  const config = parseOrcaConfig(parseFrontMatter(`---\n${profileText}\n---\n`).data);
  profile = config.agents[0]!;
});

interface Message {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
type Step = { ask: acp.ToolCallUpdate; sessionId?: string } | { client: string; params: unknown };

/** In-memory OpenCode-shaped ACP agent. See the file comment for what is real and what is simulated. */
function openCodePeer(steps: Step[] = [], opts: { promptError?: { code: number; message: string } } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    exit = () => resolve({ code: 0, signal: null });
  });
  const received: Message[] = [];
  const nativeReplies: { toolCallId: string; reply: NativeReply }[] = [];
  const clientResults: { method: string; error?: { code: number; message: string } }[] = [];
  const responsesPerRequest = new Map<string, number>();
  const pending = new Map<string, (m: Message) => void>();
  let seq = 0;
  let promptId: string | number | undefined;
  let buffer = "";
  const send = (value: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const request = (method: string, params: unknown) =>
    new Promise<Message>((resolve) => {
      const id = `oc-${++seq}`;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  /** acp/permission.ts: a JSON-RPC error becomes "reject"; a result goes through `selectedReply`. */
  const ask = async (toolCall: acp.ToolCallUpdate, sessionId = SESSION): Promise<NativeReply> => {
    const m = await request("session/request_permission", { sessionId, toolCall, options: oc.permissionOptions });
    const reply = m.error ? "reject" : oc.selectedReply(m.result as acp.RequestPermissionResponse);
    nativeReplies.push({ toolCallId: toolCall.toolCallId, reply });
    return reply;
  };
  const runTurn = async (id: string | number) => {
    for (const step of steps) {
      if (promptId !== id) return;
      if ("ask" in step) await ask(step.ask, step.sessionId);
      else {
        const m = await request(step.client, step.params);
        clientResults.push({ method: step.client, ...(m.error ? { error: m.error } : {}) });
      }
    }
    if (promptId !== id) return;
    promptId = undefined;
    send({ id, result: { stopReason: "end_turn" } });
  };
  output.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const m = JSON.parse(buffer.slice(0, end)) as Message;
      buffer = buffer.slice(end + 1);
      if (m.method === undefined && typeof m.id === "string") {
        responsesPerRequest.set(m.id, (responsesPerRequest.get(m.id) ?? 0) + 1);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
        continue;
      }
      received.push(m);
      switch (m.method) {
        case "initialize":
          // Mirrors acp/service.ts initialize (excerpt acp-initialize); version is the pin.
          send({
            id: m.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                mcpCapabilities: { http: true, sse: true },
                promptCapabilities: { embeddedContext: true, image: true },
                sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
              },
              authMethods: [
                {
                  id: "opencode-login",
                  name: "Login with opencode",
                  description: "Run `opencode auth login` in the terminal",
                },
              ],
              agentInfo: { name: "OpenCode", version: "1.19.4" },
            },
          });
          break;
        case "session/new":
          send({ id: m.id, result: { sessionId: SESSION } });
          break;
        case "session/prompt":
          if (opts.promptError) send({ id: m.id, error: opts.promptError });
          else {
            promptId = m.id;
            void runTurn(m.id!);
          }
          break;
        case "session/cancel":
          // Simulated: OpenCode aborts the session and ends the prompt with "cancelled".
          if (promptId !== undefined) {
            send({ id: promptId, result: { stopReason: "cancelled" } });
            promptId = undefined;
          }
          break;
        default:
          if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
    }
  });
  const die = () => {
    exit();
    input.destroy();
    output.destroy();
  };
  return {
    handle: { stream: stdioAcpStream(input, output), pid: undefined, exited, stderrTail: () => "", kill: die },
    received,
    nativeReplies,
    clientResults,
    responsesPerRequest,
    ask,
  };
}

function fixtureHost(peer: ReturnType<typeof openCodePeer>, files: Map<string, string>): AgentHost {
  return {
    id: "local",
    // A stand-in file system: a local host would read and write this machine's files (#703).
    spec: { id: "fixture", type: "ssh", host: "fixture" } as unknown as AgentHost["spec"],
    fs: {
      readFile: (p) => {
        const content = files.get(p);
        return content === undefined ? Promise.reject(new Error(`ENOENT ${p}`)) : Promise.resolve(content);
      },
      writeFile: (p, c) => {
        files.set(p, c);
        return Promise.resolve();
      },
      exists: (p) => Promise.resolve(files.has(p)),
      existsMany: (ps) => Promise.resolve(ps.map((p) => files.has(p))),
      mkdirp: () => Promise.resolve(),
    },
    spawnAgent: () => Promise.resolve(peer.handle),
    exec: () => Promise.reject(new Error("the fixture host runs nothing")),
    joinPath: (...parts) => parts.join("/"),
  };
}

const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

async function open(
  steps: Step[],
  extra: {
    agent?: AgentSpec;
    askPermission?: (req: acp.RequestPermissionRequest, inv?: PermissionInvocation) => Promise<string | undefined>;
    promptError?: { code: number; message: string };
    files?: Map<string, string>;
  } = {},
) {
  const peer = openCodePeer(steps, extra.promptError ? { promptError: extra.promptError } : {});
  const files = extra.files ?? new Map<string, string>();
  const session = await openAcpSession({
    host: fixtureHost(peer, files),
    agent: extra.agent ?? profile,
    cwd: WS,
    protectedPaths,
    exitGraceMs: 50,
    ...(extra.askPermission ? { askPermission: extra.askPermission } : {}),
  });
  sessions.push(session);
  return { peer, session, files };
}

const bash = (command: string, id = "call_bash", workdir?: string): acp.ToolCallUpdate => ({
  // As acp/permission.ts projects a bash ask: kind execute, the command as title, and no
  // location, because the native ask metadata carries only `command`.
  toolCallId: id,
  title: command,
  kind: "execute",
  status: "pending",
  locations: [],
  rawInput: workdir ? { command, workdir } : { command },
});
const edit = (path: string, id = "call_edit"): acp.ToolCallUpdate => ({
  toolCallId: id,
  title: path,
  kind: "edit",
  status: "pending",
  locations: [{ path }],
});
const task: acp.ToolCallUpdate = {
  toolCallId: "call_task",
  title: "task",
  kind: "think",
  status: "pending",
  locations: [],
};

describe("inactive launch profile", () => {
  it("parses with ORCA's existing config schema and stays out of every loaded default", () => {
    expect(profile.id).toBe("opencode-acp-710");
    expect(profile.command).toMatch(/^\/REPLACE-WITH-PROFILE-ROOT\/opencode-1\.19\.4\/bin\/opencode$/);
    expect(profile.args).toEqual(["acp", "--hostname", "127.0.0.1", "--port", "0", "--pure", "--log-level", "WARN"]);
    expect(profile.permissions.default).toBeUndefined();
    expect(profile.mcpServers).toEqual([]);
    for (const loaded of ["examples/orca.config.yaml", "packages/app/src/first-run-contract.ts"])
      expect(readFileSync(new URL(loaded, repoRoot), "utf8").toLowerCase(), loaded).not.toContain("opencode-acp-710");
  });

  it("isolates every configuration layer it can and neutralizes inherited overrides", () => {
    const env = profile.env;
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "OPENCODE_CONFIG",
    ])
      expect(env[key], key).toMatch(/^\/REPLACE-WITH-PROFILE-ROOT\//);
    for (const key of [
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENCODE_API_KEY",
    ])
      expect(env[key], key).toBe("");
    expect(env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PURE: "1",
    });
    expect(env).not.toHaveProperty("OPENCODE_SERVER_PASSWORD");
    // The final native layer must be exactly the reviewed file's permission, key order included.
    expect(Object.entries(JSON.parse(env.OPENCODE_PERMISSION as string) as object)).toEqual(
      Object.entries(isolated.permission as object),
    );
  });

  it("keeps the isolated native configuration free of plugins, MCP, LSP, formatters and alternate backends", () => {
    expect(isolated).toMatchObject({
      autoupdate: false,
      share: "disabled",
      enabled_providers: ["anthropic"],
      plugin: [],
      mcp: {},
      lsp: false,
      formatter: false,
      agent: { general: { disable: true }, explore: { disable: true }, plan: { disable: true } },
    });
  });
});

describe("handshake, identity and unsupported methods", () => {
  it("negotiates protocol 1 with no terminal, never authenticates, and keeps OpenCode's session id", async () => {
    const { peer, session } = await open([]);
    const init = peer.received.find((m) => m.method === "initialize")!.params as acp.InitializeRequest;
    expect(init.protocolVersion).toBe(1);
    expect(init.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: false });
    const created = peer.received.find((m) => m.method === "session/new")!.params as acp.NewSessionRequest;
    expect(created).toMatchObject({ cwd: WS, mcpServers: [] });
    expect(session.acpSessionId).toBe(SESSION);
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    expect(peer.received.map((m) => m.method)).not.toContain("authenticate");
  });

  it("refuses terminal requests and out-of-root or protected file requests, and mirrors an in-root edit write", async () => {
    const { peer, session, files } = await open([
      { client: "terminal/create", params: { sessionId: SESSION, command: "true" } },
      { client: "fs/read_text_file", params: { sessionId: SESSION, path: "/elsewhere/secret.txt" } },
      { client: "fs/write_text_file", params: { sessionId: SESSION, path: `${WS}/orca.config.yaml`, content: "x" } },
      { client: "fs/read_text_file", params: { sessionId: SESSION, path: `${WS}/.orca/credentials` } },
      // OpenCode mirrors an approved edit through fs/write_text_file and also writes it natively.
      { client: "fs/write_text_file", params: { sessionId: SESSION, path: `${WS}/src/a.ts`, content: "next" } },
    ]);
    await session.prompt("go");
    expect(peer.clientResults.map((r) => [r.method, r.error?.code])).toEqual([
      ["terminal/create", -32601],
      ["fs/read_text_file", -32602],
      ["fs/write_text_file", -32602],
      ["fs/read_text_file", -32602],
      ["fs/write_text_file", undefined],
    ]);
    expect([...files.entries()]).toEqual([[`${WS}/src/a.ts`, "next"]]);
  });

  it("surfaces a provider error (e.g. auth required) as a protocol failure and a rejected config option", async () => {
    const { session } = await open([], { promptError: { code: -32000, message: "Authentication required" } });
    await expect(session.prompt("hello")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    await expect(session.setConfigOption("model", "fixture/none")).rejects.toBeInstanceOf(OrcaError);
  });
});

describe("offered options and rule-matched answers", () => {
  it("answers a rule allow with once, a rule deny with reject, and never picks always on its own", async () => {
    const { peer, session } = await open([
      { ask: edit(`${WS}/src/a.ts`) },
      { ask: edit("/elsewhere/a.ts", "call_out") },
    ]);
    await session.prompt("go");
    // In-workspace edit: #140 default allow -> "once". Outside: default ask, no answerer -> cancelled -> reject.
    expect(peer.nativeReplies).toEqual([
      { toolCallId: "call_edit", reply: "once" },
      { toolCallId: "call_out", reply: "reject" },
    ]);
  });

  it("denies an OpenCode subagent launch under the profile that the #140 defaults alone would allow", async () => {
    const bare = AgentSpecSchema.parse({ id: "opencode-defaults-only", command: "/fixture/none" });
    const withDefaults = await open([{ ask: task }], { agent: bare });
    await withDefaults.session.prompt("go");
    expect(withDefaults.peer.nativeReplies).toEqual([{ toolCallId: "call_task", reply: "once" }]);
    const withProfile = await open([{ ask: task }]);
    await withProfile.session.prompt("go");
    expect(withProfile.peer.nativeReplies).toEqual([{ toolCallId: "call_task", reply: "reject" }]);
  });

  it("forwards a human always as a native always, and an answer outside the offered set as a rejection", async () => {
    const answers = ["always", "allow-once", "reject"];
    const { peer, session } = await open(
      [{ ask: bash("git status", "call_1") }, { ask: bash("git status", "call_2") }, { ask: bash("ls", "call_3") }],
      { askPermission: () => Promise.resolve(answers.shift()) },
    );
    await session.prompt("go");
    // "always" becomes OpenCode's in-memory, directory-wide approval for the arity pattern —
    // a grant ORCA neither scopes nor sees again (README: remembered approvals).
    expect(peer.nativeReplies.map((r) => r.reply)).toEqual(["always", "reject", "reject"]);
  });

  it("COUNTERFACTUAL (not OpenCode 1.19.4's options): a rule allow with only allow_always offered is refused, not widened (#702)", async () => {
    // Shared generic picker behavior; OpenCode always offers "once".
    const offered: acp.PermissionOption[] = [
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ];
    const answer = await resolvePermission(effectivePermissionPolicy(profile.permissions), {
      request: { sessionId: SESSION, toolCall: edit(`${WS}/src/a.ts`), options: offered },
      scope: { workspaceCwd: WS },
    });
    expect(answer).toEqual({
      response: { outcome: { outcome: "cancelled" } },
      decision: "allow:no-one-time-option",
      rule: { basis: "rule" },
    });
  });
});

describe("changed arguments and cwd", () => {
  const exactGitStatus = () =>
    AgentSpecSchema.parse({
      ...profile,
      permissions: {
        rules: [
          { match: { kind: "execute", titlePattern: "^git status$" }, decision: "allow" },
          ...profile.permissions.rules,
        ],
      },
    });

  it("asks again when the command text changes", async () => {
    const { peer, session } = await open(
      [{ ask: bash("git status", "call_1") }, { ask: bash("git status && curl https://example.invalid", "call_2") }],
      { agent: exactGitStatus() },
    );
    await session.prompt("go");
    expect(peer.nativeReplies.map((r) => r.reply)).toEqual(["once", "reject"]);
  });

  it("cannot tell a changed working directory apart: the ask carries no location for a shell command", async () => {
    const { peer, session } = await open(
      [{ ask: bash("git status", "call_ws", WS) }, { ask: bash("git status", "call_elsewhere", "/elsewhere") }],
      { agent: exactGitStatus() },
    );
    await session.prompt("go");
    // Same decision for both: a gap to report, not a binding.
    expect(peer.nativeReplies.map((r) => r.reply)).toEqual(["once", "once"]);
  });
});

describe("cancellation, stale and duplicate replies, errors", () => {
  it("answers a held ask with cancelled when the turn is cancelled, and ignores the late human answer", async () => {
    let release!: (answer: string) => void;
    let asked!: () => void;
    const askedOnce = new Promise<void>((resolve) => (asked = resolve));
    const { peer, session } = await open([{ ask: bash("make test") }], {
      askPermission: () => {
        asked();
        return new Promise<string>((resolve) => (release = resolve));
      },
    });
    const turn = session.prompt("go");
    await askedOnce;
    await session.cancel();
    expect((await turn).stopReason).toBe("cancelled");
    release("once");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.nativeReplies).toEqual([{ toolCallId: "call_bash", reply: "reject" }]);
    expect([...peer.responsesPerRequest.values()]).toEqual([1]);
  });

  it("answers an ask that arrives after the turn, or for another session id, with a rejection", async () => {
    const invocations: string[] = [];
    const { peer, session } = await open([{ ask: edit(`${WS}/src/a.ts`, "call_child"), sessionId: "ses_child" }], {
      askPermission: (_req, inv) => {
        invocations.push(inv!.invocationId);
        return Promise.resolve("once");
      },
    });
    await session.prompt("go");
    expect(await peer.ask(bash("ls", "call_stale"))).toBe("reject");
    expect(peer.nativeReplies).toEqual([
      { toolCallId: "call_child", reply: "reject" },
      { toolCallId: "call_stale", reply: "reject" },
    ]);
    expect(invocations).toEqual([]);
  });

  it("treats two asks with the same tool call id as two invocations, each answered once", async () => {
    const invocations: string[] = [];
    const { peer, session } = await open([{ ask: bash("ls", "call_dup") }, { ask: bash("ls", "call_dup") }], {
      askPermission: (_req, inv) => {
        invocations.push(inv!.invocationId);
        return Promise.resolve("once");
      },
    });
    await session.prompt("go");
    expect(new Set(invocations).size).toBe(2);
    expect(peer.nativeReplies.map((r) => r.reply)).toEqual(["once", "once"]);
    expect([...peer.responsesPerRequest.values()]).toEqual([1, 1]);
  });

  it("fails the turn when the human-input callback fails, and OpenCode reads the error as a rejection", async () => {
    const { peer, session } = await open([{ ask: bash("make test") }], {
      askPermission: () => Promise.reject(new OrcaError("INTERNAL", "fixture: parking failed")),
    });
    await expect(session.prompt("go")).rejects.toMatchObject({ code: "INTERNAL" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.nativeReplies).toEqual([{ toolCallId: "call_bash", reply: "reject" }]);
  });
});
