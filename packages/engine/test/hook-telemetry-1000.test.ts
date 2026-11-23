/**
 * Tool-call telemetry from a native pre-tool hook, through a run (#1000): off unless the agent
 * keeps it, stamped with the run and session by ORCA, redacted of the session's secret
 * values, bounded, and marked as reported by the hook.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRegistry,
  openHookTelemetrySpool,
  recordHookTelemetry,
  type AgentSession,
  type HookTelemetrySpool,
  type OpenSessionOptions,
} from "@orca/agents";
import {
  FakeClock,
  parseOrcaConfig,
  parseWorkflow,
  TemplateRegistry,
  TOOL_TELEMETRY_LIMITS,
  WorkflowRegistry,
  type HookTelemetryLine,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, toolTelemetryRecords } from "@orca/engine";
import { InMemoryToolTelemetryStore, memoryStores } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const VALUE = "ghp_telemetry-value-that-must-not-be-kept-42";

const single = `
id: single
name: Single
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: { role: coder }, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

const line = (over: Partial<HookTelemetryLine> = {}): HookTelemetryLine => ({
  v: 1,
  at: "2026-11-23T10:00:00.000Z",
  tool: "Bash",
  title: `curl -H "Authorization: ${VALUE}" https://example.test`,
  input: { command: `curl -H "Authorization: ${VALUE}" https://example.test` },
  decision: "ask",
  rule: "ask-network",
  latencyMs: 7,
  ...over,
});

async function setup(diagnostics: Record<string, unknown> | undefined) {
  const root = await mkdtemp(join(tmpdir(), "orca-hook-telemetry-"));
  dirs.push(root);
  const dir = join(root, "private-execution", "tool-hooks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const protectedPaths = { readOnly: [root], noAccess: [join(root, "private-execution")] };
  const config = parseOrcaConfig({
    secrets: { token: { host: "local", provider: "env", name: "ORCA_TOKEN" } },
    agents: [
      {
        id: "claude",
        command: "unused",
        roles: ["coder"],
        env: { TOKEN: { secret: "token" } },
        ...(diagnostics ? { diagnostics } : {}),
      },
    ],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(single));
  const stores = memoryStores();
  const spools: HookTelemetrySpool[] = [];
  const orchestrator = new Orchestrator({
    stores,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    secretUse: async () => {},
    clock: new FakeClock(Date.parse("2026-11-23T10:00:00.000Z")),
    sessionFactory: async (o: OpenSessionOptions) => {
      o.onSecretValues?.([VALUE]);
      // What the hook session does when the agent keeps tool calls: a spool before the agent
      // starts, handed to the hook, finished when the session ends.
      const spool = await openHookTelemetrySpool({ dir, protectedPaths });
      spools.push(spool);
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      const session: AgentSession = {
        id: "sess_1",
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        terminated: closed,
        configOptions: [],
        hookTelemetry: spool,
        setConfigOption: async () => [],
        prompt: async () => {
          // The hook's lines, and one the agent forged to land in another run.
          recordHookTelemetry(spool.target, line());
          recordHookTelemetry(spool.target, line({ tool: "Read", decision: "allow", input: { path: "a.ts" } }));
          recordHookTelemetry(spool.target, { ...line(), runId: "run_other" } as unknown as HookTelemetryLine);
          recordHookTelemetry(spool.target, line({ decision: "block", hookError: `context unreadable: ${VALUE}` }));
          return { stopReason: "end_turn" as const, durationMs: 1 };
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {
          await spool.finish();
          close();
        },
      };
      return session;
    },
  });
  return { orchestrator, stores, spools, dir };
}

describe.runIf(process.platform !== "win32")("hook telemetry through a run", () => {
  it("keeps nothing unless the agent keeps tool calls", async () => {
    for (const diagnostics of [undefined, { toolCalls: "off" }]) {
      const { orchestrator, stores, spools, dir } = await setup(diagnostics);
      const { run } = await orchestrator.startAndRun({ workflowId: "single" });
      await vi.waitFor(async () => expect(await readdir(dir)).toEqual([]));
      expect(spools).toHaveLength(1);
      expect(await stores.toolTelemetry!.list({ runId: run.id })).toEqual([]);
      expect(await stores.toolTelemetry!.runs()).toEqual([]);
    }
  });

  it("stores what the hook reported, scoped by ORCA, redacted, and marked as reported", async () => {
    const { orchestrator, stores, dir } = await setup({ toolCalls: "keep", retainDays: 7 });
    const { run } = await orchestrator.startAndRun({ workflowId: "single" });
    expect(run.status).toBe("completed");
    await vi.waitFor(async () => expect(await readdir(dir)).toEqual([]));
    const records = await stores.toolTelemetry!.list({ runId: run.id });
    expect(records.map((r) => [r.seq, r.tool.text, r.decision])).toEqual([
      [0, "Bash", "ask"],
      [1, "Read", "allow"],
      [2, "Bash", "block"],
    ]);
    const step = (await stores.events.read(run.id)).find((e) => e.type === "agent.session.opened")!;
    for (const r of records)
      expect(r).toMatchObject({
        runId: run.id,
        sessionId: "sess_1",
        stepRunId: (step.payload as { stepRunId: string }).stepRunId,
        agentId: "claude",
        source: "hook-reported",
        receivedAt: "2026-11-23T10:00:00.000Z",
        expiresAt: "2026-11-30T10:00:00.000Z",
        reportedAt: "2026-11-23T10:00:00.000Z",
      });
    expect(records[0]).toMatchObject({ rule: { text: "ask-network" }, latencyMs: 7 });
    expect(JSON.stringify(records)).not.toContain(VALUE);
    expect(records[0]!.title!.text).toContain("[REDACTED]");
    expect(records[0]!.input!.text).toContain("[REDACTED]");
    expect(records[2]!.hookError!.text).toBe("context unreadable: [REDACTED]");
    // Nothing went into the run's log.
    expect(JSON.stringify(await stores.events.read(run.id))).not.toContain("hook-reported");
  });
});

describe("toolTelemetryRecords", () => {
  const scope = { runId: "run_1", sessionId: "sess_1", agentId: "claude", stepRunId: "step_1", retainDays: 1 };
  const redact = <T>(value: T): T => JSON.parse(JSON.stringify(value).split(VALUE).join("[REDACTED]")) as T;

  it("bounds every field, keeping the length it had", () => {
    const [r] = toolTelemetryRecords(
      [line({ tool: "T".repeat(1000), title: "x".repeat(5000), input: { big: "y".repeat(5000) } })],
      scope,
      { firstSeq: 3, now: new Date("2026-11-23T00:00:00.000Z"), redact },
    );
    expect(r!.id).toBe("sess_1:3");
    expect(r!.tool).toEqual({ text: "T".repeat(TOOL_TELEMETRY_LIMITS.tool), length: 1000 });
    expect(r!.title!.text).toHaveLength(TOOL_TELEMETRY_LIMITS.title);
    expect(r!.title!.length).toBe(5000);
    expect(r!.input!.text).toHaveLength(TOOL_TELEMETRY_LIMITS.input);
    expect(r!.input!.length).toBeGreaterThan(5000);
    expect(r!.expiresAt).toBe("2026-11-24T00:00:00.000Z");
  });

  it("redacts a value the cut would split", () => {
    const padding = "p".repeat(TOOL_TELEMETRY_LIMITS.input - 20);
    const [r] = toolTelemetryRecords([line({ input: `${padding}${VALUE}` })], scope, {
      firstSeq: 0,
      now: new Date(),
      redact,
    });
    expect(r!.input!.text).not.toContain(VALUE.slice(0, 15));
  });

  it("works with a store that has never seen the run", async () => {
    const store = new InMemoryToolTelemetryStore();
    await store.append(toolTelemetryRecords([line()], scope, { firstSeq: 0, now: new Date(), redact }));
    expect(await store.runs()).toEqual(["run_1"]);
  });
});
