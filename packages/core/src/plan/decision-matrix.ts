/**
 * Weighted decision matrix.
 *
 * An agent (or a human) fills in criteria with weights and options with a score
 * per criterion; ORCA does the arithmetic so the ranking is reproducible and
 * auditable rather than buried in prose. `minimize` criteria (cost, effort,
 * risk) are inverted on the scale before weighting. The result also says how
 * close the call was and which criteria are pivotal, so a gate can ask a human
 * only when the matrix is not decisive.
 */
import type { DecisionCriterion, DecisionMatrixResult, DecisionOption, DecisionRankingEntry } from "../model/plan.js";

export interface DecisionMatrixInput {
  criteria: readonly DecisionCriterion[];
  options: readonly DecisionOption[];
  scale: number;
}

export interface MatrixIssue {
  path: string;
  message: string;
}

export function validateDecisionMatrix(m: DecisionMatrixInput): MatrixIssue[] {
  const issues: MatrixIssue[] = [];
  if (m.criteria.length === 0) issues.push({ path: "criteria", message: "at least one criterion is required" });
  if (m.options.length === 0) issues.push({ path: "options", message: "at least one option is required" });
  const seenC = new Set<string>();
  m.criteria.forEach((c, i) => {
    if (seenC.has(c.key)) issues.push({ path: `criteria[${i}].key`, message: `duplicate criterion key '${c.key}'` });
    seenC.add(c.key);
    if (!(c.weight > 0)) issues.push({ path: `criteria[${i}].weight`, message: "weight must be positive" });
  });
  const seenO = new Set<string>();
  m.options.forEach((o, i) => {
    if (seenO.has(o.key)) issues.push({ path: `options[${i}].key`, message: `duplicate option key '${o.key}'` });
    seenO.add(o.key);
    for (const c of m.criteria) {
      const s = o.scores[c.key];
      if (s === undefined) issues.push({ path: `options[${i}].scores.${c.key}`, message: `option '${o.key}' has no score for criterion '${c.key}'` });
      else if (!Number.isFinite(s) || s < 0 || s > m.scale) issues.push({ path: `options[${i}].scores.${c.key}`, message: `score ${s} is outside 0..${m.scale}` });
    }
  });
  return issues;
}

function rank(m: DecisionMatrixInput, weights: Map<string, number>): DecisionRankingEntry[] {
  const total = [...weights.values()].reduce((s, w) => s + w, 0) || 1;
  const entries = m.options.map((o) => {
    const byCriterion: Record<string, number> = {};
    let score = 0;
    for (const c of m.criteria) {
      const raw = Math.min(m.scale, Math.max(0, o.scores[c.key] ?? 0));
      const effective = c.direction === "minimize" ? m.scale - raw : raw;
      const contribution = ((weights.get(c.key) ?? 0) / total) * effective;
      byCriterion[c.key] = round(contribution);
      score += contribution;
    }
    return { option: o.key, score: round(score), normalized: round(score / m.scale), byCriterion };
  });
  // Stable: ties keep the authoring order.
  return entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.score - a.e.score || a.i - b.i).map(({ e }) => e);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function evaluateDecisionMatrix(m: DecisionMatrixInput, now: string): DecisionMatrixResult {
  const issues = validateDecisionMatrix(m);
  if (issues.length) throw new Error(`invalid decision matrix: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const weights = new Map(m.criteria.map((c) => [c.key, c.weight]));
  const ranking = rank(m, weights);
  const top = ranking[0]!;
  const second = ranking[1];
  const margin = second ? round(top.normalized - second.normalized) : 1;
  const confidence = margin >= 0.1 ? "clear" : margin > 0 ? "close" : "tie";
  // Sensitivity: which single criterion, if dropped, would change the recommendation?
  const pivotalCriteria = m.criteria
    .filter((c) => {
      if (m.criteria.length < 2) return false;
      const w = new Map(weights);
      w.set(c.key, 0);
      return rank(m, w)[0]!.option !== top.option;
    })
    .map((c) => c.key);
  return { ranking, recommended: top.option, margin, confidence, pivotalCriteria, evaluatedAt: now };
}

/**
 * Markdown rendering of a matrix result, for schedule artifacts and CLI output.
 *
 * The result may have been computed from an earlier version of the matrix
 * (options renamed or removed since); a ranked option the matrix no longer
 * knows is rendered by its key with blank scores rather than crashing.
 */
export function renderDecisionMatrix(m: DecisionMatrixInput, result: DecisionMatrixResult): string {
  const header = `| option | ${m.criteria.map((c) => `${c.name} (w${c.weight}${c.direction === "minimize" ? ", min" : ""})`).join(" | ")} | score |`;
  const sep = `| --- | ${m.criteria.map(() => "---").join(" | ")} | --- |`;
  const rows = result.ranking.map((r) => {
    const o = m.options.find((x) => x.key === r.option);
    const name = o?.name ?? r.option;
    return `| ${r.option === result.recommended ? "**" + name + "**" : name} | ${m.criteria.map((c) => String(o?.scores[c.key] ?? "")).join(" | ")} | ${r.score} |`;
  });
  return [header, sep, ...rows, "", `Recommended: **${result.recommended}** (${result.confidence}, margin ${result.margin})${result.pivotalCriteria.length ? `; pivotal criteria: ${result.pivotalCriteria.join(", ")}` : ""}`].join("\n");
}
