/**
 * A store the read methods can be tested against: events appended straight to an in-memory
 * event store, no interpreter involved. The log is the truth, so a fixture written this way
 * exercises exactly what a real store would present - including the shapes an interpreter
 * can only produce by crashing (a retried step, a child whose log is gone).
 *
 * Everything is on a `FakeClock`, so `asOf`, durations and waiting times are exact values in
 * the assertions rather than ranges.
 */
import { AgentRegistry } from "@orca/agents";
import {
  FakeClock,
  TemplateRegistry,
  WorkflowRegistry,
  sha256,
  silentLogger,
  type Artifact,
  type OrcaEventInput,
  type Workspace,
} from "@orca/core";
import { Orchestrator, runLeaseResource } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

export const START = Date.UTC(2026, 2, 1, 9, 0, 0);
/** Every appended event is a second after the one before it: durations are then exact. */
export const STEP_MS = 1000;

/**
 * A genuinely binary body: the PNG signature, then bytes that are not valid UTF-8. A store
 * that decoded a blob on the way in or out would turn `0xff 0xfe` into U+FFFD and be caught
 * doing it (#226), and `artifacts.get` quotes its length as the size it is declining.
 */
export const PNG_BODY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01, 0x7f]);

const workspace: Workspace = { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" };

export interface Fixture {
  clock: FakeClock;
  stores: Stores;
  orchestrator: Orchestrator;
  /** The wall-clock the fixture leaves the clock at, which is every result's `asOf`. */
  asOf: string;
}

function artifact(id: string, kind: string, runId: string, stepRunId: string, createdAt: string): Artifact {
  return {
    id,
    kind,
    name: kind,
    path: `/work/orca/.orca/artifacts/${id}.md`,
    mediaType: "text/markdown",
    contentHash: `sha256:${id}`,
    size: 128,
    version: 1,
    producedBy: { runId, stepRunId, agentId: "claude" },
    parents: [],
    data: {},
    createdAt,
  };
}

/**
 * A store whose artifacts are the point: three versions of one `spec`, produced by three
 * attempts at one node, and a screenshot that is not text. It is a fixture of its own
 * rather than more runs in `fixture()`, so the run list, the sequence numbers and the
 * durations asserted against that one stay exactly what they are.
 */
export async function artifactFixture(): Promise<Fixture> {
  const clock = new FakeClock(START);
  const stores = memoryStores(clock);
  const orc = orchestrator(stores, clock);
  const append = async (e: OrcaEventInput) => {
    clock.advance(STEP_MS);
    await stores.events.append(e);
  };

  await append({
    type: "run.created",
    runId: "run-art",
    payload: { workflowId: "sdlc", workflowVersion: "2", workspace, vars: {} },
  });
  await append({ type: "run.started", runId: "run-art", payload: {} });

  for (const version of [1, 2, 3]) {
    const stepRunId = `s-spec-${version}`;
    await append({
      type: "step.scheduled",
      runId: "run-art",
      payload: { stepRunId, nodeId: "spec", nodeType: "agent", attempt: version },
    });
    await append({ type: "step.started", runId: "run-art", payload: { stepRunId, inputArtifactIds: [] } });
    const a: Artifact = { ...artifact(`art-spec-v${version}`, "spec", "run-art", stepRunId, clock.isoNow()), version };
    await stores.artifacts.put(a, `# Spec v${version}\n`);
    await append({ type: "artifact.recorded", runId: "run-art", payload: { stepRunId, artifact: a } });
    await append({
      type: "step.completed",
      runId: "run-art",
      payload: { stepRunId, result: { artifactIds: [a.id], data: {} } },
    });
  }

  const shot: Artifact = {
    ...artifact("art-shot", "generic", "run-art", "s-spec-3", clock.isoNow()),
    name: "screenshot",
    mediaType: "image/png",
    path: "/work/orca/.orca/artifacts/art-shot.png",
    contentHash: sha256(PNG_BODY),
    size: PNG_BODY.length,
  };
  await stores.artifacts.put(shot, PNG_BODY);
  await append({ type: "artifact.recorded", runId: "run-art", payload: { stepRunId: "s-spec-3", artifact: shot } });

  return { clock, stores, orchestrator: orc, asOf: clock.isoNow() };
}

export function emptyFixture(): Fixture {
  const clock = new FakeClock(START);
  const stores = memoryStores(clock);
  return { clock, stores, orchestrator: orchestrator(stores, clock), asOf: clock.isoNow() };
}

function orchestrator(stores: Stores, clock: FakeClock): Orchestrator {
  return new Orchestrator({
    stores,
    clock,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry(),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
}

/**
 * Five runs that between them cover what the methods have to say something about:
 *
 * - `run-parent` - live, a retried step, a fan-out with two children and a skipped branch,
 *   an artifact, and a lease, so it is genuinely running rather than stale;
 * - `run-child-ok` - a finished child;
 * - `run-child-gone` - spawned by the parent, with no log: the store was rolled back under it;
 * - `run-gate` - parked on a decision, with the artifact the decision is about;
 * - `run-lost` - says it is running, and no lease backs that up: stale;
 * - `run-old` - finished in failure, named after its request because it has no work item.
 */
export async function fixture(): Promise<Fixture> {
  const clock = new FakeClock(START);
  const stores = memoryStores(clock);
  const orc = orchestrator(stores, clock);
  const append = async (e: OrcaEventInput) => {
    clock.advance(STEP_MS);
    await stores.events.append(e);
  };

  await stores.requests.put({
    id: "req-1",
    title: "SSO rollout",
    body: "Single sign-on across the estate.",
    source: { kind: "manual" },
    status: "in-progress",
    labels: [],
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
  });
  for (const [id, slug, title] of [
    ["wi-1", "auth-api", "Add the SSO callback"],
    ["wi-2", "auth-ui", "Wire the login button"],
    ["wi-3", "auth-docs", "Document the rollout"],
  ] as const) {
    await stores.workItems.put({
      id,
      requestId: "req-1",
      slug,
      title,
      description: "",
      kind: "task",
      acceptanceCriteria: [],
      dependsOn: [],
      status: "in-progress",
      produced: {},
      priority: "normal",
      createdAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
    });
  }

  // ---- run-parent: a retried step, then a fan-out it is waiting on.
  await append({
    type: "run.created",
    runId: "run-parent",
    payload: {
      workflowId: "sdlc",
      workflowVersion: "2",
      requestId: "req-1",
      workItemId: "wi-1",
      workspace,
      vars: { branch: "feat/sso" },
    },
  });
  await append({ type: "run.started", runId: "run-parent", payload: {} });
  await append({
    type: "step.scheduled",
    runId: "run-parent",
    payload: { stepRunId: "s-build-1", nodeId: "build", nodeType: "agent", attempt: 1 },
  });
  await append({
    type: "step.started",
    runId: "run-parent",
    payload: { stepRunId: "s-build-1", inputArtifactIds: [] },
  });
  await append({
    type: "agent.session.opened",
    runId: "run-parent",
    payload: {
      stepRunId: "s-build-1",
      sessionId: "sess-1",
      agentId: "claude",
      hostId: "local",
      cwd: workspace.cwd,
      model: "opus",
    },
  });
  await append({
    type: "step.failed",
    runId: "run-parent",
    payload: {
      stepRunId: "s-build-1",
      error: { code: "AGENT_TRANSPORT", message: "agent went away" },
      willRetry: true,
    },
  });
  await append({
    type: "step.scheduled",
    runId: "run-parent",
    payload: { stepRunId: "s-build-2", nodeId: "build", nodeType: "agent", attempt: 2 },
  });
  await append({
    type: "step.started",
    runId: "run-parent",
    payload: { stepRunId: "s-build-2", inputArtifactIds: [] },
  });
  await append({
    type: "agent.session.opened",
    runId: "run-parent",
    payload: { stepRunId: "s-build-2", sessionId: "sess-2", agentId: "claude", hostId: "local", cwd: workspace.cwd },
  });
  // Into the artifact index as well as the log, the way `Orchestrator.recordArtifact` does
  // it: `artifacts.list` and `artifacts.get` read the index, `runs.get` reads the log.
  const spec = artifact("art-spec", "spec", "run-parent", "s-build-2", clock.isoNow());
  await stores.artifacts.put(spec, "# Spec\n\nThe SSO callback, as designed.\n");
  await append({
    type: "artifact.recorded",
    runId: "run-parent",
    payload: { stepRunId: "s-build-2", artifact: spec },
  });
  await append({
    type: "step.completed",
    runId: "run-parent",
    payload: { stepRunId: "s-build-2", result: { artifactIds: ["art-spec"], data: {} } },
  });
  await append({
    type: "step.scheduled",
    runId: "run-parent",
    payload: { stepRunId: "s-fan", nodeId: "fanout", nodeType: "parallel", attempt: 1 },
  });
  await append({ type: "step.started", runId: "run-parent", payload: { stepRunId: "s-fan", inputArtifactIds: [] } });
  await append({
    type: "child.spawned",
    runId: "run-parent",
    payload: { stepRunId: "s-fan", childRunId: "run-child-ok", branch: "auth-ui", workItemId: "wi-2" },
  });
  await append({
    type: "child.spawned",
    runId: "run-parent",
    payload: { stepRunId: "s-fan", childRunId: "run-child-gone", branch: "auth-docs" },
  });
  await append({
    type: "branch.skipped",
    runId: "run-parent",
    payload: { stepRunId: "s-fan", branch: "auth-perf", reason: "dependency" },
  });
  await append({
    type: "step.waiting",
    runId: "run-parent",
    payload: { stepRunId: "s-fan", on: "child-run", detail: "run-child-ok,run-child-gone" },
  });

  // ---- run-child-ok: a child that finished.
  await append({
    type: "run.created",
    runId: "run-child-ok",
    payload: {
      workflowId: "sdlc-item",
      workflowVersion: "2",
      requestId: "req-1",
      workItemId: "wi-2",
      parentRunId: "run-parent",
      parentStepRunId: "s-fan",
      workspace,
      vars: {},
    },
  });
  await append({ type: "run.started", runId: "run-child-ok", payload: {} });
  await append({
    type: "step.scheduled",
    runId: "run-child-ok",
    payload: { stepRunId: "s-ui", nodeId: "implement", nodeType: "agent", attempt: 1 },
  });
  await append({ type: "step.started", runId: "run-child-ok", payload: { stepRunId: "s-ui", inputArtifactIds: [] } });
  await append({
    type: "step.completed",
    runId: "run-child-ok",
    payload: { stepRunId: "s-ui", result: { artifactIds: [], data: {} } },
  });
  await append({ type: "run.completed", runId: "run-child-ok", payload: { outcome: "success", message: "done" } });

  // ---- run-gate: parked on a decision, with the artifact it is about.
  await append({
    type: "run.created",
    runId: "run-gate",
    payload: { workflowId: "sdlc", workflowVersion: "2", workItemId: "wi-3", workspace, vars: {} },
  });
  await append({ type: "run.started", runId: "run-gate", payload: {} });
  await append({
    type: "step.scheduled",
    runId: "run-gate",
    payload: { stepRunId: "s-write", nodeId: "write", nodeType: "agent", attempt: 1 },
  });
  await append({ type: "step.started", runId: "run-gate", payload: { stepRunId: "s-write", inputArtifactIds: [] } });
  const review = artifact("art-review", "review", "run-gate", "s-write", clock.isoNow());
  await stores.artifacts.put(review, "---\nverdict: approve\n---\n\nLooks right.\n");
  await append({
    type: "artifact.recorded",
    runId: "run-gate",
    payload: { stepRunId: "s-write", artifact: review },
  });
  await append({
    type: "step.completed",
    runId: "run-gate",
    payload: { stepRunId: "s-write", result: { artifactIds: ["art-review"], data: {} } },
  });
  await append({
    type: "step.scheduled",
    runId: "run-gate",
    payload: { stepRunId: "s-gate", nodeId: "approve", nodeType: "gate", attempt: 1 },
  });
  await append({ type: "step.started", runId: "run-gate", payload: { stepRunId: "s-gate", inputArtifactIds: [] } });
  await append({
    type: "step.inputs",
    runId: "run-gate",
    payload: { stepRunId: "s-gate", artifactIds: ["art-review"] },
  });
  await append({
    type: "human.requested",
    runId: "run-gate",
    payload: {
      stepRunId: "s-gate",
      requestId: "hi-1",
      kind: "decision",
      question: "Ship the rollout?",
      // Labels differ from ids on purpose: the wire carries ids, and a view that
      // leaked labels into `options` would answer the gate with words it cannot match.
      options: [
        { id: "approve", label: "Approve and ship" },
        { id: "hold", label: "Hold for now", consequence: "The rollout stays parked until someone answers again." },
      ],
      context: { artifact: "art-review" },
    },
  });
  await append({
    type: "step.waiting",
    runId: "run-gate",
    payload: { stepRunId: "s-gate", on: "human-input", detail: "hi-1" },
  });
  await append({ type: "run.paused", runId: "run-gate", payload: { reason: "human input" } });

  // ---- run-lost: claims to be running, with nothing heartbeating for it.
  await append({
    type: "run.created",
    runId: "run-lost",
    payload: { workflowId: "sdlc", workflowVersion: "1", workspace, vars: {} },
  });
  await append({ type: "run.started", runId: "run-lost", payload: {} });

  // ---- run-old: finished in failure, and has only a request to be named after.
  await append({
    type: "run.created",
    runId: "run-old",
    payload: { workflowId: "nightly", workflowVersion: "1", requestId: "req-1", workspace, vars: {} },
  });
  await append({ type: "run.started", runId: "run-old", payload: {} });
  await append({
    type: "run.failed",
    runId: "run-old",
    payload: { error: { code: "STEP_TIMEOUT", message: "the build never finished" } },
  });

  // The parent is the one run something is actually driving.
  await stores.leases.acquire({ resource: runLeaseResource("run-parent"), holder: "test-holder", ttlMs: 60_000 });

  // Two claims: one held by a live run, one by a run whose log is gone.
  await stores.claims.claim({
    workItemId: "wi-2",
    runId: "run-parent",
    branch: "auth-ui",
    stepRunId: "s-fan",
    at: clock.isoNow(),
  });
  await stores.claims.claim({
    workItemId: "wi-3",
    runId: "run-vanished",
    branch: "auth-docs",
    at: clock.isoNow(),
  });

  return { clock, stores, orchestrator: orc, asOf: clock.isoNow() };
}
