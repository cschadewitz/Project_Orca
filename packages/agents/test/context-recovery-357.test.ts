/** #357: provider-free wire evidence. A successful context load never revives an old permission callback. */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, OrcaError } from "@orca/core";
import {
  openAcpSession,
  stdioAcpStream,
  type AgentHost,
  type AgentSession,
  type PermissionInvocation,
} from "@orca/agents";

const sessions: AgentSession[] = [];
const privateCanary = "synthetic-private-context-357";
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

/** The fixture retains a context marker across connections; it is not provider persistence. */
function fixture(load: "supported" | "unsupported" | "failed" | "timeout" = "supported") {
  const peers: ReturnType<typeof peer>[] = [];
  const history = new Map<string, string[]>();
  const forbiddenIO = vi.fn(async () => {
    throw new Error("#357 fixture forbids host I/O");
  });
  const host: AgentHost = {
    id: "synthetic-357",
    spec: { id: "synthetic-357", type: "local" },
    fs: {
      readFile: forbiddenIO,
      writeFile: forbiddenIO,
      exists: forbiddenIO,
      existsMany: forbiddenIO,
      mkdirp: forbiddenIO,
    },
    exec: forbiddenIO,
    joinPath: (...parts) => parts.join("/"),
    spawnAgent: async () => {
      const wire = peer(load, history);
      peers.push(wire);
      return wire.handle;
    },
  };
  const agent = AgentSpecSchema.parse({
    id: "context-357",
    command: "never-spawned",
    permissions: { default: "ask" },
  });
  async function open(
    askPermission: (invocation: PermissionInvocation) => Promise<string>,
    resumeSessionId?: string,
    requireContextRecovery = false,
  ) {
    const continuity: unknown[] = [];
    const session = await openAcpSession({
      host,
      agent,
      cwd: "/synthetic/context-357",
      handshakeTimeoutMs: 100,
      requireContextRecovery,
      askPermission: (_request, invocation) => askPermission(invocation!),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      onSessionContinuity: (state) => continuity.push(state),
    });
    sessions.push(session);
    return { session, continuity, wire: peers.at(-1)! };
  }
  return { open, forbiddenIO, peers };
}

function peer(load: "supported" | "unsupported" | "failed" | "timeout", history: Map<string, string[]>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    exit = () => resolve({ code: 0, signal: null });
  });
  let buffer = "";
  let promptId: number | string | undefined;
  let acpSessionId = "provider-history";
  let didExit = false;
  const methods: string[] = [];
  const replies: acp.RequestPermissionResponse[] = [];
  const send = (message: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const end = (stopReason = "end_turn") => {
    if (promptId === undefined) return;
    send({ id: promptId, result: { stopReason } });
    promptId = undefined;
  };
  output.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline)) as {
        id?: number | string;
        method?: string;
        params?: { protocolVersion: number; sessionId?: string; prompt?: acp.ContentBlock[] };
        result?: acp.RequestPermissionResponse;
      };
      buffer = buffer.slice(newline + 1);
      if (message.method) methods.push(message.method);
      if (message.method === "initialize") {
        send({
          id: message.id,
          result: {
            protocolVersion: message.params!.protocolVersion,
            agentCapabilities: { loadSession: load !== "unsupported" },
          },
        });
      } else if (message.method === "session/new") {
        history.set(acpSessionId, []);
        send({ id: message.id, result: { sessionId: acpSessionId } });
      } else if (message.method === "session/load") {
        if (load === "timeout") continue;
        if (load === "failed") send({ id: message.id, error: { code: -32602, message: privateCanary } });
        else {
          acpSessionId = message.params!.sessionId!;
          send({ id: message.id, result: {} });
        }
      } else if (message.method === "session/prompt") {
        promptId = message.id;
        const messages = history.get(acpSessionId)!;
        send({
          method: "session/update",
          params: {
            sessionId: acpSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: messages.join("\n") } },
          },
        });
        messages.push(
          ...(message.params!.prompt ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])),
        );
        send({
          id: "reused-callback-id",
          method: "session/request_permission",
          params: {
            sessionId: acpSessionId,
            toolCall: { toolCallId: "reused-tool-id", title: "Synthetic action", kind: "execute" },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
          },
        });
      } else if (message.method === "session/cancel") end("cancelled");
      else if (message.id === "reused-callback-id" && message.result) {
        replies.push(message.result);
        end();
      }
    }
  });
  const die = () => {
    didExit = true;
    exit();
    input.destroy();
    output.destroy();
  };
  return {
    handle: {
      stream: stdioAcpStream(input, output),
      pid: undefined,
      exited,
      stderrTail: () => privateCanary,
      kill: vi.fn(die),
    },
    methods,
    replies,
    end,
    die,
    didExit: () => didExit,
  };
}

it.each(["end_turn", "cancel", "timeout", "disconnect"] as const)(
  "loading context after %s uses a new invocation and leaves the old callback retired",
  async (ending) => {
    const f = fixture();
    const invocations: PermissionInvocation[] = [];
    const answers: ((answer: string) => void)[] = [];
    const ask = (invocation: PermissionInvocation) => {
      invocations.push(invocation);
      return new Promise<string>((resolve) => answers.push(resolve));
    };
    const original = await f.open(ask);
    const first = original.session.prompt("first", ending === "timeout" ? { timeoutMs: 100 } : {});
    // Observe rejection immediately for the deliberate disconnect case.
    const settled = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    if (ending === "end_turn") original.wire.end();
    if (ending === "cancel") await original.session.cancel();
    if (ending === "disconnect") original.wire.die();
    const result = await settled;
    if (ending === "disconnect") expect(result).toMatchObject({ error: { code: "AGENT_PROTOCOL" } });
    else expect(result).toHaveProperty("value");
    expect(invocations[0]!.signal.aborted).toBe(true);
    await original.session.close();

    const recovered = await f.open(ask, original.session.acpSessionId, true);
    expect(recovered.continuity).toEqual([{ mode: "loaded", reason: "load-supported" }]);
    expect(recovered.wire.methods).toEqual(["initialize", "session/load"]);
    expect(recovered.session.acpSessionId).toBe(original.session.acpSessionId);
    expect(recovered.session.id).not.toBe(original.session.id);
    const output: string[] = [];
    recovered.session.onUpdate((event) => {
      if (event.summary.text) output.push(event.summary.text);
    });
    let finished = false;
    const second = recovered.session.prompt("continue explicitly").then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(invocations).toHaveLength(2));
    expect(output).toEqual(["first"]);
    expect(invocations[1]!.sessionId).not.toBe(invocations[0]!.sessionId);
    expect(invocations[1]!.turnId).not.toBe(invocations[0]!.turnId);
    expect(invocations[1]!.invocationId).not.toBe(invocations[0]!.invocationId);
    answers[0]!("allow");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(recovered.wire.replies).toEqual([]);
    expect(invocations[1]!.signal.aborted).toBe(false);
    answers[1]!("allow");
    expect(await second).toMatchObject({ stopReason: "end_turn" });
    expect(recovered.wire.replies).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }]);
    expect(f.forbiddenIO).not.toHaveBeenCalled();
  },
);

it.each([undefined, "", "   "])("refuses required recovery without a native ID before spawning (%j)", async (id) => {
  const f = fixture();
  await expect(f.open(async () => "allow", id, true)).rejects.toMatchObject({
    code: "CONFIG_INVALID",
    details: { contextRecoveryReason: "missing-session-id" },
  });
  expect(f.peers).toEqual([]);
  expect(f.forbiddenIO).not.toHaveBeenCalled();
});

it.each([
  ["unsupported", "NOT_SUPPORTED", "load-unsupported"],
  ["failed", "AGENT_PROTOCOL", "load-failed"],
  ["timeout", "AGENT_TRANSPORT", "load-timeout"],
] as const)(
  "required recovery stops on %s, retires the connection and reports no private context",
  async (load, code, reason) => {
    const f = fixture(load);
    const ask = vi.fn(async () => "allow");
    const error: unknown = await f.open(ask, privateCanary, true).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OrcaError);
    expect(error).toMatchObject({ code, details: { contextRecoveryReason: reason } });
    expect((error as OrcaError).cause).toBeUndefined();
    expect(JSON.stringify((error as OrcaError).toJSON())).not.toContain(privateCanary);
    const wire = f.peers[0]!;
    expect(wire.methods).toEqual(load === "unsupported" ? ["initialize"] : ["initialize", "session/load"]);
    expect(wire.didExit()).toBe(true);
    expect(wire.handle.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(ask).not.toHaveBeenCalled();
    expect(f.forbiddenIO).not.toHaveBeenCalled();
  },
);

it.each([
  ["unsupported", "load-unsupported"],
  ["failed", "load-failed"],
  ["timeout", "load-failed"],
] as const)(
  "documents the existing fresh fallback on %s; this cannot satisfy durable Continue",
  async (load, reason) => {
    const f = fixture(load);
    const opened = await f.open(async () => "allow", "missing-history");
    expect(opened.continuity).toEqual([{ mode: "fresh", reason }]);
    expect(opened.wire.methods).toEqual(
      load === "unsupported" ? ["initialize", "session/new"] : ["initialize", "session/load", "session/new"],
    );
    expect(opened.wire.methods).not.toContain("session/prompt");
  },
);
