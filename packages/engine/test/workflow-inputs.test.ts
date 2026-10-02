/**
 * #330: launch inputs are validated at admission, before anything a run leaves behind - its
 * stored definition, its workspace, `run.created`, an agent or a child - and admission and
 * preflight select the same definition by version and content revision.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import {
  FakeClock,
  parseWorkflow,
  TemplateRegistry,
  validateWorkflowInputs,
  WorkflowRegistry,
  type WorkflowDefinition,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput, workflowRevision } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

function make(stores: Stores, ...yamls: string[]) {
  const workflows = new WorkflowRegistry();
  for (const y of yamls) workflows.register(parseWorkflow(y));
  const provider = new LocalWorkspaceProvider("/tmp");
  const provisioned: string[] = [];
  const sessions: string[] = [];
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: {
      name: "counting",
      provision: (input) => {
        provisioned.push(input.runId);
        return provider.provision(input);
      },
    },
    humanInput: new PausingHumanInput(),
    clock: new FakeClock(),
    sessionFactory: async () => {
      sessions.push("opened");
      throw new Error("no agent should be spawned by these tests");
    },
  });
  return { orc, provisioned, sessions };
}

const TYPED = (version = "1") => `
id: typed
name: typed
version: "${version}"
vars: { mode: fast }
inputSchema:
  fields:
    count: { type: integer, required: true, minimum: 1 }
    level: { type: string, enum: [low, high], default: low }
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges:
  - { from: s, to: e }
`;

/** Stores where another process records `theirs` just before each of this process's writes. */
function raceTo(
  stores: Stores,
  theirs: WorkflowDefinition,
  get: Stores["workflows"]["get"] = (id, version) => stores.workflows.get(id, version),
): Stores {
  return {
    ...stores,
    workflows: {
      get,
      versions: (id) => stores.workflows.versions(id),
      put: async (def) => {
        await stores.workflows.put(theirs);
        return stores.workflows.put(def);
      },
    },
  };
}

/** Everything a refused launch must not have left behind. */
async function nothingWritten(stores: Stores, provisioned: string[], sessions: string[]) {
  expect(await stores.events.listRuns()).toEqual([]);
  expect(await stores.workflows.versions("typed")).toEqual([]);
  expect(provisioned).toEqual([]);
  expect(sessions).toEqual([]);
}

describe("launch-input admission (#330)", () => {
  it("starts a run on the validated, resolved vars", async () => {
    const stores = memoryStores();
    const { orc } = make(stores, TYPED());
    const state = await orc.startAndRun({ workflowId: "typed", vars: { count: 2 } });
    expect(state.run.status).toBe("completed");
    expect(state.run.vars).toEqual({ count: 2, level: "low", mode: "fast" });
  });

  it.each([
    ["a missing required input", {}, [{ path: "vars.count", message: "is required" }]],
    [
      "a required input supplied only through __proto__",
      JSON.parse('{"__proto__":{"count":2}}') as Record<string, unknown>,
      [{ path: "vars.count", message: "is required" }],
    ],
    [
      "a value outside an enum",
      { count: 1, level: "mid" },
      [{ path: "vars.level", message: "must be one of: low, high" }],
    ],
    ["a numeric string", { count: "2" }, [{ path: "vars.count", message: "expected integer, got string" }]],
  ])("refuses %s before anything is written", async (_name, vars, errors) => {
    const stores = memoryStores();
    const { orc, provisioned, sessions } = make(stores, TYPED());
    await expect(orc.startRun({ workflowId: "typed", vars })).rejects.toMatchObject({
      code: "WORKFLOW_INPUT_INVALID",
      details: { errors, warnings: [] },
    });
    await nothingWritten(stores, provisioned, sessions);
  });

  it("refuses with the same issues a preflight reports", async () => {
    const stores = memoryStores();
    const { orc } = make(stores, TYPED());
    const vars = { count: 0, level: "mid" };
    const preflight = validateWorkflowInputs(await orc.selectDefinition("typed"), vars).validation;
    const refused = await orc.startRun({ workflowId: "typed", vars }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect((refused as { details: unknown }).details).toEqual({
      errors: preflight.errors,
      warnings: preflight.warnings,
    });
    expect((refused as Error).message).toBe(
      "workflow 'typed' inputs are invalid: vars.count: must be at least 1; vars.level: must be one of: low, high",
    );
  });

  it("leaves a workflow without a declaration on the legacy merge", async () => {
    const stores = memoryStores();
    const { orc } = make(
      stores,
      `id: plain\nname: plain\nvars: { a: 1 }\ninputs: { a: documented }\nstart: s\nnodes:\n  s: { type: start }\n  e: { type: end }\nedges:\n  - { from: s, to: e }\n`,
    );
    const state = await orc.startAndRun({ workflowId: "plain", vars: { a: "anything", b: [1] } });
    expect(state.run.vars).toEqual({ a: "anything", b: [1] });
  });

  describe("children", () => {
    const parent = (vars: string) => `
id: parent
name: parent
vars: ${vars}
start: s
nodes:
  s: { type: start }
  sub: { type: subworkflow, workflow: child }
  e: { type: end }
edges:
  - { from: s, to: sub }
  - { from: sub, to: e }
`;
    const child = (policy = "allow") => `
id: child
name: child
inputSchema:
  unknown: ${policy}
  fields:
    count: { type: integer, required: true }
start: s
nodes:
  s: { type: start }
  e: { type: end }
edges:
  - { from: s, to: e }
`;

    it("validate a newly admitted child on the vars it inherits, passing undeclared ones through", async () => {
      const stores = memoryStores();
      const { orc } = make(stores, parent(`{ count: 2, other: x }`), child());
      const state = await orc.startAndRun({ workflowId: "parent" });
      expect(state.run.status).toBe("completed");
      const [childId] = Object.values(state.steps).flatMap((s) => s.childRunIds);
      expect((await orc.getState(childId!)).run.vars).toEqual({ count: 2, other: "x" });
    });

    it("refuse a child whose inherited vars are invalid, without creating it", async () => {
      const stores = memoryStores();
      const { orc } = make(stores, parent(`{ count: "2" }`), child());
      const state = await orc.startAndRun({ workflowId: "parent" });
      expect(state.run.status).toBe("failed");
      expect(JSON.stringify(state.run.error)).toContain("WORKFLOW_INPUT_INVALID");
      expect(await stores.events.listRuns()).toEqual([state.run.id]);
    });

    it("make strict rejection an explicit opt-in, since inherited parent vars are unknown to the child", async () => {
      const stores = memoryStores();
      const { orc } = make(stores, parent(`{ count: 2, other: x }`), child("reject"));
      const state = await orc.startAndRun({ workflowId: "parent" });
      expect(state.run.status).toBe("failed");
      expect(JSON.stringify(state.run.error)).toContain("vars.other");
      expect(await stores.events.listRuns()).toEqual([state.run.id]);
    });
  });
});

describe("definition selection and revisions (#330)", () => {
  it("guards a first-ever launch with its preflight's version and revision", async () => {
    const stores = memoryStores();
    const { orc } = make(stores, TYPED());
    const def = await orc.selectDefinition("typed", "1");
    expect(await stores.workflows.versions("typed")).toEqual([]);
    const runId = await orc.startRun({
      workflowId: "typed",
      vars: { count: 1 },
      workflowVersion: def.version,
      expectedWorkflowRevision: workflowRevision(def),
    });
    expect((await orc.getState(runId)).run.workflowVersion).toBe("1");
    expect(await stores.workflows.versions("typed")).toEqual(["1"]);
  });

  it("refuses a stale revision as WORKFLOW_INVALID before anything is written", async () => {
    const stores = memoryStores();
    const { orc, provisioned, sessions } = make(stores, TYPED());
    const refused = await orc
      .startRun({ workflowId: "typed", vars: { count: 1 }, expectedWorkflowRevision: "sha256:stale" })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: "WORKFLOW_INVALID",
      message: expect.stringContaining("validate them again"),
    });
    expect((refused as { details?: unknown }).details).toBeUndefined();
    await nothingWritten(stores, provisioned, sessions);
  });

  it("checks the revision before the inputs, so a stale preflight is not reported as a bad value", async () => {
    const { orc } = make(memoryStores(), TYPED());
    await expect(
      orc.startRun({ workflowId: "typed", vars: {}, expectedWorkflowRevision: "sha256:stale" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
  });

  it("launches an explicit historical version from the store, not the file", async () => {
    const stores = memoryStores();
    await make(stores, TYPED("1")).orc.startRun({ workflowId: "typed", vars: { count: 1 } });
    // v2 drops `low`: a v1 launch must still accept it.
    const { orc } = make(stores, TYPED("2").replace("[low, high], default: low", "[high], default: high"));
    const v1 = await orc.selectDefinition("typed", "1");
    expect(v1.version).toBe("1");
    const runId = await orc.startRun({
      workflowId: "typed",
      workflowVersion: "1",
      expectedWorkflowRevision: workflowRevision(v1),
      vars: { count: 1, level: "low" },
    });
    expect((await orc.getState(runId)).run.workflowVersion).toBe("1");
    await expect(orc.startRun({ workflowId: "typed", vars: { count: 1, level: "low" } })).rejects.toMatchObject({
      code: "WORKFLOW_INPUT_INVALID",
    });
  });

  it("refuses an unknown version rather than launching the latest", async () => {
    const stores = memoryStores();
    const { orc, provisioned, sessions } = make(stores, TYPED("2"));
    await expect(orc.startRun({ workflowId: "typed", workflowVersion: "1", vars: { count: 1 } })).rejects.toMatchObject(
      {
        code: "WORKFLOW_VERSION_NOT_FOUND",
        details: { id: "typed", version: "1", available: ["2"] },
      },
    );
    await nothingWritten(stores, provisioned, sessions);
  });

  it("gives the same content the same revision whichever store copy it comes from", async () => {
    const stores = memoryStores();
    const { orc } = make(stores, TYPED());
    const live = await orc.selectDefinition("typed");
    await orc.startRun({ workflowId: "typed", vars: { count: 1 } });
    expect(workflowRevision((await stores.workflows.get("typed", "1"))!)).toBe(workflowRevision(live));
    // A changed version is a different revision even with the same graph.
    expect(workflowRevision(parseWorkflow(TYPED("2")))).not.toBe(workflowRevision(live));
  });

  describe("a same-version edit of a recorded definition", () => {
    const EDITED = TYPED("1").replace("minimum: 1", "minimum: 5");

    it("is refused for a new run as WORKFLOW_INVALID before anything is written", async () => {
      const stores = memoryStores();
      const firstRun = await make(stores, TYPED()).orc.startRun({ workflowId: "typed", vars: { count: 1 } });
      const { orc, provisioned, sessions } = make(stores, EDITED);
      await expect(orc.startRun({ workflowId: "typed", vars: { count: 5 } })).rejects.toMatchObject({
        code: "WORKFLOW_INVALID",
        details: { id: "typed", version: "1" },
      });
      await expect(orc.selectDefinition("typed")).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
      expect(await stores.events.listRuns()).toEqual([firstRun]);
      expect(provisioned).toEqual([]);
      expect(sessions).toEqual([]);
    });

    it("can still launch the recorded version explicitly", async () => {
      const stores = memoryStores();
      await make(stores, TYPED()).orc.startRun({ workflowId: "typed", vars: { count: 1 } });
      const { orc } = make(stores, EDITED);
      const runId = await orc.startRun({ workflowId: "typed", workflowVersion: "1", vars: { count: 1 } });
      expect((await orc.getState(runId)).run.vars.count).toBe(1);
    });

    it("is refused when another process won the race to record the version first", async () => {
      const stores = memoryStores();
      const theirs = parseWorkflow(TYPED("1").replace("minimum: 1", "minimum: 9"));
      // The selection read sees nothing stored; the other writer lands before our put.
      let seen = 0;
      const racing = raceTo(stores, theirs, (id, version) =>
        seen++ === 0 ? Promise.resolve(undefined) : stores.workflows.get(id, version),
      );
      const { orc, provisioned, sessions } = make(racing, TYPED());
      await expect(orc.startRun({ workflowId: "typed", vars: { count: 1 } })).rejects.toMatchObject({
        code: "WORKFLOW_INVALID",
      });
      expect(await stores.events.listRuns()).toEqual([]);
      expect(provisioned).toEqual([]);
      expect(sessions).toEqual([]);
    });

    it("is accepted when the racing writer recorded the same content", async () => {
      const stores = memoryStores();
      const { orc } = make(raceTo(stores, parseWorkflow(TYPED())), TYPED());
      await expect(orc.startRun({ workflowId: "typed", vars: { count: 1 } })).resolves.toMatch(/^run/);
    });
  });
});
