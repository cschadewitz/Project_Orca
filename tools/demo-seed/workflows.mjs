// The extra workflow definitions the seed adds, built as objects and written as JSON (which is
// YAML), so the seeder needs no YAML library on the machine it runs on. Each has a different
// shape on the canvas: a long line, parallel branches, a chain of gates, a nested workflow, a
// wide fan, and a copy of ai-sdlc that reviews with the strict template pack.

const topicInput = { topic: "What this run is about: { slug, title }." };
const out = (node) => `.orca/demo/{{ vars.topic.slug }}/${node}.md`;

function agentStep(id, name, role, template, vars = {}) {
  return {
    type: "agent",
    name,
    agent: { role },
    template,
    vars,
    produces: [{ kind: "note", name: id.replace(/-/g, "_"), path: out(id) }],
  };
}

function line(ids, roleOf, templateOf, nameOf) {
  const nodes = { start: { type: "start" } };
  const edges = [];
  let previous = "start";
  for (const [index, id] of ids.entries()) {
    nodes[id] = agentStep(id, nameOf(id, index), roleOf(id, index), templateOf(id, index), { step: index + 1 });
    edges.push({ from: previous, to: id });
    previous = id;
  }
  nodes.done = { type: "end", outcome: "success", message: "All steps done." };
  edges.push({ from: previous, to: "done" });
  return { start: "start", nodes, edges };
}

const titleCase = (id) => id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

function releaseTrain() {
  const steps = [
    "freeze-branch",
    "collect-changes",
    "write-notes",
    "bump-version",
    "build-artifacts",
    "sign-artifacts",
    "smoke-linux",
    "smoke-windows",
    "smoke-macos",
    "publish-feed",
    "announce",
    "unfreeze-branch",
  ];
  const roleOf = (id) =>
    id.startsWith("smoke")
      ? "tester"
      : id.includes("artifacts")
        ? "builder"
        : id === "publish-feed"
          ? "deployer"
          : "planner";
  const templateOf = (id) =>
    id === "write-notes"
      ? "demo/release-notes"
      : id.includes("artifacts")
        ? "demo/package"
        : id.startsWith("smoke")
          ? "demo/smoke"
          : id === "announce"
            ? "demo/announce"
            : "demo/step";
  return {
    id: "release-train",
    name: "Release train",
    version: "3",
    description: "Twelve steps in a line, from freezing the branch to announcing the release.",
    inputs: topicInput,
    ...line(steps, roleOf, templateOf, titleCase),
  };
}

function parallelAudit() {
  const areas = ["auth", "storage", "network", "dependencies", "logging"];
  const branches = {};
  for (const area of areas)
    branches[area] = {
      graph: {
        start: "start",
        nodes: {
          start: { type: "start" },
          audit: agentStep(`audit-${area}`, `Audit ${area}`, "reviewer", "demo/audit-area", { area }),
          done: { type: "end", outcome: "success" },
        },
        edges: [
          { from: "start", to: "audit" },
          { from: "audit", to: "done" },
        ],
      },
    };
  return {
    id: "parallel-audit",
    name: "Parallel security audit",
    version: "1",
    description: "Five areas audited side by side, then one summary and a sign-off.",
    inputs: topicInput,
    start: "start",
    nodes: {
      start: { type: "start" },
      fan: { type: "parallel", name: "Audit every area", branches, concurrency: 3, join: "all", failFast: false },
      summary: agentStep("summary", "Summarise findings", "planner", "demo/step"),
      "sign-off": {
        type: "gate",
        name: "Sign off the audit",
        question: "Sign off the audit for {{ vars.topic.title }}?",
        options: [
          { id: "approve", label: "Sign off", consequence: "The audit is filed as complete." },
          { id: "reject", label: "Send back", consequence: "The findings go back to their owners." },
        ],
      },
      done: { type: "end", outcome: "success" },
      "sent-back": { type: "end", outcome: "failure", message: "Audit sent back." },
    },
    edges: [
      { from: "start", to: "fan" },
      { from: "fan", to: "summary" },
      { from: "summary", to: "sign-off" },
      { from: "sign-off", to: "done", when: "choice == 'approve'" },
      { from: "sign-off", to: "sent-back" },
    ],
  };
}

function approvalChain() {
  const gate = (name, question, destructive = false) => ({
    type: "gate",
    name,
    question,
    options: [
      {
        id: "approve",
        label: "Approve",
        consequence: "Continue to the next approver.",
        ...(destructive ? { destructive: true } : {}),
      },
      { id: "reject", label: "Reject", consequence: "Stop here; nothing changes." },
    ],
  });
  return {
    id: "approval-chain",
    name: "Three-person approval",
    version: "2",
    description: "A request that needs a manager, security and the data owner to say yes, in that order.",
    inputs: topicInput,
    start: "start",
    nodes: {
      start: { type: "start" },
      prepare: agentStep("prepare", "Prepare the request", "planner", "demo/step"),
      manager: gate("Manager approval", "Does your team need this: {{ vars.topic.title }}?"),
      security: gate("Security approval", "Is this safe: {{ vars.topic.title }}?"),
      owner: gate("Data owner approval", "Go ahead with {{ vars.topic.title }}? This cannot be undone.", true),
      apply: agentStep("apply", "Apply the change", "deployer", "demo/step"),
      done: { type: "end", outcome: "success" },
      rejected: { type: "end", outcome: "failure", message: "Rejected by an approver." },
    },
    edges: [
      { from: "start", to: "prepare" },
      { from: "prepare", to: "manager" },
      { from: "manager", to: "security", when: "choice == 'approve'" },
      { from: "manager", to: "rejected" },
      { from: "security", to: "owner", when: "choice == 'approve'" },
      { from: "security", to: "rejected" },
      { from: "owner", to: "apply", when: "choice == 'approve'" },
      { from: "owner", to: "rejected" },
      { from: "apply", to: "done" },
    ],
  };
}

function nestedRelease() {
  return {
    id: "nested-release",
    name: "Hotfix with a nested release train",
    version: "1",
    description: "Fix, review, then run the whole release train as a child run.",
    inputs: topicInput,
    start: "start",
    nodes: {
      start: { type: "start" },
      fix: agentStep("fix", "Write the fix", "builder", "demo/step"),
      review: agentStep("review", "Review the fix", "reviewer", "demo/step"),
      release: {
        type: "subworkflow",
        name: "Release train",
        workflow: "release-train",
        vars: { topic: "=vars.topic" },
      },
      done: { type: "end", outcome: "success" },
    },
    edges: [
      { from: "start", to: "fix" },
      { from: "fix", to: "review" },
      { from: "review", to: "release" },
      { from: "release", to: "done" },
    ],
  };
}

function wideGraph() {
  const buckets = ["crash", "data-loss", "security", "performance", "ui", "docs", "billing", "auth", "api", "mobile"];
  const nodes = {
    start: { type: "start" },
    classify: agentStep("classify", "Classify incoming bugs", "planner", "demo/step"),
    route: {
      type: "decision",
      name: "Which bucket?",
      source: { kind: "expression", expr: "'crash'" },
      options: buckets,
      defaultOption: "docs",
    },
    merge: agentStep("merge", "Merge the triage notes", "planner", "demo/step"),
    done: { type: "end", outcome: "success" },
  };
  const edges = [
    { from: "start", to: "classify" },
    { from: "classify", to: "route" },
    { from: "merge", to: "done" },
  ];
  for (const bucket of buckets) {
    nodes[`triage-${bucket}`] = agentStep(`triage-${bucket}`, `Triage ${bucket}`, "tester", "demo/triage", { bucket });
    edges.push({ from: "route", to: `triage-${bucket}`, when: `choice == '${bucket}'`, label: bucket });
    edges.push({ from: `triage-${bucket}`, to: "merge" });
  }
  return {
    id: "wide-graph",
    name: "Weekly bug triage",
    version: "1",
    description: "One decision fanning out to ten triage lanes that meet again.",
    inputs: topicInput,
    start: "start",
    nodes,
    edges,
  };
}

function longIdentifier() {
  return {
    id: "a-workflow-with-a-very-long-identifier-that-keeps-going-to-test-truncation",
    name: "A workflow whose display name is long enough to wrap, truncate or overflow wherever workflows are listed",
    version: "2026.11.25-preview.1+build.4711",
    description: "Exists to show how long ids, names and versions render. " + "It runs two steps. ".repeat(12).trim(),
    inputs: topicInput,
    ...line(
      ["first-step-with-a-long-node-identifier", "second"],
      () => "planner",
      () => "demo/long",
      titleCase,
    ),
  };
}

/** ai-sdlc with a new id and the strict review pack, from the copied ai-sdlc source text. */
export function strictCopy(aiSdlcText) {
  return aiSdlcText
    .replace(/^id: ai-sdlc$/m, "id: ai-sdlc-strict")
    .replace(/^name: .*$/m, "name: AI-native SDLC loop (strict review)")
    .replace(/template: sdlc\/review$/m, "template: strict/sdlc/review");
}

export const WORKFLOWS = [
  releaseTrain(),
  parallelAudit(),
  approvalChain(),
  nestedRelease(),
  wideGraph(),
  longIdentifier(),
];
