/**
 * The secret use decision for local execution (#336, part B): `run`, `resume` and
 * answer-to-resume in a fresh process decide from the same files the daemon does - the root
 * run's durable owner and that owner's credentials now - so a restart neither loses a grant
 * nor keeps a revoked one.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { fileStores } from "@orca/store";
import { CREDENTIALS_FILE, CredentialStore, OWNERSHIP_FILE, OwnershipStore, PRESETS } from "@orca/daemon";
import { localSecretUse, osUserPrincipalId } from "../src/local-secret-use.js";

const VALUE = "local-value-that-must-not-be-audited";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const gated = `
id: gated
name: Gated
start: s
nodes:
  s: { type: start }
  g: { type: gate, question: Go?, options: [go] }
  work: { type: agent, agent: { role: coder }, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: g }, { from: g, to: work }, { from: work, to: e }]
`;

async function workspace() {
  const configDir = await mkdtemp(join(tmpdir(), "orca-local-secret-"));
  dirs.push(configDir);
  const storeDir = join(configDir, ".orca");
  const config = parseOrcaConfig({
    secrets: { token: { host: "local", provider: "env", name: "ORCA_TOKEN" } },
    agents: [{ id: "claude", command: "unused", roles: ["coder"], env: { TOKEN: { secret: "token" } } }],
  });
  /** One "process": its own stores, orchestrator and use decision over the shared files. */
  const process = (pause = false) => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(gated));
    const opened: string[] = [];
    const orchestrator = new Orchestrator({
      stores: fileStores(storeDir),
      agents: AgentRegistry.fromConfig(config),
      workflows,
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(configDir),
      ...(pause ? { humanInput: new PausingHumanInput() } : {}),
      sessionFactory: async (o: OpenSessionOptions) => {
        await o.authorizeSecretUse!([{ secret: "token", provider: "env", hostId: o.host.id, agentId: o.agent.id }]);
        opened.push("token");
        o.onSecretValues?.([VALUE]);
        const closed = Promise.resolve();
        const session: AgentSession = {
          id: "sess",
          agentId: o.agent.id,
          hostId: o.host.id,
          cwd: o.cwd,
          acpSessionId: "acp",
          closed,
          terminated: closed,
          configOptions: [],
          setConfigOption: async () => [],
          prompt: async () => ({ stopReason: "end_turn" as const, durationMs: 1 }),
          onUpdate: () => () => {},
          cancel: async () => {},
          close: async () => {},
        };
        return session;
      },
    });
    orchestrator.secretUse = localSecretUse({ configDir, storeDir, orchestrator });
    return { orchestrator, opened };
  };
  const own = async (runId: string, principal: string) => {
    const ownership = new OwnershipStore(join(configDir, "auth", OWNERSHIP_FILE));
    ownership.record(runId, principal);
    await ownership.flush(runId);
  };
  /** Start in one process and park at the gate; answer and resume in a fresh one. */
  const parkThenResume = async (principal: string | undefined) => {
    const first = process(true);
    const runId = await first.orchestrator.startRun({ workflowId: "gated" });
    if (principal) await own(runId, principal);
    expect((await first.orchestrator.run(runId)).run.status).toBe("paused");
    const second = process();
    const [request] = await second.orchestrator.pendingInputs(runId);
    await second.orchestrator.answer(request!.id, "go", runId);
    const { run } = await second.orchestrator.resume(runId);
    return { run, opened: second.opened };
  };
  const credentials = () => new CredentialStore({ file: join(configDir, "auth", CREDENTIALS_FILE) });
  const audit = () => readFile(join(configDir, "auth", "audit.jsonl"), "utf8").catch(() => "");
  return { configDir, parkThenResume, credentials, audit };
}

describe("local secret use across a restart", () => {
  it("uses the owner's current credential grant on resume, and a revocation stops the next one", async () => {
    const w = await workspace();
    const { credential } = await w.credentials().issue({
      principal: "ci-bot",
      permissions: [...PRESETS.client.permissions, "secrets.use"],
      scope: PRESETS.client.scope,
      secrets: [{ secret: "token", provider: "env", host: "local" }],
    });
    const granted = await w.parkThenResume("ci-bot");
    expect(granted.run.status, JSON.stringify(granted.run.error)).toBe("completed");
    expect(granted.opened).toEqual(["token"]);

    await w.credentials().revoke(credential.id);
    const revoked = await w.parkThenResume("ci-bot");
    expect(revoked.run.status).toBe("failed");
    expect(revoked.opened).toEqual([]);

    const audit = await w.audit();
    expect(
      audit
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).outcome),
    ).toEqual(["succeeded", "denied"]);
    expect(audit).not.toContain(VALUE);
  });

  it("grants the standalone OS user every reference only while no credentials file exists", async () => {
    const w = await workspace();
    const standalone = await w.parkThenResume(osUserPrincipalId());
    expect(standalone.run.status, JSON.stringify(standalone.run.error)).toBe("completed");
    await w.credentials().issue({ principal: "someone", preset: "viewer" });
    expect((await w.parkThenResume(osUserPrincipalId())).run.status).toBe("failed");
  });

  it("refuses a run nothing admitted (a direct run with overrides records no owner)", async () => {
    const w = await workspace();
    const orphan = await w.parkThenResume(undefined);
    expect(orphan.run.status).toBe("failed");
    expect(orphan.opened).toEqual([]);
    expect(await w.audit()).toContain("run has no recorded owner");
  });
});
