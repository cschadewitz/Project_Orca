/**
 * Risk matrix arithmetic. A risk's score is likelihood x impact; the plan's
 * RiskMatrixConfig maps scores to levels. Exposure of a work item is derived
 * from the *open* risks that affect it, and is what the scheduler compares
 * against the policy's risk appetite.
 */
import { OPEN_RISK_STATUSES, RISK_LEVELS, type Risk, type RiskLevel, type RiskMatrixConfig } from "../model/plan.js";

export function riskScore(r: { likelihood: number; impact: number }): number {
  return r.likelihood * r.impact;
}

/** The rating a risk gets when the author gives none: the midpoint of the grid (3 on 1..5). */
export function defaultRiskRating(matrix: Pick<RiskMatrixConfig, "scale">): number {
  return Math.ceil(matrix.scale / 2);
}

/** Why a likelihood / impact pair does not fit the matrix, or undefined when it does. */
export function riskRatingIssue(
  r: { likelihood: number; impact: number },
  matrix: Pick<RiskMatrixConfig, "scale">,
): string | undefined {
  const off = (["likelihood", "impact"] as const).filter(
    (k) => !Number.isInteger(r[k]) || r[k] < 1 || r[k] > matrix.scale,
  );
  if (!off.length) return undefined;
  return `${off.map((k) => `${k}=${r[k]}`).join(", ")} outside the plan's risk matrix (1..${matrix.scale})`;
}

/** One line describing the matrix, for CLI output and explanations. */
export function describeRiskMatrix(matrix: RiskMatrixConfig): string {
  const t = matrix.thresholds;
  return `${matrix.scale}x${matrix.scale} (medium >= ${t.medium}, high >= ${t.high}, critical >= ${t.critical})`;
}

export function riskLevel(score: number, matrix: RiskMatrixConfig): RiskLevel {
  const t = matrix.thresholds;
  if (score >= t.critical) return "critical";
  if (score >= t.high) return "high";
  if (score >= t.medium) return "medium";
  return "low";
}

export function levelRank(level: RiskLevel | "none"): number {
  return level === "none" ? -1 : RISK_LEVELS.indexOf(level);
}

export function levelAtLeast(level: RiskLevel | "none", min: RiskLevel): boolean {
  return levelRank(level) >= levelRank(min);
}

export function maxLevel(levels: Iterable<RiskLevel>): RiskLevel | "none" {
  let best: RiskLevel | "none" = "none";
  for (const l of levels) if (levelRank(l) > levelRank(best)) best = l;
  return best;
}

export function isOpenRisk(r: Pick<Risk, "status">): boolean {
  return OPEN_RISK_STATUSES.includes(r.status);
}

export interface ScoredRisk {
  id: string;
  key: string;
  title: string;
  status: Risk["status"];
  score: number;
  level: RiskLevel;
}

export function scoreRisk(r: Risk, matrix: RiskMatrixConfig): ScoredRisk {
  const score = riskScore(r);
  return { id: r.id, key: r.key, title: r.title, status: r.status, score, level: riskLevel(score, matrix) };
}

export interface RiskExposure {
  /** Sum of the open risk scores affecting the item. */
  score: number;
  /** Highest open risk level affecting the item. */
  level: RiskLevel | "none";
  risks: ScoredRisk[];
}

/** Open risks that list the work item in `affects`. */
export function itemRiskExposure(workItemId: string, risks: readonly Risk[], matrix: RiskMatrixConfig): RiskExposure {
  const own = risks.filter((r) => isOpenRisk(r) && r.affects.includes(workItemId)).map((r) => scoreRisk(r, matrix));
  return { score: own.reduce((s, r) => s + r.score, 0), level: maxLevel(own.map((r) => r.level)), risks: own };
}

/** Open risks that list the work item in `mitigatedBy` (delivering the item reduces them). */
export function risksMitigatedBy(workItemId: string, risks: readonly Risk[], matrix: RiskMatrixConfig): ScoredRisk[] {
  return risks.filter((r) => isOpenRisk(r) && r.mitigatedBy.includes(workItemId)).map((r) => scoreRisk(r, matrix));
}

export interface RiskSummary {
  total: number;
  open: number;
  byLevel: Record<RiskLevel, number>;
  /** Highest level among open risks. */
  highestLevel: RiskLevel | "none";
  /** Open risks, highest score first (capped at `top`). */
  top: ScoredRisk[];
  realized: string[];
}

export function summarizeRisks(risks: readonly Risk[], matrix: RiskMatrixConfig, top = 5): RiskSummary {
  const open = risks
    .filter(isOpenRisk)
    .map((r) => scoreRisk(r, matrix))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const byLevel: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of open) byLevel[r.level]++;
  return {
    total: risks.length,
    open: open.length,
    byLevel,
    highestLevel: maxLevel(open.map((r) => r.level)),
    top: open.slice(0, top),
    realized: risks.filter((r) => r.status === "realized").map((r) => r.key),
  };
}
