/** Discovery must describe installed implementations and the authenticated caller's grants. */
import { describe, expect, it, vi } from "vitest";
import { HelloResultSchema, OPERATOR_METHODS, PROTOCOL_VERSION, REVISION_METHODS } from "@orca/protocol";
import { hello, methodsFor, type MethodContext } from "../src/methods.js";
import { OperatorReadModel } from "../src/operator-read-model.js";
import { Authorizer, OwnershipStore, bindPrincipal, type Permission, type Principal } from "../src/auth/index.js";

const admissions = ["runs.admit", "admissions.get", "admissions.reconcile"] as const;
const continuations = ["runs.continue", "continuations.get", "continuations.reconcile"] as const;
const optional = [...OPERATOR_METHODS, ...admissions, ...REVISION_METHODS, ...continuations] as const;
const helloParams = { client: "operator-integration-test", protocol: PROTOCOL_VERSION };
const target = {
  workspaceId: "a05d4634-3cb0-451c-b0ba-6255ac03bf89",
  instanceId: "030ed95f-f03c-49c0-a3ae-8c932c508311",
};
const principal = (permissions: readonly Permission[]): Principal => ({
  id: "operator",
  kind: "credential",
  credentialId: "credential",
  scope: { runs: "all", workflows: "*" },
  permissions: new Set(permissions),
});
const context = (overrides: Partial<MethodContext> = {}): MethodContext => ({
  orcaVersion: "integration-test",
  // Deliberately stale flags must not fabricate implementations.
  capabilities: [...optional],
  ...overrides,
});
async function discovery(ctx: MethodContext) {
  const result = HelloResultSchema.parse(await hello.handle(helloParams, ctx));
  expect(result.methods?.sort()).toEqual(Object.keys(methodsFor(ctx)).sort());
  return result;
}
function operatorReads(methods: readonly string[]) {
  const model = new OperatorReadModel({
    target,
    orcaVersion: "integration-test",
    protocol: PROTOCOL_VERSION,
    current: async () => principal(["runs.read", "artifacts.read"]),
    allowsRun: async () => true,
    collections: {},
    operations: () => [...methods],
  });
  return { methods, model: vi.fn(async () => model) } satisfies NonNullable<MethodContext["operatorReads"]>;
}

// Discovery examines availability only; these sentinels must never execute feature services.
const unavailable = async (): Promise<never> => {
  throw new Error("discovery must not invoke feature services");
};
const configuredAdmissions = (): Partial<MethodContext> => ({
  control: {} as NonNullable<MethodContext["control"]>,
  admissionRetries: {} as NonNullable<MethodContext["admissionRetries"]>,
  admissionAuthorities: unavailable,
});

describe("operator runtime integration discovery", () => {
  it("hides every optional admission, revision and operator capability without its implementation", async () => {
    const result = await discovery(context());
    expect(result.methods).toEqual(["hello"]);
    for (const name of optional) expect(result.capabilities).not.toContain(name);
  });

  it.each(["control", "admissionRetries", "admissionAuthorities"] as const)(
    "hides all admission operations when %s is missing",
    async (missing) => {
      const configured = configuredAdmissions();
      delete configured[missing];
      const result = await discovery(context(configured));
      for (const name of admissions) {
        expect(result.capabilities).not.toContain(name);
        expect(result.methods).not.toContain(name);
      }
    },
  );

  it("advertises installed admission operations without relying on supplied capability flags", async () => {
    const result = await discovery(context({ ...configuredAdmissions(), capabilities: [] }));
    for (const name of admissions) {
      expect(result.capabilities).toContain(name);
      expect(result.methods).toContain(name);
    }
  });

  it.each([false, true])("advertises continuation writes only with control present (%s)", async (writable) => {
    const result = await discovery(
      context({
        capabilities: [],
        continuationAdmissions: {} as NonNullable<MethodContext["continuationAdmissions"]>,
        continuationAccess: unavailable,
        ...(writable ? { control: {} as NonNullable<MethodContext["control"]> } : {}),
      }),
    );
    expect(result.capabilities).toContain("continuations.get");
    expect(result.methods).toContain("continuations.get");
    for (const method of ["runs.continue", "continuations.reconcile"] as const) {
      expect(result.capabilities.includes(method)).toBe(writable);
      expect(result.methods?.includes(method)).toBe(writable);
    }
  });

  it("advertises only the configured operator reads and never invokes them during hello", async () => {
    const reads = operatorReads(["operator.discover", "operator.page"]);
    const ctx = context({ operatorReads: reads });
    const result = await discovery(ctx);
    for (const name of OPERATOR_METHODS) {
      expect(result.capabilities.includes(name)).toBe(reads.methods.includes(name));
      expect(result.methods?.includes(name)).toBe(reads.methods.includes(name));
    }
    expect(reads.model).not.toHaveBeenCalled();
    const discovered = await methodsFor(ctx)["operator.discover"]!.handle({}, ctx);
    expect(discovered).toMatchObject({ target, operations: ["operator.discover", "operator.page"] });
  });

  it("advertises configured operator reads when no capability flags were supplied", async () => {
    const result = await discovery(context({ capabilities: [], operatorReads: operatorReads(OPERATOR_METHODS) }));
    for (const name of OPERATOR_METHODS) {
      // Telemetry is mounted through its explicit source, not the general read inventory.
      expect(result.capabilities.includes(name)).toBe(name !== "operator.hostResources");
      expect(result.methods?.includes(name)).toBe(name !== "operator.hostResources");
    }
  });

  it.each([false, true])("advertises revision writes only with control present (%s)", async (writable) => {
    const result = await discovery(
      context({
        revisionInputs: unavailable,
        ...(writable ? { control: {} as NonNullable<MethodContext["control"]> } : {}),
      }),
    );
    for (const name of REVISION_METHODS) {
      const expected = name === "inputs.revisionPending" || writable;
      expect(result.capabilities.includes(name)).toBe(expected);
      expect(result.methods?.includes(name)).toBe(expected);
    }
  });

  it.each<{ grants: Permission[]; visible: boolean }>([
    { grants: [], visible: false },
    { grants: ["runs.read"], visible: false },
    { grants: ["artifacts.read"], visible: false },
    { grants: ["runs.read", "artifacts.read"], visible: true },
  ])("requires both artifact and run grants for authenticated hello ($grants)", async ({ grants, visible }) => {
    const ctx = context({ operatorReads: operatorReads(OPERATOR_METHODS) });
    const authorizer = new Authorizer({
      ownership: new OwnershipStore(),
      resolver: {
        run: async () => undefined,
        inputRun: async () => undefined,
        artifactRun: async () => undefined,
        claimRun: async () => undefined,
        workflowExists: () => true,
      },
    });
    const table = authorizer.guard(methodsFor(ctx));
    const result = HelloResultSchema.parse(
      await table.hello!.handle(helloParams, bindPrincipal(ctx, principal(grants), { transport: "http" })),
    );
    expect(result.capabilities.includes("operator.artifact")).toBe(visible);
    expect(result.methods?.includes("operator.artifact")).toBe(visible);
  });
});
