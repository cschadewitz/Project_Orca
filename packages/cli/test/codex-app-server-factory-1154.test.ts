/**
 * The session factory's options for a Codex app-server session (#1154): each option ORCA's runs
 * give a session reaches the driver, ORCA's own files are bound, and each one the driver does
 * not carry yet is refused rather than dropped.
 */
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSpecSchema,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type OrcaError,
} from "@orca/core";
import {
  AgentRegistry,
  ENV_SECRET_DELIVERY,
  LocalHost,
  type AgentSession,
  type OpenCodexAppServerSessionOptions,
  type OpenSessionOptions,
} from "@orca/agents";
import { LocalWorkspaceProvider, Orchestrator, type SessionFactory } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { CODEX_FACTORY_THREAD, codexAppServerSessionOptions } from "../src/codex-app-server-factory.js";

const agent = (more: Record<string, unknown> = {}) =>
  AgentSpecSchema.parse({ id: "codex", command: "codex", driver: "codex-app-server", ...more });
const base = (more: Partial<OpenSessionOptions> = {}): OpenSessionOptions => ({
  host: new LocalHost({ id: "local", type: "local" }),
  agent: agent(),
  cwd: "/w",
  ...more,
});
const refusal = (options: OpenSessionOptions) => {
  try {
    codexAppServerSessionOptions(options, "1.2.3");
  } catch (error) {
    return error as OrcaError;
  }
  return expect.unreachable("the options were accepted");
};

describe("the factory's Codex app-server options", () => {
  it("carries every option ORCA's runs give a session, with ORCA's files bound", () => {
    const fns = {
      askPermission: vi.fn(),
      authorizeSecretUse: vi.fn(),
      judgePermission: vi.fn(),
      command: vi.fn(),
      onPermission: vi.fn(),
      onSessionContinuity: vi.fn(),
      onSecretValues: vi.fn(),
      recordFsOperation: vi.fn(),
    };
    const protectedPaths = {
      readOnly: ["/cfg/orca.yaml", "/cfg/.orca"],
      noAccess: ["/cfg/keys"],
      agentAreas: ["/cfg/.orca/work"],
    };
    const options = base({
      env: { A: "1" },
      secrets: { sources: [] } as never,
      authorizeSecretUse: fns.authorizeSecretUse,
      askPermission: fns.askPermission,
      permissionFiles: ["/cfg/orca.permissions.json"],
      protectedPaths,
      judgePermission: fns.judgePermission,
      judgeKinds: { command: fns.command },
      onPermission: fns.onPermission,
      resumeSessionId: "thr_old",
      requireContextRecovery: true,
      onSessionContinuity: fns.onSessionContinuity,
      onSecretValues: fns.onSecretValues,
      // every run supplies it; this route has no ORCA file executor to invoke it
      recordFsOperation: fns.recordFsOperation,
      exitGraceMs: 5,
      cancelGraceMs: 6,
      secretDelivery: ENV_SECRET_DELIVERY,
      relayMcpServers: false,
    });
    const mapped = codexAppServerSessionOptions(options, "1.2.3");
    expect(mapped).toEqual({
      host: options.host,
      agent: options.agent,
      cwd: "/w",
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      orcaVersion: "1.2.3",
      env: { A: "1" },
      secrets: { sources: [] },
      authorizeSecretUse: fns.authorizeSecretUse,
      askPermission: fns.askPermission,
      permissionFiles: ["/cfg/orca.permissions.json"],
      policyProtectedPaths: protectedPaths,
      protectedPaths: ["/cfg/orca.yaml", "/cfg/.orca", "/cfg/keys"],
      judgePermission: fns.judgePermission,
      judgeKinds: { command: fns.command },
      onPermission: fns.onPermission,
      onSecretValues: fns.onSecretValues,
      resumeThreadId: "thr_old",
      requireContextRecovery: true,
      onSessionContinuity: fns.onSessionContinuity,
      exitGraceMs: 5,
      cancelGraceMs: 6,
    });
    expect(CODEX_FACTORY_THREAD).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  });

  it("refuses, naming it, each option the driver does not carry yet", () => {
    const cases: [Partial<OpenSessionOptions>, RegExp][] = [
      [{ additionalDirectories: ["/other"] }, /additional directories/],
      [{ agent: agent({ mcpServers: [{ name: "m", command: "m" }] }) }, /MCP servers yet \(#1163\)/],
      [{ secretDelivery: { ...ENV_SECRET_DELIVERY } }, /secret delivery other than environment variables/],
      [{ sessionMeta: {} as never }, /ACP session metadata/],
      [{ admission: Promise.resolve() }, /runtime admission/],
      [{ relayMcpServers: true }, /relayed MCP servers/],
      [{ relayMcpServers: () => true }, /relayed MCP servers/],
      [{ requireEmbeddedContext: () => new Error("x") }, /embedded context/],
      [{ authorizeCapabilityDelivery: vi.fn() }, /capability delivery/],
      [{ judgeKinds: { edit: vi.fn() } }, /judge for edits or MCP calls/],
      [{ judgeKinds: { mcp: vi.fn() } }, /judge for edits or MCP calls/],
    ];
    for (const [more, why] of cases) {
      const error = refusal(base(more));
      expect(error.code, String(why)).toBe("NOT_SUPPORTED");
      expect(error.message).toMatch(why);
      expect(error.message).toMatch(/ORCA refuses the session rather than run it without; remove driver/);
    }
    // an empty list is no directory
    expect(() => codexAppServerSessionOptions(base({ additionalDirectories: [] }), "1.2.3")).not.toThrow();
  });

  it("accepts the options the orchestrator opens an ordinary agent session with", async () => {
    let mapped: OpenCodexAppServerSessionOptions | undefined;
    let given: OpenSessionOptions | undefined;
    const factory: SessionFactory = async (o) => {
      given = o;
      // what the factory will do for this driver once the route is enabled
      mapped = codexAppServerSessionOptions(o, "1.2.3");
      const session: AgentSession = {
        id: "sess_1",
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "thr_1",
        configOptions: [],
        setConfigOption: async () => [],
        closed: new Promise(() => {}),
        prompt: async () => ({ stopReason: "end_turn", durationMs: 1 }),
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {},
      };
      return session;
    };
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents: new AgentRegistry()
        .addHost(new LocalHost({ id: "local", type: "local" }))
        .addAgent(agent({ hostId: "local" })),
      workflows: new WorkflowRegistry().register(
        parseWorkflow(`
id: contract
name: contract
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: codex, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`),
      ),
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(tmpdir()),
      logger: silentLogger,
      sessionFactory: factory,
    });
    const state = await orchestrator.startAndRun({ workflowId: "contract" });
    expect(state.run.status).toBe("completed");
    expect(mapped).toBeDefined();
    // the orchestrator gives every ordinary session ORCA's file-executor record, which this
    // route accepts and does not carry
    expect(given!.recordFsOperation).toEqual(expect.any(Function));
    expect(mapped).not.toHaveProperty("recordFsOperation");
    // the run's redaction and answerer reach the driver
    expect(mapped!.onSecretValues).toEqual(expect.any(Function));
    expect(mapped!.askPermission).toEqual(expect.any(Function));
    expect(mapped!.thread).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  });
});
