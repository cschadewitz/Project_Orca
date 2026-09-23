/**
 * Planning signals lifted from artifact front matter.
 *
 * Agents never call a planning API; they write artifacts (ADR 0002). A spec
 * that says `risks: [...]` or `dependencies: [billing-api@spec]`, a risk
 * register, or a decision matrix all carry structured front matter, and this
 * module normalises it so the PlanService can update the plan as the artifacts
 * are recorded. Unknown or malformed entries are reported, never thrown.
 */
import {
  DecisionInputSchema,
  DependencyRefSchema,
  RiskInputSchema,
  RiskRegisterSchema,
  SLUG_MAX_LENGTH,
  parseDependencyRef,
  type DecisionInput,
  type DependencyRef,
  type RiskInput,
} from "../model/plan.js";

export interface PlanSignals {
  risks: RiskInput[];
  decisions: DecisionInput[];
  dependencies: DependencyRef[];
  issues: string[];
}

export type SignalExtractor = (artifact: {
  kind: string;
  name: string;
  data: Record<string, unknown>;
}) => Partial<PlanSignals> | undefined;

/** Kebab-case key from free text, at most SLUG_MAX_LENGTH characters and never starting or ending in `-`. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, "") || "item"
  );
}

function riskFrom(raw: unknown, i: number, issues: string[]): RiskInput | undefined {
  const candidate: Record<string, unknown> | undefined =
    typeof raw === "string"
      ? { key: slugify(raw), title: raw }
      : raw && typeof raw === "object"
        ? { ...(raw as Record<string, unknown>) }
        : undefined;
  if (!candidate) return undefined;
  if (candidate.key === undefined && typeof candidate.title === "string") candidate.key = slugify(candidate.title);
  if (candidate.title === undefined && typeof candidate.key === "string") candidate.title = candidate.key;
  const parsed = RiskInputSchema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(`risks[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return undefined;
  }
  return parsed.data;
}

function decisionFrom(raw: unknown, i: number, issues: string[]): DecisionInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = { ...(raw as Record<string, unknown>) };
  if (candidate.key === undefined && typeof candidate.title === "string") candidate.key = slugify(candidate.title);
  const parsed = DecisionInputSchema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(`decisions[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return undefined;
  }
  return parsed.data;
}

/** Shape-check, then run the grammar, so the service never sees a ref `parseDependencyRef` would throw on. */
function dependencyFrom(raw: unknown, i: number, issues: string[]): DependencyRef | undefined {
  const parsed = DependencyRefSchema.safeParse(raw);
  if (!parsed.success) {
    const grammar = parsed.error.issues.find((issue) => issue.code === "custom");
    issues.push(`dependencies[${i}]: ${grammar?.message ?? "not a dependency reference"}`);
    return undefined;
  }
  try {
    parseDependencyRef(parsed.data);
  } catch (e) {
    issues.push(`dependencies[${i}]: ${(e as Error).message}`);
    return undefined;
  }
  return parsed.data;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Default extraction rules, by artifact kind. */
export const defaultSignalExtractor: SignalExtractor = (artifact) => {
  const issues: string[] = [];
  const data = artifact.data;
  const out: PlanSignals = { risks: [], decisions: [], dependencies: [], issues };
  if (artifact.kind === "risk-register") {
    const parsed = RiskRegisterSchema.safeParse(data);
    if (parsed.success) out.risks = parsed.data.risks;
    else
      issues.push(`risk-register: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return out;
  }
  if (artifact.kind === "decision-matrix") {
    const d = decisionFrom(data, 0, issues);
    if (d) out.decisions.push(d);
    return out;
  }
  // Any other artifact (decomposition, spec, intent, review ...) may carry planning fields.
  asList(data.risks).forEach((r, i) => {
    const risk = riskFrom(r, i, issues);
    if (risk) out.risks.push(risk);
  });
  asList(data.decisions).forEach((d, i) => {
    const dec = decisionFrom(d, i, issues);
    if (dec) out.decisions.push(dec);
  });
  asList(data.dependencies ?? data.discoveredDependencies).forEach((ref, i) => {
    const dep = dependencyFrom(ref, i, issues);
    if (dep) out.dependencies.push(dep);
  });
  return out;
};

export function extractPlanSignals(
  artifact: { kind: string; name: string; data: Record<string, unknown> },
  extractors: readonly SignalExtractor[] = [defaultSignalExtractor],
): PlanSignals {
  const merged: PlanSignals = { risks: [], decisions: [], dependencies: [], issues: [] };
  for (const extract of extractors) {
    const part = extract(artifact);
    if (!part) continue;
    merged.risks.push(...(part.risks ?? []));
    merged.decisions.push(...(part.decisions ?? []));
    merged.dependencies.push(...(part.dependencies ?? []));
    merged.issues.push(...(part.issues ?? []));
  }
  return merged;
}
