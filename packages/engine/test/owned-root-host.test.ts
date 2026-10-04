/** Owned local workspaces never authorize sending their pathname to another host. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, SshHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, SshHostSchema, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { GitWorktreeProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(selection = "direct", inherited = false, isolateRoots = true) {
  const repo = await mkdtemp(join(tmpdir(), "orca-owned-host-"));
  dirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  const config = parseOrcaConfig({
    hosts: [
      { id: "local", type: "local" },
      { id: "remote", type: "ssh", host: "unused.invalid" },
      { id: "other-local", type: "local" },
    ],
    agents: [
      { id: "remote-agent", command: "unused", hostId: "remote", sessionMode: "per-run" },
      { id: "local-agent", command: "unused", hostId: "local", sessionMode: "per-run" },
      { id: "other-agent", command: "unused", hostId: "other-local" },
    ],
    roles: { worker: selection === "override" ? "local-agent" : "remote-agent" },
  });
  const agents = AgentRegistry.fromConfig(config);
  const remote = agents.host("remote");
  const remoteSpawn = vi.spyOn(remote, "spawnAgent");
  const remoteExec = vi.spyOn(remote, "exec");
  const selector =
    selection === "role" || selection === "override"
      ? "{role: worker}"
      : selection === "local"
        ? "local-agent"
        : selection === "other-local"
          ? "other-agent"
          : "remote-agent";
  const workflows = new WorkflowRegistry()
    .register(
      parseWorkflow(`
id: work
name: Work
start: first
nodes:
  first: {type: agent, agent: ${selector}, prompt: go}
  second: {type: agent, agent: ${selector}, prompt: again}
  end: {type: end}
edges: [{from: first, to: second}, {from: second, to: end}]
`),
    )
    .register(
      parseWorkflow(`
id: parent
name: Parent
start: child
nodes:
  child: {type: subworkflow, workflow: work}
  end: {type: end}
edges: [{from: child, to: end}]
`),
    );
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, durationMs: 1 }));
  const spawn = vi.fn(async (opts: OpenSessionOptions): Promise<AgentSession> => ({
    id: "session",
    agentId: opts.agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId: "acp",
    closed: new Promise(() => {}),
    configOptions: [],
    setConfigOption: async () => [],
    prompt,
    onUpdate: () => () => {},
    cancel: async () => {},
    close: async () => {},
  }));
  const orc = new Orchestrator({
    stores: memoryStores(),
    agents,
    workflows,
    templates: new TemplateRegistry(),
    sessionFactory: spawn,
    workspaceProvider: new GitWorktreeProvider({
      host: agents.host("local"),
      repo,
      worktreeRoot: join(repo, "trees"),
      isolateRoots,
    }),
  });
  const run = () =>
    orc.startAndRun({
      workflowId: inherited ? "parent" : "work",
      ...(selection === "override" ? { overrides: { roles: { worker: "remote-agent" } } } : {}),
    });
  return { orc, agents, spawn, prompt, remoteSpawn, remoteExec, run };
}

it.each(
  ["direct", "role", "override", "other-local"].flatMap((selection) =>
    [false, true].map((inherited) => ({ selection, inherited })),
  ),
)(
  "refuses $selection host mismatch (inherited: $inherited) before any session or remote call",
  async ({ selection, inherited }) => {
    const f = await fixture(selection, inherited);
    const state = await f.run();
    expect(state.run.status).toBe("failed");
    const states = await Promise.all((await f.orc.listRuns()).map((id) => f.orc.getState(id)));
    expect(states.some((s) => s.run.error?.message.includes("matching supported local execution host"))).toBe(true);
    if (inherited) {
      const child = states.find((s) => s.run.parentRunId === state.run.id)!;
      expect(child.run.workspace).toEqual(state.run.workspace);
      expect(child.run.workspace.rootProvisioning).toBeDefined();
    }
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.remoteSpawn).not.toHaveBeenCalled();
    expect(f.remoteExec).not.toHaveBeenCalled();
  },
);

it("allows matching local execution and pooled reuse", async () => {
  const f = await fixture("local");
  expect((await f.run()).run.status).toBe("completed");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn.mock.calls[0]![0].host).toBeInstanceOf(LocalHost);
  expect(f.prompt).toHaveBeenCalledTimes(2);
});

it("preserves existing mixed-host behavior when root isolation is disabled", async () => {
  const f = await fixture("direct", false, false);
  const state = await f.run();
  expect(state.run.status).toBe("completed");
  expect(state.run.workspace.rootProvisioning).toBeUndefined();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn.mock.calls[0]![0].host).toBeInstanceOf(SshHost);
  expect(f.prompt).toHaveBeenCalledTimes(2);
  expect(f.remoteSpawn).not.toHaveBeenCalled(); // The fixture session never starts a real SSH process.
});

it("rejects a host replaced by SSH even with the same id before returning a pooled session", async () => {
  const f = await fixture("local");
  f.prompt.mockImplementationOnce(async () => {
    f.agents.addHost(new SshHost(SshHostSchema.parse({ id: "local", type: "ssh", host: "unused.invalid" })));
    return { stopReason: "end_turn", durationMs: 1 };
  });
  const state = await f.run();
  expect(state.run.status).toBe("failed");
  expect(state.run.error?.message).toContain("matching supported local execution host");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.prompt).toHaveBeenCalledTimes(1);
});
