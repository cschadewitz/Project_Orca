/** Operator read bounds, current authority, safe projections and preflight invariants. */
import { describe, expect, it, vi } from "vitest";
import { InMemoryEventStore } from "@orca/store";
import { WorkflowDefinitionSchema } from "@orca/core";
import {
  OperatorReadModel,
  eventSnapshot,
  workflowRows,
  type OperatorReadOptions,
} from "../src/operator-read-model.js";
import type { Principal } from "../src/auth/principal.js";
import type { OperatorPageParams, OperatorRow } from "@orca/protocol";

const target = {
  workspaceId: "a05d4634-3cb0-451c-b0ba-6255ac03bf89",
  instanceId: "030ed95f-f03c-49c0-a3ae-8c932c508311",
};
const owner = (): Principal => ({
  id: "operator",
  kind: "credential",
  credentialId: "credential",
  scope: { runs: "all", workflows: "*" },
  permissions: new Set(["runs.read", "artifacts.read", "workflows.read", "runs.start", "config.read", "plan.read"]),
});
const params = (extra: Partial<OperatorPageParams> = {}): OperatorPageParams => ({
  target,
  collection: "events",
  runId: "run",
  limit: 50,
  ...extra,
});
function fixture(rows: OperatorRow[] = [], overrides: Partial<OperatorReadOptions> = {}) {
  let revision = "1";
  let principal = owner();
  const source = vi.fn(async () => ({
    revision,
    currentRevision: async () => revision,
    rows: (async function* () {
      yield* rows;
    })(),
  }));
  const model = new OperatorReadModel({
    target,
    orcaVersion: "test",
    protocol: { major: 1, minor: 10 },
    current: async () => principal,
    allowsRun: async (_p, id) => id !== "hidden",
    collections: { events: source },
    operations: () => ["operator.discover", "operator.page"],
    ...overrides,
  });
  return {
    model,
    source,
    revise: () => (revision = "2"),
    revoke: () => (principal = { ...principal, permissions: new Set() }),
    principal: (p: Principal) => (principal = p),
  };
}
describe("bounded operator reads", () => {
  it("pages visible rows and strips unknown fields, hidden links and unauthorized associations before sizing", async () => {
    const f = fixture([
      { id: "hidden-row", kind: "event", runId: "hidden" },
      {
        id: "visible",
        kind: "event",
        runId: "run",
        childRunId: "hidden",
        requestId: "secret-request",
        text: "readable",
        ...{ secret: "never" },
      },
      { id: "last", kind: "event", runId: "run" },
    ]);
    f.principal({ ...owner(), permissions: new Set(["runs.read"]) });
    const first = await f.model.page(params({ limit: 1 }));
    expect(first.items).toEqual([{ id: "visible", kind: "event", runId: "run", text: "readable" }]);
    expect(first.nextCursor).toBeTruthy();
    const next = await f.model.page(params({ cursor: first.nextCursor, limit: 1 }));
    expect(next.items.map((r) => r.id)).toEqual(["last"]);
    expect(next.nextCursor).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("secret");
  });
  it("rejects forged, wrong-filter, wrong-principal, changed-revision and restart cursors without hidden data", async () => {
    const rows = [
      { id: "1", kind: "event" },
      { id: "2", kind: "event" },
    ];
    const f = fixture(rows);
    const page = await f.model.page(params({ limit: 1 }));
    for (const cursor of ["tampered", `${page.nextCursor}x`, `${page.nextCursor}.extra`])
      expect((await f.model.page(params({ cursor }))).restartRequired).toBe(true);
    expect((await f.model.page(params({ cursor: page.nextCursor, stepRunId: "different" }))).restartRequired).toBe(
      true,
    );
    f.principal({ ...owner(), id: "another" });
    expect((await f.model.page(params({ cursor: page.nextCursor }))).restartRequired).toBe(true);
    f.principal(owner());
    f.revise();
    expect((await f.model.page(params({ cursor: page.nextCursor }))).items).toEqual([]);
    expect((await fixture(rows).model.page(params({ cursor: page.nextCursor }))).restartRequired).toBe(true);
  });
  it("checks authority before parameter diagnostics or opening a collection", async () => {
    const f = fixture();
    f.revoke();
    await expect(f.model.page(params({ limit: 500 }))).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(f.source).not.toHaveBeenCalled();
  });
  it("refuses anonymous compatibility, wrong targets, hidden runs and missing scoped run IDs", async () => {
    const f = fixture();
    await expect(f.model.page(params({ runId: "hidden" }))).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(
      f.model.page(params({ target: { ...target, instanceId: crypto.randomUUID() } })),
    ).rejects.toMatchObject({ code: "RUN_STATE" });
    await expect(f.model.page(params({ runId: undefined }))).rejects.toMatchObject({ code: "PROTOCOL_MESSAGE" });
    f.principal({ ...owner(), kind: "local" });
    await expect(f.model.discover()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it("summarizes oversized items while retaining a stable authorized drill-down ID", async () => {
    const { model } = fixture([{ id: "big", kind: "event", runId: "run", text: '\\"'.repeat(50_000) }]);
    expect((await model.page(params())).items).toEqual([
      { id: "big", kind: "event", runId: "run", omitted: ["oversized-item"] },
    ]);
  });
  it("invalidates a page that changes while being read", async () => {
    const f = fixture([], {
      collections: {
        events: async () => ({
          revision: "1",
          currentRevision: async () => "2",
          rows: (async function* () {
            yield { id: "1", kind: "event" };
          })(),
        }),
      },
    });
    expect(await f.model.page(params())).toMatchObject({ items: [], restartRequired: true });
  });
  it("projects only config status; never raw configuration or restart paths", async () => {
    const f = fixture([], {
      configStatus: async () => ({
        activeGeneration: "generation",
        activeRevision: "old",
        savedRevision: "new",
        state: "pending",
        restartRequired: ["/private/path"],
        ...{ config: { token: "secret" } },
      }),
    });
    expect(await f.model.config(target)).toMatchObject({ activeGeneration: "generation", state: "pending" });
    expect(JSON.stringify(await f.model.config(target))).not.toMatch(/secret|private|config"/);
  });
  it("walks long public event histories in store pages, omitting protected pointers, vars and tool args", async () => {
    const events = new InMemoryEventStore();
    await events.append({
      type: "run.created",
      runId: "run",
      payload: {
        workflowId: "wf",
        workflowVersion: "1",
        vars: { secret: "PRIVATE" },
        workspace: { hostId: "local", cwd: "/secret" },
      },
    });
    for (let i = 0; i < 205; i++)
      await events.append({
        type: "agent.update",
        runId: "run",
        payload: {
          stepRunId: "step",
          sessionId: "session",
          update: { kind: "text", text: `line ${i}`, args: { text: "PRIVATE", length: 7 } },
        },
      });
    const reads = vi.spyOn(events, "readRange");
    const f = fixture([], { collections: { events: (p) => eventSnapshot(events, p) } });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.model.page(params({ cursor, limit: 100 }));
      ids.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE|secret|executionPayloadRef/);
    } while (cursor);
    expect(new Set(ids).size).toBe(206);
    expect(reads.mock.calls.every(([, range]) => range?.limit === 100 || range?.limit === 1)).toBe(true);
  });
  it.each([
    ["path-bearing text", "Recorded artifact at /workspace/private-job/artifacts/revision.md"],
    ["legitimate safe text", "Revision completed successfully."],
  ])("keeps closed event metadata and explicitly omits arbitrary agent %s", async (_label, text) => {
    const events = new InMemoryEventStore();
    await events.append({
      type: "agent.update",
      runId: "run",
      payload: {
        stepRunId: "step",
        sessionId: "session",
        update: {
          kind: "text",
          text,
          title: "/private/title",
          locations: ["C:\\private\\artifact.md"],
          args: { text: "/private/tool-argument", length: 22 },
          result: { text: "/private/tool-result", length: 20 },
        },
      },
    });
    const [stored] = await events.readRange("run", { after: -1, limit: 1 });
    const f = fixture([], { collections: { events: (p) => eventSnapshot(events, p) } });
    const page = await f.model.page(params());
    expect(page.items).toEqual([
      {
        id: stored!.id,
        kind: "agent.update",
        runId: "run",
        stepRunId: "step",
        seq: stored!.seq,
        at: stored!.at,
        omitted: ["agent-text", "tool-arguments", "tool-results", "paths"],
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(text);
    expect(JSON.stringify(page)).not.toMatch(/private|session/);
    expect(stored).toMatchObject({ payload: { update: { text } } });
  });
  it("projects graph topology and redacted typed inputs without prompts, defaults or metadata", async () => {
    const def = WorkflowDefinitionSchema.parse({
      id: "wf",
      name: "Workflow",
      version: "1",
      start: "start",
      nodes: { start: { type: "start" }, end: { type: "end", message: "PRIVATE" } },
      edges: [{ from: "start", to: "end" }],
      inputSchema: { fields: { token: { type: "string", sensitive: true, default: "PRIVATE" } } },
    });
    const rows: OperatorRow[] = [];
    for await (const row of workflowRows(def)) rows.push(row);
    expect(rows.some((r) => r.kind === "input-declaration")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });
});

it("denies cross-run artifact IDs before reading their bodies", async () => {
  const artifact = vi.fn();
  const f = fixture([], { artifact, artifactRun: async () => "other-run" });
  await expect(f.model.artifact({ target, runId: "run", artifactId: "foreign" })).rejects.toMatchObject({
    code: "ARTIFACT_MISSING",
  });
  expect(artifact).not.toHaveBeenCalled();
});
it("checks grant changes during the collection scan before releasing rows", async () => {
  const f = fixture([], {
    collections: {
      events: async () => ({
        revision: "1",
        currentRevision: async () => "1",
        rows: (async function* () {
          f.revoke();
          yield { id: "event", kind: "event" };
        })(),
      }),
    },
  });
  await expect(f.model.page(params())).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});

it("preflights invalid and valid vars against one captured generation without admitting work", async () => {
  const { parseOrcaConfig } = await import("@orca/core");
  const { ConfigurationGenerations } = await import("@orca/engine");
  const { InMemoryWorkflowVersionStore, InMemoryExecutionStore } = await import("@orca/store");
  const definition = WorkflowDefinitionSchema.parse({
    id: "wf",
    name: "Workflow",
    version: "1",
    start: "start",
    nodes: { start: { type: "start" }, end: { type: "end" } },
    edges: [{ from: "start", to: "end" }],
    inputSchema: {
      fields: {
        count: { type: "integer", required: true },
        token: { type: "string", sensitive: true, default: "PRIVATE" },
      },
    },
  });
  const startRun = vi.fn(async () => "should-not-start");
  const generations = new ConfigurationGenerations({
    store: new InMemoryExecutionStore(),
    workflows: new InMemoryWorkflowVersionStore(),
    loadAssets: async () => ({ workflows: [definition], templates: [] }),
    admission: { validateStartRun: async () => {}, startRun },
  });
  await generations.initialize(parseOrcaConfig({}), "saved");
  const f = fixture([], { generations });
  const bad = await f.model.preflight({ target, purpose: "workflow", workflowId: "wf", vars: { count: "no" } });
  const good = await f.model.preflight({ target, purpose: "workflow", workflowId: "wf", vars: { count: 2 } });
  expect(bad.validation.ok).toBe(false);
  expect(good.validation.ok).toBe(true);
  expect(good.expectedConfigGeneration).toBe(generations.current.snapshot.id);
  expect(good.expectedWorkflowRevision).toBe(bad.expectedWorkflowRevision);
  expect(JSON.stringify([good, bad])).not.toContain("PRIVATE");
  expect(startRun).not.toHaveBeenCalled();
});

it.each(["1", "2"])("refuses preflight when captured stored v1 differs from active v%s", async (activeVersion) => {
  const { parseOrcaConfig } = await import("@orca/core");
  const { ConfigurationGenerations, workflowRevision } = await import("@orca/engine");
  const { InMemoryWorkflowVersionStore, InMemoryExecutionStore } = await import("@orca/store");
  const stored = WorkflowDefinitionSchema.parse({
    id: "wf",
    name: "Stored workflow",
    version: "1",
    start: "start",
    nodes: { start: { type: "start" }, end: { type: "end" } },
    edges: [{ from: "start", to: "end" }],
    inputSchema: { fields: { count: { type: "integer", required: true } } },
  });
  const active = WorkflowDefinitionSchema.parse({
    ...stored,
    version: activeVersion,
    inputSchema: { fields: { count: { type: "string", required: true } } },
  });
  const workflows = new InMemoryWorkflowVersionStore();
  await workflows.put(stored);
  const validateStartRun = vi.fn(async () => {});
  const startRun = vi.fn(async () => "should-not-start");
  const generations = new ConfigurationGenerations({
    store: new InMemoryExecutionStore(),
    workflows,
    loadAssets: async () => ({ workflows: [active], templates: [] }),
    admission: { validateStartRun, startRun },
  });
  await generations.initialize(parseOrcaConfig({}), "saved");
  // Both are valid explicit captures, but the protected active snapshot cannot validate them.
  const captured = await generations.captureLaunch({ purpose: "workflow", workflowId: "wf", workflowVersion: "1" });
  expect(captured.workflow.revision).toBe(workflowRevision(stored));
  expect(captured.workflow.revision).not.toBe(workflowRevision(active));
  const f = fixture([], { generations });
  for (const count of [2, "active-only"])
    await expect(
      f.model.preflight({ target, purpose: "workflow", workflowId: "wf", workflowVersion: "1", vars: { count } }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  expect(validateStartRun).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
});

it("preserves input identity without plan permissions and rejects expired legacy permissions", async () => {
  const { operatorEventCollections } = await import("../src/operator-read-model.js");
  const events = new InMemoryEventStore();
  await events.append({
    type: "run.created",
    runId: "run",
    payload: { workflowId: "wf", workflowVersion: "1", vars: {}, workspace: { hostId: "local", cwd: "/private" } },
  });
  await events.append({
    type: "human.requested",
    runId: "run",
    payload: {
      requestId: "gate",
      stepRunId: "step",
      kind: "decision",
      question: "Continue?",
      options: [{ id: "yes", label: "Yes" }],
      context: { secret: "PRIVATE" },
    },
  });
  await events.append({
    type: "human.requested",
    runId: "run",
    payload: {
      requestId: "expired",
      stepRunId: "old-step",
      kind: "permission",
      question: "Allow?",
      options: [],
      context: {},
    },
  });
  const f = fixture([], { collections: operatorEventCollections({ events, allowsRun: async () => true }) });
  f.principal({ ...owner(), permissions: new Set(["runs.read"]) });
  const page = await f.model.page(params({ collection: "inputs" }));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ id: "gate", requestId: "gate", stepRunId: "step" });
  expect(JSON.stringify(page)).not.toContain("PRIVATE");
  await events.append({
    type: "human.answered",
    runId: "run",
    payload: { requestId: "gate", stepRunId: "step", answer: "yes" },
  });
  expect((await f.model.page(params({ collection: "inputs" }))).items).toEqual([]);
});

it("requires run-read as well as artifact-read before advertising or opening artifact pages", async () => {
  const open = vi.fn();
  const f = fixture([], { collections: { artifacts: open } });
  f.principal({ ...owner(), permissions: new Set(["artifacts.read"]) });
  expect((await f.model.discover()).collections).not.toContain("artifacts");
  await expect(f.model.page(params({ collection: "artifacts", limit: 500 }))).rejects.toMatchObject({
    code: "AUTH_FORBIDDEN",
  });
  expect(open).not.toHaveBeenCalled();
});
