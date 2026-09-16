/**
 * Long-term planning model: the Plan, and the three things it tracks *between*
 * work items - Dependencies, Risks and Decisions.
 *
 * A Request is one ask; a Plan is the durable graph that several requests feed
 * over time. Work items from different requests can depend on each other, on a
 * decision that has not been made yet, or on something outside ORCA. The
 * scheduler (plan/schedule.ts) reads this graph to decide which item may be
 * handed to an agent next, in which order, and why.
 *
 * Everything here is data (zod schemas). Behaviour lives in `plan/*`.
 */
import { z } from "zod";

// ------------------------------------------------------------------ origins

/** Where a plan entity came from. Recorded on every entity and journal event. */
export const PlanOriginSchema = z.object({
  kind: z.enum(["decomposition", "artifact", "agent", "human", "api", "system"]),
  runId: z.string().optional(),
  artifactId: z.string().optional(),
  /** Free text: user name, agent id, CLI ... */
  actor: z.string().optional(),
});
export type PlanOrigin = z.infer<typeof PlanOriginSchema>;

// -------------------------------------------------------------------- risks

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * A likelihood x impact matrix. Scores are `likelihood * impact` on a 1..scale
 * grid; `thresholds` are the *minimum* score for each level above `low`.
 */
export const RiskMatrixConfigSchema = z.object({
  scale: z.number().int().min(2).max(10).default(5),
  thresholds: z
    .object({
      medium: z.number().positive().default(5),
      high: z.number().positive().default(10),
      critical: z.number().positive().default(16),
    })
    .default({ medium: 5, high: 10, critical: 16 }),
});
export type RiskMatrixConfig = z.infer<typeof RiskMatrixConfigSchema>;
export const DEFAULT_RISK_MATRIX: RiskMatrixConfig = RiskMatrixConfigSchema.parse({});

export const RiskCategorySchema = z.enum(["technical", "schedule", "security", "dependency", "operational", "product", "compliance", "other"]);
export type RiskCategory = z.infer<typeof RiskCategorySchema>;

/** open -> mitigating -> mitigated | accepted | realized -> closed. */
export const RiskStatusSchema = z.enum(["open", "mitigating", "mitigated", "accepted", "realized", "closed"]);
export type RiskStatus = z.infer<typeof RiskStatusSchema>;
export const OPEN_RISK_STATUSES: readonly RiskStatus[] = ["open", "mitigating", "realized"];

export const PlanKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "keys are kebab-case");

export const RiskSchema = z.object({
  id: z.string(),
  planId: z.string(),
  /** Stable key within the plan (e.g. "token-leak"); agents refer to risks by key. */
  key: PlanKeySchema,
  title: z.string().min(1),
  description: z.string().default(""),
  category: RiskCategorySchema.default("technical"),
  likelihood: z.number().int().min(1),
  impact: z.number().int().min(1),
  status: RiskStatusSchema.default("open"),
  mitigation: z.string().optional(),
  contingency: z.string().optional(),
  owner: z.string().optional(),
  /** Observable signals that the risk is materialising. */
  triggers: z.array(z.string()).default([]),
  /** Work items exposed to this risk. */
  affects: z.array(z.string()).default([]),
  /** Work items whose delivery reduces this risk (the scheduler can pull them forward). */
  mitigatedBy: z.array(z.string()).default([]),
  origin: PlanOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type Risk = z.infer<typeof RiskSchema>;

// ---------------------------------------------------------------- decisions

export const DecisionStatusSchema = z.enum(["open", "decided", "deferred", "superseded"]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionCriterionSchema = z.object({
  key: PlanKeySchema,
  name: z.string().min(1),
  /** Relative importance; any positive number, normalised at evaluation time. */
  weight: z.number().positive().default(1),
  /** `maximize`: higher scores are better (default). `minimize`: lower is better (cost, effort). */
  direction: z.enum(["maximize", "minimize"]).default("maximize"),
  description: z.string().optional(),
});
export type DecisionCriterion = z.infer<typeof DecisionCriterionSchema>;

export const DecisionOptionSchema = z.object({
  key: PlanKeySchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** criterion key -> score on the matrix scale (1..scale). */
  scores: z.record(z.string(), z.number()).default({}),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  /** Risk keys this option introduces or worsens. */
  risks: z.array(z.string()).default([]),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionRankingEntrySchema = z.object({
  option: z.string(),
  /** Weighted sum on the matrix scale. */
  score: z.number(),
  /** 0..1 share of the best possible score. */
  normalized: z.number(),
  byCriterion: z.record(z.string(), z.number()),
});
export type DecisionRankingEntry = z.infer<typeof DecisionRankingEntrySchema>;

export const DecisionMatrixResultSchema = z.object({
  ranking: z.array(DecisionRankingEntrySchema),
  recommended: z.string(),
  /** Normalised gap between the first and second option. */
  margin: z.number(),
  /** `clear` when margin >= 0.1, `close` when > 0, `tie` otherwise. */
  confidence: z.enum(["clear", "close", "tie"]),
  /** Criteria whose weight change would flip the recommendation (sensitivity hint). */
  pivotalCriteria: z.array(z.string()),
  evaluatedAt: z.string(),
});
export type DecisionMatrixResult = z.infer<typeof DecisionMatrixResultSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  key: PlanKeySchema,
  title: z.string().min(1),
  question: z.string().default(""),
  context: z.string().optional(),
  status: DecisionStatusSchema.default("open"),
  criteria: z.array(DecisionCriterionSchema).default([]),
  options: z.array(DecisionOptionSchema).default([]),
  /** Score scale used by options (1..scale). */
  scale: z.number().int().min(2).default(10),
  result: DecisionMatrixResultSchema.optional(),
  chosen: z.string().optional(),
  decidedBy: z.enum(["matrix", "agent", "human"]).optional(),
  rationale: z.string().optional(),
  /** Follow-ups the choice implies (new work, constraints). Informational. */
  consequences: z.array(z.string()).default([]),
  /** Work items that must not start before this decision is made (denormalised from dependencies). */
  blocks: z.array(z.string()).default([]),
  supersedes: z.string().optional(),
  dueBy: z.string().optional(),
  origin: PlanOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedAt: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ------------------------------------------------------------- dependencies

/**
 * What a work item waits for. `stage` on a work-item target makes the
 * dependency *stage-level*: satisfied as soon as the upstream item has produced
 * an artifact of that kind (e.g. its `spec`), which lets downstream design start
 * while upstream is still building.
 */
export const DependencyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work-item"), workItemId: z.string(), stage: z.string().optional() }),
  z.object({ kind: z.literal("decision"), decisionId: z.string() }),
  /** Something outside the plan (a vendor, another team, a slug not registered yet). */
  z.object({ kind: z.literal("external"), key: z.string(), description: z.string().optional() }),
]);
export type DependencyTarget = z.infer<typeof DependencyTargetSchema>;

/**
 * `blocks`: hard ordering, the dependent cannot start (or reach `requiredBy`).
 * `soft`: preferred ordering; scheduled after when possible, never blocks.
 * `informs`: no ordering, but the upstream artifacts are handed to the dependent's agents.
 */
export const DependencyTypeSchema = z.enum(["blocks", "soft", "informs"]);
export type DependencyType = z.infer<typeof DependencyTypeSchema>;

export const DependencyStatusSchema = z.enum(["open", "satisfied", "failed", "waived"]);
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

/** The dependent's phase by which the dependency must be satisfied. `start` = before dispatch. */
export const DEPENDENCY_START_PHASE = "start";

export const DependencySchema = z.object({
  id: z.string(),
  planId: z.string(),
  /** The dependent work item. */
  from: z.string(),
  target: DependencyTargetSchema,
  type: DependencyTypeSchema.default("blocks"),
  requiredBy: z.string().default(DEPENDENCY_START_PHASE),
  status: DependencyStatusSchema.default("open"),
  rationale: z.string().optional(),
  origin: PlanOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().optional(),
  /** Why it was satisfied / failed / waived. */
  resolution: z.string().optional(),
});
export type Dependency = z.infer<typeof DependencySchema>;

// ------------------------------------------------------------------- policy

export const SchedulingStrategySchema = z.enum(["critical-path", "risk-first", "most-dependents", "fifo"]);
export type SchedulingStrategy = z.infer<typeof SchedulingStrategySchema>;

/** Weights applied to the normalised priority factors of a work item. */
export const PriorityWeightsSchema = z.object({
  criticalPath: z.number().nonnegative().default(3),
  dependents: z.number().nonnegative().default(2),
  risk: z.number().nonnegative().default(2),
  mitigation: z.number().nonnegative().default(2),
  priority: z.number().nonnegative().default(1.5),
  age: z.number().nonnegative().default(0.5),
});
export type PriorityWeights = z.infer<typeof PriorityWeightsSchema>;

export const SchedulingPolicySchema = z.object({
  strategy: SchedulingStrategySchema.default("critical-path"),
  /** Overrides the strategy's preset weights. */
  weights: PriorityWeightsSchema.partial().optional(),
  concurrency: z.number().int().positive().default(2),
  /** Highest open-risk level an item may carry and still be dispatched without a human accepting the risk. */
  riskAppetite: RiskLevelSchema.default("high"),
  /** Hold items whose exposure exceeds the appetite (else only report). */
  holdAboveAppetite: z.boolean().default(true),
  /** Pull items that mitigate open high/critical risks forward. */
  mitigateFirst: z.boolean().default(true),
  /** Treat `soft` dependencies as ordering hints in wave layout. */
  orderSoftDependencies: z.boolean().default(true),
});
export type SchedulingPolicy = z.infer<typeof SchedulingPolicySchema>;
export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = SchedulingPolicySchema.parse({});

// --------------------------------------------------------------------- plan

export const PlanStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  key: PlanKeySchema,
  name: z.string().min(1),
  description: z.string().default(""),
  status: PlanStatusSchema.default("active"),
  /** Requests that contributed work items, oldest first. */
  requestIds: z.array(z.string()).default([]),
  riskMatrix: RiskMatrixConfigSchema.default(DEFAULT_RISK_MATRIX),
  policy: SchedulingPolicySchema.default(DEFAULT_SCHEDULING_POLICY),
  meta: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

// -------------------------------------------------- agent-facing input shapes

/**
 * Dependency reference as agents write it in front matter (decomposition
 * `dependsOn`, spec `dependencies`). String grammar:
 *
 *   slug                 blocks, satisfied when the item is done
 *   slug@spec            blocks, satisfied once the item produced a `spec`
 *   soft:slug            soft ordering
 *   informs:slug@spec    hand the upstream spec to this item's agents
 *   decision:key         wait for a decision
 *   external:key         wait for something outside ORCA (a human satisfies it)
 *   ...#build            (suffix) the dependency must hold before this item's `build` phase
 */
export const DependencyRefObjectSchema = z.object({
  on: z.string().min(1),
  type: DependencyTypeSchema.default("blocks"),
  stage: z.string().optional(),
  requiredBy: z.string().default(DEPENDENCY_START_PHASE),
  rationale: z.string().optional(),
});
export type DependencyRefObject = z.infer<typeof DependencyRefObjectSchema>;
export const DependencyRefSchema = z.union([z.string().min(1), DependencyRefObjectSchema]);
export type DependencyRef = z.infer<typeof DependencyRefSchema>;

/** Parsed, normalised form of a DependencyRef. */
export interface ParsedDependencyRef {
  targetKind: "work-item" | "decision" | "external";
  key: string;
  stage?: string;
  type: DependencyType;
  requiredBy: string;
  rationale?: string;
}

const REF_RE = /^(?:(soft|informs|blocks):)?(?:(decision|external):)?([^@#]+?)(?:@([^#]+))?(?:#(.+))?$/;

export function parseDependencyRef(ref: DependencyRef): ParsedDependencyRef {
  if (typeof ref !== "string") {
    const m = REF_RE.exec(ref.on.trim());
    const base = m ? { targetKind: (m[2] as "decision" | "external" | undefined) ?? "work-item", key: m[3]!.trim(), stage: m[4]?.trim() } : { targetKind: "work-item" as const, key: ref.on.trim(), stage: undefined };
    const stage = ref.stage ?? base.stage;
    return { ...base, type: ref.type, requiredBy: ref.requiredBy, ...(stage ? { stage } : {}), ...(ref.rationale ? { rationale: ref.rationale } : {}) } as ParsedDependencyRef;
  }
  const m = REF_RE.exec(ref.trim());
  if (!m) throw new Error(`invalid dependency reference '${ref}'`);
  const targetKind = (m[2] as "decision" | "external" | undefined) ?? "work-item";
  const out: ParsedDependencyRef = { targetKind, key: m[3]!.trim(), type: (m[1] as DependencyType | undefined) ?? "blocks", requiredBy: m[5]?.trim() || DEPENDENCY_START_PHASE };
  if (m[4]) out.stage = m[4].trim();
  return out;
}

/** Render a parsed ref back to the string grammar (for prompts and CLI output). */
export function formatDependencyRef(ref: ParsedDependencyRef): string {
  const type = ref.type === "blocks" ? "" : `${ref.type}:`;
  const kind = ref.targetKind === "work-item" ? "" : `${ref.targetKind}:`;
  const stage = ref.stage ? `@${ref.stage}` : "";
  const phase = ref.requiredBy && ref.requiredBy !== DEPENDENCY_START_PHASE ? `#${ref.requiredBy}` : "";
  return `${type}${kind}${ref.key}${stage}${phase}`;
}

/** A risk as agents write it (risk registers, spec front matter, decompositions). */
export const RiskInputSchema = z.object({
  key: PlanKeySchema,
  title: z.string().min(1),
  description: z.string().default(""),
  category: RiskCategorySchema.default("technical"),
  likelihood: z.number().int().min(1).default(3),
  impact: z.number().int().min(1).default(3),
  status: RiskStatusSchema.optional(),
  mitigation: z.string().optional(),
  contingency: z.string().optional(),
  owner: z.string().optional(),
  triggers: z.array(z.string()).default([]),
  /** Work item slugs. */
  affects: z.array(z.string()).default([]),
  mitigatedBy: z.array(z.string()).default([]),
});
export type RiskInput = z.infer<typeof RiskInputSchema>;
/** What callers may pass (defaults optional). */
export type RiskInputLike = z.input<typeof RiskInputSchema>;

/** A decision as agents open it (decomposition) or fill it in (decision-matrix artifact). */
export const DecisionInputSchema = z.object({
  key: PlanKeySchema,
  title: z.string().min(1),
  question: z.string().default(""),
  context: z.string().optional(),
  criteria: z.array(DecisionCriterionSchema).default([]),
  options: z.array(DecisionOptionSchema).default([]),
  scale: z.number().int().min(2).default(10),
  /** Option key the author picks (overrides the matrix recommendation when valid). */
  chosen: z.string().optional(),
  rationale: z.string().optional(),
  consequences: z.array(z.string()).default([]),
  /** Work item slugs that must wait for this decision. */
  blocks: z.array(z.string()).default([]),
  dueBy: z.string().optional(),
});
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type DecisionInputLike = z.input<typeof DecisionInputSchema>;

/** Front matter of a `risk-register` artifact. */
export const RiskRegisterSchema = z.object({ risks: z.array(RiskInputSchema).default([]), summary: z.string().optional() });
export type RiskRegister = z.infer<typeof RiskRegisterSchema>;

/** Front matter of a `decision-matrix` artifact (one decision per artifact). */
export const DecisionMatrixArtifactSchema = DecisionInputSchema;

/** Estimate sizes understood by the critical-path calculation. */
export const ESTIMATE_WEIGHTS: Record<string, number> = { XS: 0.5, S: 1, M: 2, L: 3, XL: 5 };
export function estimateWeight(estimate: string | undefined): number {
  if (!estimate) return 1;
  const n = Number(estimate);
  if (Number.isFinite(n) && n > 0) return n;
  return ESTIMATE_WEIGHTS[estimate.trim().toUpperCase()] ?? 1;
}

export const WorkItemPrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type WorkItemPriority = z.infer<typeof WorkItemPrioritySchema>;
export const PRIORITY_RANK: Record<WorkItemPriority, number> = { critical: 3, high: 2, normal: 1, low: 0 };
