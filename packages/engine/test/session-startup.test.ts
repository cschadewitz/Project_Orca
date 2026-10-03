/** Startup bookkeeping retains ownership until the caller or per-run pool takes over. */
import { expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession } from "@orca/agents";
import {
  AgentSpecSchema,
  OrcaError,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type Logger,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

it.each(
  (["per-step", "per-run"] as const).flatMap((sessionMode) =>
    [false, true].map((closeFails) => ({ sessionMode, closeFails })),
  ),
)(
  "closes a $sessionMode session once when the opened event fails (close fails: $closeFails)",
  async ({ sessionMode, closeFails }) => {
    const stores = memoryStores();
    const failure = new OrcaError("STORE_WRITE", "opened event refused", { marker: "original" });
    const append = stores.events.append.bind(stores.events);
    let refuse = true;
    vi.spyOn(stores.events, "append").mockImplementation(async (event) => {
      if (event.type === "agent.session.opened" && refuse) throw failure;
      return append(event);
    });
    const closes: ReturnType<typeof vi.fn>[] = [];
    const prompts: ReturnType<typeof vi.fn>[] = [];
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn, child: () => logger };
    const orchestrator = new Orchestrator({
      stores,
      logger,
      agents: new AgentRegistry()
        .addHost(new LocalHost({ id: "local", type: "local" }))
        .addAgent(AgentSpecSchema.parse({ id: "fake", command: "unused", sessionMode })),
      workflows: new WorkflowRegistry().register(
        parseWorkflow(`
id: startup
name: startup
start: work
nodes:
  work: { type: agent, agent: fake, prompt: "go" }
  next: { type: agent, agent: fake, prompt: "again" }
  done: { type: end }
edges: [{ from: work, to: next }, { from: next, to: done }]
`),
      ),
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
      sessionFactory: async (opts) => {
        const close = vi.fn(async () => {
          if (closeFails && closes[0] === close) throw new Error("cleanup refused");
        });
        const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, durationMs: 1 }));
        closes.push(close);
        prompts.push(prompt);
        const session: AgentSession = {
          id: `sess_${closes.length}`,
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
          close,
        };
        return session;
      },
    });
    const opened = vi.fn();
    orchestrator.onAgentSessionOpened(opened);
    const failed = await orchestrator.startAndRun({ workflowId: "startup" });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error).toEqual(failure.toJSON());
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(prompts[0]).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    if (closeFails)
      expect(warn).toHaveBeenCalledWith("agent session startup cleanup failed", {
        sessionId: "sess_1",
        error: { code: "INTERNAL", message: "cleanup refused" },
      });
    else expect(warn).not.toHaveBeenCalled();
    // A later successful run still uses normal per-step/per-run ownership.
    refuse = false;
    const resumed = await orchestrator.startAndRun({ workflowId: "startup" });
    expect(resumed.run.status).toBe("completed");
    expect(prompts[0]).not.toHaveBeenCalled();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes).toHaveLength(sessionMode === "per-run" ? 2 : 3);
    for (const close of closes.slice(1)) expect(close).toHaveBeenCalledTimes(1);
  },
);
