/** Protected revision delivery uses the actual attached actor and its current grants. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, RequestSchema, TemplateRegistry, WorkflowRegistry, type MutationActor } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, type ExecutionResumeAuthority } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { CredentialStore, OwnershipStore, type IssueOptions, type Permission } from "../src/auth/index.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
import { LiveExecutionAuthorities } from "../src/live-input-authority.js";

const runtimes: ReturnType<typeof daemonExecutionRuntime>[] = [];
const required = ["runs.start", "runs.read", "runs.control", "inputs.answer"] as const;
const refused = { code: "RUN_STATE", details: { executionResumeRequired: true } };
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  vi.restoreAllMocks();
});

async function fixture(options: { credential?: Partial<IssueOptions>; request?: boolean } = {}) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const credentials = new CredentialStore({ now: () => new Date(now) });
  const grants: IssueOptions = {
    principal: "alice",
    permissions: [...required, ...(options.request ? ["plan.write" as const] : [])],
    scope: options.request ? { workflows: "*", runs: "all" } : { workflows: ["visible"], runs: "owned" },
    ...options.credential,
  };
  const original = await credentials.issue(grants);
  const actor = { principalId: "alice", credentialId: original.credential.id };
  const stores = memoryStores();
  const ownership = new OwnershipStore();
  const workflows = new WorkflowRegistry();
  for (const id of ["visible", "private-child"])
    workflows.register(
      parseWorkflow(`
id: ${id}
name: Revision authority fixture
start: end
nodes: {end: {type: end}}
edges: []
`),
    );
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
  });
  const runtime = daemonExecutionRuntime({
    instanceId: "revision-boot",
    orchestrator,
    credentials,
    ownership,
    revalidateMs: 60_000,
  });
  runtimes.push(runtime);
  if (options.request)
    await stores.requests.put(
      RequestSchema.parse({ id: "request", title: "Task", body: "", createdAt: "now", updatedAt: "now" }),
    );
  const runId = await orchestrator.startRun({
    workflowId: "visible",
    actor,
    ...(options.request ? { requestId: "request", requestAdmissionId: "admission" } : {}),
  });
  ownership.record(runId, actor.principalId);
  return {
    credentials,
    original,
    actor,
    grants,
    ownership,
    orchestrator,
    runtime,
    runId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("requires a currently attached binding and never borrows an owner credential", async () => {
  const f = await fixture();
  await f.credentials.issue({ principal: "owner", preset: "owner" });
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  await expect(f.runtime.authorizeExecution("unknown")).rejects.toMatchObject(refused);
  await f.runtime.prepareExecution(f.runId);
  await expect(f.runtime.authorizeExecution(f.runId)).resolves.toBeUndefined();
  f.runtime.releaseExecution(f.runId);
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  await f.runtime.prepareExecution(f.runId);
  f.runtime.close();
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
});

it("uses the sealed root actor, root scope and root ownership for descendants", async () => {
  const f = await fixture();
  const other = await f.credentials.issue({ principal: "bob", preset: "owner" });
  const child = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: f.runId,
    parentStepRunId: "spawn",
    actor: { principalId: "bob", credentialId: other.credential.id },
  });
  const grandchild = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: child,
    parentStepRunId: "spawn-again",
  });
  expect(f.ownership.owner(grandchild)).toBeUndefined();
  await f.runtime.prepareExecution(grandchild);
  await f.credentials.revoke(other.credential.id);
  await expect(f.runtime.authorizeExecution(grandchild)).resolves.toBeUndefined();
  await f.credentials.revoke(f.original.credential.id);
  await expect(f.runtime.authorizeExecution(grandchild)).rejects.toMatchObject(refused);
});

it.each(["revoked", "expired", "rotated"])("rejects %s attached authority without renewal", async (change) => {
  const f = await fixture({ credential: { ttlMs: 1000 } });
  await f.runtime.prepareExecution(f.runId);
  await expect(f.runtime.authorizeExecution(f.runId)).resolves.toBeUndefined();
  if (change === "revoked") await f.credentials.revoke(f.original.credential.id);
  if (change === "rotated") await f.credentials.rotate(f.original.credential.id);
  if (change === "expired") f.advance(1001);
  await f.credentials.issue({ principal: "alice", preset: "owner" });
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  expect(f.runtime.executionSignal(f.runId).aborted).toBe(true);
  f.runtime.releaseExecution(f.runId);
  await expect(f.runtime.prepareExecution(f.runId)).rejects.toMatchObject(refused);
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
});

it.each(["missing", "different"])(
  "refuses %s current root ownership even for unrestricted credentials",
  async (change) => {
    const f = await fixture({ credential: { scope: { workflows: "*", runs: "all" } } });
    await f.runtime.prepareExecution(f.runId);
    f.ownership.forget(f.runId, "alice");
    if (change === "different") f.ownership.record(f.runId, "bob");
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
    if (change === "different") f.ownership.forget(f.runId, "bob");
    f.ownership.record(f.runId, "alice");
    // Restoring ownership cannot revive the old, already-invalidated attachment.
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  },
);

it.each(["runs.read", "runs.control", "inputs.answer"] as const)(
  "requires %s for revisions without changing legacy execution grants",
  async (missing) => {
    const f = await fixture({ credential: { permissions: required.filter((grant) => grant !== missing) } });
    await f.runtime.prepareExecution(f.runId);
    expect(f.runtime.executionSignal(f.runId).aborted).toBe(false);
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
    expect(f.runtime.executionSignal(f.runId).aborted).toBe(false);
  },
);

it.each([...required, "plan.write"] as const)("rechecks current %s on every revision boundary", async (missing) => {
  const f = await fixture({ request: true });
  await f.runtime.prepareExecution(f.runId);
  await expect(f.runtime.authorizeExecution(f.runId)).resolves.toBeUndefined();
  const current = f.credentials.current(f.original.credential.id);
  if (!current.ok) throw new Error("fixture credential missing");
  vi.spyOn(f.credentials, "current").mockReturnValue({
    ok: true,
    principal: {
      ...current.principal,
      permissions: new Set([...current.principal.permissions].filter((grant) => grant !== missing)),
    },
  });
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
});

it.each(["scope", "principal"])(
  "rechecks current credential %s before revision content is accessed",
  async (change) => {
    const f = await fixture();
    await f.runtime.prepareExecution(f.runId);
    const current = f.credentials.current(f.original.credential.id);
    if (!current.ok) throw new Error("fixture credential missing");
    vi.spyOn(f.credentials, "current").mockReturnValue({
      ok: true,
      principal: {
        ...current.principal,
        ...(change === "scope" ? { scope: { workflows: ["other"], runs: "owned" } as const } : { id: "bob" }),
      },
    });
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  },
);

it("requires explicit renewal and checks the new bound actor instead of the original credential", async () => {
  const f = await fixture();
  await f.runtime.prepareExecution(f.runId);
  const next = await f.credentials.rotate(f.original.credential.id);
  await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
  f.runtime.releaseExecution(f.runId);
  const authority = {
    actor: { principalId: "alice", credentialId: next.credential.id },
    authorize: vi.fn(async () => {}),
  };
  await f.runtime.withResumeAuthority(f.runId, authority, async () => {
    await f.runtime.prepareExecution(f.runId);
    await expect(f.runtime.authorizeExecution(f.runId)).resolves.toBeUndefined();
    await f.credentials.revoke(next.credential.id);
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
    f.runtime.releaseExecution(f.runId);
    return f.orchestrator.getState(f.runId);
  });
  expect(authority.authorize).toHaveBeenCalledTimes(2);
});

it("cannot replace the copied bound actor by mutating the external renewal authority", async () => {
  const f = await fixture();
  const next = await f.credentials.rotate(f.original.credential.id);
  const unrelated = await f.credentials.issue({ principal: "bob", preset: "owner" });
  const spare = await f.credentials.issue(f.grants);
  const authority: ExecutionResumeAuthority = {
    actor: { principalId: "alice", credentialId: next.credential.id },
    authorize: async () => {},
  };
  await f.runtime.withResumeAuthority(f.runId, authority, async () => {
    await f.runtime.prepareExecution(f.runId);
    authority.actor = { principalId: "bob", credentialId: unrelated.credential.id };
    await expect(f.runtime.authorizeExecution(f.runId)).resolves.toBeUndefined();
    const current = f.credentials.current(next.credential.id);
    if (!current.ok) throw new Error("fixture credential missing");
    const lookup = f.credentials.current.bind(f.credentials);
    vi.spyOn(f.credentials, "current").mockImplementation((id) =>
      id === next.credential.id
        ? {
            ok: true,
            principal: {
              ...current.principal,
              permissions: new Set<Permission>(["runs.start", "runs.read", "runs.control"]),
            },
          }
        : lookup(id),
    );
    authority.actor.principalId = "alice";
    authority.actor.credentialId = spare.credential.id;
    expect(f.runtime.executionSignal(f.runId).aborted).toBe(false);
    await expect(f.runtime.authorizeExecution(f.runId)).rejects.toMatchObject(refused);
    f.runtime.releaseExecution(f.runId);
    return f.orchestrator.getState(f.runId);
  });
});

it("never treats an actorless legacy execution as revision authority", async () => {
  const f = await fixture();
  const legacy = await f.orchestrator.startRun({ workflowId: "visible" });
  f.ownership.record(legacy, "alice");
  await f.runtime.prepareExecution(legacy);
  await expect(f.runtime.authorizeExecution(legacy)).rejects.toMatchObject(refused);
});

it("keeps the retained actor private from synchronous operation checks", () => {
  const actor = { principalId: "alice", credentialId: "credential" };
  const authority = new LiveExecutionAuthorities(() => true, 60_000);
  try {
    const allow = vi.fn(() => true);
    expect(authority.allowsCurrent("missing", allow)).toBe(false);
    expect(allow).not.toHaveBeenCalled();
    authority.bind("run", actor);
    actor.principalId = "bob";
    expect(
      authority.allowsCurrent("run", (current) => {
        expect(current.principalId).toBe("alice");
        (current as MutationActor).principalId = "changed";
        return true;
      }),
    ).toBe(true);
    expect(authority.allowsCurrent("run", (current) => current.principalId === "alice")).toBe(true);
    authority.close();
    expect(authority.allowsCurrent("run", allow)).toBe(false);
    expect(allow).not.toHaveBeenCalled();
  } finally {
    authority.close();
  }
});
