/**
 * #186: per-run selection overrides. `roles` steers an agent step to another agent than the
 * config maps, a subworkflow child inherits it, and replaying the log against a registry whose
 * config has since changed resolves the same agents the live run did.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentRegistry, LocalHost, openAcpSession } from "@orca/agents";
import { parseWorkflow, reduceRun, WorkflowRegistry } from "@orca/core";
import { scriptedAgentSpec } from "@orca/testing";
import { afterAll, describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const child = `
id: child
name: child
version: "1"
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "child build"
    produces: [{ kind: note, path: ".orca/child-note.md" }]
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: done }
`;

const parent = `
id: parent
name: parent
version: "1"
start: start
nodes:
  start: { type: start }
  build:
    type: agent
    agent: { role: builder }
    prompt: "parent build"
    produces: [{ kind: note, path: ".orca/parent-note.md" }]
  sub: { type: subworkflow, workflow: child }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: build }
  - { from: build, to: sub }
  - { from: sub, to: done }
`;

const playbook = { kinds: { note: [{ data: { status: "done" }, body: "noted" }] } };

async function setup() {
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(child, "child.yaml"));
  workflows.register(parseWorkflow(parent, "parent.yaml"));
  const opened: string[] = [];
  const h = await harness(playbook, {
    workflows,
    sessionFactory: (options) => {
      opened.push(options.agent.id);
      return openAcpSession(options);
    },
  });
  dirs.push(h.dir);
  // The harness registers the scripted agent as `scripted`; add a second one as `codex`
  // and map `builder` to the first, so only an override can reach `codex`.
  const spec = (id: string) =>
    scriptedAgentSpec({ id, playbookJson: playbook, stateFile: join(h.dir, ".orca-test", `${id}.json`) });
  h.orchestrator.agents.addAgent(spec("claude")).addAgent(spec("codex")).mapRole("builder", "claude");
  return { h, opened };
}

describe("run overrides (#186)", () => {
  it("sends the build step to the overriding agent, in the run and in its subworkflow child", async () => {
    const { h, opened } = await setup();
    const state = await h.orchestrator.startAndRun({ workflowId: "parent", overrides: { roles: { builder: "codex" } } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.overrides).toEqual({ roles: { builder: "codex" } });
    expect(opened).toEqual(["codex", "codex"]);

    const childId = Object.values(state.steps).find((s) => s.nodeId === "sub")!.childRunIds[0]!;
    const childState = await h.orchestrator.getState(childId);
    expect(childState.run.overrides).toEqual({ roles: { builder: "codex" } });

    // The shared registry is untouched: without the override `builder` is still `claude`.
    expect(h.orchestrator.agents.resolve({ role: "builder" }).agent.id).toBe("claude");

    // Replay against a registry whose config has since changed resolves the same agents.
    const events = await h.orchestrator.stores.events.read(state.run.id);
    const replayed = reduceRun(events);
    const changed = new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(scriptedAgentSpec({ id: "claude" }))
      .addAgent(scriptedAgentSpec({ id: "codex" }))
      .addAgent(scriptedAgentSpec({ id: "gemini" }))
      .mapRole("builder", "gemini");
    expect(changed.withOverrides(replayed.run.overrides).resolve({ role: "builder" }).agent.id).toBe("codex");
    expect(changed.resolve({ role: "builder" }).agent.id).toBe("gemini");
  });

  it("refuses an unknown agent before the run is created", async () => {
    const { h } = await setup();
    await expect(
      h.orchestrator.startRun({ workflowId: "parent", overrides: { roles: { builder: "nope" } } }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND", message: "agent 'nope' not configured" });
    expect(await h.orchestrator.listRuns()).toEqual([]);
  });

  it("an unchanged run records no overrides", async () => {
    const { h } = await setup();
    const id = await h.orchestrator.startRun({ workflowId: "parent" });
    expect((await h.orchestrator.getState(id)).run.overrides).toBeUndefined();
  });
});
