/** Applied with the shared #237 patch: the real interpreter, lease, read and control paths agree. */
import WebSocket from "ws";
import { CredentialStore, OwnershipStore, orchestratorResolver } from "../src/auth/index.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession } from "@orca/agents";
import { AgentSpecSchema, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import {
  LiveHumanInput,
  LocalWorkspaceProvider,
  Orchestrator,
  type LiveAnswerAuthority,
  type SessionFactory,
} from "@orca/engine";
import { memoryStores } from "@orca/store";
import { ControlModel, ReadModel, startDaemon } from "@orca/daemon";
import { LiveExecutionAuthorities } from "../src/live-input-authority.js";

async function fixture(isCurrent = () => true, protectedSecret?: string) {
  const stores = memoryStores();
  const port = new LiveHumanInput("boot-a");
  const executions = new LiveExecutionAuthorities(isCurrent, 60_000);
  const answers: (string | undefined)[] = [];
  let opens = 0;
  const sessionFactory: SessionFactory = async (opts) => {
    const id = `session-${++opens}`;
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const abort = new AbortController();
    const session: AgentSession = {
      id,
      agentId: opts.agent.id,
      hostId: opts.host.id,
      cwd: opts.cwd,
      acpSessionId: id,
      configOptions: [],
      closed: closed,
      setConfigOption: async () => [],
      onUpdate: () => () => {},
      cancel: async () => {
        abort.abort();
      },
      close: async () => {
        abort.abort();
        close();
      },
      prompt: async (_input, options) => {
        const answer = await opts.askPermission!(
          {
            sessionId: id,
            toolCall: { toolCallId: "same-tool", title: "Execute a?", kind: "execute", rawInput: { data: "a" } },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
              { optionId: "remember-allow", name: "Always allow", kind: "allow_always" },
              { optionId: "remember-deny", name: "Always deny", kind: "reject_always" },
            ],
          },
          {
            sessionId: id,
            turnId: `turn-a-${randomUUID()}`,
            invocationId: `invocation-a-${randomUUID()}`,
            signal: AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]),
          },
        );
        answers.push(answer);
        return { stopReason: "end_turn", durationMs: 1 };
      },
    };
    return session;
  };
  const agents = new AgentRegistry()
    .addHost(new LocalHost({ id: "local", type: "local" }))
    .addAgent(AgentSpecSchema.parse({ id: "builder", command: "unused", permissions: { default: "ask" } }));
  const workflows = new WorkflowRegistry().register(
    parseWorkflow(`
id: live
name: live
${protectedSecret === undefined ? "" : "inputSchema: {fields: {secret: {type: string, sensitive: true}}}"}
start: s
nodes:
  s: {type: start}
  work: {type: agent, agent: builder, prompt: Execute}
  end: {type: end}
edges: [{from: s, to: work}, {from: work, to: end}]
`),
  );
  const orc = new Orchestrator({
    stores,
    agents,
    workflows,
    templates: new TemplateRegistry(),
    sessionFactory,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    liveInput: { port, executionSignal: (id) => executions.signalFor(id) },
    lease: { ttlMs: 300, renewMs: 50 },
  });
  const reads = new ReadModel({ orchestrator: orc });
  const control = new ControlModel({ orchestrator: orc, reads });
  const runId = await orc.startRun({
    workflowId: "live",
    ...(protectedSecret === undefined ? {} : { vars: { secret: protectedSecret } }),
  });
  executions.bind(runId, { principalId: "alice" });
  const done = orc.run(runId);
  void done.catch(() => undefined);
  await vi.waitFor(async () => expect((await reads.inputsList({ runId })).inputs).toHaveLength(1));
  const input = (await reads.inputsList({ runId })).inputs[0]!;
  expect(input.live?.state).toBe("pending");
  const authority: LiveAnswerAuthority = { actor: { principalId: "alice" }, authorize: async () => {} };
  const params = { runId, requestId: input.id, optionId: "allow", live: input.live!.target, resume: true };
  return {
    orc,
    reads,
    control,
    runId,
    done,
    input,
    authority,
    params,
    port,
    stores,
    answers,
    opens: () => opens,
    close: async () => {
      port.close();
      executions.close();
      await done.catch(() => undefined);
    },
  };
}

it("answers the original callback once while retaining and renewing the interpreter lease", async () => {
  const f = await fixture();
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const held = (await f.orc.listLeases()).find((l) => l.runId === f.runId)!;
    expect(held.lapsed).toBe(false);
    const second = new Orchestrator({
      stores: f.stores,
      agents: f.orc.agents,
      workflows: f.orc.workflows,
      templates: f.orc.templates,
    });
    await expect(second.run(f.runId)).rejects.toMatchObject({ code: "RUN_LEASED" });
    await expect(f.orc.answer(f.input.id, "allow", f.runId)).rejects.toMatchObject({ code: "RUN_LEASED" });
    const results = await Promise.allSettled([
      f.control.answerInput(f.params, f.authority.actor, f.authority),
      f.control.answerInput(f.params, f.authority.actor, f.authority),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.done).run.status).toBe("completed");
    expect(f.answers).toEqual(["allow"]);
    expect(f.opens()).toBe(1);
    expect((await f.orc.events(f.runId)).filter((e) => e.type === "human.answered")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("preserves live identity through protected projection without exempting context", async () => {
  const f = await fixture(() => true, "a");
  try {
    const requested = (await f.orc.events(f.runId)).find((event) => event.type === "human.requested")!;
    expect(requested.type).toBe("human.requested");
    if (requested.type !== "human.requested") throw new Error("missing request");
    expect(requested.payload.liveDecision).toEqual({
      instanceId: f.params.live.instanceId,
      sessionId: f.params.live.sessionId,
      turnId: f.params.live.turnId,
      invocationId: f.params.live.invocationId,
    });
    expect(JSON.stringify(requested.payload.context)).toContain("[REDACTED]");
    expect(requested.payload.question).toBe("Execute [REDACTED]?");
    expect(f.port.inspect(f.params.live)).toBe("pending");
    await f.control.answerInput(f.params, f.authority.actor, f.authority);
    expect((await f.done).run.status).toBe("completed");
    expect(f.answers).toEqual(["allow"]);
  } finally {
    await f.close();
  }
});

it("projects only the four structural identifiers, never lookalikes or extra context", async () => {
  const stores = memoryStores();
  await stores.execution.putInputs({
    runId: "run",
    workflowId: "live",
    workflowVersion: "1",
    vars: { secret: "a" },
    sensitiveNames: ["secret"],
    secrets: ["a"],
  });
  const identity = { instanceId: "a", sessionId: "a", turnId: "a", invocationId: "a" };
  const event = await stores.events.append({
    runId: "run",
    type: "human.requested",
    payload: {
      stepRunId: "step",
      requestId: "input",
      kind: "permission",
      question: "a",
      options: [],
      liveDecision: { ...identity, ...{ extra: "a" } },
      context: { liveDecision: { instanceId: "a" }, value: "a" },
    },
  });
  if (event.type !== "human.requested") throw new Error("wrong event");
  expect(event.payload.liveDecision).toEqual(identity);
  expect(event.payload.context).toEqual({
    liveDecision: { "inst[REDACTED]nceId": "[REDACTED]" },
    "v[REDACTED]lue": "[REDACTED]",
  });
  expect(event.payload.question).toBe("[REDACTED]");
});

it("rechecks the initiating credential at acceptance before the idle revocation poll", async () => {
  const credentials = new CredentialStore();
  const initiator = await credentials.issue({ principal: "alice", preset: "operator" });
  const f = await fixture(() => credentials.authenticate(initiator.token).ok);
  try {
    await credentials.revoke(initiator.credential.id);
    // No timer advancement: a distinct, still-authorized responder arrives immediately.
    expect(f.port.inspect(f.params.live)).toBe("pending");
    const responder: LiveAnswerAuthority = { actor: { principalId: "bob" }, authorize: async () => {} };
    await expect(f.control.answerInput(f.params, responder.actor, responder)).rejects.toMatchObject({
      code: "RUN_STATE",
      details: { liveInputState: "expired" },
    });
    await f.done;
    expect(f.answers).toEqual([undefined]);
    expect((await f.orc.events(f.runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it("honestly reports cross-process owner-unavailable and refuses stale identities", async () => {
  const f = await fixture();
  try {
    const peer = new Orchestrator({
      stores: f.stores,
      agents: f.orc.agents,
      workflows: f.orc.workflows,
      templates: f.orc.templates,
    });
    const peerReads = new ReadModel({ orchestrator: peer });
    expect((await peerReads.inputsList({ runId: f.runId })).inputs[0]!.live?.state).toBe("owner-unavailable");
    await expect(
      new ControlModel({ orchestrator: peer, reads: peerReads }).answerInput(f.params, f.authority.actor, f.authority),
    ).rejects.toMatchObject({ details: { liveInputState: "owner-unavailable" } });
    await expect(
      f.control.answerInput({ ...f.params, live: { ...f.params.live, turnId: "old" } }, f.authority.actor, f.authority),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    await f.control.answerInput(f.params, f.authority.actor, f.authority);
    await f.done;
  } finally {
    await f.close();
  }
});

it("parks after accepted standing-write failure and asks afresh on resume", async () => {
  const f = await fixture();
  try {
    await expect(
      f.port.answer({ target: f.params.live, optionId: "allow", standing: true }, f.authority, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toMatchObject({ details: { answerRecorded: true } });
    expect((await f.done).run.status).toBe("paused");
    expect(f.answers).toEqual([]);
    const resumed = f.orc.resume(f.runId);
    await vi.waitFor(async () =>
      expect((await f.reads.inputsList({ runId: f.runId })).inputs[0]?.id).not.toBe(f.input.id),
    );
    await vi.waitFor(async () => expect((await f.reads.inputsList({ runId: f.runId })).inputs).toHaveLength(1));
    const input = (await f.reads.inputsList({ runId: f.runId })).inputs[0]!;
    expect(input.live!.target.sessionId).not.toBe(f.params.live.sessionId);
    await expect(f.control.answerInput(f.params, f.authority.actor, f.authority)).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    await f.control.answerInput(
      { ...f.params, requestId: input.id, live: input.live!.target },
      f.authority.actor,
      f.authority,
    );
    expect((await resumed).run.status).toBe("completed");
    expect(f.answers).toEqual(["allow"]);
  } finally {
    await f.close();
  }
});

it.each(["http", "socket"] as const)(
  "%s authorizes, reconnects and answers the same original callback",
  async (transport) => {
    const f = await fixture();
    const credentials = new CredentialStore();
    const owner = await credentials.issue({ principal: "owner", preset: "owner" });
    const viewer = await credentials.issue({ principal: "viewer", preset: "viewer" });
    const operator = await credentials.issue({ principal: "operator", preset: "operator" });
    const daemon = await startDaemon({
      orcaVersion: "test",
      capabilities: ["runs.read", "runs.control", "runs.subscribe"],
      reads: f.reads,
      control: f.control,
      source: f.orc,
      auth: { mode: "token", credentials, ownership: new OwnershipStore(), resolver: orchestratorResolver(f.orc) },
    });
    const clients: WebSocket[] = [];
    const call = async (
      token: string,
      method: string,
      params: unknown,
    ): Promise<{ ok: boolean; error?: { code: string }; result?: unknown }> => {
      const message = { kind: "request", id: 1, method, params };
      if (transport === "http") {
        const res = await fetch(`${daemon.url}/rpc`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        return (await res.json()) as { ok: boolean; error?: { code: string }; result?: unknown };
      }
      const ws = new WebSocket(daemon.socketUrl!, ["orca.v1"], { headers: { authorization: `Bearer ${token}` } });
      clients.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const result = new Promise<{ ok: boolean; error?: { code: string }; result?: unknown }>((resolve, reject) => {
        ws.once("message", (data) =>
          resolve(JSON.parse(String(data)) as { ok: boolean; error?: { code: string }; result?: unknown }),
        );
        ws.once("error", reject);
      });
      ws.send(JSON.stringify(message));
      const response = await result;
      ws.close();
      return response;
    };
    try {
      expect(f.input.options.map((option) => option.id)).toEqual(["allow", "deny"]);
      for (const optionId of ["remember-allow", "remember-deny"]) {
        expect(await call(operator.token, "inputs.answer", { ...f.params, optionId })).toMatchObject({
          ok: false,
          error: { code: "RUN_STATE" },
        });
        expect(f.port.inspect(f.params.live)).toBe("pending");
        expect(f.answers).toEqual([]);
        expect((await f.orc.events(f.runId)).filter((event) => event.type === "human.answered")).toHaveLength(0);
      }
      expect(await call(viewer.token, "inputs.answer", f.params)).toMatchObject({
        ok: false,
        error: { code: "AUTH_FORBIDDEN" },
      });
      expect(await call(owner.token, "inputs.list", { runId: f.runId })).toMatchObject({
        ok: true,
        result: { inputs: [{ live: { state: "pending" } }] },
      });
      // Each call above disconnects its client; execution authority remains attached to the run.
      expect(f.port.inspect(f.params.live)).toBe("pending");
      expect(await call(owner.token, "inputs.list", { runId: f.runId })).toMatchObject({
        ok: true,
        result: { inputs: [{ id: f.input.id }] },
      });
      expect(await call(owner.token, "inputs.answer", f.params)).toMatchObject({ ok: true });
      expect((await f.done).run.status).toBe("completed");
      expect(f.answers).toEqual(["allow"]);
      expect((await f.orc.events(f.runId)).find((e) => e.type === "human.answered")?.payload).toMatchObject({
        actor: { principalId: "owner", credentialId: owner.credential.id },
      });
    } finally {
      for (const ws of clients) ws.terminate();
      await daemon.close();
      await f.close();
    }
  },
);

it("refuses an orphaned tool approval even if an old log describes it as a parked gate", async () => {
  const f = await fixture();
  try {
    const runId = await f.orc.startRun({ workflowId: "live" });
    const stepRunId = "dead-step",
      requestId = "dead-permission";
    await f.stores.events.append({ type: "run.started", runId, payload: {} });
    await f.stores.events.append({
      type: "step.scheduled",
      runId,
      payload: { stepRunId, nodeId: "work", nodeType: "agent", attempt: 1 },
    });
    await f.stores.events.append({ type: "step.started", runId, payload: { stepRunId, inputArtifactIds: [] } });
    await f.stores.events.append({
      type: "human.requested",
      runId,
      payload: {
        stepRunId,
        requestId,
        kind: "permission",
        question: "Old tool",
        options: [{ id: "allow", label: "Allow" }],
        context: {},
      },
    });
    await f.stores.events.append({
      type: "step.waiting",
      runId,
      payload: { stepRunId, on: "human-input", detail: requestId },
    });
    await f.stores.events.append({ type: "run.paused", runId, payload: { reason: "old callback" } });
    await expect(f.orc.answer(requestId, "allow", runId)).rejects.toMatchObject({
      code: "RUN_STATE",
      details: { liveInputState: "expired" },
    });
    expect((await f.orc.events(runId)).filter((e) => e.type === "human.answered")).toHaveLength(0);
  } finally {
    await f.close();
  }
});
