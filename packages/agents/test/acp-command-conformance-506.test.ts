/** #506: credential-free ACP wire peer through existing live-input/operator seams; no real execution. */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AgentRegistry,
  openAcpSession,
  stdioAcpStream,
  type AgentHost,
  type AgentSession,
  type PermissionInvocation,
} from "@orca/agents";
import { AgentSpecSchema, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LiveHumanInput, Orchestrator, type LiveAnswerAuthority, type LiveDecisionTarget } from "@orca/engine";
import { executionEvents, memoryStores } from "@orca/store";
import {
  ControlModel,
  methodsFor,
  OperatorReadModel,
  operatorEventCollections,
  ReadModel,
  type MethodContext,
  type Principal,
} from "@orca/daemon";
import { InputsAnswerParamsSchema, OperatorMutationContracts, ProtocolFault } from "@orca/protocol";

const deployment = {
  workspaceId: "00000000-0000-4000-8000-000000000506",
  instanceId: "00000000-0000-4000-8000-000000000507",
};
const cwd = "/synthetic/acp-command-506";
const options: acp.PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
  { optionId: "cancel", name: "Cancel", kind: "reject_once" },
  { optionId: "remember", name: "Remember", kind: "allow_always" },
  { optionId: "remember-deny", name: "Remember denial", kind: "reject_always" },
];
const command = { command: "printf 'orca-506\\n'", cwd, additionalPermissions: { network: false } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** JSON-RPC over real ACP framing, with effects limited to counters. No host spawn/fs/exec. */
function peer(toolCall: acp.ToolCallUpdate, offered: acp.PermissionOption[], asks = 1, updateOnly = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let exit!: () => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    exit = () => resolve({ code: 0, signal: null });
  });
  let promptId: number | undefined;
  let count = 0;
  let inTurn = 0;
  let executions = 0;
  let buffer = "";
  const replies: acp.RequestPermissionResponse[] = [];
  const send = (value: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const request = () => {
    inTurn++;
    send({
      id: `permission-${++count}`,
      method: "session/request_permission",
      params: { sessionId: "synthetic-acp-session", toolCall, options: offered },
    });
  };
  output.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const m = JSON.parse(buffer.slice(0, end)) as {
        id?: number | string;
        method?: string;
        params?: { protocolVersion: number };
        result?: acp.RequestPermissionResponse;
      };
      buffer = buffer.slice(end + 1);
      if (m.method === "initialize")
        send({ id: m.id, result: { protocolVersion: m.params!.protocolVersion, agentCapabilities: {} } });
      else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "synthetic-acp-session" } });
      else if (m.method === "session/prompt") {
        promptId = m.id as number;
        inTurn = 0;
        if (updateOnly) {
          send({
            method: "session/update",
            params: {
              sessionId: "synthetic-acp-session",
              update: { ...toolCall, sessionUpdate: "tool_call", title: toolCall.title ?? "Run command" },
            },
          });
          send({ id: promptId, result: { stopReason: "end_turn" } });
          promptId = undefined;
        } else request();
      } else if (m.method === "session/cancel" && promptId !== undefined) {
        send({ id: promptId, result: { stopReason: "cancelled" } });
        promptId = undefined;
      } else if (typeof m.id === "string" && m.id.startsWith("permission-") && m.result) {
        replies.push(m.result);
        if (promptId === undefined) continue;
        if (m.result.outcome.outcome === "selected" && m.result.outcome.optionId === "allow-once") executions++;
        if (inTurn < asks) request();
        else {
          send({ id: promptId, result: { stopReason: "end_turn" } });
          promptId = undefined;
        }
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
    replies,
    executions: () => executions,
    die,
  };
}

async function fixture(
  extra: {
    ordinary?: boolean;
    asks?: number;
    twoTurns?: boolean;
    updateOnly?: boolean;
    offered?: acp.PermissionOption[];
    rawInput?: unknown;
    timeoutMs?: number;
  } = {},
) {
  const toolCall: acp.ToolCallUpdate = {
    toolCallId: "reused-tool-id",
    title: "Run command",
    kind: extra.ordinary ? "read" : "execute",
    ...(extra.ordinary ? { locations: [{ path: `${cwd}/fixture.txt` }] } : {}),
    ...(extra.rawInput === null ? {} : { rawInput: extra.rawInput ?? command }),
  };
  const wire = peer(toolCall, extra.offered ?? options, extra.asks, extra.updateOnly);
  const noIO = vi.fn(async () => {
    throw new Error("#506 fixture forbids host I/O");
  });
  const emptyExistenceCheck = vi.fn(async (paths: string[]) => {
    expect(paths).toEqual([]);
    return [];
  });
  const host: AgentHost = {
    id: "synthetic-host",
    spec: { id: "synthetic-host", type: "local" },
    fs: { readFile: noIO, writeFile: noIO, exists: noIO, existsMany: emptyExistenceCheck, mkdirp: noIO },
    exec: noIO,
    joinPath: (...parts) => parts.join("/"),
    spawnAgent: vi.fn(async () => wire.handle),
  };
  const agent = AgentSpecSchema.parse({
    id: "synthetic-agent",
    hostId: host.id,
    command: "never-spawned-506",
    sessionMode: "per-run",
    permissions: extra.ordinary ? {} : { default: "ask" },
  });
  const stores = memoryStores();
  const port = new LiveHumanInput(deployment.instanceId);
  const execution = new AbortController();
  let responderCurrent = true;
  let readCurrent = true;
  const invocations: PermissionInvocation[] = [];
  let session: AgentSession | undefined;
  const workflows = new WorkflowRegistry().register(
    parseWorkflow(
      JSON.stringify({
        id: "synthetic-506",
        name: "Synthetic 506",
        start: "start",
        nodes: {
          start: { type: "start" },
          work: {
            type: "agent",
            agent: agent.id,
            prompt: "synthetic",
            ...(extra.timeoutMs ? { completion: { timeoutMs: extra.timeoutMs } } : {}),
          },
          ...(extra.twoTurns ? { second: { type: "agent", agent: agent.id, prompt: "synthetic again" } } : {}),
          end: { type: "end" },
        },
        edges: [
          { from: "start", to: "work" },
          ...(extra.twoTurns
            ? [
                { from: "work", to: "second" },
                { from: "second", to: "end" },
              ]
            : [{ from: "work", to: "end" }]),
        ],
      }),
    ),
  );
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(host).addAgent(agent),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: { name: "synthetic", provision: async () => ({ cwd, hostId: host.id, provider: "synthetic" }) },
    liveInput: { port, executionSignal: () => execution.signal },
    sessionFactory: async (opts) => {
      session = await openAcpSession({
        ...opts,
        askPermission: async (req, invocation) => {
          invocations.push(invocation!);
          return opts.askPermission!(req, invocation);
        },
      });
      return session;
    },
  });
  const reads = new ReadModel({ orchestrator: orc });
  const control = new ControlModel({ orchestrator: orc, reads });
  const runId = await orc.startRun({ workflowId: "synthetic-506" });
  const authority: LiveAnswerAuthority = {
    actor: { principalId: "synthetic-responder", credentialId: "synthetic-credential" },
    authorize: vi.fn(async (target, standing) => {
      if (!responderCurrent || target.runId !== runId || standing)
        throw new ProtocolFault("AUTH_FORBIDDEN", "synthetic authority refused");
    }),
  };
  const principal: Principal = {
    id: authority.actor.principalId,
    credentialId: "synthetic-credential",
    kind: "credential",
    permissions: new Set(["runs.read", "inputs.answer"]),
    scope: { runs: "owned", workflows: ["synthetic-506"] },
  };
  const projection = new OperatorReadModel({
    target: deployment,
    orcaVersion: "synthetic-506",
    protocol: { major: 2, minor: 0 },
    current: async () => {
      if (!readCurrent) throw new ProtocolFault("AUTH_FORBIDDEN", "synthetic reader revoked");
      return principal;
    },
    allowsRun: async (_p, id) => id === runId,
    collections: operatorEventCollections({
      events: stores.events,
      allowsRun: async (_p, id) => id === runId,
      liveState: (target) => port.inspect(target),
      liveRevision: () => port.observationRevision,
    }),
    operations: () => ["operator.page", "operator.answer"],
  });
  const ctx: MethodContext = {
    orcaVersion: "synthetic-506",
    capabilities: [],
    identity: deployment,
    reads,
    control,
    operatorReads: { methods: ["operator.page"], model: async () => projection },
    operatorMutations: {
      current: async (invocation) => {
        if (!responderCurrent) throw new ProtocolFault("AUTH_FORBIDDEN", "synthetic responder revoked");
        return invocation;
      },
      invokeLegacy: async (name, params, _invocation, expected) => {
        if (name !== "inputs.answer") throw new Error("Only synthetic answer supported");
        return control.answerInput(InputsAnswerParamsSchema.parse(params), authority.actor, authority, expected);
      },
    },
  };
  const method = methodsFor(ctx)["operator.answer"]!;
  const answer = async (target: LiveDecisionTarget, optionId = "allow-once") => {
    const params = OperatorMutationContracts["operator.answer"].params.parse({
      target: deployment,
      decision: { lifetime: "live", live: target, optionId },
    });
    return method.handle(params, ctx);
  };
  const done = orc.run(runId);
  void done.catch(() => undefined);
  const close = async () => {
    port.close();
    await session?.cancel();
    await done.catch(() => undefined);
    await session?.close();
    wire.die();
    expect(noIO).not.toHaveBeenCalled();
  };
  cleanups.push(close);
  const page = () => projection.page({ target: deployment, collection: "inputs", runId, limit: 50 });
  const pending = async () => {
    await vi.waitFor(async () => expect((await page()).items.some((r) => r.live?.state === "pending")).toBe(true), {
      timeout: 3000,
      interval: 10,
    });
    return (await page()).items.find((r) => r.live?.state === "pending")!.live!.target;
  };
  // Keep protected rehydration explicit; never put these payloads in a report.
  const history = async () => executionEvents(await stores.events.read(runId), stores.execution);
  return {
    orc,
    stores,
    port,
    execution,
    wire,
    invocations,
    authority,
    answer,
    done,
    page,
    pending,
    history,
    session: () => session!,
    revokeResponder: () => {
      responderCurrent = false;
    },
    revokeReader: () => {
      readCurrent = false;
    },
  };
}

it("ordinary workspace reads need no invented live approval", async () => {
  const f = await fixture({ ordinary: true });
  expect((await f.done).run.status).toBe("completed");
  expect(f.invocations).toEqual([]);
  expect((await f.history()).filter((e) => e.type === "human.requested")).toEqual([]);
  expect(f.wire.replies).toEqual([{ outcome: { outcome: "selected", optionId: "allow-once" } }]);
});

it("preserves exact lifetime and offered one-shot choices, while exposing the command-evidence projection gap", async () => {
  const f = await fixture();
  const target = await f.pending();
  const invocation = f.invocations[0]!;
  expect(target).toMatchObject({
    instanceId: deployment.instanceId,
    sessionId: invocation.sessionId,
    turnId: invocation.turnId,
    invocationId: invocation.invocationId,
  });
  const rows = (await f.page()).items;
  expect(rows[0]!.options?.map((o) => o.id)).toEqual(["allow-once", "reject-once", "cancel"]);
  expect(rows[0]!.omitted).toContain("context");
  expect(JSON.stringify(rows)).not.toContain(command.command);
  expect(JSON.stringify(rows)).not.toContain(cwd);
  const requested = (await f.history()).find((e) => e.type === "human.requested");
  expect(requested).toMatchObject({
    payload: { liveDecision: { sessionId: invocation.sessionId }, context: { toolCall: { rawInput: command } } },
  });
  await expect(f.answer(target, "remember")).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.port.inspect(target)).toBe("pending");
  await f.answer(target);
  await f.done;
  expect(f.wire.executions()).toBe(1);
  expect((await f.history()).filter((e) => e.type === "human.answered")).toMatchObject([
    { payload: { answer: "allow-once", actor: f.authority.actor } },
  ]);
  await expect(f.answer(target)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.wire.executions()).toBe(1);
});

it.each(["reject-once", "cancel"])("%s delivers a refusal and no synthetic execution authorization", async (option) => {
  const f = await fixture();
  await f.answer(await f.pending(), option);
  await f.done;
  expect(f.wire.replies).toEqual([{ outcome: { outcome: "selected", optionId: option } }]);
  expect(f.wire.executions()).toBe(0);
});

it.each(["runId", "stepRunId", "requestId", "instanceId", "sessionId", "turnId", "invocationId"] as const)(
  "wrong %s cannot authorize or consume the original callback",
  async (key) => {
    const f = await fixture();
    const target = await f.pending();
    await expect(f.answer({ ...target, [key]: "wrong-synthetic-identity" })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(f.port.inspect(target)).toBe("pending");
    expect(f.wire.replies).toEqual([]);
    expect((await f.history()).filter((e) => e.type === "human.answered")).toEqual([]);
    await f.answer(target, "reject-once");
    await f.done;
    expect(f.wire.executions()).toBe(0);
  },
);

it.each([false, true])("a second invocation needs a fresh answer (new turn: %s)", async (twoTurns) => {
  const f = await fixture({ asks: twoTurns ? 1 : 2, twoTurns });
  const first = await f.pending();
  await f.answer(first);
  const second = await f.pending();
  expect(second.requestId).not.toBe(first.requestId);
  expect(second.invocationId).not.toBe(first.invocationId);
  expect(second.sessionId).toBe(first.sessionId);
  expect(second.turnId === first.turnId).toBe(!twoTurns);
  await expect(f.answer(first)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.port.inspect(second)).toBe("pending");
  await f.answer(second, "reject-once");
  await f.done;
  expect(f.wire.executions()).toBe(1);
  expect(f.wire.replies).toHaveLength(2);
});

it("concurrent responders deliver one choice to the wire and record one answer", async () => {
  const f = await fixture();
  const target = await f.pending();
  const outcomes = await Promise.allSettled([f.answer(target), f.answer(target, "reject-once")]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await f.done;
  expect(f.wire.replies).toHaveLength(1);
  expect(f.wire.executions()).toBeLessThanOrEqual(1);
  expect((await f.history()).filter((e) => e.type === "human.answered")).toHaveLength(1);
});

it.each(["cancel", "agent-death", "owner-shutdown", "execution-revoked", "lease-loss"] as const)(
  "%s expires pending callbacks and cannot resurrect authorization",
  async (reason) => {
    const f = await fixture();
    const target = await f.pending();
    if (reason === "cancel") await f.session().cancel();
    if (reason === "agent-death") f.wire.die();
    if (reason === "owner-shutdown") f.port.close();
    if (reason === "execution-revoked") f.execution.abort("synthetic authority revoked");
    if (reason === "lease-loss") {
      const lease = (await f.stores.leases.list()).find((l) => l.resource === `run:${target.runId}`)!;
      await f.stores.leases.release(lease);
      await expect(f.answer(target)).rejects.toMatchObject({ code: "RUN_LEASED" });
    }
    await vi.waitFor(() => expect(f.port.inspect(target)).toBe("expired"), { interval: 10 });
    await expect(f.answer(target)).rejects.toMatchObject({ code: "RUN_STATE" });
    await f.done.catch(() => undefined);
    expect(f.wire.executions()).toBe(0);
    expect((await f.history()).filter((e) => e.type === "human.answered")).toEqual([]);
  },
);

it("turn timeout expires the same live callback", async () => {
  const f = await fixture({ timeoutMs: 500 });
  const target = await f.pending();
  await f.done;
  expect(f.port.inspect(target)).toBe("expired");
  await expect(f.answer(target)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.wire.executions()).toBe(0);
});

it("restart has no original callback even with copied identity and history", async () => {
  const f = await fixture();
  const target = await f.pending();
  f.port.close();
  await f.done;
  const restarted = new LiveHumanInput("00000000-0000-4000-8000-000000000508");
  try {
    await expect(restarted.answer({ target, optionId: "allow-once" }, f.authority)).rejects.toMatchObject({
      details: { liveInputState: "owner-unavailable" },
    });
    expect(f.wire.executions()).toBe(0);
  } finally {
    restarted.close();
  }
});

it("responder and read revocation refuse without consuming the callback", async () => {
  const f = await fixture();
  const target = await f.pending();
  f.revokeResponder();
  await expect(f.answer(target)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.revokeReader();
  await expect(f.page()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  expect(f.port.inspect(target)).toBe("pending");
  expect(f.wire.executions()).toBe(0);
  expect((await f.history()).filter((e) => e.type === "human.answered")).toEqual([]);
});

it("rechecks responder authority inside the lease after asynchronous authorization", async () => {
  const f = await fixture();
  const target = await f.pending();
  const authorize = vi.mocked(f.authority.authorize);
  authorize
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new ProtocolFault("AUTH_FORBIDDEN", "revoked under fence"));
  await expect(f.answer(target)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  expect(f.port.inspect(target)).toBe("pending");
  expect(f.wire.replies).toEqual([]);
});

it.each(["before-delivery", "after-delivery"] as const)(
  "reconnect/lost response %s inspects without replay",
  async (loss) => {
    const f = await fixture();
    const target = await f.pending();
    const initial = (await f.page()).items;
    if (loss === "before-delivery") {
      expect((await f.page()).items).toEqual(initial);
      expect(f.wire.replies).toEqual([]);
      await f.answer(target);
    } else {
      await f.answer(target); // Intentionally discard the acknowledged result.
    }
    await f.done;
    expect((await f.page()).items).toEqual([]);
    expect(f.port.inspect(target)).toBe("expired");
    expect(f.wire.executions()).toBe(1);
    await expect(f.answer(target)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect((await f.history()).filter((e) => e.type === "human.answered")).toHaveLength(1);
  },
);

it.each([null, { command: command.command }, { cwd }, { command: command.command, cwd }])(
  "missing command/cwd/scope evidence remains a review blocker (%j)",
  async (rawInput) => {
    const f = await fixture({ rawInput });
    const target = await f.pending();
    const requested = (await f.history()).find((e) => e.type === "human.requested");
    expect(requested).toMatchObject({ payload: { question: "Run command" } });
    if (requested?.type !== "human.requested") throw new Error("Expected synthetic permission request");
    expect((requested.payload.context as { toolCall: acp.ToolCallUpdate }).toolCall.rawInput).toEqual(
      rawInput === null ? undefined : rawInput,
    );
    expect((await f.page()).items[0]!.omitted).toContain("context");
    // The current seam permits title-only asks. This is a capability gap, not an invented enforcement fix.
    await f.answer(target, "reject-once");
    await f.done;
    expect(f.wire.executions()).toBe(0);
  },
);

it("remembered-only choices are unsupported and create no live card or policy write", async () => {
  const f = await fixture({ offered: options.filter((o) => o.kind.endsWith("always")) });
  await f.done;
  expect((await f.page()).items).toEqual([]);
  expect(f.wire.replies).toEqual([{ outcome: { outcome: "cancelled" } }]);
  expect((await f.history()).filter((e) => e.type === "human.requested" || e.type === "human.answered")).toEqual([]);
  expect(f.wire.executions()).toBe(0);
});

it("tool updates alone never open a permission callback or supply authorization", async () => {
  const f = await fixture({ updateOnly: true });
  await f.done;
  expect(f.invocations).toEqual([]);
  expect(f.wire.replies).toEqual([]);
  expect((await f.page()).items).toEqual([]);
  expect((await f.history()).some((e) => e.type === "agent.update")).toBe(true);
  expect(f.wire.executions()).toBe(0);
});
