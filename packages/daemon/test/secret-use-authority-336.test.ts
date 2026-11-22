/**
 * The server-verified use decision for secret references (#336, part B): a run may receive a
 * value only while the principal that owns its root holds a current credential with
 * `secrets.use` and a grant naming that secret on the host it is bound to.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions, type SecretUse } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";
import {
  CredentialStore,
  LOCAL_PRINCIPAL,
  MemoryAuditSink,
  OwnershipStore,
  PRESETS,
  credentialSecretUse,
  loopbackSecretUse,
  orchestratorResolver,
  type ResourceResolver,
} from "../src/auth/index.js";

const VALUE = "ghp_value-that-must-not-be-audited-0123";
const use = (secret = "token", hostId = "local"): SecretUse => ({ secret, provider: "env", hostId, agentId: "claude" });

/** Runs `root` (owned by `owner`), `child` under it, and `orphan` with no owner. */
function fixture(now = () => new Date("2026-11-22T12:00:00Z")) {
  const credentials = new CredentialStore({ now });
  const ownership = new OwnershipStore();
  const runs: Record<string, { workflowId: string; parentRunId?: string }> = {
    root: { workflowId: "w" },
    child: { workflowId: "w::n", parentRunId: "root" },
    orphan: { workflowId: "w" },
  };
  const resolver: ResourceResolver = {
    run: async (id) => runs[id],
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  };
  const audit = new MemoryAuditSink();
  const check = credentialSecretUse({ resolver, ownership, credentials, audit });
  return { credentials, ownership, audit, check };
}

const client = [...PRESETS.client.permissions, "secrets.use" as const];

describe("secret use authority", () => {
  it("lets a run use a reference its owner's current credential grants on that host", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      secrets: [{ secret: "token", host: "local" }],
    });
    await f.check({ runId: "root", uses: [use()] });
    // A child run is judged by its root's owner.
    await f.check({ runId: "child", uses: [use()] });
    expect(f.audit.records.map((r) => [r.event, r.outcome, r.actor?.principal, r.target])).toEqual([
      ["secret.use", "succeeded", "ci-bot", { runId: "root", secrets: "token" }],
      ["secret.use", "succeeded", "ci-bot", { runId: "child", secrets: "token" }],
    ]);
  });

  it("refuses a reference outside the grant, on another host, or without secrets.use", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      secrets: [{ secret: "token", host: "local" }],
    });
    const unauthorized = { code: "CONFIG_INVALID", details: { reason: "unauthorized" } };
    await expect(f.check({ runId: "root", uses: [use("other")] })).rejects.toMatchObject({
      ...unauthorized,
      details: { secret: "other", hostId: "local", reason: "unauthorized" },
    });
    // The same id, rebound to another host: the grant does not follow it.
    await expect(f.check({ runId: "root", uses: [use("token", "build-box")] })).rejects.toMatchObject(unauthorized);
    // One refused use refuses the open.
    await expect(f.check({ runId: "root", uses: [use(), use("other")] })).rejects.toMatchObject(unauthorized);

    const g = fixture();
    g.ownership.record("root", "viewer");
    await g.credentials.issue({ principal: "viewer", preset: "client", secrets: "*" });
    await expect(g.check({ runId: "root", uses: [use()] })).rejects.toMatchObject(unauthorized);
  });

  it("judges by the run's owner only: another principal's grant never covers it", async () => {
    const f = fixture();
    f.ownership.record("root", "alice");
    await f.credentials.issue({ principal: "alice", preset: "client" });
    await f.credentials.issue({ principal: "mallory", preset: "owner" });
    await expect(f.check({ runId: "root", uses: [use()] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // A run with no recorded owner is refused outright.
    await expect(f.check({ runId: "orphan", uses: [use()] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(f.check({ runId: "missing", uses: [use()] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(f.audit.records.map((r) => r.reason)).toEqual([
      "no current grant",
      "run has no recorded owner",
      "run root unavailable",
    ]);
  });

  it("reads the owner's credentials at every decision: revocation and expiry stop the next one", async () => {
    let now = new Date("2026-11-22T12:00:00Z");
    const f = fixture(() => now);
    f.ownership.record("root", "ci-bot");
    const { credential } = await f.credentials.issue({ principal: "ci-bot", preset: "owner" });
    await f.check({ runId: "root", uses: [use()] });
    await f.credentials.revoke(credential.id);
    await expect(f.check({ runId: "root", uses: [use()] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await f.credentials.issue({ principal: "ci-bot", preset: "owner", ttlMs: 60_000 });
    await f.check({ runId: "root", uses: [use()] });
    now = new Date(now.getTime() + 61_000);
    await expect(f.check({ runId: "root", uses: [use()] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("keeps a grant across rotation, and the owner preset grants every reference", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    const { credential } = await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      secrets: [{ secret: "token", host: "local" }],
    });
    const rotated = await f.credentials.rotate(credential.id, {});
    expect(rotated.credential.secrets).toEqual([{ secret: "token", host: "local" }]);
    await f.check({ runId: "root", uses: [use()] });
    const owner = await f.credentials.issue({ principal: "someone", preset: "owner" });
    expect(owner.credential.secrets).toBe("*");
    expect(owner.credential.permissions).toContain("secrets.use");
  });

  it("allows every reference in loopback compatibility mode", async () => {
    await loopbackSecretUse(LOCAL_PRINCIPAL)({ runId: "anything", uses: [use(), use("x", "build-box")] });
  });

  it("decides at a real session open, before the host reads anything, and audits no value", async () => {
    const config = parseOrcaConfig({
      secrets: { token: { host: "local", provider: "env", name: "ORCA_TOKEN" } },
      agents: [{ id: "claude", command: "unused", roles: ["coder"], env: { TOKEN: { secret: "token" } } }],
    });
    const workflows = new WorkflowRegistry();
    workflows.register(
      parseWorkflow(`
id: single
name: Single
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: { role: coder }, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`),
    );
    const read: string[] = [];
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents: AgentRegistry.fromConfig(config),
      workflows,
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
      sessionFactory: async (o: OpenSessionOptions) => {
        await o.authorizeSecretUse!([{ secret: "token", provider: "env", hostId: o.host.id, agentId: o.agent.id }]);
        read.push("token");
        o.onSecretValues?.([VALUE]);
        const closed = Promise.resolve();
        const session: AgentSession = {
          id: "sess_1",
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
    const credentials = new CredentialStore();
    const ownership = new OwnershipStore();
    const audit = new MemoryAuditSink();
    orchestrator.secretUse = credentialSecretUse({
      resolver: orchestratorResolver(orchestrator),
      ownership,
      credentials,
      audit,
    });

    const denied = await orchestrator.startRun({ workflowId: "single" });
    ownership.record(denied, "ci-bot");
    await credentials.issue({ principal: "ci-bot", preset: "client" });
    expect((await orchestrator.run(denied)).run.status).toBe("failed");
    expect(read).toEqual([]);

    await credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      secrets: [{ secret: "token", host: "local" }],
    });
    const allowed = await orchestrator.startRun({ workflowId: "single" });
    ownership.record(allowed, "ci-bot");
    const { run } = await orchestrator.run(allowed);
    expect(run.status, JSON.stringify(run.error)).toBe("completed");
    expect(read).toEqual(["token"]);
    expect(audit.records.map((r) => [r.target?.runId, r.outcome])).toEqual([
      [denied, "denied"],
      [allowed, "succeeded"],
    ]);
    expect(JSON.stringify(audit.records)).not.toContain(VALUE);
  });
});
