/**
 * The plan the fake bridge answers the nine plan reads from (#169).
 *
 * Every value here was taken from a real `PlanModel` run over
 * `packages/daemon/test/plan-fixture.ts` — the scores, the priority reasons, the schedule
 * buckets, the explanation lines and the journal summaries are the scheduler's own output,
 * not prose written to look like it. Only the ids were made readable (`wi-api` for a ULID),
 * because a test that names an item reads better than one that names `wi_01KJM…`.
 *
 * The plan is one of each thing a Plan surface has to draw:
 *
 * - `auth-api` — ready, head of the critical path, exposed to a medium risk;
 * - `auth-ui` — waiting for `auth-api` to be done, and second on the critical path;
 * - `auth-docs` — waiting for a *stage*: `auth-api` producing a `spec`;
 * - `auth-store` — waiting for an open decision;
 * - `auth-legal` — waiting for something outside ORCA;
 * - `auth-crypto` — held: a critical risk above the plan's appetite;
 * - `auth-metrics` — running, with a claim held by a run whose log is gone;
 * - `auth-spike` — done; `auth-legacy` — failed.
 *
 * There is no date estimate anywhere, because ORCA cannot compute one (#174).
 * `criticalPathLength` is in the plan's estimate units and is not a duration.
 */
import type {
  DecisionView,
  DependencyView,
  PlanItemView,
  PlanJournalEntryView,
  PlanView,
  RiskView,
  ScheduleView,
} from "@orca/protocol";
import { AS_OF } from "./fixtures.js";

/** Everything in this plan was written in one tick of the fixture's `FakeClock`. */
const T = "2026-03-01T09:00:00.000Z";

export const PLAN_ID = "plan-sso";
export const DECISION_ID = "dec-datastore";

export const PLAN: PlanView = {
  id: PLAN_ID,
  key: "sso",
  title: "SSO rollout",
  description: "",
  status: "active",
  requestIds: ["req-1"],
  counts: { ready: 1, running: 1, waiting: 4, held: 1, unschedulable: 0, done: 1, failed: 1 },
  riskMatrix: { scale: 5, thresholds: { medium: 5, high: 10, critical: 16 } },
  policy: { strategy: "critical-path", concurrency: 2, riskAppetite: "high" },
  createdAt: T,
  updatedAt: T,
};

export const PLANS: readonly PlanView[] = [PLAN];

const KEY_LEAK = {
  id: "risk-key-leak",
  key: "key-leak",
  title: "Signing key could leak during rotation",
  status: "open" as const,
  score: 20,
  level: "critical" as const,
};
const VENDOR_SLIP = {
  id: "risk-vendor-slip",
  key: "vendor-slip",
  title: "The provider's migration window may move",
  status: "open" as const,
  score: 6,
  level: "medium" as const,
};

const item = (
  id: string,
  slug: string,
  title: string,
  rest: Omit<PlanItemView, "id" | "slug" | "title" | "requestId" | "kind" | "createdAt" | "updatedAt">,
): PlanItemView => ({
  id,
  slug,
  title,
  requestId: "req-1",
  kind: "task",
  createdAt: T,
  updatedAt: T,
  ...rest,
});

/**
 * In the daemon's order: ready first and best first, then running, waiting, held,
 * unschedulable and the settled ones — which is the dispatch order, not a sort.
 */
export const PLAN_ITEMS: readonly PlanItemView[] = [
  item("wi-api", "auth-api", "Add the SSO callback", {
    status: "pending",
    priorityBand: "high",
    classification: "ready",
    risk: { score: 6, level: "medium", risks: [VENDOR_SLIP] },
    priority: {
      score: 6.6,
      reasons: [
        "unblocks 2 items (auth-ui, auth-docs)",
        "on the critical path (length 5)",
        "exposed to medium risk: vendor-slip",
        "priority high",
      ],
    },
  }),
  item("wi-metrics", "auth-metrics", "Instrument the login funnel", {
    status: "in-progress",
    priorityBand: "normal",
    classification: "running",
    risk: { score: 0, level: "none", risks: [] },
    priority: { score: 0.5, reasons: [] },
    claim: { runId: "run-metrics" },
    runId: "run-metrics",
  }),
  item("wi-ui", "auth-ui", "Wire the login button", {
    status: "pending",
    priorityBand: "normal",
    classification: "waiting",
    risk: { score: 0, level: "none", risks: [] },
    priority: { score: 3.5, reasons: ["on the critical path (length 5)"] },
  }),
  item("wi-store", "auth-store", "Choose and wire the session store", {
    status: "pending",
    priorityBand: "normal",
    classification: "waiting",
    risk: { score: 0, level: "none", risks: [] },
    priority: { score: 0.5, reasons: [] },
  }),
  item("wi-legal", "auth-legal", "Legal sign-off", {
    status: "pending",
    priorityBand: "normal",
    classification: "waiting",
    risk: { score: 0, level: "none", risks: [] },
    priority: { score: 0.5, reasons: [] },
  }),
  item("wi-docs", "auth-docs", "Document the rollout", {
    status: "pending",
    priorityBand: "normal",
    classification: "waiting",
    risk: { score: 0, level: "none", risks: [] },
    priority: { score: 0.5, reasons: [] },
  }),
  item("wi-crypto", "auth-crypto", "Rotate the signing keys", {
    status: "pending",
    priorityBand: "normal",
    classification: "held",
    risk: { score: 20, level: "critical", risks: [KEY_LEAK] },
    priority: {
      score: 5.1,
      reasons: ["exposed to critical risk: key-leak", "mitigates key-leak (critical)"],
    },
  }),
  item("wi-spike", "auth-spike", "Spike the provider SDK", {
    status: "done",
    priorityBand: "normal",
    classification: "done",
    risk: { score: 0, level: "none", risks: [] },
  }),
  item("wi-legacy", "auth-legacy", "Retire the legacy login", {
    status: "failed",
    priorityBand: "normal",
    classification: "failed",
    risk: { score: 0, level: "none", risks: [] },
  }),
];

export const SCHEDULE: ScheduleView = {
  planId: PLAN_ID,
  computedAt: T,
  strategy: "critical-path",
  ready: [
    {
      workItemId: "wi-api",
      slug: "auth-api",
      score: 6.6,
      reasons: [
        "unblocks 2 items (auth-ui, auth-docs)",
        "on the critical path (length 5)",
        "exposed to medium risk: vendor-slip",
        "priority high",
      ],
    },
  ],
  running: ["auth-metrics"],
  waiting: [
    { workItemId: "wi-ui", slug: "auth-ui", on: ["waiting for auth-api to be done (currently pending)"] },
    { workItemId: "wi-docs", slug: "auth-docs", on: ["waiting for auth-api to produce spec"] },
    { workItemId: "wi-store", slug: "auth-store", on: ["waiting for decision datastore"] },
    { workItemId: "wi-legal", slug: "auth-legal", on: ["waiting for external 'legal-review'"] },
  ],
  held: [
    {
      workItemId: "wi-crypto",
      slug: "auth-crypto",
      level: "critical",
      reason: "open critical risk key-leak exceeds the plan's appetite (high); accept or mitigate first",
    },
  ],
  unschedulable: [],
  done: ["auth-spike"],
  failed: ["auth-legacy"],
  waves: [
    ["auth-api", "auth-store", "auth-legal", "auth-crypto", "auth-metrics"],
    ["auth-ui", "auth-docs"],
  ],
  criticalPath: ["auth-api", "auth-ui"],
  criticalPathLength: 5,
  cycles: [],
  risk: {
    open: 2,
    highestLevel: "critical",
    byLevel: { low: 0, medium: 1, high: 0, critical: 1 },
    top: [
      { key: "key-leak", level: "critical", score: 20 },
      { key: "vendor-slip", level: "medium", score: 6 },
    ],
  },
  openDecisions: [{ key: "datastore", title: "Where sessions live", blocks: ["auth-store"] }],
  asOf: AS_OF,
};

/**
 * `schedule.explain`'s answer per item, which is `orca plan explain`'s output word for word.
 * A popover renders these lines; it does not re-phrase them.
 */
export const EXPLANATIONS: Readonly<Record<string, readonly string[]>> = {
  "auth-api": [
    "auth-api: pending (priority high)",
    "ready - position 1 of 1 (score 6.6)",
    "why: unblocks 2 items (auth-ui, auth-docs)",
    "why: on the critical path (length 5)",
    "why: exposed to medium risk: vendor-slip",
    "why: priority high",
    "critical path: auth-api -> auth-ui",
    "wave 1 of 2",
    "risk vendor-slip: open (L2 x I3)",
  ],
  "auth-ui": [
    "auth-ui: pending",
    "waiting: waiting for auth-api to be done (currently pending)",
    "why: on the critical path (length 5)",
    "critical path: auth-api -> auth-ui",
    "wave 2 of 2",
    "dependency (blocks): waiting for auth-api to be done (currently pending)",
  ],
  "auth-docs": [
    "auth-docs: pending",
    "waiting: waiting for auth-api to produce spec",
    "wave 2 of 2",
    "dependency (blocks): waiting for auth-api to produce spec",
  ],
  "auth-store": [
    "auth-store: pending",
    "waiting: waiting for decision datastore",
    "wave 1 of 2",
    "dependency (blocks): waiting for decision datastore",
  ],
  "auth-legal": [
    "auth-legal: pending",
    "waiting: waiting for external 'legal-review'",
    "wave 1 of 2",
    "dependency (blocks): waiting for external 'legal-review'",
  ],
  "auth-crypto": [
    "auth-crypto: pending",
    "held: open critical risk key-leak exceeds the plan's appetite (high); accept or mitigate first",
    "why: exposed to critical risk: key-leak",
    "why: mitigates key-leak (critical)",
    "wave 1 of 2",
    "risk key-leak: open (L4 x I5)",
  ],
  "auth-metrics": ["auth-metrics: in-progress", "running", "wave 1 of 2"],
  "auth-spike": ["auth-spike: done"],
  "auth-legacy": ["auth-legacy: failed"],
};

export const DEPENDENCIES: readonly DependencyView[] = [
  {
    id: "dep-store-datastore",
    from: "wi-store",
    fromSlug: "auth-store",
    target: { kind: "decision", decisionId: DECISION_ID, key: "datastore" },
    type: "blocks",
    requiredBy: "start",
    status: "open",
    evaluation: { state: "waiting", detail: "waiting for decision datastore" },
    rationale: "decision datastore must be made first",
    createdAt: T,
    updatedAt: T,
  },
  {
    id: "dep-ui-api",
    from: "wi-ui",
    fromSlug: "auth-ui",
    target: { kind: "work-item", workItemId: "wi-api", slug: "auth-api" },
    type: "blocks",
    requiredBy: "start",
    status: "open",
    evaluation: { state: "waiting", detail: "waiting for auth-api to be done (currently pending)" },
    createdAt: T,
    updatedAt: T,
  },
  {
    id: "dep-docs-api-spec",
    from: "wi-docs",
    fromSlug: "auth-docs",
    target: { kind: "work-item", workItemId: "wi-api", slug: "auth-api", stage: "spec" },
    type: "blocks",
    requiredBy: "start",
    status: "open",
    evaluation: { state: "waiting", detail: "waiting for auth-api to produce spec" },
    createdAt: T,
    updatedAt: T,
  },
  {
    id: "dep-legal-external",
    from: "wi-legal",
    fromSlug: "auth-legal",
    target: { kind: "external", key: "legal-review" },
    type: "blocks",
    requiredBy: "start",
    status: "open",
    evaluation: { state: "waiting", detail: "waiting for external 'legal-review'" },
    createdAt: T,
    updatedAt: T,
  },
];

/** Highest score first, which is the order `risks.list` answers in. */
export const RISKS: readonly RiskView[] = [
  {
    id: "risk-key-leak",
    key: "key-leak",
    title: "Signing key could leak during rotation",
    description: "",
    category: "security",
    likelihood: 4,
    impact: 5,
    score: 20,
    level: "critical",
    status: "open",
    open: true,
    mitigation: "Rotate through the HSM and never write a key to disk.",
    triggers: [],
    affects: [{ id: "wi-crypto", slug: "auth-crypto" }],
    mitigatedBy: [{ id: "wi-crypto", slug: "auth-crypto" }],
    createdAt: T,
    updatedAt: T,
  },
  {
    id: "risk-vendor-slip",
    key: "vendor-slip",
    title: "The provider's migration window may move",
    description: "",
    category: "schedule",
    likelihood: 2,
    impact: 3,
    score: 6,
    level: "medium",
    status: "open",
    open: true,
    triggers: [],
    affects: [{ id: "wi-api", slug: "auth-api" }],
    mitigatedBy: [],
    createdAt: T,
    updatedAt: T,
  },
];

export const DECISIONS: readonly DecisionView[] = [
  {
    id: DECISION_ID,
    key: "datastore",
    title: "Where sessions live",
    question: "Cookie, Redis or the database?",
    status: "open",
    criteria: [
      { key: "latency", name: "Latency", weight: 2, direction: "maximize" },
      { key: "ops", name: "Operational cost", weight: 1, direction: "minimize" },
    ],
    options: [
      {
        key: "cookie",
        name: "Signed cookie",
        scores: { latency: 9, ops: 2 },
        pros: ["No new service"],
        cons: [],
        risks: [],
      },
      {
        key: "redis",
        name: "Redis",
        scores: { latency: 8, ops: 6 },
        pros: [],
        cons: ["Another thing to run"],
        risks: [],
      },
    ],
    scale: 10,
    consequences: [],
    blocks: [{ id: "wi-store", slug: "auth-store" }],
    createdAt: T,
    updatedAt: T,
  },
];

const entry = (
  seq: number,
  type: string,
  summary: string,
  payload: Record<string, unknown>,
  kind: PlanJournalEntryView["origin"]["kind"] = "decomposition",
): PlanJournalEntryView => ({
  id: `pev-${seq}`,
  seq,
  planId: PLAN_ID,
  at: T,
  type,
  origin: { kind, actor: kind === "human" ? "daemon" : "planner" },
  payload,
  summary,
});

/**
 * The audit trail, oldest first. The payloads are trimmed to what a timeline row would
 * actually reach for — `summary` is the rendering, and it is the daemon's, so a row shows it
 * rather than folding a payload shape of its own.
 */
export const JOURNAL: readonly PlanJournalEntryView[] = [
  entry(0, "plan.created", '{"key":"sso"}', { plan: { id: PLAN_ID, key: "sso" } }),
  entry(1, "request.linked", '{"requestId":"req-1"}', { requestId: "req-1" }),
  entry(2, "work-item.added", "auth-api", { workItem: { id: "wi-api", slug: "auth-api" } }),
  entry(3, "work-item.added", "auth-ui", { workItem: { id: "wi-ui", slug: "auth-ui" } }),
  entry(4, "work-item.added", "auth-crypto", { workItem: { id: "wi-crypto", slug: "auth-crypto" } }),
  entry(5, "risk.raised", "key-leak", { risk: { id: "risk-key-leak", key: "key-leak" } }),
  entry(6, "decision.opened", "datastore", { decision: { id: DECISION_ID, key: "datastore" } }),
  entry(7, "dependency.added", 'auth-ui -> {"kind":"work-item","workItemId":"wi-api"}', {
    dependency: { id: "dep-ui-api", from: "wi-ui", target: { kind: "work-item", workItemId: "wi-api" } },
  }),
  entry(8, "work-item.updated", 'auth-spike {"status":"done"}', {
    workItemId: "wi-spike",
    changes: { status: "done" },
  }),
  entry(9, "work-item.updated", 'auth-legacy {"status":"failed"}', {
    workItemId: "wi-legacy",
    changes: { status: "failed" },
  }),
  entry(
    10,
    "dependency.resolved",
    "dep-legal-external waived: not needed for the pilot",
    { dependencyId: "dep-legal-external", status: "waived", resolution: "not needed for the pilot" },
    "human",
  ),
];
