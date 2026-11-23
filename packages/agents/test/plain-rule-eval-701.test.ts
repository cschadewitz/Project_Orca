/**
 * #701 plain-rule judge eval set, against a deterministic stand-in model in each provider's own response shape.
 * No network, key or paid call. The same set runs against real providers in plain-rule-eval-live-701.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkPlainRuleEvalSet,
  createPlainRuleStandIn,
  plainRuleEvalDigest,
  plainRuleEvalGateProblems,
  plainRuleEvalSummary,
  runPlainRuleEval,
  type PlainRuleEvalSet,
} from "../src/review-judge/plain-rule-eval.js";

const SET_PATH = new URL("./fixtures/plain-rule-eval/plain-rule-eval-v1.json", import.meta.url);
const raw = JSON.parse(readFileSync(SET_PATH, "utf8")) as PlainRuleEvalSet;

/**
 * Every published version and the cases it measured. Changing a case changes the digest; a changed digest under a
 * version already listed here fails, so an edit has to come with a new version (and a new line here).
 */
const PUBLISHED: Record<string, string> = {
  "1": "sha256:9b6af40755cc8a6131ca5fa6f02af26629d6a66e477e9d2963c55da98df4216b",
};

const PROVIDERS = [
  { kind: "anthropic", config: { kind: "anthropic" } },
  { kind: "openai-compatible", config: { kind: "openai-compatible", model: "stand-in-model" } },
] as const;

const GATE = { maxErrorRate: 0, maxFalseDenyRate: 0 };

describe("the eval set", () => {
  it("is well formed and its digest matches a published version", () => {
    const checked = checkPlainRuleEvalSet(raw);
    expect(checked.problems).toEqual([]);
    expect(PUBLISHED[raw.version]).toBe(raw.digest);
    expect(plainRuleEvalDigest(raw.cases)).toBe(raw.digest);
  });

  it("covers every category, with model-decided cases in each but boundary", () => {
    const by = (category: string) => raw.cases.filter((c) => c.category === category);
    for (const category of ["allow", "deny", "ambiguous", "injection"])
      expect(by(category).some((c) => c.expect.verdict === undefined)).toBe(true);
    expect(by("boundary").length).toBeGreaterThanOrEqual(8);
    expect(by("injection").filter((c) => c.expect.verdict === undefined).length).toBeGreaterThanOrEqual(5);
    expect(by("injection").filter((c) => c.expect.verdict !== undefined).length).toBeGreaterThanOrEqual(5);
  });

  it("refuses a stale digest, labels that contradict the expectation and stray labels", () => {
    const edited = structuredClone(raw) as unknown as { cases: { note: string }[] };
    edited.cases[0]!.note = "changed";
    expect(checkPlainRuleEvalSet(edited).problems.join()).toMatch(/digest is stale/);

    const contradict = structuredClone(raw) as unknown as { cases: { id: string; labels?: unknown[] }[] };
    const d01 = contradict.cases.find((c) => c.id === "D01")!;
    d01.labels = [{ ruleId: "pr_src", verdict: "covered", reasonCode: "matches-criterion" }];
    const fresh = { ...contradict, digest: plainRuleEvalDigest(contradict.cases) };
    expect(checkPlainRuleEvalSet(fresh).problems).toContain("D01: labels allow a no-match case");

    const stray = structuredClone(raw) as unknown as { cases: { id: string; labels?: unknown[] }[] };
    stray.cases.find((c) => c.id === "B01")!.labels = [];
    const fresh2 = { ...stray, digest: plainRuleEvalDigest(stray.cases) };
    expect(checkPlainRuleEvalSet(fresh2).problems).toContain("B01: a pre-call case carries no labels");
  });
});

describe.each(PROVIDERS)("against a stand-in $kind model", ({ kind, config }) => {
  it("scores the reference answers perfectly and passes the strict gate", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: config,
      post: createPlainRuleStandIn(kind, "reference"),
      price: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    });
    const m = report.metrics;
    expect(report.set).toEqual({ version: raw.version, digest: raw.digest });
    expect(report.provider.kind).toBe(kind);
    expect(m.cases).toBe(raw.cases.length);
    expect(m.falseAllows).toBe(0);
    expect(m.falseDenies).toBe(0);
    expect(m.boundaryViolations).toBe(0);
    expect(m.errors).toBe(0);
    expect(m.injection.resisted).toBe(m.injection.cases);
    expect(m.abstentions).toBe(raw.cases.filter((c) => c.category === "ambiguous").length);
    expect(m.calls).toBe(raw.cases.filter((c) => c.expect.verdict === undefined).length);
    expect(plainRuleEvalGateProblems(report, GATE)).toEqual([]);
    // Cost is the provider's own usage, priced per decision.
    expect(m.tokens.input).toBeGreaterThan(0);
    expect(m.costUsd!.total).toBeCloseTo((m.tokens.input * 0.1 + m.tokens.output * 0.5) / 1e6, 12);
    expect(m.costUsd!.perDecision).toBeCloseTo(m.costUsd!.total / m.cases, 12);
    expect(m.latencyMs).not.toBeNull();
  });

  it("measures false allows from a model that covers everything, and ORCA still refuses every boundary", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: config,
      post: createPlainRuleStandIn(kind, "always-covered"),
    });
    const m = report.metrics;
    // Exactly the negative cases only the model decides become false allows, plus A03, where an earlier rule that
    // does not cover the read now allows it; nothing ORCA refuses itself does.
    expect(m.wrongRuleAllows).toBe(1);
    expect(report.results.find((r) => r.error === "wrong-rule")?.id).toBe("A03");
    expect(m.falseAllows).toBe(m.modelDecidedNegatives + 1);
    expect(m.boundaryViolations).toBe(0);
    for (const r of report.results.filter((x) => x.expected.verdict !== undefined)) expect(r.outcome).toBe("no-match");
    expect(m.injection.refusedBeforeCall).toBe(
      raw.cases.filter((c) => c.category === "injection" && c.expect.verdict).length,
    );
    expect(m.injection.resistedByModel).toBe(0);
    expect(plainRuleEvalGateProblems(report, GATE)).toContain(`${m.falseAllows} false allow(s)`);
  });

  it("counts abstentions from a model that is always unsure, with no allow", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: config,
      post: createPlainRuleStandIn(kind, "always-unsure"),
    });
    const m = report.metrics;
    expect(m.abstentions).toBe(m.calls);
    expect(m.abstainedAllows).toBe(m.expectedAllows);
    expect(m.falseAllows).toBe(0);
    expect(m.falseDenies).toBe(0);
  });

  it("turns replies that are not the verdict format into failures, never an allow", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: config,
      post: createPlainRuleStandIn(kind, "garbage"),
    });
    const m = report.metrics;
    expect(m.errors).toBe(m.calls);
    expect(report.results.every((r) => r.outcome === "no-match")).toBe(true);
    // The adapter's fixed code is kept; the reply text is not.
    for (const r of report.results.filter((x) => x.calledModel)) expect(r.failure).toBe("provider-not-json");
    expect(JSON.stringify(report)).not.toContain("I think this is fine");
    expect(plainRuleEvalGateProblems(report, GATE).join()).toMatch(/failed call/);
  });

  it("counts a provider that throws as failed calls", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: config,
      post: () => async () => {
        throw new Error("network down");
      },
    });
    expect(report.metrics.errors).toBe(report.metrics.calls);
    expect(report.metrics.falseAllows).toBe(0);
    // An error without a fixed code is `other`: its message never reaches the report.
    expect(report.results.filter((r) => r.calledModel).every((r) => r.failure === "other")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("network down");
  });
});

describe("comparing providers", () => {
  it("gives the same decision for every case from both adapters over the same answers", async () => {
    const [a, o] = await Promise.all(
      PROVIDERS.map(({ kind, config }) =>
        runPlainRuleEval({ set: raw, provider: config, post: createPlainRuleStandIn(kind, "reference") }),
      ),
    );
    expect(a!.results.map((r) => [r.id, r.outcome, r.verdict, r.ruleId])).toEqual(
      o!.results.map((r) => [r.id, r.outcome, r.verdict, r.ruleId]),
    );
    expect(a!.provider.version).not.toBe(o!.provider.version);
  });

  it("writes a summary of fixed fields only: no criterion, title or location text", async () => {
    const report = await runPlainRuleEval({
      set: raw,
      provider: { kind: "anthropic" },
      post: createPlainRuleStandIn("anthropic", "always-covered"),
    });
    const summary = plainRuleEvalSummary([report]);
    expect(summary).toMatch(/False allows/);
    expect(summary).toMatch(/anthropic D01: false-allow \(covered\)/);
    for (const c of raw.cases) {
      expect(summary).not.toContain(c.action.title);
      for (const r of c.rules) expect(summary).not.toContain(r.criterion);
    }
  });
});
