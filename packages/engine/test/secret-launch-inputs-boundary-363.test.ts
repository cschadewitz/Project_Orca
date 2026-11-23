/**
 * `secret` launch inputs at the real secret-use boundary (#363): a real ACP agent process,
 * opened by the default session factory, reads the secret on its host under the run owner's
 * grant at every step. A secret-bearing step gets a process of its own, so a denied grant, a
 * grant revoked between steps and a value rotated between steps each take effect at the next
 * step. The selection is the one the launch recorded, not the run's working vars.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { OrcaError, parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

const SCRIPTED = resolve(__dirname, "../../testing/dist/scripted-agent/main.js");
const VAR = "ORCA_363_DEPLOY_TOKEN";
const OTHER_VAR = "ORCA_363_OTHER_TOKEN";

const workflow = `
id: deploy
name: Deploy
version: "1"
inputSchema:
  fields:
    token: { type: secret, required: true }
start: s
nodes:
  s: { type: start }
  first:
    type: agent
    agent: { role: coder }
    prompt: "first deploy using {{ vars.token }}"
    secretEnv: { DEPLOY_TOKEN: token }
    produces: [{ kind: report, name: first, path: "out/first.md" }]
  second:
    type: agent
    agent: { role: coder }
    prompt: "second deploy using {{ vars.token }}"
    secretEnv: { DEPLOY_TOKEN: token }
    produces: [{ kind: report, name: second, path: "out/second.md" }]
  e: { type: end }
edges: [{ from: s, to: first }, { from: first, to: second }, { from: second, to: e }]
`;

type SecretUse = NonNullable<ConstructorParameters<typeof Orchestrator>[0]["secretUse"]>;

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "orca-363-boundary-"));
  process.env[VAR] = "rotate-v1-value";
  process.env[OTHER_VAR] = "other-secret-value";
});
afterEach(async () => {
  delete process.env[VAR];
  delete process.env[OTHER_VAR];
  await rm(work, { recursive: true, force: true });
});

function setup(secretUse: SecretUse, stores: Stores = memoryStores()) {
  const config = parseOrcaConfig({
    secrets: {
      "deploy-a": { host: "local", provider: "env", name: VAR },
      "deploy-b": { host: "local", provider: "env", name: OTHER_VAR },
    },
    agents: [
      {
        id: "scripted",
        command: process.execPath,
        args: [SCRIPTED],
        roles: ["coder"],
        // Per-run on purpose: a secret-bearing step must not reuse the pooled process.
        sessionMode: "per-run",
        permissions: { default: "allow" },
        env: {
          ORCA_PLAYBOOK_JSON: JSON.stringify({ kinds: { report: [{ body: "token={env:DEPLOY_TOKEN}" }] } }),
        },
      },
    ],
  });
  const orchestrator = new Orchestrator({
    stores,
    agents: AgentRegistry.fromConfig(config),
    workflows: new WorkflowRegistry().register(parseWorkflow(workflow)),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(work),
    secretUse,
  });
  return { orchestrator, stores };
}

/** What the agent process wrote on disk: its own environment, as it saw it. */
async function written(name: string): Promise<string | undefined> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === name) found.push(path);
    }
  };
  await walk(work);
  return found.length ? readFile(found[0]!, "utf8") : undefined;
}

async function record(stores: Stores, runId: string): Promise<string> {
  return JSON.stringify([
    await stores.events.read(runId),
    await stores.artifacts.list({ runId }),
    await Promise.all(
      (await stores.artifacts.list({ runId })).map(async (a) =>
        Buffer.from(await stores.artifacts.bytes(a.id)).toString("utf8"),
      ),
    ),
  ]);
}

const sessionsOpened = async (stores: Stores, runId: string) =>
  (await stores.events.read(runId)).filter((e) => e.type === "agent.session.opened").length;

const denial = () => new OrcaError("CONFIG_INVALID", "use of secret 'deploy-a' is not granted to this run");

describe("secret launch inputs at the secret-use boundary (#363)", () => {
  it("reads a rotated value at the next step, in a process of its own", async () => {
    let asked = 0;
    const { orchestrator, stores } = setup(async () => {
      asked++;
      // Rotated after the first step's process read it, before the second step's opens.
      if (asked === 2) process.env[VAR] = "rotate-v2-value";
    });
    const { run } = await orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status).toBe("completed");
    expect(asked).toBe(2);
    expect(await written("first.md")).toContain("token=rotate-v1-value");
    expect(await written("second.md")).toContain("token=rotate-v2-value");
    // Two processes, though the agent is per-run: neither secret-bearing session was pooled.
    expect(await sessionsOpened(stores, run.id)).toBe(2);
    const stored = await record(stores, run.id);
    expect(stored).not.toContain("rotate-v1-value");
    expect(stored).not.toContain("rotate-v2-value");
  }, 60_000);

  it("stops at the next step when the grant is revoked between steps", async () => {
    let asked = 0;
    const { orchestrator, stores } = setup(async () => {
      asked++;
      if (asked === 2) throw denial();
    });
    const { run } = await orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status).toBe("failed");
    expect(await written("first.md")).toContain("token=rotate-v1-value");
    // The second step's process never started, so nothing read the value for it.
    expect(await written("second.md")).toBeUndefined();
    expect(await sessionsOpened(stores, run.id)).toBe(1);
    const stored = await record(stores, run.id);
    expect(stored).toContain("is not granted to this run");
    expect(stored).not.toContain("rotate-v1-value");
  }, 60_000);

  it("starts no process when the grant is denied", async () => {
    const { orchestrator, stores } = setup(async () => {
      throw denial();
    });
    const { run } = await orchestrator.startAndRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    expect(run.status).toBe("failed");
    expect(await written("first.md")).toBeUndefined();
    expect(await sessionsOpened(stores, run.id)).toBe(0);
    expect(await record(stores, run.id)).not.toContain("rotate-v1-value");
  }, 60_000);

  it("uses the secret the launch recorded, not a later change to the run's vars", async () => {
    const stores = memoryStores();
    const { orchestrator } = setup(async () => {}, stores);
    const runId = await orchestrator.startRun({ workflowId: "deploy", vars: { token: "deploy-a" } });
    // A working-vars change after admission (what a step may emit) names another secret.
    await stores.events.append({ type: "vars.set", runId, payload: { vars: { token: "deploy-b" } } });
    const run = await orchestrator.run(runId);
    expect(run.run.status).toBe("completed");
    expect(await written("first.md")).toContain("token=rotate-v1-value");
    expect(await written("second.md")).toContain("token=rotate-v1-value");
    expect(JSON.stringify([await written("first.md"), await written("second.md")])).not.toContain("other-secret-value");
  }, 60_000);
});
