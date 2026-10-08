/** The real collector must never credit a prior report to a new attempt (#137/#135). */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession } from "@orca/agents";
import { AgentSpecSchema, parseDeliverablesBlock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const REPORT = "---\nstatus: done\npassed: true\n---\nPreviously passing report.\n";

async function setup(mode: string, backEdge: boolean, requiredContext = false) {
  const dir = await mkdtemp(join(tmpdir(), "orca-fresh-"));
  dirs.push(dir);
  await writeFile(join(dir, "report.md"), REPORT);
  const prompts: string[] = [];
  const paths: string[] = [];
  let cancellations = 0;
  const orc = new Orchestrator({
    stores: memoryStores(),
    agents: new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "fake", command: "unused", hostId: "local" })),
    templates: new TemplateRegistry(),
    workflows: new WorkflowRegistry().register(
      parseWorkflow(`
id: fresh
name: fresh
${requiredContext ? "inputs: { workItem: required }" : ""}
start: test
nodes:
  test:
    type: agent
    agent: fake
    prompt: "Task {{ workItem.title }}: {{ workItem.description }}"
    completion: { mode: ${mode}, maxFollowUps: 0, maxAttempts: 1 }
    inputs: [{ name: report, required: false }]
    produces: [{ kind: test-report, name: report, path: report.md, validate: { requiredFields: [status, passed] } }]
  done: { type: end }
edges:
  - { from: test, to: ${backEdge ? "test" : "done"} }
`),
    ),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    sessionFactory: async (options) => {
      const session: AgentSession = {
        id: `session_${prompts.length}`,
        agentId: "fake",
        hostId: "local",
        cwd: dir,
        acpSessionId: "fake",
        configOptions: [],
        setConfigOption: async () => [],
        closed: new Promise(() => {}),
        onUpdate: () => () => {},
        close: async () => {},
        cancel: async () => {
          cancellations++;
        },
        prompt: async (input) => {
          if (typeof input !== "string") throw new Error("expected a text prompt");
          const text = input;
          prompts.push(text);
          const path = parseDeliverablesBlock(text)[0]!.path;
          paths.push(path);
          if (backEdge && prompts.length === 1) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, REPORT);
          }
          if (mode === "artifact-present" && (!backEdge || prompts.length > 1)) await vi.advanceTimersByTimeAsync(1501);
          // A completed turn that writes nothing is the reported collector reproduction.
          expect(options.cwd).toBe(dir);
          return { stopReason: "end_turn", durationMs: 1 };
        },
      };
      return session;
    },
  });
  return { orc, dir, prompts, paths, cancellations: () => cancellations };
}

describe("fresh attempt outputs", () => {
  for (const mode of ["turn-end", "artifact-present"]) {
    for (const backEdge of [false, true]) {
      it(`${mode}: no new report fails${backEdge ? " on a back-edge" : " despite an old passing file"}`, async () => {
        if (mode === "artifact-present") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const h = await setup(mode, backEdge);
        const state = await h.orc.startAndRun({ workflowId: "fresh" });
        expect(state.run).toMatchObject({ status: "failed", error: { code: "ARTIFACT_MISSING" } });
        expect(h.cancellations()).toBe(0);
        expect(await readFile(join(h.dir, "report.md"), "utf8")).toBe(REPORT);
        const artifacts = Object.values(state.artifacts);
        expect(artifacts).toHaveLength(backEdge ? 1 : 0);
        if (backEdge) {
          expect(h.paths[1]).not.toBe(h.paths[0]);
          expect(artifacts[0]!.producedBy.agentSessionId).toBe("session_0");
          const inputEvents = (await h.orc.events(state.run.id)).filter((event) => event.type === "step.inputs");
          expect(inputEvents.at(-1)?.payload.artifactIds).toEqual([artifacts[0]!.id]);
          expect(await h.orc.stores.artifacts.content(artifacts[0]!.id)).toBe(REPORT);
        }
      });
    }
  }
  it("validates required work-item context before opening an agent", async () => {
    const h = await setup("turn-end", false, true);
    const absent = await h.orc.startAndRun({ workflowId: "fresh" });
    expect(absent.run.error?.code).toBe("WORKFLOW_INVALID");
    expect(h.prompts).toHaveLength(0);
    await h.orc.startAndRun({
      workflowId: "fresh",
      vars: { workItem: { slug: "login", title: "Login endpoint", description: "Add authenticated sessions" } },
    });
    expect(h.prompts[0]).toContain("Task Login endpoint: Add authenticated sessions");
    const bad = await h.orc.startAndRun({
      workflowId: "fresh",
      vars: { workItem: { slug: "../escape", title: "Wrong", description: "Wrong" } },
    });
    expect(bad.run.error?.code).toBe("WORKFLOW_INVALID");
    expect(h.prompts).toHaveLength(1);
  });
});
