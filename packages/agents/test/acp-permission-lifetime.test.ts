/** Real ACP transport lifetime controls. A new prompt never resumes an old permission callback. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, openAcpSession, type AgentSession, type PermissionInvocation } from "@orca/agents";

// Synthetic requests only; this agent has no effect implementation. It remains
// connected after cooperative cancellation so a genuinely new turn can be tested.
const agentSource = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const reply = (id, result) => send({ id, result });
let sequence = 0, prompt, heartbeat;
const requests = new Map();
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, {
    protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: false },
    agentInfo: { name: "permission-lifetime-fixture", version: "1" }
  });
  else if (message.method === "session/new") reply(message.id, { sessionId: "fixture-session" });
  else if (message.method === "session/prompt") {
    prompt = message.id;
    const requestId = "permission-" + ++sequence;
    requests.set(requestId, message.id);
    send({ id: requestId, method: "session/request_permission", params: {
      sessionId: "fixture-session",
      toolCall: { toolCallId: "same-provider-tool-id", title: "Synthetic fixture only", kind: "execute" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" }
      ]
    }});
    heartbeat = setInterval(() => send({ method: "session/update", params: {
      sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "synthetic activity" } }
    }}), 25);
  }
  else if (message.method === "session/cancel") {
    clearInterval(heartbeat);
    if (prompt !== undefined) reply(prompt, { stopReason: "cancelled" });
    prompt = undefined;
  }
  else if (message.id !== undefined && requests.has(message.id) && message.result !== undefined) {
    const originalPrompt = requests.get(message.id);
    requests.delete(message.id);
    if (prompt === originalPrompt && message.result.outcome?.outcome === "selected") {
      clearInterval(heartbeat);
      reply(prompt, { stopReason: "end_turn" });
      prompt = undefined;
    }
  }
});
`;

const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

function deferred() {
  let resolve!: (value: string | undefined) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | undefined>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each(["timeout", "cancel", "late-failure"] as const)(
  "%s invalidates the old callback without authorizing or cancelling the next turn",
  async (mode) => {
    const waits: { answer: ReturnType<typeof deferred>; invocation: PermissionInvocation }[] = [];
    const decisions: string[] = [];
    let activity = 0;
    const session = await openAcpSession({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({
        id: "permission-lifetime-fixture",
        command: process.execPath,
        args: ["-e", agentSource],
        permissions: { default: "ask" },
        cancelGraceMs: 1000,
      }),
      cwd: process.cwd(),
      askPermission: async (_request, invocation) => {
        if (!invocation) throw new Error("Missing actual invocation");
        const answer = deferred();
        waits.push({ answer, invocation });
        return answer.promise;
      },
      onPermission: ({ decision }) => decisions.push(decision),
    });
    sessions.push(session);
    session.onUpdate(() => activity++);
    const first = session.prompt("first synthetic turn", mode === "timeout" ? { timeoutMs: 500 } : {});
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    if (mode !== "timeout") await session.cancel();
    await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
    await vi.waitFor(() => expect(decisions).toEqual(["ask:expired"]));
    expect(waits[0]!.invocation.signal.aborted).toBe(true);
    if (mode === "timeout") expect(activity).toBeGreaterThan(0);

    const next = session.prompt("new synthetic turn");
    let nextSettled = false;
    void next.then(
      () => (nextSettled = true),
      () => (nextSettled = true),
    );
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    const old = waits[0]!,
      current = waits[1]!;
    expect(current.invocation.sessionId).toBe(old.invocation.sessionId);
    expect(current.invocation.turnId).not.toBe(old.invocation.turnId);
    expect(current.invocation.invocationId).not.toBe(old.invocation.invocationId);
    if (mode === "late-failure") old.answer.reject(new Error("Old disconnected callback failed"));
    else old.answer.resolve("once");
    // Drain promise settlement, including the old callback's ACP catch path.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextSettled).toBe(false);
    expect(current.invocation.signal.aborted).toBe(false);
    expect(decisions).toEqual(["ask:expired"]);
    current.answer.resolve("once");
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(decisions).toEqual(["ask:expired", "ask:allow_once"]);
    expect(current.invocation.signal.aborted).toBe(true);
  },
);
