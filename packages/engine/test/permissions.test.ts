/**
 * `ask` permissions raised by an agent session become human-input requests:
 * one request id per ask (so concurrent asks can be answered independently),
 * recorded in the event log and attributed to the step using the session.
 */
import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { AgentRegistry, LocalHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  AgentSpecSchema,
  FakeClock,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  type JudgedDecision,
} from "@orca/core";
import {
  autoHumanInput,
  humanInputCancelled,
  LocalWorkspaceProvider,
  Orchestrator,
  type HumanInputPort,
  type HumanInputQuery,
  type SessionFactory,
} from "@orca/engine";
import { memoryStores } from "@orca/store";

/**
 * In-process port that parks questions until the test answers them. `ask`
 * permissions cannot outlive the agent session that raised them, so they are
 * never persisted (PausingHumanInput cancels them); a live port like this one
 * is how a host answers them while the run is in flight.
 */
class InProcessHumanInput implements HumanInputPort {
  private readonly pending = new Map<string, { query: HumanInputQuery; settle: (v: string | undefined) => void }>();
  ask(query: HumanInputQuery): Promise<string | undefined> {
    const { signal } = query;
    if (signal?.aborted) return Promise.reject(humanInputCancelled(signal));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(query.requestId);
        reject(humanInputCancelled(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(query.requestId, {
        query,
        settle: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
      });
    });
  }
  list(): HumanInputQuery[] {
    return [...this.pending.values()].map((p) => p.query);
  }
  answer(requestId: string, value: string | undefined): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.settle(value);
    return true;
  }
}

const permissionRequest = (id: string): acp.RequestPermissionRequest => ({
  sessionId: "acp",
  toolCall: { toolCallId: id, title: `Write ${id}`, kind: "edit" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

/** A fake ACP session whose prompt turn raises `asksPerTurn` permission requests at once. */
function fakeSessions(asksPerTurn: number, judged?: JudgedDecision) {
  const answers: (string | undefined)[] = [];
  let opened = 0;
  let calls = 0;
  const sessionFactory: SessionFactory = async (o: OpenSessionOptions) => {
    opened++;
    const session: AgentSession = {
      id: `sess_${opened}`,
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      configOptions: [],
      setConfigOption: async () => [],
      closed: new Promise(() => {}),
      async prompt() {
        const reqs = Array.from({ length: asksPerTurn }, () => permissionRequest(`tool-${++calls}`));
        const got = await Promise.all(reqs.map((r) => o.askPermission!(r, undefined, judged)));
        for (const [i, r] of reqs.entries())
          o.onPermission?.({
            toolCallId: r.toolCall.toolCallId,
            title: r.toolCall.title ?? "",
            decision: got[i] ? `ask:${got[i]}` : "ask:cancelled",
          });
        answers.push(...got);
        return { stopReason: "end_turn", durationMs: 1 };
      },
      onUpdate: () => () => {},
      cancel: async () => {},
      close: async () => {},
    };
    return session;
  };
  return { sessionFactory, answers, opened: () => opened };
}

function make(
  yaml: string,
  sessionFactory: SessionFactory,
  opts: { sessionMode?: "per-step" | "per-run"; port?: HumanInputPort } = {},
) {
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(yaml));
  const agents = new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent(
    AgentSpecSchema.parse({
      id: "fake",
      command: "x",
      roles: ["builder"],
      permissions: { default: "ask" },
      ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
    }),
  );
  const humanInput = new InProcessHumanInput();
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents,
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
    humanInput: opts.port ?? humanInput,
    sessionFactory,
  });
  return { orchestrator, humanInput };
}

const oneStep = `
id: perm
name: perm
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: fake, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

const twoSteps = `
id: perm2
name: perm2
start: s
nodes:
  s: { type: start }
  first: { type: agent, agent: fake, prompt: "one" }
  second: { type: agent, agent: fake, prompt: "two" }
  e: { type: end }
edges: [{ from: s, to: first }, { from: first, to: second }, { from: second, to: e }]
`;

describe("ask permissions as human input", () => {
  it("carries the judge's note with the ask, field by field (#701)", async () => {
    const fake = fakeSessions(1, {
      verdict: "covered",
      kind: "command",
      advisory: true,
      reasonCode: "matches-criterion",
      ruleId: "config:2",
      ruleRevision: "sha256:digest-of-the-rule",
      judgeConfigRef: "judge-config-ref",
    });
    const { orchestrator, humanInput } = make(oneStep, fake.sessionFactory);
    const done = orchestrator.startAndRun({ workflowId: "perm" });
    await vi.waitFor(() => expect(humanInput.list()).toHaveLength(1));
    const [ask] = humanInput.list();
    // The note goes where the person answers; the rule's digest and the judge config ref do not.
    expect(ask!.context).toEqual({
      toolCall: expect.objectContaining({ toolCallId: "tool-1" }),
      judge: {
        verdict: "covered",
        kind: "command",
        advisory: true,
        reasonCode: "matches-criterion",
        ruleId: "config:2",
      },
    });
    humanInput.answer(ask!.requestId, "allow");
    const state = await done;
    expect(state.humanInputs[ask!.requestId]?.context).toMatchObject({ judge: { verdict: "covered" } });
  });

  it("adds no judge note to an ask the judge did not look at", async () => {
    const fake = fakeSessions(1);
    const { orchestrator, humanInput } = make(oneStep, fake.sessionFactory);
    const done = orchestrator.startAndRun({ workflowId: "perm" });
    await vi.waitFor(() => expect(humanInput.list()).toHaveLength(1));
    const [ask] = humanInput.list();
    expect(Object.keys(ask!.context)).toEqual(["toolCall"]);
    humanInput.answer(ask!.requestId, "allow");
    await done;
  });

  it("gives every concurrent ask its own request id and logs request + answer", async () => {
    const fake = fakeSessions(2);
    const { orchestrator, humanInput } = make(oneStep, fake.sessionFactory);
    const done = orchestrator.startAndRun({ workflowId: "perm" });

    await vi.waitFor(() => expect(humanInput.list()).toHaveLength(2));
    const [a, b] = humanInput.list();
    expect(a!.requestId).not.toBe(b!.requestId);
    expect(a!.kind).toBe("permission");
    // ACP's `optionId` becomes the id (what the agent is answered with), its `name` the label,
    // and a `reject_*` kind marks the option destructive: what an "always deny" answers with.
    expect(a!.options).toEqual([
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny", destructive: true },
    ]);
    expect(a!.context).toMatchObject({ toolCall: { toolCallId: "tool-1" } });

    // Both asks are visible on the run while pending, and the step is waiting on human input.
    const mid = await orchestrator.getState(a!.runId);
    expect(
      Object.values(mid.humanInputs)
        .filter((h) => h.answer === undefined)
        .map((h) => h.id)
        .sort(),
    ).toEqual([a!.requestId, b!.requestId].sort());
    expect(mid.steps[a!.stepRunId]).toMatchObject({ nodeId: "work", status: "waiting", waitingOn: "human-input" });
    expect(mid.run.status).toBe("waiting");

    expect(humanInput.answer(a!.requestId, "allow")).toBe(true);
    expect(humanInput.answer(b!.requestId, "deny")).toBe(true);
    const state = await done;

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(fake.answers).toEqual(["allow", "deny"]);
    expect(state.humanInputs[a!.requestId]).toMatchObject({
      kind: "permission",
      question: "Write tool-1",
      answer: "allow",
    });
    expect(state.humanInputs[b!.requestId]).toMatchObject({
      kind: "permission",
      question: "Write tool-2",
      answer: "deny",
    });

    const events = await orchestrator.events(state.run.id);
    const types = (t: string) => events.filter((e) => e.type === t);
    expect(
      types("human.requested")
        .map((e) => (e.payload as { requestId: string }).requestId)
        .sort(),
    ).toEqual([a!.requestId, b!.requestId].sort());
    expect(
      types("human.answered")
        .map((e) => (e.payload as { answer: string }).answer)
        .sort(),
    ).toEqual(["allow", "deny"]);
    expect(types("agent.permission").map((e) => (e.payload as { decision: string }).decision)).toEqual([
      "ask:allow",
      "ask:deny",
    ]);
    // The step went back to waiting on the agent turn once the last ask was answered.
    const waits = types("step.waiting").map((e) => (e.payload as { on: string }).on);
    expect(waits).toEqual(["agent-turn", "human-input", "human-input", "agent-turn"]);
  });

  it("attributes asks on a pooled per-run session to the step currently using it", async () => {
    const fake = fakeSessions(1);
    const { orchestrator, humanInput } = make(twoSteps, fake.sessionFactory, { sessionMode: "per-run" });
    const done = orchestrator.startAndRun({ workflowId: "perm2" });

    await vi.waitFor(() => expect(humanInput.list()).toHaveLength(1));
    const first = humanInput.list()[0]!;
    humanInput.answer(first.requestId, "allow");
    await vi.waitFor(() => expect(humanInput.list()).toHaveLength(1));
    const second = humanInput.list()[0]!;
    expect(second.requestId).not.toBe(first.requestId);
    humanInput.answer(second.requestId, "allow");
    const state = await done;

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(fake.opened()).toBe(1);
    expect(state.steps[first.stepRunId]?.nodeId).toBe("first");
    expect(state.steps[second.stepRunId]?.nodeId).toBe("second");
    const events = await orchestrator.events(state.run.id);
    const perms = events
      .filter((e) => e.type === "agent.permission")
      .map((e) => state.steps[(e.payload as { stepRunId: string }).stepRunId]?.nodeId);
    expect(perms).toEqual(["first", "second"]);
  });

  /**
   * The unattended case #140 is about. `mode: auto` answers gates by taking the first
   * option; a permission request's options are the *agent's*, and its first option is
   * conventionally "allow once", so taking it would quietly undo the policy that asked.
   */
  describe("with nobody to answer (humanInput mode: auto)", () => {
    it("refuses the ask instead of taking the agent's first option, and the run carries on", async () => {
      const fake = fakeSessions(1);
      const { orchestrator } = make(oneStep, fake.sessionFactory, { port: autoHumanInput() });
      const state = await orchestrator.startAndRun({ workflowId: "perm" });

      expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
      // The agent was told "cancelled" — not "allow", which is what option[0] would have been.
      expect(fake.answers).toEqual([undefined]);
      const events = await orchestrator.events(state.run.id);
      expect(
        events.filter((e) => e.type === "agent.permission").map((e) => (e.payload as { decision: string }).decision),
      ).toEqual(["ask:cancelled"]);
      // And it is on the record as a question that was asked and went unanswered.
      expect(events.filter((e) => e.type === "human.requested")).toHaveLength(1);
      expect(Object.values(state.humanInputs).map((h) => h.answer)).toEqual([""]);
    });

    it("still takes a named option when the config names one the agent offered", async () => {
      const fake = fakeSessions(1);
      const { orchestrator } = make(oneStep, fake.sessionFactory, { port: autoHumanInput("deny") });
      const state = await orchestrator.startAndRun({ workflowId: "perm" });
      expect(state.run.status).toBe("completed");
      expect(fake.answers).toEqual(["deny"]);
    });

    it("refuses an option the agent never offered rather than guessing a near one", async () => {
      // `humanInput: { mode: auto, option: approve }` is the demo's gate answer; no agent
      // offers an option called "approve" on a permission request.
      const fake = fakeSessions(1);
      const { orchestrator } = make(oneStep, fake.sessionFactory, { port: autoHumanInput("approve") });
      const state = await orchestrator.startAndRun({ workflowId: "perm" });
      expect(state.run.status).toBe("completed");
      expect(fake.answers).toEqual([undefined]);
    });
  });
});
