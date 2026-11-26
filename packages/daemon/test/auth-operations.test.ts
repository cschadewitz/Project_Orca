/**
 * The operation inventory and the guard, without a transport: every method the protocol
 * declares or the daemon can answer is inventoried, the documented matrix is the table, and
 * the guard is a wrapper that works on any injected method table - including one carrying
 * the reserved `workflows.validateInputs` preflight, which nothing registers yet.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SCOPED_PERMISSION_CONTRACTS,
  OPERATOR_METHODS,
  OperatorMutationContracts,
  AGENT_METHODS,
  SECRET_METHODS,
  CONTROL_METHODS,
  HELLO_METHOD,
  MAINTENANCE_RUNTIME_METHOD,
  NOTIFICATION_METHODS,
  PLAN_READ_METHODS,
  READ_METHODS,
  SUBSCRIPTION_METHODS,
  TEMPLATE_METHOD_CONTRACTS,
  WORKFLOW_DRAFT_METHOD_CONTRACTS,
} from "@orca/protocol";
import { methodsFor, type MethodContext, type MethodTable } from "@orca/daemon";
import { Maintenance } from "../src/maintenance.js";
import {
  Authorizer,
  CredentialError,
  CredentialStore,
  MemoryAuditSink,
  OPERATIONS,
  OwnershipStore,
  PERMISSIONS,
  PRESETS,
  WORKFLOWS_VALIDATE_INPUTS_OPERATION,
  bindPrincipal,
  type Principal,
  type ResourceResolver,
  type ResourceScope,
} from "../src/auth/index.js";

const ctx: MethodContext = { orcaVersion: "0.0.0", capabilities: [] };

function principal(id: string, permissions: readonly string[], scope: ResourceScope): Principal {
  return { id, kind: "credential", credentialId: `cred-${id}`, permissions: new Set(permissions) as never, scope };
}

/** Every method a fully equipped daemon answers - with every optional model present. */
function everyAnsweredMethod(): string[] {
  const present = {} as never;
  const full: MethodContext = {
    orcaVersion: "0.0.0",
    capabilities: [],
    identity: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
    },
    maintenance: new Maintenance(),
    revisionInputs: async () => {
      throw new Error("inventory fixture must not execute");
    },
    reads: { plans: present } as never,
    source: present,
    control: present,
    planControl: present,
    agents: present,
    config: { canApply: true } as never,
    judgeStatus: async () => {
      throw new Error("inventory fixture must not execute");
    },
    remotes: present,
  };
  return Object.keys(methodsFor(full));
}

describe("the operation inventory", () => {
  it("covers every method the protocol declares and the daemon answers, and nothing else", () => {
    const declared = new Set<string>([
      ...Object.keys(SCOPED_PERMISSION_CONTRACTS),
      HELLO_METHOD,
      MAINTENANCE_RUNTIME_METHOD,
      ...OPERATOR_METHODS,
      ...Object.keys(OperatorMutationContracts),
      "runs.admit",
      "runs.recover",
      "admissions.find",
      "admissions.fence",
      "admissions.get",
      "admissions.reconcile",
      "runs.continue",
      "continuations.get",
      "continuations.reconcile",
      ...READ_METHODS,
      ...PLAN_READ_METHODS,
      ...CONTROL_METHODS,
      ...AGENT_METHODS,
      ...SECRET_METHODS,
      ...SUBSCRIPTION_METHODS,
      ...Object.keys(TEMPLATE_METHOD_CONTRACTS),
      ...Object.keys(WORKFLOW_DRAFT_METHOD_CONTRACTS),
      ...everyAnsweredMethod(),
      WORKFLOWS_VALIDATE_INPUTS_OPERATION,
    ]);
    expect(Object.keys(OPERATIONS).sort()).toEqual([...declared].sort());
  });

  it("names only real permissions, and reserves the preflight without registering it", () => {
    for (const spec of Object.values(OPERATIONS)) if (spec.permission) expect(PERMISSIONS).toContain(spec.permission);
    expect(OPERATIONS[WORKFLOWS_VALIDATE_INPUTS_OPERATION]).toMatchObject({ reserved: true, permission: "runs.start" });
    expect(everyAnsweredMethod()).not.toContain(WORKFLOWS_VALIDATE_INPUTS_OPERATION);
  });

  it("is the permission matrix docs/daemon-security.md documents", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/daemon-security.md", import.meta.url)), "utf8");
    const rows = new Map<string, string>();
    for (const m of doc.matchAll(/^\| `([\w.]+)` \| (?:`([\w.]+)`|any authenticated principal) \|/gm))
      rows.set(m[1]!, m[2] ?? "");
    expect(Object.fromEntries([...rows].sort())).toEqual(
      Object.fromEntries(
        Object.entries(OPERATIONS)
          .map(([name, spec]) => [name, spec.permission ?? ""] as const)
          .sort(),
      ),
    );
    for (const method of NOTIFICATION_METHODS) expect(doc).toContain(`\`${method}\``);
  });

  it("keeps workspace grants from restricted presets, and refuses to issue them", async () => {
    expect(PRESETS.client.permissions).not.toContain("config.read");
    const store = new CredentialStore();
    await expect(
      store.issue({ principal: "x", permissions: ["config.read"], scope: { workflows: "*", runs: "owned" } }),
    ).rejects.toThrow(CredentialError);
    await expect(
      store.issue({ principal: "x", permissions: [], scope: { workflows: "*", runs: "all" } }),
    ).rejects.toThrow(CredentialError);
  });
});

describe("the guard over an injected table", () => {
  const resolver: ResourceResolver = {
    run: async (runId) => (runId === "run-a" ? { workflowId: "gated" } : undefined),
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: (id) => ["gated", "secret"].includes(id),
  };
  const setup = () => {
    const audit = new MemoryAuditSink();
    const authorizer = new Authorizer({ resolver, ownership: new OwnershipStore(), audit });
    const preflight = vi.fn((params: { workflowId: string }) => {
      if (params.workflowId === "nope")
        throw Object.assign(new Error("workflow 'nope' not registered"), { code: "WORKFLOW_NOT_FOUND" });
      return { workflowId: params.workflowId, version: "1", revision: "r", validation: { ok: true } };
    });
    const table: MethodTable = {
      [WORKFLOWS_VALIDATE_INPUTS_OPERATION]: {
        params: z.object({ workflowId: z.string(), vars: z.record(z.string(), z.unknown()).default({}) }),
        handle: (p) => preflight(p as { workflowId: string }),
      },
      "experimental.unlisted": { params: z.object({}), handle: () => "should never run" },
    };
    return { audit, authorizer, preflight, guarded: authorizer.guard(table) };
  };
  const meta = { transport: "http" as const };

  it("fails closed for a context no transport bound", async () => {
    const { guarded, preflight } = setup();
    await expect(
      guarded[WORKFLOWS_VALIDATE_INPUTS_OPERATION]!.handle({ workflowId: "gated" }, ctx),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("refuses a method the table answers but the inventory does not name", async () => {
    const { guarded, authorizer } = setup();
    const owner = principal("owner", PERMISSIONS, { workflows: "*", runs: "all" });
    await expect(guarded["experimental.unlisted"]!.handle({}, bindPrincipal(ctx, owner, meta))).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
    expect(() => authorizer.checkOperation(owner, "experimental.unlisted", true, meta)).toThrow();
    // Nobody answers it and nobody listed it: that is an unknown method, not a secret.
    expect(() => authorizer.checkOperation(owner, "experimental.absent", false, meta)).not.toThrow();
  });

  it("checks preflight access to the selected workflow before disclosing anything", async () => {
    const { guarded, preflight } = setup();
    const narrow = principal("narrow", PRESETS.client.permissions, { workflows: ["gated"], runs: "owned" });
    type Refusal = { code: string; message: string; details?: unknown };
    const call = async (workflowId: string): Promise<unknown> =>
      guarded[WORKFLOWS_VALIDATE_INPUTS_OPERATION]!.handle({ workflowId, vars: {} }, bindPrincipal(ctx, narrow, meta));
    const refused = (workflowId: string): Promise<Refusal> =>
      call(workflowId).then(
        () => {
          throw new Error(`expected ${workflowId} to be refused`);
        },
        (e: unknown) => e as Refusal,
      );
    const hidden = await refused("secret");
    const absent = await refused("nope");
    expect(preflight).not.toHaveBeenCalled();
    expect({ code: hidden.code, message: hidden.message.replace("secret", "ID"), details: hidden.details }).toEqual({
      code: absent.code,
      message: absent.message.replace("nope", "ID"),
      details: absent.details,
    });
    await expect(call("gated")).resolves.toMatchObject({ workflowId: "gated" });
    expect(preflight).toHaveBeenCalledTimes(1);

    const viewer = principal("viewer", PRESETS.viewer.permissions, PRESETS.viewer.scope);
    await expect(
      guarded[WORKFLOWS_VALIDATE_INPUTS_OPERATION]!.handle({ workflowId: "gated" }, bindPrincipal(ctx, viewer, meta)),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });

  it("gates each notification method on its own grant", async () => {
    const { authorizer } = setup();
    const viewer = principal("viewer", PRESETS.viewer.permissions, PRESETS.viewer.scope);
    const narrow = principal("narrow", PRESETS.client.permissions, { workflows: ["gated"], runs: "all" });
    const allows = (p: Principal, method: string, params: Record<string, unknown> = {}) =>
      authorizer.allowsNotification(p, method, params);
    expect(await allows(viewer, "run.changed", { runId: "run-a" })).toBe(true);
    expect(await allows(viewer, "agent.changed")).toBe(true);
    expect(await allows(viewer, "plan.changed")).toBe(true);
    expect(await allows(viewer, "config.changed")).toBe(false);
    expect(await allows(narrow, "run.changed", { runId: "run-a" })).toBe(true);
    expect(await allows(narrow, "run.changed", { runId: "run-unknown" })).toBe(false);
    expect(await allows(narrow, "workflows.changed", { id: "secret" })).toBe(false);
    expect(await allows(narrow, "workflows.changed", { id: "gated::loop" })).toBe(true);
    expect(await allows(narrow, "agent.changed")).toBe(false);
    expect(await allows(viewer, "something.new")).toBe(false);
  });
});
