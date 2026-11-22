/**
 * Skills delivered over a real ACP connection (#337): the scripted agent, started as a
 * process, reports whether it accepts embedded context and logs every prompt it receives,
 * so the test sees exactly what reached it.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, skillDigest } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const workflow = `
id: flow
name: Flow
start: s
nodes:
  s: { type: start }
  a:
    type: agent
    agent: { role: builder }
    prompt: build
    capabilities: { skills: { enable: [review] } }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: e }]
`;

async function run(embeddedContext: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "orca-skills-acp-"));
  dirs.push(dir);
  await mkdir(join(dir, "review"));
  await writeFile(join(dir, "review", "SKILL.md"), "# Review\nlook for missing tests");
  const promptLog = join(dir, "prompts.jsonl");
  const agent = scriptedAgentSpec({ id: "builder", roles: ["builder"], promptLog, embeddedContext });
  const config = parseOrcaConfig({
    capabilities: { skills: { review: { path: join(dir, "review") } } },
    agents: [{ ...agent, capabilities: { skills: { available: ["review"] } } }],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(workflow));
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    logger: silentLogger,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    capabilityUse: async () => {},
  });
  const { run: state } = await orchestrator.startAndRun({ workflowId: "flow" });
  const prompts = await readFile(promptLog, "utf8").then(
    (text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text: string; resources?: { uri: string; text?: string }[] }),
    () => [],
  );
  return { state, prompts, dir, events: await orchestrator.events(state.id) };
}

describe("skills over a real ACP connection", () => {
  it("reaches an agent that accepts embedded context as an inline resource in its prompt", async () => {
    const { state, prompts, dir } = await run(true);
    expect(state.status).toBe("completed");
    const digest = skillDigest({ path: join(dir, "review") }, undefined);
    if (!("digest" in digest)) throw new Error(digest.error);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.resources).toEqual([
      { uri: `orca-skill://review/SKILL.md?digest=${digest.digest}`, text: "# Review\nlook for missing tests" },
    ]);
    expect(prompts[0]!.text).toMatch(/^\[resource\]\n/);
  }, 60_000);

  it("refuses the step for an agent that does not, and sends it no prompt", async () => {
    const { state, prompts, events } = await run(false);
    expect(state.status).toBe("failed");
    expect(prompts).toEqual([]);
    expect(JSON.stringify(events)).toMatch(/agent 'builder' does not accept embedded context/);
  }, 60_000);
});
