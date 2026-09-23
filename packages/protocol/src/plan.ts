/**
 * The plan read methods: `plans.list`, `plan.get`, `items.list`, `schedule.get`,
 * `schedule.explain`, `dependencies.list`, `risks.list`, `decisions.list`, `journal.list`.
 *
 * Everything before this projected *runs* - what happened. This projects the plan - what is
 * coming, why it is not moving, and what it waits for. The shapes are display read models
 * the same way `runs.ts`'s are (views.ts): a work item arrives with the scheduler's
 * classification, its priority score *and the reasons behind it*, its risk exposure and the
 * run holding its claim, because those four are the columns of the schedule table and a
 * client that had to derive any of them would be re-implementing `computeSchedule`.
 *
 * Three shaping decisions worth knowing before the schemas:
 *
 * - **Every method takes an explicit `planId`.** The daemon has no per-client configuration
 *   and so no default plan; `plans.list` is how a client finds one. (The CLI has a default
 *   because a checkout has an `orca.config.yaml`; a daemon serves a store, not a person.)
 * - **The explanation is `core`'s, verbatim.** `schedule.explain` returns the lines
 *   `explainWorkItem` produces plus the dependency and risk lines `orca plan explain` adds,
 *   in that order and unchanged. The text is produced once, in `core`, and shared - a
 *   paraphrase on the wire would be a second explanation to keep true.
 * - **Nothing here carries a date estimate.** There is no "ready by", no ETA and no percent
 *   complete anywhere in these views, because ORCA cannot compute one (#174). The critical
 *   path has a `length`, which is in the plan's own estimate units and is not a duration.
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import {
  DecisionCriterionSchema,
  DecisionMatrixResultSchema,
  DecisionOptionSchema,
  DecisionStatusSchema,
  DependencyStatusSchema,
  DependencyTypeSchema,
  PlanOriginSchema,
  PlanStatusSchema,
  RiskCategorySchema,
  RiskLevelSchema,
  RiskStatusSchema,
  RiskThresholdsSchema,
  SchedulingStrategySchema,
  WorkItemPrioritySchema,
  WorkItemStatusSchema,
} from "@orca/core/schemas";
import { WorkItemViewSchema } from "./views.js";

export const PLANS_LIST_METHOD = "plans.list";
export const PLAN_GET_METHOD = "plan.get";
export const ITEMS_LIST_METHOD = "items.list";
export const SCHEDULE_GET_METHOD = "schedule.get";
export const SCHEDULE_EXPLAIN_METHOD = "schedule.explain";
export const DEPENDENCIES_LIST_METHOD = "dependencies.list";
export const RISKS_LIST_METHOD = "risks.list";
export const DECISIONS_LIST_METHOD = "decisions.list";
export const JOURNAL_LIST_METHOD = "journal.list";

// ------------------------------------------------------------------- the shared pieces

/**
 * Where the scheduler put an item. Five of these are the design system's `ScheduleClass`
 * (`@orca/design`), which draws a badge for each; `done` and `failed` are the two settled
 * buckets, which a badge does not draw but a filter and a count do.
 *
 * A *cancelled* item reports `failed`. The scheduler tracks `settled.cancelled` separately
 * and this view does not, because the seven values are what a person may filter by and both
 * mean the same thing to a plan: the item will not be delivered. The item's own
 * `status` is on the view beside this, and it still says `cancelled`.
 */
export const ITEM_CLASSIFICATIONS = ["ready", "running", "waiting", "held", "unschedulable", "done", "failed"] as const;
export const ItemClassificationSchema = z.enum(ITEM_CLASSIFICATIONS);
export type ItemClassification = z.infer<typeof ItemClassificationSchema>;

/** A work item as another object points at it: enough to render a link and nothing more. */
export const ItemRefSchema = z.object({ id: z.string(), slug: z.string() });
export type ItemRef = z.infer<typeof ItemRefSchema>;

/** The plan's likelihood x impact grid, so a client can draw the matrix it scores against. */
export const RiskMatrixViewSchema = z.object({
  scale: z.number().int().positive(),
  /** Minimum score for each level above `low`. */
  thresholds: RiskThresholdsSchema,
});
export type RiskMatrixView = z.infer<typeof RiskMatrixViewSchema>;

/** One risk as something else's exposure names it: scored and levelled, without the prose. */
export const ScoredRiskViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: RiskStatusSchema,
  /** likelihood x impact. */
  score: z.number(),
  level: RiskLevelSchema,
});
export type ScoredRiskView = z.infer<typeof ScoredRiskViewSchema>;

/**
 * What the open risks affecting one item add up to. `level` is the highest of them, which is
 * what the policy's `riskAppetite` is compared against; `none` means no open risk names it.
 */
export const RiskExposureViewSchema = z.object({
  score: z.number(),
  level: z.union([RiskLevelSchema, z.literal("none")]),
  risks: z.array(ScoredRiskViewSchema),
});
export type RiskExposureView = z.infer<typeof RiskExposureViewSchema>;

/** A priority score and, more usefully, why it is that: the reasons render in the explain popover. */
export const ItemPriorityViewSchema = z.object({
  score: z.number(),
  /** One line each, already human-readable ("on the critical path", "mitigates token-leak (high)"). */
  reasons: z.array(z.string()),
});
export type ItemPriorityView = z.infer<typeof ItemPriorityViewSchema>;

// ------------------------------------------------------------------------- plans.list

/**
 * One plan as a row and as a header. `counts` is the schedule folded to seven numbers, so a
 * plan picker says "4 ready, 9 waiting" without a second call; it is the only reason this
 * read computes a schedule at all.
 */
export const PlanViewSchema = z.object({
  id: z.string(),
  /** Kebab-case, unique in the store, and what `orca plan --plan <key>` takes. */
  key: z.string(),
  /** The plan's name. `title` here to match every other view's naming. */
  title: z.string(),
  description: z.string(),
  status: PlanStatusSchema,
  /** Requests that contributed work items, oldest first. */
  requestIds: z.array(z.string()),
  /** How many items sit in each classification. Every item is in exactly one. */
  counts: z.record(ItemClassificationSchema, z.number().int().nonnegative()),
  riskMatrix: RiskMatrixViewSchema,
  policy: z.object({
    strategy: SchedulingStrategySchema,
    concurrency: z.number().int().positive(),
    /** Highest open-risk level an item may carry and still be dispatched. */
    riskAppetite: RiskLevelSchema,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlanView = z.infer<typeof PlanViewSchema>;

export const PlansListParamsSchema = z.object({});
export type PlansListParams = z.infer<typeof PlansListParamsSchema>;

export const PlansListResultSchema = z.object({
  /** Oldest first, by creation. */
  plans: z.array(PlanViewSchema),
  asOf: z.string(),
});
export type PlansListResult = z.infer<typeof PlansListResultSchema>;

export const PlanGetParamsSchema = z.object({ planId: z.string().min(1) });
export type PlanGetParams = z.infer<typeof PlanGetParamsSchema>;

/**
 * The plan and its counts - deliberately not the snapshot. Items, dependencies, risks,
 * decisions and the journal are five paged calls of their own, because a plan that has run
 * for a month would otherwise ship its whole history to draw a header.
 */
export const PlanGetResultSchema = z.object({
  plan: PlanViewSchema,
  asOf: z.string(),
});
export type PlanGetResult = z.infer<typeof PlanGetResultSchema>;

// ------------------------------------------------------------------------- items.list

/**
 * One row of the schedule table: the work item, where the scheduler put it, why it is in
 * that order, what it is exposed to, and which run is holding it.
 *
 * `classification`, `priority` and `risk` all come off one `computeSchedule` over the whole
 * plan, so they agree with `schedule.get` and with `schedule.explain` by construction.
 */
export const PlanItemViewSchema = WorkItemViewSchema.extend({
  /** The request this item was decomposed from; the table groups by it. */
  requestId: z.string(),
  kind: z.string(),
  priorityBand: WorkItemPrioritySchema,
  classification: ItemClassificationSchema,
  /** Present for every unsettled item; a settled one is not in the ordering. */
  priority: ItemPriorityViewSchema.optional(),
  risk: RiskExposureViewSchema,
  /** The run holding this item's claim, when one does. A claim outlives its run (#88). */
  claim: z.object({ runId: z.string() }).optional(),
  /** The run that most recently advanced the item, as the work item records it. */
  runId: z.string().optional(),
  /** Why the plan is not dispatching it, when the plan wrote one down. */
  deferredReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlanItemView = z.infer<typeof PlanItemViewSchema>;

export const ItemsListParamsSchema = z.object({
  planId: z.string().min(1),
  /** Keep only these work-item statuses. Empty or absent means all of them. */
  status: z.array(WorkItemStatusSchema).optional(),
  /** Keep only these schedule classifications. */
  classification: z.array(ItemClassificationSchema).optional(),
  requestId: z.string().min(1).optional(),
  /** Case-insensitive substring of the slug or the title - the table's text filter. */
  text: z.string().optional(),
  limit: z.number().int().positive().max(500).default(200),
  offset: z.number().int().nonnegative().default(0),
});
export type ItemsListParams = z.infer<typeof ItemsListParamsSchema>;

export const ItemsListResultSchema = z.object({
  /** In schedule order: ready first and best first, then running, waiting, held, unschedulable, settled. */
  items: z.array(PlanItemViewSchema),
  /** How many items match the filter, so a client can page without asking again. */
  total: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type ItemsListResult = z.infer<typeof ItemsListResultSchema>;

// ---------------------------------------------------------------------- schedule.get

const scheduledEntry = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ workItemId: z.string(), slug: z.string(), ...shape });

/**
 * The schedule as `compactSchedule` renders it, plus the work-item id on every entry.
 *
 * The compact form is slug-based because it goes into prompts and run vars, where a slug is
 * the name an agent uses. A screen needs to *link*, so the id travels beside it; `waves`,
 * `criticalPath`, `cycles`, `running`, `done` and `failed` stay slugs, since those are
 * orderings a person reads rather than rows to click.
 */
export const ScheduleViewSchema = z.object({
  planId: z.string(),
  computedAt: z.string(),
  strategy: SchedulingStrategySchema,
  /** Dispatchable now, best first. `reasons` is why it is in this position. */
  ready: z.array(scheduledEntry({ score: z.number(), reasons: z.array(z.string()) })),
  running: z.array(z.string()),
  /** `on` is one line per unmet dependency, in `core`'s own words. */
  waiting: z.array(scheduledEntry({ on: z.array(z.string()) })),
  /** Held above the plan's risk appetite; `level` is the exposure that holds it. */
  held: z.array(scheduledEntry({ level: z.union([RiskLevelSchema, z.literal("none")]), reason: z.string() })),
  /** Cannot run at all: a cycle, or a failed blocking dependency. */
  unschedulable: z.array(scheduledEntry({ reason: z.string() })),
  done: z.array(z.string()),
  failed: z.array(z.string()),
  /** Topological layers over every unsettled item: the plan view, not the dispatch order. */
  waves: z.array(z.array(z.string())),
  criticalPath: z.array(z.string()),
  /** In the plan's estimate units. **Not** a duration and not an ETA (#174). */
  criticalPathLength: z.number(),
  /** Cycles among `blocks` edges; every item in one is unschedulable. */
  cycles: z.array(z.array(z.string())),
  risk: z.object({
    open: z.number().int().nonnegative(),
    highestLevel: z.union([RiskLevelSchema, z.literal("none")]),
    byLevel: z.record(RiskLevelSchema, z.number().int().nonnegative()),
    top: z.array(z.object({ key: z.string(), level: RiskLevelSchema, score: z.number() })),
  }),
  openDecisions: z.array(z.object({ key: z.string(), title: z.string(), blocks: z.array(z.string()) })),
  asOf: z.string(),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

export const ScheduleGetParamsSchema = z.object({ planId: z.string().min(1) });
export type ScheduleGetParams = z.infer<typeof ScheduleGetParamsSchema>;

export const ScheduleGetResultSchema = z.object({ schedule: ScheduleViewSchema, asOf: z.string() });
export type ScheduleGetResult = z.infer<typeof ScheduleGetResultSchema>;

// ------------------------------------------------------------------ schedule.explain

export const ScheduleExplainParamsSchema = z.object({
  planId: z.string().min(1),
  /** The work item's id or its slug - `PlanService.requireItem` takes either. */
  workItemId: z.string().min(1),
});
export type ScheduleExplainParams = z.infer<typeof ScheduleExplainParamsSchema>;

/**
 * The lines `orca plan explain <slug>` prints, in the same order and word for word: the
 * item's position, what it waits on, why it is held, its priority reasons, the critical path
 * and the wave, then one line per dependency and one per risk that names it.
 *
 * They are strings and not a structure on purpose. The explanation is the scheduler's own
 * account of its decision; giving a client the parts to re-sentence would let the popover and
 * the terminal disagree about why an item is blocked, which is the one thing this method
 * exists to prevent.
 */
export const ScheduleExplainResultSchema = z.object({
  lines: z.array(z.string()),
  asOf: z.string(),
});
export type ScheduleExplainResult = z.infer<typeof ScheduleExplainResultSchema>;

// --------------------------------------------------------------- dependencies.list

/** What a dependency points at. The three kinds the plan knows, each resolved for display. */
export const DependencyTargetViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("work-item"),
    workItemId: z.string(),
    /** The upstream item's slug, when it is still in the plan. */
    slug: z.string().optional(),
    /** Set on a stage-level edge: satisfied as soon as the upstream produces this kind. */
    stage: z.string().optional(),
  }),
  z.object({ kind: z.literal("decision"), decisionId: z.string(), key: z.string().optional() }),
  z.object({ kind: z.literal("external"), key: z.string(), description: z.string().optional() }),
]);
export type DependencyTargetView = z.infer<typeof DependencyTargetViewSchema>;

/**
 * One dependency, with the scheduler's *live* evaluation beside the stored status.
 *
 * The two can differ, and that is the point: `status` is what was last written to the
 * document, `evaluation` is what `computeSchedule` decided against the plan as it stands
 * now. A dependency whose upstream finished a second ago is `open` and `satisfied`
 * respectively until `reconcile` catches up, and a screen should show the live one.
 */
export const DependencyViewSchema = z.object({
  id: z.string(),
  /** The dependent work item. */
  from: z.string(),
  fromSlug: z.string().optional(),
  target: DependencyTargetViewSchema,
  type: DependencyTypeSchema,
  /** The dependent's phase by which it must hold; `start` means before dispatch. */
  requiredBy: z.string(),
  status: DependencyStatusSchema,
  evaluation: z.object({
    state: z.enum(["satisfied", "waiting", "failed", "waived"]),
    /** One line a person can read: "waiting for auth-api to produce spec". */
    detail: z.string(),
  }),
  rationale: z.string().optional(),
  resolution: z.string().optional(),
  resolvedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DependencyView = z.infer<typeof DependencyViewSchema>;

export const DependenciesListParamsSchema = z.object({
  planId: z.string().min(1),
  /** Only the dependencies *of* this item (its `from` side). Id or slug. */
  workItemId: z.string().min(1).optional(),
  status: z.array(DependencyStatusSchema).optional(),
});
export type DependenciesListParams = z.infer<typeof DependenciesListParamsSchema>;

export const DependenciesListResultSchema = z.object({
  /** Oldest first. */
  dependencies: z.array(DependencyViewSchema),
  asOf: z.string(),
});
export type DependenciesListResult = z.infer<typeof DependenciesListResultSchema>;

// --------------------------------------------------------------------- risks.list

export const RiskViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  category: RiskCategorySchema,
  /** 1..`matrix.scale`. */
  likelihood: z.number().int().positive(),
  impact: z.number().int().positive(),
  /** likelihood x impact, and where that sits on the plan's matrix. */
  score: z.number(),
  level: RiskLevelSchema,
  status: RiskStatusSchema,
  /** True while the risk counts towards exposure (`open`, `mitigating`, `realized`). */
  open: z.boolean(),
  mitigation: z.string().optional(),
  contingency: z.string().optional(),
  owner: z.string().optional(),
  triggers: z.array(z.string()),
  /** Work items exposed to it. */
  affects: z.array(ItemRefSchema),
  /** Work items whose delivery reduces it. */
  mitigatedBy: z.array(ItemRefSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type RiskView = z.infer<typeof RiskViewSchema>;

export const RisksListParamsSchema = z.object({
  planId: z.string().min(1),
  status: z.array(RiskStatusSchema).optional(),
  /** Only risks that affect this item (id or slug). */
  workItemId: z.string().min(1).optional(),
});
export type RisksListParams = z.infer<typeof RisksListParamsSchema>;

export const RisksListResultSchema = z.object({
  /** Highest score first. */
  risks: z.array(RiskViewSchema),
  matrix: RiskMatrixViewSchema,
  /** The plan's `policy.riskAppetite`: exposure above it holds an item. */
  appetite: RiskLevelSchema,
  asOf: z.string(),
});
export type RisksListResult = z.infer<typeof RisksListResultSchema>;

// ----------------------------------------------------------------- decisions.list

export const DecisionViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  question: z.string(),
  context: z.string().optional(),
  status: DecisionStatusSchema,
  criteria: z.array(DecisionCriterionSchema),
  options: z.array(DecisionOptionSchema),
  /** Option scores run 0..`scale`. */
  scale: z.number().int(),
  /** The weighted matrix: ranking, recommendation, margin and the pivotal criteria. */
  result: DecisionMatrixResultSchema.optional(),
  /**
   * True when `result` was computed for this read rather than stored: the decision has never
   * been evaluated or decided, so the daemon ran the matrix to show what it would recommend.
   * Absent when `result` is the stored one, or when there is no result at all.
   */
  resultIsPreview: z.boolean().optional(),
  chosen: z.string().optional(),
  decidedBy: z.enum(["matrix", "agent", "human"]).optional(),
  rationale: z.string().optional(),
  consequences: z.array(z.string()),
  supersedes: z.string().optional(),
  /**
   * When the decision is wanted by, as the decomposition wrote it. It is an input somebody
   * stated, never a projection: ORCA computes no dates (#174).
   */
  dueBy: z.string().optional(),
  /**
   * The work items this decision gates - the `from` side of every `blocks` dependency
   * targeting it. `Decision` keeps no copy of this; the dependencies are the truth.
   */
  blocks: z.array(ItemRefSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedAt: z.string().optional(),
});
export type DecisionView = z.infer<typeof DecisionViewSchema>;

export const DecisionsListParamsSchema = z.object({
  planId: z.string().min(1),
  status: z.array(DecisionStatusSchema).optional(),
});
export type DecisionsListParams = z.infer<typeof DecisionsListParamsSchema>;

export const DecisionsListResultSchema = z.object({
  /** Oldest first. */
  decisions: z.array(DecisionViewSchema),
  asOf: z.string(),
});
export type DecisionsListResult = z.infer<typeof DecisionsListResultSchema>;

// ------------------------------------------------------------------- journal.list

/**
 * One plan journal entry. `payload` travels as the journal recorded it - the entry types are
 * `core`'s `PlanEvent` union and a client that wants a particular one narrows on `type` -
 * and `summary` is the same one-line rendering `orca plan journal` prints, so a timeline row
 * needs no second fold of a payload shape it would have to keep in step.
 */
export const PlanJournalEntryViewSchema = z.object({
  id: z.string(),
  /** Per-plan, monotonic, gap-free: the cursor this method pages by. */
  seq: z.number().int().nonnegative(),
  planId: z.string(),
  at: z.string(),
  type: z.string(),
  origin: PlanOriginSchema,
  payload: z.record(z.string(), z.unknown()),
  /** One line, slugs resolved. What the CLI prints in its last column. */
  summary: z.string(),
});
export type PlanJournalEntryView = z.infer<typeof PlanJournalEntryViewSchema>;

/**
 * One page of the plan journal, with `runs.events`'s cursor semantics: `after` walks forward
 * from a sequence number, `before` walks back to the `limit` entries immediately preceding
 * one, and either way the page reads oldest first. Giving both is an error - a page has one
 * anchor.
 */
export const JournalListParamsSchema = z
  .object({
    planId: z.string().min(1),
    /** Entries with `seq` greater than this, oldest first. */
    after: z.number().int().nonnegative().optional(),
    /** Entries with `seq` less than this: the `limit` immediately before it, still oldest first. */
    before: z.number().int().nonnegative().optional(),
    /** Only these entry types. An unknown type matches nothing rather than failing. */
    types: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(500).default(200),
  })
  .refine((p) => p.after === undefined || p.before === undefined, {
    message: "give either 'after' or 'before', not both",
  });
export type JournalListParams = z.infer<typeof JournalListParamsSchema>;

export const JournalListResultSchema = z.object({
  /** Oldest first, whichever direction the page was taken in. */
  entries: z.array(PlanJournalEntryViewSchema),
  /** Pass as `after` for the next page forward; absent when the page is empty. */
  nextCursor: z.number().int().nonnegative().optional(),
  /** Pass as `before` for the next page backward; absent when the page is empty. */
  prevCursor: z.number().int().nonnegative().optional(),
  /** Whether the journal continues past this page, in the direction it was taken. */
  hasMore: z.boolean(),
  /** The highest sequence number in the plan's journal, filter or no filter. */
  lastSeq: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type JournalListResult = z.infer<typeof JournalListResultSchema>;
