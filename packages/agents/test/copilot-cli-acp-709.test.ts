/**
 * GitHub Copilot CLI ACP — offline contract tests (#709).
 *
 * ORCA's real `openAcpSession` is driven against `ScriptedCopilotPeer`, an in-memory
 * Copilot-shaped agent: no process, network, login or credential is involved, and nothing
 * here is evidence about how the installed Copilot CLI behaves. What it pins is ORCA's half
 * of the contract with the values the pinned registry probe and documentation give, plus
 * synthetic values where Copilot's are unknown (`FIXTURE_PROVENANCE`). A passing suite is
 * neither connectivity nor approval qualification, and never an execution guard.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, parseFrontMatter, parseOrcaConfig, type AgentSpec } from "@orca/core";
import { openAcpSession, type AgentSession, type PermissionInvocation, type SessionUpdateEvent } from "@orca/agents";
import {
  COPILOT_INITIALIZE_RESULT,
  COPILOT_SESSION_ID,
  COPILOT_VERSION,
  FIXTURE_PROVENANCE,
  PLACEHOLDER,
  SYNTHETIC_OPTIONS,
  ScriptedCopilotPeer,
  copilotProfileFindings,
  scriptedHost,
  type WireMessage,
} from "./fixtures/copilot-cli-acp.js";

const PACKET = new URL("../../../docs/preparation/copilot-cli-acp-709/", import.meta.url);
const PREFIX = "/opt/orca-providers";

/** The example profile's agent, parsed by ORCA's own config schema. The YAML parser is core's. */
async function exampleProfile(): Promise<AgentSpec> {
  const text = await readFile(new URL("orca.copilot-acp.example.yaml", PACKET), "utf8");
  const config = parseOrcaConfig(parseFrontMatter(`---\n${text}\n---\n`).data);
  expect(config.agents).toHaveLength(1);
  return config.agents[0]!;
}

function filled(spec: AgentSpec): AgentSpec {
  const fill = (s: string) => s.replaceAll(PLACEHOLDER, PREFIX);
  return AgentSpecSchema.parse({
    ...spec,
    command: fill(spec.command),
    env: Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, fill(v)])),
  });
}

let workspace: string;
let profile: AgentSpec;
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "orca-copilot-709-"));
  profile = filled(await exampleProfile());
});

const open: AgentSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function connect(
  peer: ScriptedCopilotPeer,
  extra: Partial<Parameters<typeof openAcpSession>[0]> = {},
  agent: AgentSpec = profile,
) {
  const fake = scriptedHost(peer);
  const session = await openAcpSession({ host: fake.host, agent, cwd: workspace, exitGraceMs: 50, ...extra });
  open.push(session);
  return { session, ...fake };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const outcome = (m: WireMessage) => (m.result as { outcome: { outcome: string; optionId?: string } }).outcome;

describe("profile and provenance", () => {
  it("parses as ORCA configuration and is inert until both placeholders are replaced", async () => {
    const raw = await exampleProfile();
    expect(raw.command).toContain(PLACEHOLDER);
    expect(copilotProfileFindings(raw)).toEqual(["placeholder: replace the absolute prefix"]);
    expect(copilotProfileFindings(profile)).toEqual([]);
    expect(profile.args.slice(0, 2)).toEqual(["--acp", "--stdio"]);
    expect(profile.command.endsWith(`/${COPILOT_VERSION}/node_modules/@github/copilot-darwin-arm64/copilot`)).toBe(
      true,
    );
  });

  it("agrees with the recorded pins and claims no installed or certified evidence", async () => {
    const pins = JSON.parse(await readFile(new URL("source-pins.json", PACKET), "utf8")) as {
      provider: { cliVersion: string; registryId: string };
      acp: { negotiatedProtocolVersion: number };
      artifacts: { platformPackages: { package: string; version: string; downloaded: boolean }[] };
      supportMatrix: { area: string; levels: string[]; status: string }[];
    };
    expect(pins.provider.cliVersion).toBe(COPILOT_VERSION);
    expect(pins.provider.registryId).toBe("github-copilot-cli");
    expect(COPILOT_INITIALIZE_RESULT.agentInfo.version).toBe(COPILOT_VERSION);
    expect(COPILOT_INITIALIZE_RESULT.protocolVersion).toBe(pins.acp.negotiatedProtocolVersion);
    const mac = pins.artifacts.platformPackages.find((p) => p.package === "@github/copilot-darwin-arm64");
    expect(mac).toMatchObject({ version: COPILOT_VERSION, downloaded: false });
    expect(profile.command).toContain(mac!.package);
    const levels = new Set(pins.supportMatrix.flatMap((row) => row.levels));
    for (const level of levels)
      expect(["documented", "registry-probed", "source-reviewed", "offline-fixture"]).toContain(level);
    expect(pins.supportMatrix.map((row) => row.status)).not.toContain("certified");
    expect(Object.values(FIXTURE_PROVENANCE)).toContain("synthetic");
  });

  it.each([
    [["--allow-all"], "args: --allow-all grants or widens approval"],
    [["--yolo"], "args: --yolo grants or widens approval"],
    [["--allow-tool=shell(git:*)"], "args: --allow-tool grants or widens approval"],
    [["--allow-all-tools"], "args: --allow-all-tools grants or widens approval"],
    [["--no-sandbox"], "args: --no-sandbox grants or widens approval"],
    [["--mode", "autopilot"], "args: --mode autopilot continues without a person"],
    [["--port", "3000"], "args: --port selects TCP; ORCA speaks stdio"],
  ])("refuses a profile that adds %j", (extra, finding) => {
    expect(copilotProfileFindings({ ...profile, args: [...profile.args, ...extra] })).toContain(finding);
  });

  it("refuses unpinned launchers, written tokens and unsafe inherited environment", () => {
    expect(copilotProfileFindings({ ...profile, command: "copilot" })).toEqual(
      expect.arrayContaining(["command: not an absolute path", `command: not a ${COPILOT_VERSION} directory`]),
    );
    expect(copilotProfileFindings({ ...profile, command: "/usr/local/bin/npx" })).toContain(
      "command: resolves the package at launch",
    );
    expect(copilotProfileFindings({ ...profile, args: ["--acp", "--stdio"] })).toContain(
      "args: missing --no-auto-update",
    );
    expect(copilotProfileFindings({ ...profile, env: { ...profile.env, GH_TOKEN: "x" } })).toContain(
      "env: GH_TOKEN written into ORCA configuration",
    );
    const { COPILOT_ALLOW_ALL: _drop, ...withoutOverride } = profile.env;
    // LocalHost merges the daemon's environment under the agent's, so absence inherits it.
    expect(copilotProfileFindings({ ...profile, env: withoutOverride }, { COPILOT_ALLOW_ALL: "true" })).toContain(
      "env: COPILOT_ALLOW_ALL is not explicitly false",
    );
    expect(copilotProfileFindings(profile, { COPILOT_ALLOW_ALL: "true" })).toEqual([]);
    expect(copilotProfileFindings(profile, { GITHUB_TOKEN: "x" })).toContain(
      "env: GITHUB_TOKEN inherited from the daemon overrides the chosen login",
    );
  });

  it("leaves production defaults without any Copilot agent", async () => {
    expect(parseOrcaConfig({}).agents).toEqual([]);
    const shipped = await readFile(new URL("../../../examples/orca.config.yaml", import.meta.url), "utf8");
    expect(shipped.toLowerCase()).not.toContain("copilot");
  });
});

describe("capability negotiation and authentication", () => {
  it("launches exactly the profile and negotiates ORCA's capabilities without authenticating", async () => {
    const peer = new ScriptedCopilotPeer();
    const { session, spawn } = await connect(peer);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toEqual(profile);
    expect(spawn.mock.calls[0]![1]).toEqual({ cwd: workspace });

    const init = peer.sent("initialize")[0]!.params!;
    expect(init.protocolVersion).toBe(1);
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
      session: { configOptions: { boolean: {} } },
    });
    expect(peer.sent("session/new")[0]!.params).toEqual({ cwd: workspace, mcpServers: [] });
    expect(peer.fromClient.map((m) => m.method)).toEqual(["initialize", "session/new"]);
    // No ACP authenticate, no session/load without an explicit resume, and no config set:
    // Copilot's allow_all option is left as Copilot reported it.
    expect(session.acpSessionId).toBe(COPILOT_SESSION_ID);
    expect(session.id).not.toBe(COPILOT_SESSION_ID);
    expect(session.configOptions).toEqual([
      expect.objectContaining({ id: "allow_all", type: "boolean", currentValue: false }),
    ]);
  });

  it("fails closed when session/new reports authentication required", async () => {
    const peer = new ScriptedCopilotPeer({ authenticated: false });
    const fake = scriptedHost(peer);
    await expect(
      openAcpSession({ host: fake.host, agent: profile, cwd: workspace, exitGraceMs: 50 }),
    ).rejects.toMatchObject({ code: "AGENT_PROTOCOL", message: expect.stringContaining("Authentication required") });
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
    expect(peer.fromClient.map((m) => m.method)).toEqual(["initialize", "session/new"]);
  });
});

describe("streaming, session and turn identity", () => {
  it("delivers Copilot-shaped updates in order and drops another session's", async () => {
    const peer = new ScriptedCopilotPeer();
    peer.handle("session/prompt", (m, p) => {
      p.update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "context", description: "Show context" }],
      });
      p.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
      p.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } }, "another-session");
      p.update({ sessionUpdate: "plan", entries: [{ content: "read", status: "in_progress", priority: "medium" }] });
      p.update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "view README.md",
        kind: "read",
        status: "pending",
      });
      p.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      p.update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
      p.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
      p.reply(m.id!, { stopReason: "end_turn" });
    });
    const { session } = await connect(peer);
    const seen: SessionUpdateEvent[] = [];
    session.onUpdate((e) => seen.push(e));
    await expect(session.prompt("hello")).resolves.toMatchObject({ stopReason: "end_turn" });
    await settle();
    expect(seen.every((e) => e.sessionId === COPILOT_SESSION_ID)).toBe(true);
    expect(seen.map((e) => e.summary.kind)).toEqual([
      "available_commands_update",
      "agent_message_chunk",
      "plan",
      "tool_call",
      "tool_call_update",
      "usage_update",
      "agent_message_chunk",
    ]);
    expect(seen.filter((e) => e.summary.kind === "agent_message_chunk").map((e) => e.summary.text)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(peer.sent("session/prompt")[0]!.params).toEqual({
      sessionId: COPILOT_SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
  });

  it("keeps the turn alive when an update variant is outside ORCA's ACP schema", async () => {
    const peer = new ScriptedCopilotPeer();
    peer.handle("session/prompt", (m, p) => {
      p.update({ sessionUpdate: "copilot_fixture_unknown", detail: 1 });
      p.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } });
      p.reply(m.id!, { stopReason: "end_turn" });
    });
    const { session } = await connect(peer);
    const kinds: string[] = [];
    session.onUpdate((e) => kinds.push(e.summary.kind));
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    await settle();
    expect(kinds).not.toContain("copilot_fixture_unknown");
    expect(kinds).toContain("agent_message_chunk");
  });

  it("gives each prompt its own turn identity and refuses a concurrent one", async () => {
    const peer = new ScriptedCopilotPeer();
    const invocations: PermissionInvocation[] = [];
    peer.handle("session/prompt", (m, p) => {
      void p
        .askPermission({ toolCallId: `t${m.id}`, title: "curl example.com", kind: "fetch" })
        .then(() => p.reply(m.id!, { stopReason: "end_turn" }));
    });
    const { session } = await connect(peer, {
      askPermission: async (_req, invocation) => {
        invocations.push(invocation!);
        return "fixture-reject-once";
      },
    });
    const first = session.prompt("one");
    await expect(session.prompt("overlap")).rejects.toMatchObject({ code: "RUN_STATE" });
    await first;
    await session.prompt("two");
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.sessionId).toBe(session.id);
    expect(invocations[0]!.turnId).not.toBe(invocations[1]!.turnId);
    expect(invocations[0]!.invocationId).not.toBe(invocations[1]!.invocationId);
    expect(invocations[0]!.signal.aborted).toBe(true); // that turn is over
  });

  it("ignores a duplicated prompt response and serves the next turn", async () => {
    const peer = new ScriptedCopilotPeer();
    peer.handle("session/prompt", (m, p) => {
      p.reply(m.id!, { stopReason: "end_turn" });
      p.reply(m.id!, { stopReason: "cancelled" });
    });
    const { session } = await connect(peer);
    await expect(session.prompt("a")).resolves.toMatchObject({ stopReason: "end_turn" });
    await settle();
    await expect(session.prompt("b")).resolves.toMatchObject({ stopReason: "end_turn" });
  });
});

describe("errors", () => {
  it("surfaces a prompt error as AGENT_PROTOCOL and keeps the session usable", async () => {
    const peer = new ScriptedCopilotPeer();
    let calls = 0;
    peer.handle("session/prompt", (m, p) =>
      calls++ === 0
        ? p.fail(m.id!, -32603, "fixture: request quota exceeded")
        : p.reply(m.id!, { stopReason: "max_tokens" }),
    );
    const { session } = await connect(peer);
    await expect(session.prompt("a")).rejects.toMatchObject({
      code: "AGENT_PROTOCOL",
      message: expect.stringContaining("fixture: request quota exceeded"),
    });
    await expect(session.prompt("b")).resolves.toMatchObject({ stopReason: "max_tokens" });
  });

  it("rejects the turn instead of hanging when the agent's stream ends", async () => {
    const peer = new ScriptedCopilotPeer();
    peer.handle("session/prompt", (_m, p) => p.agentStdout.end());
    const { session } = await connect(peer);
    await expect(session.prompt("a")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
  });
});

describe("cancellation", () => {
  it("cancels a pending permission ask and accepts the agent's cancelled stop", async () => {
    const peer = new ScriptedCopilotPeer();
    let ask!: Promise<WireMessage>;
    let promptId: number | string | undefined;
    peer.handle("session/prompt", (m, p) => {
      promptId = m.id;
      ask = p.askPermission({ toolCallId: "t1", title: "rm build", kind: "execute" });
    });
    peer.handle("session/cancel", (_m, p) => p.reply(promptId!, { stopReason: "cancelled" }));
    let asked!: () => void;
    const reachedHuman = new Promise<void>((r) => (asked = r));
    const { session, kill } = await connect(peer, {
      cancelGraceMs: 50,
      askPermission: () => {
        asked();
        return new Promise<string | undefined>(() => undefined); // nobody answers
      },
    });
    const turn = session.prompt("go");
    await reachedHuman;
    await session.cancel();
    expect(outcome(await ask)).toEqual({ outcome: "cancelled" });
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(peer.sent("session/cancel").map((m) => m.params)).toEqual([{ sessionId: COPILOT_SESSION_ID }]);
    await new Promise((r) => setTimeout(r, 100)); // past cancelGraceMs
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills an agent that does not end its turn within cancelGraceMs", async () => {
    const peer = new ScriptedCopilotPeer();
    peer.handle("session/prompt", () => undefined);
    const { session, kill } = await connect(peer, { cancelGraceMs: 30 });
    const turn = session.prompt("go");
    await peer.waitFor("session/prompt");
    await session.cancel();
    await expect(turn).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringMatching(/within 30ms/),
    });
    expect(peer.sent("session/cancel")).toHaveLength(1);
    expect(kill).toHaveBeenCalled();
  });
});

describe("unsupported blocking client methods", () => {
  it.each(["terminal/create", "elicitation/create", "mcp/message", "_copilot/fixture_custom"])(
    "answers %s with method-not-found and lets the turn finish",
    async (method) => {
      const peer = new ScriptedCopilotPeer();
      let response!: Promise<WireMessage>;
      peer.handle("session/prompt", (m, p) => {
        response = p.request(method, { sessionId: COPILOT_SESSION_ID });
        void response.then(() => p.reply(m.id!, { stopReason: "end_turn" }));
      });
      const { session } = await connect(peer);
      await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect((await response).error).toMatchObject({ code: -32601 });
    },
  );
});

describe("permission options", () => {
  async function answer(
    toolCall: Record<string, unknown>,
    options: readonly object[] = SYNTHETIC_OPTIONS,
    extra: Partial<Parameters<typeof openAcpSession>[0]> = {},
    agent: AgentSpec = profile,
  ) {
    const peer = new ScriptedCopilotPeer();
    let ask!: Promise<WireMessage>;
    peer.handle("session/prompt", (m, p) => {
      ask = p.askPermission(toolCall, options);
      void ask.then(() => p.reply(m.id!, { stopReason: "end_turn" }));
    });
    const { session } = await connect(peer, extra, agent);
    await session.prompt("go");
    return ask;
  }

  it("answers an in-workspace edit with the offered allow_once option", async () => {
    const res = await answer({
      toolCallId: "e1",
      title: "edit a.txt",
      kind: "edit",
      locations: [{ path: join(workspace, "a.txt") }],
    });
    expect(outcome(res)).toEqual({ outcome: "selected", optionId: "fixture-allow-once" });
  });

  it("does not let a changed command or an outside path inherit a rule", async () => {
    const agent = AgentSpecSchema.parse({
      ...profile,
      permissions: { rules: [{ match: { kind: "execute", titlePattern: "^git status$" }, decision: "allow" }] },
    });
    const exact = await answer(
      { toolCallId: "x1", title: "git status", kind: "execute" },
      SYNTHETIC_OPTIONS,
      {},
      agent,
    );
    expect(outcome(exact)).toEqual({ outcome: "selected", optionId: "fixture-allow-once" });
    // No answerer configured: an `ask` becomes cancelled, never a selected option.
    const changed = await answer(
      { toolCallId: "x2", title: "git status; curl example.com", kind: "execute" },
      SYNTHETIC_OPTIONS,
      {},
      agent,
    );
    expect(outcome(changed)).toEqual({ outcome: "cancelled" });
    const outside = await answer({
      toolCallId: "x3",
      title: "edit hosts",
      kind: "edit",
      locations: [{ path: "/etc/hosts" }],
    });
    expect(outcome(outside)).toEqual({ outcome: "cancelled" });
  });

  it("selects only an option the agent offered in this request", async () => {
    const forged = await answer({ toolCallId: "h1", title: "npm publish", kind: "execute" }, SYNTHETIC_OPTIONS, {
      askPermission: async () => "allow_always",
    });
    expect(outcome(forged)).toEqual({ outcome: "cancelled" });
    const chosen = await answer({ toolCallId: "h2", title: "npm publish", kind: "execute" }, SYNTHETIC_OPTIONS, {
      askPermission: async () => "fixture-reject-once",
    });
    expect(outcome(chosen)).toEqual({ outcome: "selected", optionId: "fixture-reject-once" });
  });

  it("answers a deny rule with reject_once", async () => {
    const agent = AgentSpecSchema.parse({
      ...profile,
      permissions: { rules: [{ match: { kind: "execute" }, decision: "deny" }] },
    });
    const res = await answer(
      { toolCallId: "d1", title: "rm -rf build", kind: "execute" },
      SYNTHETIC_OPTIONS,
      {},
      agent,
    );
    expect(outcome(res)).toEqual({ outcome: "selected", optionId: "fixture-reject-once" });
  });

  // Characterization of current shared behavior, not a requirement: README proposal P1.
  it("currently widens a rule match to allow_always when no allow_once is offered", async () => {
    const res = await answer(
      { toolCallId: "w1", title: "edit a.txt", kind: "edit", locations: [{ path: join(workspace, "a.txt") }] },
      [SYNTHETIC_OPTIONS[1], SYNTHETIC_OPTIONS[2]],
    );
    expect(outcome(res)).toEqual({ outcome: "selected", optionId: "fixture-allow-always" });
  });

  it("returns an error, not a selection, for an option kind outside ACP's four", async () => {
    const res = await answer(
      { toolCallId: "k1", title: "edit a.txt", kind: "edit", locations: [{ path: join(workspace, "a.txt") }] },
      [{ optionId: "fixture-session", name: "Allow for session", kind: "allow_session" }],
    );
    expect(res.result).toBeUndefined();
    expect(res.error).toMatchObject({ code: -32602 });
  });

  it("cancels asks for another session or outside a live turn", async () => {
    const peer = new ScriptedCopilotPeer();
    let foreign!: Promise<WireMessage>;
    peer.handle("session/prompt", (m, p) => {
      foreign = p.askPermission(
        { toolCallId: "s1", title: "edit a.txt", kind: "edit" },
        SYNTHETIC_OPTIONS,
        "another-session",
      );
      void foreign.then(() => p.reply(m.id!, { stopReason: "end_turn" }));
    });
    const { session } = await connect(peer, { askPermission: async () => "fixture-allow-once" });
    await session.prompt("go");
    expect(outcome(await foreign)).toEqual({ outcome: "cancelled" });
    const stale = await peer.askPermission({ toolCallId: "s2", title: "edit a.txt", kind: "edit" });
    expect(outcome(stale)).toEqual({ outcome: "cancelled" });
  });
});
