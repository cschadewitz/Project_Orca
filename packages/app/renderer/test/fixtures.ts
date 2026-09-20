/**
 * The data the fake preload bridge answers from: one small store, rendered through the five
 * read methods exactly as a daemon would render it.
 *
 * Every value here was taken from a real `ReadModel` run over `packages/daemon/test/fixture.ts`
 * rather than invented, so the shapes, the folded display statuses, the derived names and the
 * `asOf`-relative durations are the ones a screen will actually meet. The story is that
 * fixture's, and it is worth knowing when reading a test:
 *
 * - `run-parent` — running, one step retried after a transport failure, a fan-out with one
 *   finished child, one child whose log is gone (`stale`) and one branch skipped;
 * - `run-child-ok` — that fan-out's finished child;
 * - `run-gate` — parked on a decision, with the artifact the decision is about;
 * - `run-lost` — says it is running with no lease behind it, so: `stale`;
 * - `run-old` — finished in failure, named after its request because it has no work item.
 *
 * Between them they cover all four things a surface has to get right — a live run, a finished
 * one, a run asking for a person, and a run nobody is driving — plus a claim whose owner has
 * vanished. `fake-bridge.test.ts` parses every constant here through its protocol schema, so
 * a protocol change breaks this file rather than a screen test three waves later.
 *
 * The clock is the fixture's `FakeClock`: it starts at 2026-03-01T09:00:00Z and every event
 * is one second after the one before, which is why the durations are round numbers.
 */
import type {
  ClaimView,
  HelloResult,
  OpenInputView,
  RunSummaryView,
  RunsEventsResult,
  RunsGetResult,
} from "@orca/protocol";

/** The fixture clock's epoch, and the daemon's `asOf` for every result below. */
export const START = Date.UTC(2026, 2, 1, 9, 0, 0);
export const AS_OF = "2026-03-01T09:00:40.000Z";

/** Second `n` of the fixture clock. */
const at = (n: number): string => new Date(START + n * 1000).toISOString();

const WORKSPACE = { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" } as const;

const WI = {
  "wi-1": { id: "wi-1", slug: "auth-api", title: "Add the SSO callback", status: "in-progress" },
  "wi-2": { id: "wi-2", slug: "auth-ui", title: "Wire the login button", status: "in-progress" },
  "wi-3": { id: "wi-3", slug: "auth-docs", title: "Document the rollout", status: "in-progress" },
} as const;

/**
 * A daemon that serves a store and takes commands about it: both capabilities, and every
 * method this protocol version has.
 *
 * It used to claim six methods and `runs.read` alone, which was true when the wire had six
 * — and stopped being true four batches ago, quietly, because nothing reads `methods` for
 * anything but display. It matters now: `useWritability()` reads `capabilities` and hides
 * every control when `runs.control` is missing, so a fixture without it is a fixture in
 * which no test can press a button (#161). The read-only daemon is a real state and is a
 * *variant* of this rather than the default of it (#164).
 */
export const HELLO: HelloResult = {
  protocol: { major: 1, minor: 5 },
  orcaVersion: "0.2.0-test",
  storeDir: "/work/orca/.orca",
  capabilities: ["runs.read", "runs.control"],
  methods: [
    "hello",
    "runs.list",
    "runs.get",
    "runs.events",
    "inputs.list",
    "claims.list",
    "artifacts.list",
    "artifacts.get",
    "agents.list",
    "inputs.answer",
    "runs.resume",
    "runs.cancel",
    // Answered by a daemon with `runs.control`, and called by nothing in the app: the app
    // has no workflow picker to start a run from (#178).
    "runs.start",
  ],
};

/**
 * A daemon started `--read-only`, which is what file mode is (#164, ADR 0008): the control
 * capability is absent and so are the control methods, and that is an omission rather than
 * a refusal — a screen hides a button instead of pressing one that would fail.
 *
 * Written out rather than derived from `HELLO` so it stays read-only whatever `HELLO`
 * grows: the two exist in order to differ.
 */
export const HELLO_READ_ONLY: HelloResult = {
  protocol: { major: 1, minor: 0 },
  orcaVersion: "0.2.0-test",
  storeDir: "/work/other/.orca",
  capabilities: ["runs.read"],
  methods: ["hello", "runs.list", "runs.get", "runs.events", "inputs.list", "claims.list"],
};

/** `runs.list` with no filter: newest first, which is how the daemon orders it. */
export const RUNS: readonly RunSummaryView[] = [
  {
    id: "run-old",
    name: "SSO rollout",
    workflowId: "nightly",
    workflowVersion: "1",
    status: "failed",
    outcome: "failure",
    createdAt: at(38),
    startedAt: at(39),
    finishedAt: at(40),
    durationMs: 1000,
    requestId: "req-1",
    error: { code: "STEP_TIMEOUT", message: "the build never finished" },
  },
  {
    id: "run-lost",
    name: "sdlc",
    workflowId: "sdlc",
    workflowVersion: "1",
    status: "stale",
    createdAt: at(36),
    startedAt: at(37),
    durationMs: 3000,
  },
  {
    id: "run-gate",
    name: "Document the rollout",
    workflowId: "sdlc",
    workflowVersion: "2",
    status: "waiting",
    createdAt: at(24),
    startedAt: at(25),
    durationMs: 15000,
    waitingOn: "human-input",
    waitingDetail: "hi-1",
    waitingSince: at(34),
    workItem: WI["wi-3"],
  },
  {
    id: "run-child-ok",
    name: "Wire the login button",
    workflowId: "sdlc-item",
    workflowVersion: "2",
    status: "succeeded",
    outcome: "success",
    createdAt: at(18),
    startedAt: at(19),
    finishedAt: at(23),
    durationMs: 4000,
    parentRunId: "run-parent",
    requestId: "req-1",
    workItem: WI["wi-2"],
  },
  {
    id: "run-parent",
    name: "Add the SSO callback",
    workflowId: "sdlc",
    workflowVersion: "2",
    status: "running",
    createdAt: at(1),
    startedAt: at(2),
    durationMs: 38000,
    waitingOn: "child-run",
    waitingDetail: "run-child-ok,run-child-gone",
    waitingSince: at(17),
    requestId: "req-1",
    workItem: WI["wi-1"],
    agentId: "claude",
  },
];

const ART_SPEC = {
  id: "art-spec",
  kind: "spec",
  name: "spec",
  version: 1,
  mediaType: "text/markdown",
  size: 128,
  path: "/work/orca/.orca/artifacts/art-spec.md",
  createdAt: at(9),
  producedByStepRunId: "s-build-2",
} as const;

const ART_REVIEW = {
  id: "art-review",
  kind: "review",
  name: "review",
  version: 1,
  mediaType: "text/markdown",
  size: 128,
  path: "/work/orca/.orca/artifacts/art-review.md",
  createdAt: at(27),
  producedByStepRunId: "s-write",
} as const;

const run = (id: string): RunSummaryView => RUNS.find((r) => r.id === id)!;

/** `runs.get`, for the two runs a detail surface has anything to say about. */
export const RUN_DETAILS: Readonly<Record<string, RunsGetResult>> = {
  "run-parent": {
    run: run("run-parent"),
    workspace: WORKSPACE,
    vars: { branch: "feat/sso" },
    steps: [
      {
        id: "s-build-1",
        runId: "run-parent",
        nodeId: "build",
        nodeType: "agent",
        attempt: 1,
        status: "failed",
        scheduledAt: at(3),
        startedAt: at(4),
        finishedAt: at(6),
        durationMs: 2000,
        agentId: "claude",
        agentSessionId: "sess-1",
        inputArtifactIds: [],
        outputArtifactIds: [],
        error: { code: "AGENT_TRANSPORT", message: "agent went away" },
        children: [],
        skippedBranches: [],
      },
      {
        id: "s-build-2",
        runId: "run-parent",
        nodeId: "build",
        nodeType: "agent",
        attempt: 2,
        status: "succeeded",
        scheduledAt: at(7),
        startedAt: at(8),
        finishedAt: at(11),
        durationMs: 3000,
        agentId: "claude",
        agentSessionId: "sess-2",
        inputArtifactIds: [],
        outputArtifactIds: ["art-spec"],
        children: [],
        skippedBranches: [],
      },
      {
        id: "s-fan",
        runId: "run-parent",
        nodeId: "fanout",
        nodeType: "parallel",
        attempt: 1,
        status: "running",
        waitingOn: "child-run",
        scheduledAt: at(12),
        startedAt: at(13),
        durationMs: 27000,
        inputArtifactIds: [],
        outputArtifactIds: [],
        children: [
          {
            runId: "run-child-ok",
            name: "Wire the login button",
            status: "succeeded",
            outcome: "success",
            branch: "auth-ui",
            workItemId: "wi-2",
          },
          // No log for this one any more: the tree still has to draw it.
          { runId: "run-child-gone", name: "run-child-gone", status: "stale", branch: "auth-docs" },
        ],
        skippedBranches: [{ branch: "auth-perf", reason: "dependency" }],
      },
    ],
    artifacts: [ART_SPEC],
    lastSeq: 16,
    asOf: AS_OF,
  },
  "run-gate": {
    run: run("run-gate"),
    workspace: WORKSPACE,
    vars: {},
    steps: [
      {
        id: "s-write",
        runId: "run-gate",
        nodeId: "write",
        nodeType: "agent",
        attempt: 1,
        status: "succeeded",
        scheduledAt: at(26),
        startedAt: at(27),
        finishedAt: at(29),
        durationMs: 2000,
        inputArtifactIds: [],
        outputArtifactIds: ["art-review"],
        children: [],
        skippedBranches: [],
      },
      {
        id: "s-gate",
        runId: "run-gate",
        nodeId: "approve",
        nodeType: "gate",
        attempt: 1,
        status: "waiting",
        waitingOn: "human-input",
        scheduledAt: at(30),
        startedAt: at(31),
        durationMs: 9000,
        inputArtifactIds: ["art-review"],
        outputArtifactIds: [],
        children: [],
        skippedBranches: [],
      },
    ],
    artifacts: [ART_REVIEW],
    lastSeq: 11,
    asOf: AS_OF,
  },
};

type OrcaEvent = RunsEventsResult["events"][number];
/** One event without the three fields the store stamps on: `id`, `seq` and `at`. */
type EventSeed = { [K in OrcaEvent["type"]]: [K, Extract<OrcaEvent, { type: K }>["payload"]] }[OrcaEvent["type"]];

/**
 * Stamp a run's log: `seq` is the index (the store numbers per run) and `at` walks the
 * fixture clock from `from`. The cast is the one place a fixture has to assert that a
 * `[type, payload]` pair belongs together — the tuple type above already made the pair
 * check out, but TypeScript will not push that through a discriminated union in a `map`.
 */
const log = (runId: string, from: number, seeds: readonly EventSeed[]): OrcaEvent[] =>
  seeds.map(
    ([type, payload], i) => ({ id: `evt-${runId}-${i}`, seq: i, runId, at: at(from + i), type, payload }) as OrcaEvent,
  );

export const EVENTS: Readonly<Record<string, readonly OrcaEvent[]>> = {
  "run-parent": log("run-parent", 1, [
    [
      "run.created",
      {
        workflowId: "sdlc",
        workflowVersion: "2",
        requestId: "req-1",
        workItemId: "wi-1",
        workspace: WORKSPACE,
        vars: { branch: "feat/sso" },
      },
    ],
    ["run.started", {}],
    ["step.scheduled", { stepRunId: "s-build-1", nodeId: "build", nodeType: "agent", attempt: 1 }],
    ["step.started", { stepRunId: "s-build-1", inputArtifactIds: [] }],
    [
      "agent.session.opened",
      { stepRunId: "s-build-1", sessionId: "sess-1", agentId: "claude", hostId: "local", cwd: WORKSPACE.cwd },
    ],
    [
      "step.failed",
      { stepRunId: "s-build-1", error: { code: "AGENT_TRANSPORT", message: "agent went away" }, willRetry: true },
    ],
    ["step.scheduled", { stepRunId: "s-build-2", nodeId: "build", nodeType: "agent", attempt: 2 }],
    ["step.started", { stepRunId: "s-build-2", inputArtifactIds: [] }],
    [
      "agent.session.opened",
      { stepRunId: "s-build-2", sessionId: "sess-2", agentId: "claude", hostId: "local", cwd: WORKSPACE.cwd },
    ],
    [
      "artifact.recorded",
      {
        stepRunId: "s-build-2",
        artifact: {
          ...ART_SPEC,
          contentHash: "sha256:art-spec",
          producedBy: { runId: "run-parent", stepRunId: "s-build-2", agentId: "claude" },
          parents: [],
          data: {},
        },
      },
    ],
    ["step.completed", { stepRunId: "s-build-2", result: { artifactIds: ["art-spec"], data: {} } }],
    ["step.scheduled", { stepRunId: "s-fan", nodeId: "fanout", nodeType: "parallel", attempt: 1 }],
    ["step.started", { stepRunId: "s-fan", inputArtifactIds: [] }],
    ["child.spawned", { stepRunId: "s-fan", childRunId: "run-child-ok", branch: "auth-ui", workItemId: "wi-2" }],
    ["child.spawned", { stepRunId: "s-fan", childRunId: "run-child-gone", branch: "auth-docs" }],
    ["branch.skipped", { stepRunId: "s-fan", branch: "auth-perf", reason: "dependency" }],
    ["step.waiting", { stepRunId: "s-fan", on: "child-run", detail: "run-child-ok,run-child-gone" }],
  ]),
  "run-gate": log("run-gate", 24, [
    ["run.created", { workflowId: "sdlc", workflowVersion: "2", workItemId: "wi-3", workspace: WORKSPACE, vars: {} }],
    ["run.started", {}],
    ["step.scheduled", { stepRunId: "s-write", nodeId: "write", nodeType: "agent", attempt: 1 }],
    ["step.started", { stepRunId: "s-write", inputArtifactIds: [] }],
    [
      "artifact.recorded",
      {
        stepRunId: "s-write",
        artifact: {
          ...ART_REVIEW,
          contentHash: "sha256:art-review",
          producedBy: { runId: "run-gate", stepRunId: "s-write", agentId: "claude" },
          parents: [],
          data: {},
        },
      },
    ],
    ["step.completed", { stepRunId: "s-write", result: { artifactIds: ["art-review"], data: {} } }],
    ["step.scheduled", { stepRunId: "s-gate", nodeId: "approve", nodeType: "gate", attempt: 1 }],
    ["step.started", { stepRunId: "s-gate", inputArtifactIds: ["art-review"] }],
    ["step.inputs", { stepRunId: "s-gate", artifactIds: ["art-review"] }],
    [
      "human.requested",
      {
        stepRunId: "s-gate",
        requestId: "hi-1",
        kind: "decision",
        question: "Ship the rollout?",
        options: [
          { id: "approve", label: "approve" },
          { id: "hold", label: "hold" },
        ],
        context: { artifact: "art-review" },
      },
    ],
    ["step.waiting", { stepRunId: "s-gate", on: "human-input", detail: "hi-1" }],
    ["run.paused", { reason: "human input" }],
  ]),
};

/** `inputs.list`: the one open decision, with the artifact it is about carried inline. */
export const INPUTS: readonly OpenInputView[] = [
  {
    id: "hi-1",
    kind: "decision",
    question: "Ship the rollout?",
    // Whole `GateOption`s as of protocol 1.4: the id is what an answer carries and the label
    // is what a card draws, so they are deliberately different words here.
    options: [
      { id: "approve", label: "Approve and ship" },
      { id: "hold", label: "Hold for now", consequence: "The rollout stays parked until someone answers again." },
    ],
    context: { artifact: "art-review" },
    runId: "run-gate",
    runName: "Document the rollout",
    stepRunId: "s-gate",
    nodeId: "approve",
    workItem: WI["wi-3"],
    requestedAt: at(33),
    waitingMs: 7000,
    artifacts: [ART_REVIEW],
  },
];

/** `claims.list`: one claim a live run holds, one whose owner's log is gone. */
export const CLAIMS: readonly ClaimView[] = [
  {
    workItemId: "wi-2",
    workItem: WI["wi-2"],
    branch: "auth-ui",
    stepRunId: "s-fan",
    claimedAt: AS_OF,
    owner: { runId: "run-parent", name: "Add the SSO callback", status: "running", missing: false, releasable: false },
  },
  {
    workItemId: "wi-3",
    workItem: WI["wi-3"],
    branch: "auth-docs",
    claimedAt: AS_OF,
    owner: { runId: "run-vanished", status: "stale", missing: true, releasable: true },
  },
];
