/**
 * Cancellation is only a notification in ACP. A wedged agent (deadlocked, or
 * behind a stalled transport) never answers it, so the session must stop
 * waiting on its own: after `cancelGraceMs` the prompt fails and the process
 * is killed, escalating to SIGKILL when SIGTERM is ignored.
 *
 * Session config options (#185): what `session/new` advertises is kept and normalised, a
 * `session/set_config_option` replaces it with the full list the agent returns, and an
 * unsolicited `config_option_update` lands in the same cache.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError, type SessionConfigOption } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  type AgentProcessHandle,
  type AgentSession,
  type SessionUpdateEvent,
} from "@orca/agents";
import { scriptedAgentSpec } from "@orca/testing";

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
const settled = <T>(p: Promise<T>, ms = 100) =>
  Promise.race([p, new Promise<typeof pending>((r) => setTimeout(() => r(pending), ms))]);

const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

async function open(env: Record<string, string> = {}, cancelGraceMs = 200) {
  const host = new LocalHost({ id: "local", type: "local" });
  let proc: AgentProcessHandle | undefined;
  const spawn = host.spawnAgent.bind(host);
  host.spawnAgent = async (...args) => (proc = await spawn(...args));
  const agent = AgentSpecSchema.parse({
    id: "wedged",
    command: process.execPath,
    args: ["-e", wedgedAgent],
    env,
    cancelGraceMs,
  });
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
    await expect(turn).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringMatching(/aborted: operator cancelled/),
    });
    expect(await settled(proc.exited, 1000)).not.toBe(pending);
    // The failed turn is over: close() must not wait on anything.
    await expect(settled(session.close(), 500)).resolves.not.toBe(pending);
  });

  it("escalates to SIGKILL when the wedged agent ignores SIGTERM too", async () => {
    const { session, proc } = await open({ IGNORE_TERM: "1" });
    await expect(session.prompt("go", { timeoutMs: 20 })).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
    const exit = await settled(proc.exited, 5000);
    expect(exit).not.toBe(pending);
    // Windows SIGTERM is unconditional termination, even with an installed listener.
    expect((exit as { signal: string | null }).signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
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
    await expect(turn).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringMatching(/cancel requested/),
    });
    expect(await settled(proc.exited, 1000)).not.toBe(pending);
  });
});

const MODEL_OPTION: SessionConfigOption = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "sonnet",
  options: [
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus", description: "Most capable" },
  ],
};
const THINKING_OPTION: SessionConfigOption = {
  type: "boolean",
  id: "thinking",
  name: "Extended thinking",
  category: "thought_level",
  currentValue: false,
};

/**
 * An agent that advertises what CONFIG / MODES say in `session/new`, and on every prompt sends
 * an unsolicited `config_option_update` carrying UPDATE before ending the turn.
 */
const configAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    require("node:fs").writeFileSync(process.env.INIT_LOG, JSON.stringify(m.params));
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: {}, agentInfo: { name: "cfg", version: "0" } } });
  } else if (m.method === "session/new") {
    const result = { sessionId: "s1" };
    if (process.env.CONFIG) result.configOptions = JSON.parse(process.env.CONFIG);
    if (process.env.MODES) result.modes = JSON.parse(process.env.MODES);
    send({ id: m.id, result });
  } else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "config_option_update", configOptions: JSON.parse(process.env.UPDATE) } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;

async function openConfigAgent(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "orca-cfg-"));
  const host = new LocalHost({ id: "local", type: "local" });
  const agent = AgentSpecSchema.parse({
    id: "cfg",
    command: process.execPath,
    args: ["-e", configAgent],
    env: { INIT_LOG: join(dir, "init.json"), UPDATE: "[]", ...env },
  });
  const session = await openAcpSession({ host, agent, cwd: process.cwd() });
  sessions.push(session);
  return { session, initLog: join(dir, "init.json") };
}

describe("acp session config options", () => {
  it("keeps a model select, sets it, and takes the full list the agent returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-cfg-"));
    const promptLog = join(dir, "prompts.jsonl");
    const agent = scriptedAgentSpec({ promptLog, configOptions: [MODEL_OPTION, THINKING_OPTION] });
    const host = new LocalHost({ id: "local", type: "local" });
    const session = await openAcpSession({ host, agent, cwd: dir });
    sessions.push(session);

    expect(session.configOptions).toEqual([MODEL_OPTION, THINKING_OPTION]);
    const model = session.configOptions.find((o) => o.category === "model");
    expect(model).toMatchObject({ type: "select", currentValue: "sonnet" });

    const after = await session.setConfigOption("model", "opus");
    // The full list comes back, not just the option that changed.
    expect(after).toEqual([{ ...MODEL_OPTION, currentValue: "opus" }, THINKING_OPTION]);
    expect(session.configOptions).toEqual(after);

    await session.setConfigOption("thinking", true);
    expect(session.configOptions.find((o) => o.id === "thinking")?.currentValue).toBe(true);

    const log = (await readFile(promptLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log).toEqual([
      { sessionId: session.acpSessionId, configId: "model", value: "opus" },
      { sessionId: session.acpSessionId, configId: "thinking", value: true },
    ]);

    // A value the select does not offer is the agent's to refuse, and the cache is left alone.
    await expect(session.setConfigOption("model", "gpt-9")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    expect(session.configOptions.find((o) => o.id === "model")?.currentValue).toBe("opus");
  });

  it("lands an unsolicited config_option_update in the cache and emits it as an update", async () => {
    const grouped: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "opus",
      options: [{ group: "anthropic", name: "Anthropic", options: [{ value: "opus", name: "Opus" }] }],
    };
    const { session, initLog } = await openConfigAgent({
      CONFIG: JSON.stringify([MODEL_OPTION]),
      UPDATE: JSON.stringify([grouped]),
    });
    expect(session.configOptions).toEqual([MODEL_OPTION]);
    // ORCA says it can set boolean options too.
    const init = JSON.parse(await readFile(initLog, "utf8")) as { clientCapabilities: unknown };
    expect(init.clientCapabilities).toMatchObject({ session: { configOptions: { boolean: {} } } });

    const seen: SessionUpdateEvent[] = [];
    session.onUpdate((e) => seen.push(e));
    await session.prompt("go");
    expect(session.configOptions).toEqual([grouped]);
    const update = seen.find((e) => e.summary.kind === "config_option_update");
    expect(update?.summary.text).toBe("config options: model=opus");
  });

  it("normalises legacy modes into one select, and prefers configOptions when both are sent", async () => {
    const modes = {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code", description: "Edits files" },
      ],
    };
    const legacy = await openConfigAgent({ MODES: JSON.stringify(modes) });
    expect(legacy.session.configOptions).toEqual([
      {
        type: "select",
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "ask",
        options: [
          { value: "ask", name: "Ask" },
          { value: "code", name: "Code", description: "Edits files" },
        ],
      },
    ]);
    const both = await openConfigAgent({ MODES: JSON.stringify(modes), CONFIG: JSON.stringify([MODEL_OPTION]) });
    expect(both.session.configOptions).toEqual([MODEL_OPTION]);
  });

  it("opens an agent that advertises nothing unchanged", async () => {
    const { session } = await openConfigAgent({});
    expect(session.configOptions).toEqual([]);
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    // An empty update keeps the cache empty rather than failing.
    expect(session.configOptions).toEqual([]);
  });
});
