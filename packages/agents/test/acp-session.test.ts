/**
 * Cancellation is only a notification in ACP. A wedged agent (deadlocked, or
 * behind a stalled transport) never answers it, so the session must stop
 * waiting on its own: after `cancelGraceMs` the prompt fails and the process
 * is killed, escalating to SIGKILL when SIGTERM is ignored.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError } from "@orca/core";
import { LocalHost, openAcpSession, type AgentProcessHandle, type AgentSession } from "@orca/agents";

/**
 * A minimal ACP agent over stdio that completes the handshake and then wedges:
 * `session/prompt` is never answered. By default `session/cancel` is ignored;
 * with COOPERATIVE=1 it ends the pending turn with `cancelled`, and with
 * IGNORE_TERM=1 the process also shrugs off SIGTERM.
 */
const wedgedAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let pendingPrompt;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "wedged", version: "0" } });
  else if (m.method === "session/new") reply(m.id, { sessionId: "s1" });
  else if (m.method === "session/prompt") pendingPrompt = m.id;
  else if (m.method === "session/cancel" && process.env.COOPERATIVE && pendingPrompt !== undefined) reply(pendingPrompt, { stopReason: "cancelled" });
});
if (process.env.IGNORE_TERM) process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

const pending = Symbol("pending");
const settled = <T>(p: Promise<T>, ms = 100) => Promise.race([p, new Promise<typeof pending>((r) => setTimeout(() => r(pending), ms))]);

const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

async function open(env: Record<string, string> = {}, cancelGraceMs = 200) {
  const host = new LocalHost({ id: "local", type: "local" });
  let proc: AgentProcessHandle | undefined;
  const spawn = host.spawnAgent.bind(host);
  host.spawnAgent = async (...args) => (proc = await spawn(...args));
  const agent = AgentSpecSchema.parse({ id: "wedged", command: process.execPath, args: ["-e", wedgedAgent], env, cancelGraceMs });
  const session = await openAcpSession({ host, agent, cwd: process.cwd() });
  sessions.push(session);
  return { session, proc: proc! };
}

describe("acp session cancellation", () => {
  it("kills an agent that ignores session/cancel after the turn timeout", async () => {
    const { session, proc } = await open();
    const started = Date.now();
    const err = await session.prompt("go", { timeoutMs: 50 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrcaError);
    expect((err as OrcaError).code).toBe("AGENT_TRANSPORT");
    expect((err as OrcaError).message).toMatch(/turn timed out after 50ms/);
    expect(Date.now() - started).toBeLessThan(2000);
    await session.closed;
    expect(await settled(proc.exited, 1000)).not.toBe(pending);
    // The session is unusable afterwards, and says so instead of hanging.
    await expect(session.prompt("again")).rejects.toThrow();
  });

  it("kills an agent that ignores session/cancel after an abort", async () => {
    const { session, proc } = await open();
    const ac = new AbortController();
    const turn = session.prompt("go", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort("operator cancelled");
    await expect(turn).rejects.toMatchObject({ code: "AGENT_TRANSPORT", message: expect.stringMatching(/aborted: operator cancelled/) });
    expect(await settled(proc.exited, 1000)).not.toBe(pending);
    // The failed turn is over: close() must not wait on anything.
    await expect(settled(session.close(), 500)).resolves.not.toBe(pending);
  });

  it("escalates to SIGKILL when the wedged agent ignores SIGTERM too", async () => {
    const { session, proc } = await open({ IGNORE_TERM: "1" });
    await expect(session.prompt("go", { timeoutMs: 20 })).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    const exit = await settled(proc.exited, 5000);
    expect(exit).not.toBe(pending);
    expect((exit as { signal: string | null }).signal).toBe("SIGKILL");
  });

  it("rejects a prompt whose signal is already aborted without sending it", async () => {
    const { session, proc } = await open();
    const ac = new AbortController();
    ac.abort("too late");
    await expect(session.prompt("go", { signal: ac.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await settled(proc.exited)).toBe(pending); // nothing was killed
  });

  it("leaves a cooperative agent alone once it ends the cancelled turn", async () => {
    const { session, proc } = await open({ COOPERATIVE: "1" });
    const turn = session.prompt("go", { timeoutMs: 20 });
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    // Grace timer was cleared: the process is still there well after cancelGraceMs.
    expect(await settled(proc.exited, 400)).toBe(pending);
    expect(await settled(session.closed)).toBe(pending);
  });

  it("cancel() itself is enforced, not just the timeout and the signal", async () => {
    const { session, proc } = await open();
    const turn = session.prompt("go");
    await new Promise((r) => setTimeout(r, 30));
    await session.cancel();
    await expect(turn).rejects.toMatchObject({ code: "AGENT_TRANSPORT", message: expect.stringMatching(/cancel requested/) });
    expect(await settled(proc.exited, 1000)).not.toBe(pending);
  });
});
