/**
 * `secret` launch inputs (#363): the launcher names a configured secret, and a step hands it to
 * its agent only as an environment variable (`secretEnv`). The session gets a reference, read on
 * the agent's host at open under the run owner's grant; the prompt and the record hold the id only.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  isOrcaError,
  parseOrcaConfig,
  parseWorkflow,
  TemplateRegistry,
  validateWorkflow,
  WorkflowRegistry,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

const workflow = (opts: { secretEnv?: string; second?: boolean } = {}) => `
id: deploy
name: Deploy
version: "1"
inputSchema:
  fields:
    token: { type: secret, required: true }
    other: { type: secret }
start: s
nodes:
  s: { type: start }
  work:
    type: agent
    agent: { role: coder }
    prompt: "deploy using {{ vars.token }}"
    secretEnv: ${opts.secretEnv ?? "{ DEPLOY_TOKEN: token }"}
${
  opts.second
    ? `  again:
    type: agent
    agent: { role: coder }
    prompt: "again"
    secretEnv: { DEPLOY_TOKEN: other }
`
    : ""
}  e: { type: end }
edges: [{ from: s, to: work }, ${opts.second ? "{ from: work, to: again }, { from: again, to: e }" : "{ from: work, to: e }"}]
`;

function setup(
  opts: {
    workflow?: string;
    secretUse?: "none";
    sessionMode?: "per-run";
    hostId?: string;
    maxAgentSessions?: number;
  } = {},
) {
  const config = parseOrcaConfig({
    hosts: [
      { id: "local", type: "local" },
      { id: "build-box", type: "ssh", host: "build-box.invalid" },
    ],
    secrets: {
      "deploy-a": { host: "local", provider: "env", name: "DEPLOY_A" },
      "deploy-b": { host: "local", provider: "env", name: "DEPLOY_B" },
      remote: { host: "build-box", provider: "env", name: "REMOTE" },
    },
    agents: [
      {
        id: "claude",
        command: "unused",
        roles: ["coder"],
        env: { LOG_LEVEL: "info" },
        ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
        ...(opts.hostId ? { hostId: opts.hostId } : {}),
      },
    ],
  });
  const opened: OpenSessionOptions[] = [];
  const shut: number[] = [];
  const prompts: unknown[] = [];
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents: AgentRegistry.fromConfig(config),
    workflows: new WorkflowRegistry().register(parseWorkflow(opts.workflow ?? workflow())),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    ...(opts.secretUse === "none" ? {} : { secretUse: async () => {} }),
    ...(opts.maxAgentSessions !== undefined ? { maxAgentSessions: opts.maxAgentSessions } : {}),
    sessionFactory: async (o: OpenSessionOptions) => {
      opened.push(o);
      const n = opened.length;
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      return {
        id: `sess_${opened.length}`,
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        terminated: closed,
        configOptions: [],
        setConfigOption: async () => [],
        prompt: async (input) => {
          prompts.push(input);
          return { stopReason: "end_turn" as const, durationMs: 1 };
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => {
          shut.push(n);
          close();
        },
      } satisfies AgentSession;
    },
  });
  return { orchestrator, opened, prompts, shut };
}

const refusal = async (made: ReturnType<typeof setup>, vars: Record<string, unknown>) => {
  const error = await made.orchestrator.startRun({ workflowId: "deploy", vars }).catch((e: unknown) => e);
  expect(isOrcaError(error, "CONFIG_INVALID") || isOrcaError(error, "WORKFLOW_INPUT_INVALID")).toBe(true);
  expect(made.opened).toEqual([]);
  return error as { message: string; details?: { reason?: string } };
};

describe("secret launch inputs (#363)", () => {
  it("hands the agent a reference to the named secret as an env variable, and only the id to the prompt", async () => {
    const made = setup();
    const { run } = await made.orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status, JSON.stringify(run.error)).toBe("completed");
    expect(made.opened[0]!.agent.env).toEqual({ LOG_LEVEL: "info", DEPLOY_TOKEN: { secret: "deploy-a" } });
    // The session reads it like any other reference: on its host, under the use decision.
    expect(made.opened[0]!.authorizeSecretUse).toBeDefined();
    expect(made.opened[0]!.secrets).toHaveProperty("deploy-a");
    expect(String(made.prompts[0])).toContain("deploy using deploy-a");
  });

  it("refuses before anything is written when the input is not a secret id, unknown, or bound to another host", async () => {
    expect((await refusal(setup(), { token: { value: "x" } })).message).toMatch(/token/);
    expect((await refusal(setup(), { token: "no-such" })).details?.reason).toBe("not-found");
    expect((await refusal(setup(), { token: "remote" })).details?.reason).toBe("wrong-host");
  });

  it("refuses where there is no use check to deliver it under", async () => {
    expect((await refusal(setup({ secretUse: "none" }), { token: "deploy-a" })).details?.reason).toBe("unauthorized");
  });

  it("opens a fresh per-run session for a step that maps another secret", async () => {
    const made = setup({ workflow: workflow({ second: true }), sessionMode: "per-run" });
    const { run } = await made.orchestrator.startAndRun({
      workflowId: "deploy",
      vars: { token: "deploy-a", other: "deploy-b" },
    });
    expect(run.status).toBe("completed");
    expect(made.opened.map((o) => o.agent.env.DEPLOY_TOKEN)).toEqual([{ secret: "deploy-a" }, { secret: "deploy-b" }]);
  });

  it("under a one-session cap, retires the run's idle pool for a secret step and pools again after it", async () => {
    const mixed = `
id: deploy
name: Deploy
version: "1"
inputSchema:
  fields:
    token: { type: secret, required: true }
start: s
nodes:
  s: { type: start }
  before: { type: agent, agent: { role: coder }, prompt: "prepare" }
  work:
    type: agent
    agent: { role: coder }
    prompt: "deploy"
    secretEnv: { DEPLOY_TOKEN: token }
  after: { type: agent, agent: { role: coder }, prompt: "verify" }
  again: { type: agent, agent: { role: coder }, prompt: "verify again" }
  e: { type: end }
edges: [{ from: s, to: before }, { from: before, to: work }, { from: work, to: after }, { from: after, to: again }, { from: again, to: e }]
`;
    const made = setup({ workflow: mixed, sessionMode: "per-run", maxAgentSessions: 1 });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status, JSON.stringify(run.error)).toBe("completed");
    // The ordinary pool (1) was retired for the secret step (2), whose own session closed with
    // it; the ordinary steps after it share a new pool (3).
    expect(made.opened.map((o) => o.agent.env.DEPLOY_TOKEN)).toEqual([undefined, { secret: "deploy-a" }, undefined]);
    expect(made.shut.slice(0, 2)).toEqual([1, 2]);
    expect(made.prompts).toHaveLength(4);
    await expect.poll(() => made.orchestrator.sessionSlots.view().inUse.total).toBe(0);
  });

  it("under a one-session cap, runs parallel secret steps one after the other", async () => {
    const branch = (name: string) =>
      `${name}: { graph: { start: s, nodes: { s: { type: start }, w: { type: agent, agent: { role: coder }, prompt: "${name}", secretEnv: { DEPLOY_TOKEN: token } }, e: { type: end } }, edges: [{ from: s, to: w }, { from: w, to: e }] } }`;
    const parallel = `
id: deploy
name: Deploy
version: "1"
inputSchema:
  fields:
    token: { type: secret, required: true }
start: s
nodes:
  s: { type: start }
  fan:
    type: parallel
    branches:
      ${branch("left")}
      ${branch("right")}
  e: { type: end }
edges: [{ from: s, to: fan }, { from: fan, to: e }]
`;
    const made = setup({ workflow: parallel, sessionMode: "per-run", maxAgentSessions: 1 });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status, JSON.stringify(run.error)).toBe("completed");
    expect(made.opened.map((o) => o.agent.env.DEPLOY_TOKEN)).toEqual([{ secret: "deploy-a" }, { secret: "deploy-a" }]);
    // Neither held the slot past its step, so the second could open once the first closed.
    expect(made.shut).toEqual([1, 2]);
    await expect.poll(() => made.orchestrator.sessionSlots.view().inUse.total).toBe(0);
  });

  it("validates that a step's secretEnv names a secret launch input", () => {
    const bad = parseWorkflow(workflow({ secretEnv: "{ DEPLOY_TOKEN: missing }" }));
    expect(validateWorkflow(bad).errors).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/nodes\.work.*\.secretEnv\.DEPLOY_TOKEN$/),
        message: expect.stringMatching(/'missing' is not a launch input of type 'secret'/),
      }),
    ]);
    expect(validateWorkflow(parseWorkflow(workflow())).errors).toEqual([]);
  });

  it("refuses a secret input below the top level", () => {
    expect(() =>
      parseWorkflow(`
id: nested
name: Nested
inputSchema:
  fields:
    creds: { type: object, properties: { token: { type: secret } } }
start: s
nodes: { s: { type: start }, e: { type: end } }
edges: [{ from: s, to: e }]
`),
    ).toThrow();
  });
});
