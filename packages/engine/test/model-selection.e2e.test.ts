/**
 * #187: a run's selected model reaches the agent. Over the scripted agent: the override arrives
 * as `session/set_config_option` before the turn, a pooled per-run session whose agent drifted
 * off the model is re-applied (and reopened when it refuses), an agent with no model option runs
 * only on a model its config declares, and a model nobody offers fails the step before any turn.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { openAcpSession, type AgentRegistry, type AgentSession } from "@orca/agents";
import { OrcaError, parseWorkflow, readJsonl, WorkflowRegistry, type SessionConfigOption } from "@orca/core";
import { scriptedAgentSpec, type PlaybookInput } from "@orca/testing";
import { afterAll, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const MODEL: SessionConfigOption = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "sonnet",
  options: [
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus" },
  ],
};

const twoSteps = `
id: two
name: two
version: "1"
start: start
nodes:
  start: { type: start }
  first:
    type: agent
    agent: { role: builder }
    prompt: "first"
    produces: [{ kind: first, path: ".orca/first.md" }]
  second:
    type: agent
    agent: { role: builder }
    prompt: "second"
    produces: [{ kind: second, path: ".orca/second.md" }]
  done: { type: end, outcome: success }
edges:
  - { from: start, to: first }
  - { from: first, to: second }
  - { from: second, to: done }
`;

type LogLine = { sessionId: string; configId?: string; value?: unknown; text?: string };

async function setup(
  playbook: PlaybookInput,
  agentOpts: Partial<Parameters<typeof scriptedAgentSpec>[0]> & { models?: { id: string; name: string }[] },
  wrap?: (s: AgentSession) => AgentSession,
) {
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(twoSteps, "two.yaml"));
  const opened: string[] = [];
  const h = await harness(playbook, {
    workflows,
    sessionFactory: async (o) => {
      const s = await openAcpSession(o);
      opened.push(s.id);
      return wrap ? wrap(s) : s;
    },
  });
  dirs.push(h.dir);
  const { models, ...rest } = agentOpts;
  const spec = scriptedAgentSpec({
    id: "claude",
    playbookJson: playbook,
    stateFile: join(h.dir, ".orca-test", "claude.json"),
    promptLog: h.promptLog,
    ...rest,
  });
  const agents: AgentRegistry = h.orchestrator.agents;
  agents.addAgent(models ? { ...spec, models } : spec).mapRole("builder", "claude");
  const log = () => readJsonl(h.promptLog, { parse: (raw) => raw as LogLine });
  return { h, opened, log };
}

const events = async (h: Awaited<ReturnType<typeof setup>>["h"], runId: string) =>
  h.orchestrator.stores.events.read(runId);

describe("applying a run's model (#187)", () => {
  it("sends the override to the agent as session/set_config_option before the first turn", async () => {
    const { h, log } = await setup({}, { configOptions: [MODEL] });
    const state = await h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: "opus" } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");

    const lines = await log();
    // Per-step sessions: each step's session is set, and the set comes before that session's turn.
    const sets = lines.filter((l) => l.configId !== undefined);
    expect(sets.map((l) => [l.configId, l.value])).toEqual([
      ["model", "opus"],
      ["model", "opus"],
    ]);
    for (const set of sets) {
      const turn = lines.findIndex((l) => l.sessionId === set.sessionId && l.text !== undefined);
      expect(lines.indexOf(set)).toBeLessThan(turn);
    }
    const opened = (await events(h, state.run.id)).filter((e) => e.type === "agent.session.opened");
    expect(opened.map((e) => (e.payload as { model?: string }).model)).toEqual(["opus", "opus"]);
  });

  it("records the agent's own model when the run selects none", async () => {
    const { h, log } = await setup({}, { configOptions: [MODEL] });
    const state = await h.orchestrator.startAndRun({ workflowId: "two" });
    expect(state.run.status).toBe("completed");
    expect((await log()).some((l) => l.configId !== undefined)).toBe(false);
    const opened = (await events(h, state.run.id)).find((e) => e.type === "agent.session.opened");
    expect((opened?.payload as { model?: string }).model).toBe("sonnet");
  });

  it("re-applies the model on a pooled per-run session the agent drifted off", async () => {
    // The first step's turn switches the agent to sonnet by itself.
    const playbook: PlaybookInput = { kinds: { first: [{ setConfig: { configId: "model", value: "sonnet" } }] } };
    const { h, opened, log } = await setup(playbook, { configOptions: [MODEL], sessionMode: "per-run" });
    const state = await h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: "opus" } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(opened).toHaveLength(1);
    const sets = (await log()).filter((l) => l.configId !== undefined).map((l) => l.value);
    expect(sets).toEqual(["opus", "opus"]);
    const reapplied = (await events(h, state.run.id)).find(
      (e) =>
        e.type === "agent.update" && (e.payload as { update: { text?: string } }).update.text?.includes("re-applied"),
    );
    expect((reapplied?.payload as { update: { text: string } }).update.text).toBe(
      "model re-applied: opus (was sonnet)",
    );
  });

  it("reopens a pooled session whose agent refuses the re-apply", async () => {
    const playbook: PlaybookInput = { kinds: { first: [{ setConfig: { configId: "model", value: "sonnet" } }] } };
    let sets = 0;
    const refuseSecond = (s: AgentSession): AgentSession =>
      new Proxy(s, {
        get(target, prop, receiver) {
          if (prop === "setConfigOption")
            return async (id: string, value: string | boolean) => {
              if (++sets === 2) throw new OrcaError("AGENT_PROTOCOL", "not now");
              return target.setConfigOption(id, value);
            };
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const { h, opened } = await setup(playbook, { configOptions: [MODEL], sessionMode: "per-run" }, refuseSecond);
    const state = await h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: "opus" } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(opened).toHaveLength(2);
    const log = await events(h, state.run.id);
    expect(log.filter((e) => e.type === "agent.session.closed").length).toBeGreaterThanOrEqual(1);
    const models = log
      .filter((e) => e.type === "agent.session.opened")
      .map((e) => (e.payload as { model?: string }).model);
    expect(models).toEqual(["opus", "opus"]);
  });

  it("fails the step before any turn when no agent offers the model", async () => {
    const { h, log } = await setup({}, { configOptions: [MODEL] });
    const state = await h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: "gpt-9" } });
    expect(state.run.status).toBe("failed");
    const first = Object.values(state.steps).find((s) => s.nodeId === "first")!;
    expect(first.error).toMatchObject({
      code: "AGENT_MODEL_NOT_FOUND",
      message: expect.stringContaining("sonnet, opus"),
    });
    // Not retried, and the agent never got a prompt.
    expect(Object.values(state.steps).filter((s) => s.nodeId === "first")).toHaveLength(1);
    expect((await log()).filter((l) => l.text !== undefined)).toEqual([]);
    const types = (await events(h, state.run.id)).map((e) => e.type);
    expect(types).not.toContain("agent.turn.started");
  });

  it("runs an agent with no model option only on a model its config declares", async () => {
    const declared = [{ id: "m1", name: "Model one" }];
    const ok = await setup({}, { models: declared });
    const done = await ok.h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: { claude: "m1" } } });
    expect(done.run.status, JSON.stringify(done.run.error)).toBe("completed");
    const opened = (await events(ok.h, done.run.id)).find((e) => e.type === "agent.session.opened");
    expect((opened?.payload as { model?: string }).model).toBe("m1");

    const bad = await setup({}, { models: declared });
    const failed = await bad.h.orchestrator.startAndRun({ workflowId: "two", overrides: { model: "m2" } });
    expect(failed.run.status).toBe("failed");
    expect(Object.values(failed.steps).find((s) => s.nodeId === "first")?.error).toMatchObject({
      code: "AGENT_MODEL_NOT_FOUND",
      message: expect.stringContaining("m1"),
    });
  });
});
