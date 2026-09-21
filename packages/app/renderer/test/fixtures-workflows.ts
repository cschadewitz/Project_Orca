/**
 * The workflows the fake bridge answers `workflows.list` and `workflows.get` from (#174).
 *
 * They are the workflows the run fixtures in `fixtures.ts` say they were started against —
 * `sdlc` for `run-parent` and `run-gate`, `sdlc-item` for the child, `nightly` for the
 * finished one — so a viewer test can open a run, fetch its workflow and overlay the
 * traversal without the two halves disagreeing about which nodes exist. `sdlc` is shaped
 * around what those runs did: a node that was retried (`build`), a fan-out with two inline
 * branches (`fanout`), a gate parked on a person (`approve`), and a back edge from the gate
 * to `write`, so a viewer has a cycle to lay out.
 *
 * `sdlc` is at version `3` while both runs recorded `2`: that is the `◷ pinned` case from
 * docs/design/70-workflow-editing.md, and it is deliberate — a fixture where every run is on
 * the newest version is a fixture in which the pinned chip can never be tested.
 */
import type { WorkflowSummaryView, WorkflowView } from "@orca/protocol";

/** The branches of `sdlc`'s `parallel` node, as inline graphs with the engine's own ids. */
const FANOUT_BRANCHES: readonly WorkflowView[] = [
  {
    id: "sdlc::fanout::auth-ui",
    name: "sdlc::fanout::auth-ui",
    version: "3",
    start: "ui-start",
    nodes: [
      { id: "ui-start", type: "start", fields: {} },
      {
        id: "ui-build",
        type: "agent",
        name: "Wire the login button",
        fields: { role: "builder", template: "sdlc/build", inputs: [], produces: [] },
      },
      { id: "ui-done", type: "end", fields: { outcome: "success" } },
    ],
    edges: [
      { from: "ui-start", to: "ui-build" },
      { from: "ui-build", to: "ui-done" },
    ],
  },
  {
    id: "sdlc::fanout::auth-docs",
    name: "sdlc::fanout::auth-docs",
    version: "3",
    start: "docs-start",
    nodes: [
      { id: "docs-start", type: "start", fields: {} },
      {
        id: "docs-write",
        type: "agent",
        name: "Document the rollout",
        fields: { role: "writer", template: "sdlc/docs", inputs: [], produces: [] },
      },
      { id: "docs-done", type: "end", fields: { outcome: "success" } },
    ],
    edges: [
      { from: "docs-start", to: "docs-write" },
      { from: "docs-write", to: "docs-done" },
    ],
  },
];

const SDLC: WorkflowView = {
  id: "sdlc",
  name: "SSO delivery loop",
  version: "3",
  description: "Build a work item, fan out its pieces, write it up and ask a person.",
  start: "start",
  inputs: { workItem: "The work item this run implements." },
  vars: { maxBuildAttempts: 3 },
  nodes: [
    { id: "start", type: "start", fields: {} },
    {
      id: "build",
      type: "agent",
      name: "Build: plan and implement",
      maxAttempts: 3,
      fields: {
        role: "builder",
        template: "sdlc/build",
        inputs: [],
        produces: [{ kind: "spec", path: ".orca/work/spec.md" }],
        completion: { mode: "turn-end", maxFollowUps: 2, maxAttempts: 3 },
      },
    },
    {
      id: "fanout",
      type: "parallel",
      name: "Fan out the pieces",
      fields: { concurrency: 4, join: "all", failFast: true, branches: ["auth-ui", "auth-docs"] },
      nested: [...FANOUT_BRANCHES],
    },
    {
      id: "write",
      type: "agent",
      name: "Review: agentic PR review",
      fields: { role: "reviewer", template: "sdlc/review", inputs: [], produces: [{ kind: "review" }] },
    },
    {
      id: "approve",
      type: "gate",
      name: "Approve spec",
      fields: {
        question: "Ship the rollout?",
        options: [
          { id: "approve", label: "Approve and ship" },
          { id: "hold", label: "Hold for now", consequence: "The rollout stays parked until someone answers again." },
        ],
      },
    },
    { id: "done", type: "end", fields: { outcome: "success", message: "Rolled out." } },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "fanout" },
    { from: "fanout", to: "write" },
    { from: "write", to: "approve" },
    { from: "approve", to: "done", when: "choice == 'approve'", label: "ship" },
    // The back edge: a cycle the layout has to draw, and the one a run overlay re-enters.
    { from: "approve", to: "write", when: "choice == 'hold'", label: "revise" },
  ],
  versions: ["2", "3"],
};

const SDLC_ITEM: WorkflowView = {
  id: "sdlc-item",
  name: "One work item",
  version: "2",
  start: "item-start",
  nodes: [
    { id: "item-start", type: "start", fields: {} },
    {
      id: "implement",
      type: "agent",
      name: "Implement",
      fields: { role: "builder", template: "sdlc/build", inputs: [], produces: [] },
    },
    { id: "item-done", type: "end", fields: { outcome: "success" } },
  ],
  edges: [
    { from: "item-start", to: "implement" },
    { from: "implement", to: "item-done" },
  ],
  versions: ["2"],
};

const NIGHTLY: WorkflowView = {
  id: "nightly",
  name: "Nightly build",
  version: "1",
  start: "nightly-start",
  nodes: [
    { id: "nightly-start", type: "start", fields: {} },
    {
      id: "nightly-build",
      type: "agent",
      name: "Build everything",
      fields: { agentId: "claude", template: "ci/build", inputs: [], produces: [] },
    },
    { id: "nightly-done", type: "end", fields: { outcome: "success" } },
  ],
  edges: [
    { from: "nightly-start", to: "nightly-build" },
    { from: "nightly-build", to: "nightly-done" },
  ],
  versions: ["1"],
};

/**
 * Every workflow `workflows.get` can answer, by id — the three registered ones and the two
 * graphs written inline inside `sdlc`'s `parallel`, under the `parent::node::branch` ids the
 * daemon addresses them by. A nested graph is fetchable by id *and* present under its node,
 * exactly as the daemon sends it, so a test can take either route.
 */
export const WORKFLOW_VIEWS: Readonly<Record<string, WorkflowView>> = {
  sdlc: SDLC,
  "sdlc-item": SDLC_ITEM,
  nightly: NIGHTLY,
  "sdlc::fanout::auth-ui": FANOUT_BRANCHES[0]!,
  "sdlc::fanout::auth-docs": FANOUT_BRANCHES[1]!,
};

/** `workflows.list`: the registered workflows only, by id, as the daemon orders them. */
export const WORKFLOWS: readonly WorkflowSummaryView[] = [NIGHTLY, SDLC, SDLC_ITEM].map((w) => ({
  id: w.id,
  name: w.name,
  version: w.version,
  nodeCount: w.nodes.length,
  edgeCount: w.edges.length,
  start: w.start,
  ...(w.description === undefined ? {} : { description: w.description }),
}));
