/** Pure planning algorithms: dependency refs, risk matrix, graph, decision matrix, scheduler, signals, Mermaid. */
import { describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  compactSchedule,
  computeSchedule,
  criticalPath,
  decisionBlocks,
  defaultRiskRating,
  defaultRiskThresholds,
  describeRiskMatrix,
  dropCycleClosingEdges,
  DEFAULT_RISK_MATRIX,
  DependencyRefSchema,
  DecompositionSchema,
  evaluateDecisionMatrix,
  explainWorkItem,
  extractPlanSignals,
  findCycles,
  formatDependencyRef,
  itemRiskExposure,
  longestDownstreamPaths,
  parseDependencyRef,
  PlanKeySchema,
  PlanSchema,
  planToMermaid,
  renderDecisionMatrix,
  RiskMatrixConfigSchema,
  riskLevel,
  riskRatingIssue,
  SLUG_MAX_LENGTH,
  slugify,
  summarizeRisks,
  topologicalWaves,
  transitiveDownstream,
  validateDecisionMatrix,
  WorkItemSchema,
  type Decision,
  type Dependency,
  type Risk,
  type WorkItem,
} from "@orca/core";

const T = "2026-01-01T00:00:00.000Z";
const plan = PlanSchema.parse({ id: "plan_1", key: "p", name: "P", createdAt: T, updatedAt: T });
const origin = { kind: "system" as const };

describe("dependency input boundary", () => {
  it("keeps legacy work items readable when their raw references were previously accepted", () => {
    expect(WorkItemSchema.parse(item("legacy", { dependsOn: ["@spec"] })).dependsOn).toEqual(["@spec"]);
  });
  it.each(["@spec", "decision:", "a@b@c", { on: "soft:x", type: "blocks" }])(
    "rejects malformed %j with a decomposition path",
    (ref) => {
      expect(DependencyRefSchema.safeParse(ref).success).toBe(false);
      const parsed = DecompositionSchema.safeParse({ items: [{ slug: "api", title: "API", dependsOn: [ref] }] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["items", 0, "dependsOn", 0]);
    },
  );
});

function item(slug: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `wi_${slug}`,
    requestId: "req_1",
    planId: plan.id,
    slug,
    title: slug,
    description: "",
    kind: "task",
    acceptanceCriteria: [],
    dependsOn: [],
    priority: "normal",
    produced: {},
    status: "pending",
    createdAt: T,
    updatedAt: T,
    ...extra,
  };
}
function dep(from: string, to: string, extra: Partial<Dependency> & { stage?: string } = {}): Dependency {
  const { stage, ...rest } = extra;
  return {
    id: `dep_${from}_${to}${stage ? "@" + stage : ""}`,
    planId: plan.id,
    from: `wi_${from}`,
    target: { kind: "work-item", workItemId: `wi_${to}`, ...(stage ? { stage } : {}) },
    type: "blocks",
    requiredBy: "start",
    status: "open",
    origin,
    createdAt: T,
    updatedAt: T,
    ...rest,
  };
}
function risk(key: string, likelihood: number, impact: number, affects: string[], extra: Partial<Risk> = {}): Risk {
  return {
    id: `risk_${key}`,
    planId: plan.id,
    key,
    title: key,
    description: "",
    category: "technical",
    likelihood,
    impact,
    status: "open",
    triggers: [],
    affects: affects.map((s) => `wi_${s}`),
    mitigatedBy: [],
    origin,
    createdAt: T,
    updatedAt: T,
    ...extra,
  };
}
function decision(key: string, extra: Partial<Decision> = {}): Decision {
  return {
    id: `dec_${key}`,
    planId: plan.id,
    key,
    title: key,
    question: "",
    status: "open",
    criteria: [],
    options: [],
    scale: 10,
    consequences: [],
    origin,
    createdAt: T,
    updatedAt: T,
    ...extra,
  };
}

describe("dependency references", () => {
  it("parses the string grammar", () => {
    expect(parseDependencyRef("auth-api")).toEqual({
      targetKind: "work-item",
      key: "auth-api",
      type: "blocks",
      requiredBy: "start",
    });
    expect(parseDependencyRef("auth-api@spec")).toMatchObject({
      targetKind: "work-item",
      key: "auth-api",
      stage: "spec",
    });
    expect(parseDependencyRef("soft:auth-api")).toMatchObject({ type: "soft" });
    expect(parseDependencyRef("informs:auth-api@spec#build")).toMatchObject({
      type: "informs",
      stage: "spec",
      requiredBy: "build",
    });
    expect(parseDependencyRef("decision:storage")).toMatchObject({ targetKind: "decision", key: "storage" });
    expect(parseDependencyRef("external:vendor-contract#deploy")).toMatchObject({
      targetKind: "external",
      key: "vendor-contract",
      requiredBy: "deploy",
    });
    expect(
      parseDependencyRef({ on: "auth-api", type: "soft", stage: "spec", requiredBy: "build", rationale: "r" }),
    ).toMatchObject({ key: "auth-api", type: "soft", stage: "spec", requiredBy: "build", rationale: "r" });
  });
  it("object form honours the prefixes and suffixes written in `on`", () => {
    expect(parseDependencyRef({ on: "soft:auth-api@spec#build" })).toEqual(
      parseDependencyRef("soft:auth-api@spec#build"),
    );
    expect(parseDependencyRef({ on: "decision:storage" })).toMatchObject({
      targetKind: "decision",
      key: "storage",
      type: "blocks",
      requiredBy: "start",
    });
    // Object fields fill in what `on` leaves out, and may restate it.
    expect(parseDependencyRef({ on: "auth-api@spec", requiredBy: "build" })).toMatchObject({
      stage: "spec",
      requiredBy: "build",
      type: "blocks",
    });
    expect(parseDependencyRef({ on: "soft:auth-api", type: "soft" })).toMatchObject({ type: "soft" });
  });
  it("rejects an object whose fields disagree with `on`", () => {
    expect(() => parseDependencyRef({ on: "soft:auth-api", type: "blocks" })).toThrow(
      /type 'soft' conflicts with type 'blocks'/,
    );
    expect(() => parseDependencyRef({ on: "auth-api@spec", stage: "build" })).toThrow(
      /stage 'spec' conflicts with stage 'build'/,
    );
    expect(() => parseDependencyRef({ on: "auth-api#build", requiredBy: "deploy" })).toThrow(
      /requiredBy 'build' conflicts with requiredBy 'deploy'/,
    );
  });
  it("rejects references the grammar does not cover, in both forms", () => {
    for (const bad of [
      "@spec",
      "#build",
      "decision:",
      "soft:",
      "external:",
      "foo:bar",
      "auth@",
      "auth#",
      "auth@spec@x",
      "  ",
      "auth@ #build",
    ]) {
      expect(() => parseDependencyRef(bad), bad).toThrow(/invalid dependency reference/);
      expect(() => parseDependencyRef({ on: bad }), bad).toThrow(/invalid dependency reference/);
    }
  });
  it("round-trips through formatDependencyRef", () => {
    for (const s of [
      "auth-api",
      "auth-api@spec",
      "soft:auth-api",
      "informs:auth-api@spec#build",
      "decision:storage",
      "external:x",
    ])
      expect(formatDependencyRef(parseDependencyRef(s))).toBe(s);
  });
  it("object form: a fully specified ref parses exactly, `on` is trimmed, and the result round-trips through formatDependencyRef", () => {
    expect(parseDependencyRef({ on: "decision:store", type: "blocks", requiredBy: "start" })).toEqual({
      targetKind: "decision",
      key: "store",
      type: "blocks",
      requiredBy: "start",
    });
    expect(parseDependencyRef({ on: "external:vendor", type: "soft", requiredBy: "deploy" })).toEqual({
      targetKind: "external",
      key: "vendor",
      type: "soft",
      requiredBy: "deploy",
    });
    expect(parseDependencyRef({ on: "auth-api@spec", type: "blocks", requiredBy: "build" })).toEqual({
      targetKind: "work-item",
      key: "auth-api",
      stage: "spec",
      type: "blocks",
      requiredBy: "build",
    });
    expect(parseDependencyRef({ on: "  auth-api  ", type: "blocks", requiredBy: "start" }).key).toBe("auth-api");
    expect(formatDependencyRef(parseDependencyRef({ on: "decision:store", type: "blocks", requiredBy: "build" }))).toBe(
      "decision:store#build",
    );
    expect(
      formatDependencyRef(
        parseDependencyRef({ on: "auth-api", type: "soft", stage: "spec", requiredBy: "build", rationale: "r" }),
      ),
    ).toBe("soft:auth-api@spec#build");
  });
  it("rejects a string whose key, stage or phase is empty", () => {
    for (const bad of ["@spec", "#build", "auth-api@", "auth-api#", "auth-api@spec#", "   "])
      expect(() => parseDependencyRef(bad), bad).toThrow(`invalid dependency reference '${bad}'`);
    expect(parseDependencyRef("  auth-api@spec  ")).toMatchObject({ key: "auth-api", stage: "spec" });
  });
});

describe("risk matrix", () => {
  it("maps scores to levels with the default thresholds", () => {
    expect(riskLevel(1, DEFAULT_RISK_MATRIX)).toBe("low");
    expect(riskLevel(5, DEFAULT_RISK_MATRIX)).toBe("medium");
    expect(riskLevel(12, DEFAULT_RISK_MATRIX)).toBe("high");
    expect(riskLevel(20, DEFAULT_RISK_MATRIX)).toBe("critical");
    expect(DEFAULT_RISK_MATRIX).toEqual({ scale: 5, thresholds: { medium: 5, high: 10, critical: 16 } });
  });
  it("derives thresholds from the scale, so every level stays reachable on any grid", () => {
    expect(RiskMatrixConfigSchema.parse({ scale: 3 })).toEqual({
      scale: 3,
      thresholds: { medium: 2, high: 4, critical: 6 },
    });
    expect(riskLevel(9, RiskMatrixConfigSchema.parse({ scale: 3 }))).toBe("critical");
    for (let scale = 2; scale <= 10; scale++) {
      const t = defaultRiskThresholds(scale);
      expect(t.medium, `scale ${scale}`).toBeLessThan(t.high);
      expect(t.high, `scale ${scale}`).toBeLessThan(t.critical);
      expect(t.critical, `scale ${scale}`).toBeLessThanOrEqual(scale * scale);
      expect(riskLevel(scale * scale, RiskMatrixConfigSchema.parse({ scale }))).toBe("critical");
      expect(defaultRiskRating({ scale })).toBe(Math.ceil(scale / 2));
    }
    // Thresholds given explicitly win; the rest still follow the scale.
    expect(RiskMatrixConfigSchema.parse({ scale: 4, thresholds: { critical: 12 } })).toEqual({
      scale: 4,
      thresholds: { medium: 4, high: 7, critical: 12 },
    });
    expect(describeRiskMatrix(RiskMatrixConfigSchema.parse({ scale: 4 }))).toBe(
      "4x4 (medium >= 4, high >= 7, critical >= 11)",
    );
  });
  it("rejects thresholds that are out of order or unreachable on the grid", () => {
    const unordered = RiskMatrixConfigSchema.safeParse({ thresholds: { medium: 10, high: 5 } });
    expect(unordered.success).toBe(false);
    expect(unordered.error!.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/strictly increasing.*medium=10, high=5, critical=16/),
    ]);
    const unreachable = RiskMatrixConfigSchema.safeParse({
      scale: 3,
      thresholds: { medium: 5, high: 10, critical: 16 },
    });
    expect(unreachable.success).toBe(false);
    expect(unreachable.error!.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/critical=16 is unreachable on a 3x3 grid \(maximum score 9\)/),
    ]);
    expect(RiskMatrixConfigSchema.safeParse({ scale: 11 }).success).toBe(false);
  });
  it("tells a rating that does not fit the matrix", () => {
    const m = RiskMatrixConfigSchema.parse({ scale: 3 });
    expect(riskRatingIssue({ likelihood: 3, impact: 1 }, m)).toBeUndefined();
    expect(riskRatingIssue({ likelihood: 4, impact: 0 }, m)).toBe(
      "likelihood=4, impact=0 outside the plan's risk matrix (1..3)",
    );
  });
  it("computes exposure from open risks only and summarises", () => {
    const risks = [risk("a", 5, 5, ["x"]), risk("b", 2, 2, ["x", "y"]), risk("c", 4, 4, ["y"], { status: "accepted" })];
    expect(itemRiskExposure("wi_x", risks, DEFAULT_RISK_MATRIX)).toMatchObject({ score: 29, level: "critical" });
    expect(itemRiskExposure("wi_y", risks, DEFAULT_RISK_MATRIX)).toMatchObject({ score: 4, level: "low" });
    const s = summarizeRisks(risks, DEFAULT_RISK_MATRIX);
    expect(s).toMatchObject({
      total: 3,
      open: 2,
      highestLevel: "critical",
      byLevel: { low: 1, medium: 0, high: 0, critical: 1 },
    });
    expect(s.top[0]!.key).toBe("a");
  });
});

describe("dependency graph", () => {
  const items = ["a", "b", "c", "d", "e"].map((s) => item(s, { estimate: s === "b" ? "L" : "S" }));
  const deps = [dep("b", "a"), dep("c", "b"), dep("d", "a"), dep("e", "d", { type: "soft" })];
  it("layers into waves and finds dependents", () => {
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      deps,
    );
    expect(topologicalWaves(g).waves).toEqual([["wi_a"], ["wi_b", "wi_d"], ["wi_c", "wi_e"]]);
    expect([...transitiveDownstream(g, "wi_a")].sort()).toEqual(["wi_b", "wi_c", "wi_d", "wi_e"]);
    expect(findCycles(g)).toEqual([]);
  });
  it("computes the critical path from estimates", () => {
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      deps,
    );
    const paths = longestDownstreamPaths(g, (id) => (id === "wi_b" ? 3 : 1));
    expect(criticalPath(paths)).toEqual({ length: 5, path: ["wi_a", "wi_b", "wi_c"] });
    // A node with no dependents is a chain of one, so a lone heavy item can be the critical path.
    expect(paths.get("wi_c")).toEqual({ length: 1, path: ["wi_c"] });
  });
  it("charges an overlapping edge only part of the upstream weight", () => {
    // c waits for b's spec: c can start partway through b, so the chain is not a + b + c.
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      [dep("b", "a"), dep("c", "b", { stage: "spec" })],
    );
    const weight = (id: string) => ({ wi_a: 1, wi_b: 4, wi_c: 3 })[id] ?? 1;
    const lag = (e: { stage?: string }) => (e.stage ? 0.5 : 1);
    expect(criticalPath(longestDownstreamPaths(g, weight, lag))).toEqual({ length: 6, path: ["wi_a", "wi_b", "wi_c"] }); // 1 + 0.5*4 + 3
    expect(criticalPath(longestDownstreamPaths(g, weight))).toEqual({ length: 8, path: ["wi_a", "wi_b", "wi_c"] });
    // When the overlapped chain is lighter than the node itself, the node stands alone (c finishes before b does).
    expect(longestDownstreamPaths(g, weight, () => 0).get("wi_b")).toEqual({ length: 4, path: ["wi_b"] });
  });
  it("overlaps the dependent's early phases with a later-phase edge", () => {
    // c needs b only by its build phase: c starts alongside b, and only the part of c from build on waits.
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      [dep("b", "a"), dep("c", "b", { requiredBy: "build" })],
    );
    expect(g.edges.map((e) => e.requiredBy)).toEqual([undefined, "build"]);
    const weight = (id: string) => ({ wi_a: 1, wi_b: 4, wi_c: 2 })[id] ?? 1;
    const lead = (e: { requiredBy?: string }) => (e.requiredBy ? 0.5 : 0);
    // a + max(c, b + the second half of c) = 1 + (4 + 1).
    expect(criticalPath(longestDownstreamPaths(g, weight, undefined, lead))).toEqual({
      length: 6,
      path: ["wi_a", "wi_b", "wi_c"],
    });
    expect(criticalPath(longestDownstreamPaths(g, weight))).toEqual({ length: 7, path: ["wi_a", "wi_b", "wi_c"] });
    // A lead longer than the wait hides the upstream entirely: the chain costs no more than c alone.
    const short = (id: string) => (id === "wi_b" ? 0.5 : weight(id));
    expect(longestDownstreamPaths(g, short, undefined, lead).get("wi_b")).toEqual({
      length: 2,
      path: ["wi_b", "wi_c"],
    });
    // Lag and lead combine: c needs b's spec (half of b) by a phase a quarter into c.
    const long = (id: string) => (id === "wi_c" ? 6 : weight(id));
    expect(
      longestDownstreamPaths(
        g,
        long,
        () => 0.5,
        () => 0.25,
      ).get("wi_b"),
    ).toEqual({
      length: 6.5, // 6 + (0.5 * 4 - 0.25 * 6), not b + c
      path: ["wi_b", "wi_c"],
    });
  });
  it("holds a later-phase dependent until its upstream starts, so the upstream's predecessors delay it in full", () => {
    // b waits for all of a; c needs b only by its build phase, halfway in. b runs 10..11, and the
    // scheduler does not dispatch c before b is underway, so c runs 10..20 (its build half from 15 on
    // is past b's finish). Starting c at 6 to meet b's finish at its halfway point would occupy a slot
    // with an item the dispatch rule still holds.
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      [dep("b", "a"), dep("c", "b", { requiredBy: "build" })],
    );
    const weight = (id: string) => ({ wi_a: 10, wi_b: 1, wi_c: 10 })[id] ?? 1;
    const lead = (e: { requiredBy?: string }) => (e.requiredBy ? 0.5 : 0);
    expect(criticalPath(longestDownstreamPaths(g, weight, undefined, lead))).toEqual({
      length: 20,
      path: ["wi_a", "wi_b", "wi_c"],
    });
  });
  it("drops the soft edges that close a cycle, keeping the required ones", () => {
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      [...deps, dep("a", "e", { type: "soft" })],
    );
    expect(findCycles(g)).toEqual([["wi_a", "wi_e", "wi_d"]]); // edge order: a waits for e waits for d waits for a
    const relaxed = dropCycleClosingEdges(g, ["soft"]);
    expect(relaxed.dropped.map((e) => e.dependencyId)).toEqual(["dep_a_e"]);
    expect(findCycles(relaxed.graph)).toEqual([]);
    expect(topologicalWaves(relaxed.graph).waves).toEqual([["wi_a"], ["wi_b", "wi_d"], ["wi_c", "wi_e"]]);
    // A cycle made only of required edges survives untouched.
    const hard = buildDependencyGraph(
      items.map((i) => i.id),
      [...deps, dep("a", "c")],
    );
    expect(dropCycleClosingEdges(hard, ["soft"])).toMatchObject({ dropped: [] });
    expect(findCycles(dropCycleClosingEdges(hard, ["soft"]).graph)).toEqual([["wi_a", "wi_c", "wi_b"]]);
  });
  it("detects cycles and keeps the rest schedulable", () => {
    const g = buildDependencyGraph(
      items.map((i) => i.id),
      [...deps, dep("a", "c")],
    );
    expect(findCycles(g)).toEqual([["wi_a", "wi_c", "wi_b"]]);
    // Same ring, different input order: still reported from the smallest id, in edge order.
    expect(
      findCycles(buildDependencyGraph(["wi_c", "wi_b", "wi_a"], [dep("a", "c"), dep("c", "b"), dep("b", "a")])),
    ).toEqual([["wi_a", "wi_c", "wi_b"]]);
    const { waves, cyclic } = topologicalWaves(g);
    expect(waves).toEqual([]); // d and e sit behind the cycle
    expect(cyclic.sort()).toEqual(["wi_a", "wi_b", "wi_c", "wi_d", "wi_e"]);
  });
  it("reports a self-loop as a cycle of one, and drops a soft one like any other closing hint", () => {
    const g = buildDependencyGraph(["wi_a", "wi_b"], [dep("a", "a"), dep("b", "a")]);
    expect(findCycles(g)).toEqual([["wi_a"]]);
    expect(topologicalWaves(g)).toEqual({ waves: [], cyclic: ["wi_a", "wi_b"] }); // b sits behind the loop
    expect([...transitiveDownstream(g, "wi_a")]).toEqual(["wi_b"]);
    expect(dropCycleClosingEdges(g, ["soft"]).dropped).toEqual([]); // a `blocks` loop is not a hint
    const soft = dropCycleClosingEdges(buildDependencyGraph(["wi_a"], [dep("a", "a", { type: "soft" })]), ["soft"]);
    expect(soft.dropped.map((e) => e.dependencyId)).toEqual(["dep_a_a"]);
    expect(findCycles(soft.graph)).toEqual([]);
  });
  it("keeps a cycle out of the critical path without losing the chains around it", () => {
    // root <- a <-> b <- leaf, plus an unrelated solo <- tail chain ("x <- y": y waits for x).
    const nodes = ["root", "a", "b", "leaf", "solo", "tail"].map((s) => `wi_${s}`);
    const g = buildDependencyGraph(nodes, [
      dep("a", "root"),
      dep("a", "b"),
      dep("b", "a"),
      dep("leaf", "b"),
      dep("tail", "solo"),
    ]);
    expect(findCycles(g)).toEqual([["wi_a", "wi_b"]]);
    const paths = longestDownstreamPaths(g, () => 1);
    expect(paths.get("wi_a")).toEqual({ length: 0, path: [] });
    expect(paths.get("wi_b")).toEqual({ length: 0, path: [] });
    // Upstream of the loop the chain stops where the loop begins; downstream of it an item is a chain of one.
    expect(paths.get("wi_root")).toEqual({ length: 1, path: ["wi_root"] });
    expect(paths.get("wi_leaf")).toEqual({ length: 1, path: ["wi_leaf"] });
    expect(criticalPath(paths)).toEqual({ length: 2, path: ["wi_solo", "wi_tail"] });
    expect(topologicalWaves(g)).toEqual({
      waves: [["wi_root", "wi_solo"], ["wi_tail"]],
      cyclic: ["wi_a", "wi_b", "wi_leaf"],
    });
  });
});

describe("decision matrix", () => {
  const criteria = [
    { key: "fit", name: "Fit", weight: 3, direction: "maximize" as const },
    { key: "cost", name: "Cost", weight: 1, direction: "minimize" as const },
  ];
  const options = [
    { key: "a", name: "A", scores: { fit: 8, cost: 8 }, pros: [], cons: [], risks: [] },
    { key: "b", name: "B", scores: { fit: 6, cost: 2 }, pros: [], cons: [], risks: [] },
  ];
  it("ranks with weights and inverts minimize criteria", () => {
    const r = evaluateDecisionMatrix({ criteria, options, scale: 10 }, T);
    // a: 0.75*8 + 0.25*(10-8) = 6.5 ; b: 0.75*6 + 0.25*(10-2) = 6.5 -> tie, authoring order wins
    expect(r.ranking.map((x) => [x.option, x.score])).toEqual([
      ["a", 6.5],
      ["b", 6.5],
    ]);
    expect(r).toMatchObject({ recommended: "a", margin: 0, confidence: "tie" });
    const clear = evaluateDecisionMatrix(
      { criteria, options: [options[0]!, { ...options[1]!, scores: { fit: 2, cost: 9 } }], scale: 10 },
      T,
    );
    expect(clear).toMatchObject({ recommended: "a", confidence: "clear" });
    expect(clear.pivotalCriteria).toEqual([]);
  });
  it("reports pivotal criteria", () => {
    const r = evaluateDecisionMatrix(
      { criteria, options: [{ ...options[0]!, scores: { fit: 7, cost: 9 } }, options[1]!], scale: 10 },
      T,
    );
    // a: 5.25+0.25 = 5.5 ; b: 4.5+2 = 6.5 -> b; dropping cost flips it to a
    expect(r.recommended).toBe("b");
    expect(r.pivotalCriteria).toEqual(["cost"]);
    expect(renderDecisionMatrix({ criteria, options, scale: 10 }, r)).toContain("Recommended: **b**");
  });
  it("renders a result whose options the matrix no longer has", () => {
    const r = evaluateDecisionMatrix({ criteria, options, scale: 10 }, T);
    const renamed = renderDecisionMatrix(
      {
        criteria,
        options: [{ key: "c", name: "C", scores: { fit: 1, cost: 1 }, pros: [], cons: [], risks: [] }],
        scale: 10,
      },
      r,
    );
    expect(renamed).toContain("| **a** |  |  | 6.5 |");
    expect(renamed).toContain("| b |  |  | 6.5 |");
    expect(renderDecisionMatrix({ criteria, options: [], scale: 10 }, r)).toContain("Recommended: **a**");
  });
  it("validates shape", () => {
    const issues = validateDecisionMatrix({
      criteria,
      options: [{ key: "a", name: "A", scores: { fit: 11 }, pros: [], cons: [], risks: [] }],
      scale: 10,
    });
    expect(issues.map((i) => i.path)).toEqual(["options[0].scores.fit", "options[0].scores.cost"]);
    expect(() => evaluateDecisionMatrix({ criteria: [], options, scale: 10 }, T)).toThrow(/at least one criterion/);
  });
});

describe("scheduler", () => {
  const items = [
    item("core", { estimate: "M" }),
    item("api", { priority: "high" }),
    item("ui"),
    item("risky"),
    item("ext"),
    item("done-item", { status: "done" }),
  ];
  const decisions = [decision("store")];
  const deps: Dependency[] = [
    dep("api", "core", { stage: "spec" }), // stage-level
    { ...dep("api", "core"), id: "dep_api_store", target: { kind: "decision", decisionId: "dec_store" } },
    dep("ui", "api", { requiredBy: "build" }), // later phase
    { ...dep("ext", "core"), id: "dep_ext", target: { kind: "external", key: "vendor" } },
  ];
  const risks = [risk("boom", 5, 5, ["risky"]), risk("meh", 2, 2, ["core"], { mitigatedBy: ["wi_api"] })];

  it("separates ready, waiting, held and settled with reasons", () => {
    const s = computeSchedule({ plan, items, dependencies: deps, risks, decisions, now: T });
    expect(s.ready.map((r) => r.slug)).toEqual(["core"]);
    expect(s.waiting.map((w) => [w.slug, w.waitingOn.map((x) => x.detail)])).toEqual([
      ["api", ["waiting for core to produce spec", "waiting for decision store"]],
      ["ui", ["waiting for api to start (needed by build)"]],
      ["ext", ["waiting for external 'vendor'"]],
    ]);
    expect(s.held).toEqual([
      {
        workItemId: "wi_risky",
        slug: "risky",
        level: "critical",
        reason: expect.stringMatching(/boom.*exceeds the plan's appetite \(high\)/),
      },
    ]);
    expect(s.settled.done).toEqual(["wi_done-item"]);
    // core (M = 2) -> api (S, via core@spec, so only half of core is charged) -> ui (S, via api#build,
    // so the first half of ui overlaps api): 1 + (1 - 0.5) + 1.
    expect(s.criticalPath).toEqual({ workItemIds: ["wi_core", "wi_api", "wi_ui"], length: 2.5 });
    expect(s.priorities["wi_core"]!.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unblocks 2 items \(api, ui\)/),
        "on the critical path (length 2.5)",
        "exposed to low risk: meh",
      ]),
    );
    // Every member of the reported path says so, not only its head.
    for (const id of s.criticalPath.workItemIds)
      expect(s.priorities[id]!.reasons).toContain("on the critical path (length 2.5)");
    expect(s.priorities["wi_risky"]!.reasons.some((r) => r.includes("critical path"))).toBe(false);
    // The "mitigates" reason is backed by a non-zero factor even for a low risk.
    expect(s.priorities["wi_api"]!.reasons).toEqual(expect.arrayContaining(["mitigates meh (low)", "priority high"]));
    expect(s.priorities["wi_api"]!.factors.mitigation).toBe(0.25);
    expect(s.openDecisions).toEqual([{ decisionId: "dec_store", key: "store", title: "store", blocks: ["wi_api"] }]);
    expect(explainWorkItem(s, items, "wi_api")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^api: pending \(priority high\)/),
        "waiting: waiting for core to produce spec",
        "why: priority high",
        "why: on the critical path (length 2.5)",
        "critical path: core -> api -> ui",
        "wave 2 of 3",
      ]),
    );
  });

  it("keeps settled items out of the waves and the critical path", () => {
    // core is done; everything that waited for it is now the head of the remaining chain.
    const s = computeSchedule({
      plan,
      items: items.map((i) => (i.slug === "core" ? { ...i, status: "done" as const } : i)),
      dependencies: deps,
      risks: [],
      decisions: [],
      now: T,
    });
    expect(s.settled.done).toEqual(["wi_core", "wi_done-item"]);
    expect(s.waves.flat()).not.toContain("wi_core");
    expect(s.waves).toEqual([["wi_api", "wi_risky", "wi_ext"], ["wi_ui"]]);
    expect(s.criticalPath).toEqual({ workItemIds: ["wi_api", "wi_ui"], length: 1.5 });
    expect(s.priorities["wi_api"]!.reasons).toContain("on the critical path (length 1.5)");
    expect(explainWorkItem(s, items, "wi_core").some((l) => l.startsWith("wave ") || l.includes("critical path"))).toBe(
      false,
    );
  });

  it("charges only the remaining work of items already underway", () => {
    const base = { plan, dependencies: deps, risks: [], decisions: [], now: T };
    // core (M = 2) is in progress: half of it is left, and half of that gates api (core@spec).
    const s = computeSchedule({
      ...base,
      items: items.map((i) => (i.slug === "core" ? { ...i, status: "in-progress" as const } : i)),
    });
    expect(s.criticalPath).toEqual({ workItemIds: ["wi_core", "wi_api", "wi_ui"], length: 2 }); // 0.5 + 1.5
    // Once core has produced its spec, api no longer waits for any of it.
    const produced = computeSchedule({
      ...base,
      items: items.map((i) =>
        i.slug === "core" ? { ...i, status: "in-progress" as const, produced: { spec: "art_1" } } : i,
      ),
    });
    expect(produced.criticalPath).toEqual({ workItemIds: ["wi_api", "wi_ui"], length: 1.5 });
    // A dispatched item counts as underway even before its status flips.
    expect(computeSchedule({ ...base, items, running: ["wi_ui"] }).criticalPath).toEqual({
      workItemIds: ["wi_core", "wi_api", "wi_ui"],
      length: 2.25, // 1 (core@spec) + 0.5 (what is left of ui) + 0.75 (api, less the quarter of ui overlapping it)
    });
  });

  it("leaves a satisfied stage edge out of the critical path, with its producer's remaining predecessors", () => {
    // u is underway and has produced its spec, but still needs p by its build phase. d needs only
    // u's spec, so nothing ahead delays d: p's wait must not reach d through u.
    const s = computeSchedule({
      plan,
      items: [
        item("p", { estimate: "8" }),
        item("u", { estimate: "M", status: "in-progress", produced: { spec: "art_1" } }),
        item("d", { estimate: "8" }),
      ],
      dependencies: [dep("u", "p", { requiredBy: "build" }), dep("d", "u", { stage: "spec" })],
      risks: [],
      decisions: [],
      now: T,
    });
    // p (8) then what is left of u (1), less the half of it that overlaps p: 8 + 0.5.
    expect(s.criticalPath).toEqual({ workItemIds: ["wi_p", "wi_u"], length: 8.5 });
    // Readiness keeps the full view: d is ready, the edge only stops counting toward the path.
    expect(s.ready.map((r) => r.slug)).toContain("d");
    expect(s.waves.flat()).toContain("wi_d");
  });

  it("reports what an open decision blocks from the live dependency states", () => {
    const decided = computeSchedule({
      plan,
      items,
      dependencies: deps,
      risks: [],
      decisions: [{ ...decisions[0]!, status: "deferred" as const }],
      now: T,
    });
    expect(decided.openDecisions).toEqual([expect.objectContaining({ key: "store", blocks: ["wi_api"] })]);
    // A waived dependency, a settled dependent or a non-blocking edge is not "blocked" whatever the persisted status says.
    const waived = computeSchedule({
      plan,
      items,
      dependencies: deps.map((d) => (d.id === "dep_api_store" ? { ...d, status: "waived" as const } : d)),
      risks: [],
      decisions,
      now: T,
    });
    expect(waived.openDecisions[0]!.blocks).toEqual([]);
    const apiDone = computeSchedule({
      plan,
      items: items.map((i) => (i.slug === "api" ? { ...i, status: "done" as const } : i)),
      dependencies: deps,
      risks: [],
      decisions,
      now: T,
    });
    expect(apiDone.openDecisions[0]!.blocks).toEqual([]);
    const soft = computeSchedule({
      plan,
      items,
      dependencies: deps.map((d) => (d.id === "dep_api_store" ? { ...d, type: "soft" as const } : d)),
      risks: [],
      decisions,
      now: T,
    });
    expect(soft.openDecisions[0]!.blocks).toEqual([]);
  });
  it("derives what a decision blocks from its dependencies", () => {
    const decided = {
      ...dep("ui", "core"),
      id: "dep_ui_store",
      target: { kind: "decision" as const, decisionId: "dec_store" },
      status: "satisfied" as const,
    };
    const waived = { ...decided, id: "dep_docs_store", from: "wi_docs", status: "waived" as const };
    const soft = { ...decided, id: "dep_x_store", from: "wi_x", type: "soft" as const, status: "open" as const };
    const deps: Dependency[] = [
      dep("api", "core"),
      { ...decided, id: "dep_api_store", from: "wi_api", status: "open" },
      decided,
      waived,
      soft,
      { ...decided, id: "dep_api_store_build", from: "wi_api", status: "open", requiredBy: "build" },
    ];
    expect(decisionBlocks("dec_store", deps)).toEqual(["wi_api", "wi_ui"]);
    expect(decisionBlocks("dec_store", deps, ["open"])).toEqual(["wi_api"]);
    expect(decisionBlocks("dec_other", deps)).toEqual([]);
  });

  it("unblocks on produced stages, decisions, accepted risks and satisfied externals", () => {
    const later = {
      plan,
      items: items.map((i) =>
        i.slug === "core" ? { ...i, status: "in-progress" as const, produced: { spec: "art_1" } } : i,
      ),
      dependencies: deps.map((d) => (d.id === "dep_ext" ? { ...d, status: "satisfied" as const } : d)),
      risks: risks.map((r) => (r.key === "boom" ? { ...r, status: "accepted" as const } : r)),
      decisions: [{ ...decisions[0]!, status: "decided" as const, chosen: "sqlite" }],
      now: T,
    };
    const s = computeSchedule(later);
    expect(s.running).toEqual(["wi_core"]);
    expect(s.ready.map((r) => r.slug)).toEqual(["api", "ext", "risky"]); // api by priority + mitigation, then alphabetical among equals
    expect(s.held).toEqual([]);
    expect(s.dependencyStates["dep_api_store"]).toEqual({ state: "satisfied", detail: "decision store = sqlite" });
    // ui may start once api is underway.
    const s2 = computeSchedule({ ...later, running: ["wi_api"] });
    expect(s2.ready.map((r) => r.slug)).toContain("ui");
  });

  it("marks items behind failures as unschedulable", () => {
    const s = computeSchedule({
      plan,
      items: items.map((i) => (i.slug === "core" ? { ...i, status: "failed" as const } : i)),
      dependencies: deps,
      risks: [],
      decisions,
      now: T,
    });
    expect(s.unschedulable.map((u) => [u.slug, u.reason])).toEqual([["api", "core is failed"]]);
    expect(s.settled.failed).toEqual(["wi_core"]);
    // Once the dispatcher marks api blocked, ui's build-phase dependency fails too.
    const s2 = computeSchedule({
      plan,
      items: items.map((i) =>
        i.slug === "core"
          ? { ...i, status: "failed" as const }
          : i.slug === "api"
            ? { ...i, status: "blocked" as const }
            : i,
      ),
      dependencies: deps,
      risks: [],
      decisions,
      now: T,
    });
    expect(s2.unschedulable.map((u) => [u.slug, u.reason])).toEqual([
      ["api", "core is failed"],
      ["ui", "api is blocked"],
    ]);
  });

  it("detects cycles among unsettled items", () => {
    const s = computeSchedule({
      plan,
      items: [item("x"), item("y")],
      dependencies: [dep("x", "y"), dep("y", "x")],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(s.cycles).toEqual([["wi_x", "wi_y"]]);
    expect(s.unschedulable.map((u) => u.reason)).toEqual([
      "dependency cycle: x -> y -> x",
      "dependency cycle: x -> y -> x",
    ]);
    // Three items, listed in edge order from the smallest slug, whatever order they were registered in.
    const ring = computeSchedule({
      plan,
      items: [item("c"), item("b"), item("a")],
      dependencies: [dep("a", "c"), dep("c", "b"), dep("b", "a")],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(ring.unschedulable[0]!.reason).toBe("dependency cycle: a -> c -> b -> a");
    // A done item cannot be part of a cycle any more.
    const stale = computeSchedule({
      plan,
      items: [item("x", { status: "done" }), item("y")],
      dependencies: [dep("x", "y"), dep("y", "x")],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(stale.cycles).toEqual([]);
    expect(stale.ready.map((r) => r.slug)).toEqual(["y"]);
  });

  it("ignores soft edges that close a cycle instead of stranding both items", () => {
    const two = [item("x"), item("y")];
    // x waits for y; y would *prefer* to come after x. The hint cannot be honoured - it is not a cycle.
    const s = computeSchedule({
      plan,
      items: two,
      dependencies: [dep("x", "y"), dep("y", "x", { type: "soft" })],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(s.cycles).toEqual([]);
    expect(s.unschedulable).toEqual([]);
    expect(s.ready.map((r) => r.slug)).toEqual(["y"]);
    expect(s.waiting.map((w) => [w.slug, w.waitingOn.map((o) => o.detail)])).toEqual([
      ["x", ["waiting for y to be done (currently pending)"]],
    ]);
    expect(s.waves).toEqual([["wi_y"], ["wi_x"]]);
    expect(s.ignoredSoftDependencies).toEqual([{ dependencyId: "dep_y_x", from: "wi_y", to: "wi_x" }]);
  });

  it("keeps soft edges that only order, and a soft-only ring never blocks", () => {
    const two = [item("x"), item("y")];
    const soft = computeSchedule({
      plan,
      items: two,
      dependencies: [dep("x", "y", { type: "soft" })],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(soft.ignoredSoftDependencies).toEqual([]);
    expect(soft.waves).toEqual([["wi_y"], ["wi_x"]]); // still an ordering hint
    expect(soft.ready.map((r) => r.slug)).toEqual(["y", "x"]); // ... that never blocks dispatch, it only ranks y first
    const ring = computeSchedule({
      plan,
      items: two,
      dependencies: [dep("x", "y", { type: "soft" }), dep("y", "x", { type: "soft" })],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(ring.cycles).toEqual([]);
    expect(ring.unschedulable).toEqual([]);
    expect(ring.ignoredSoftDependencies.map((d) => d.dependencyId)).toEqual(["dep_y_x"]);
  });

  it("still reports a blocks cycle when soft edges are not ordering", () => {
    const s = computeSchedule({
      plan,
      items: [item("x"), item("y")],
      dependencies: [dep("x", "y"), dep("y", "x")],
      risks: [],
      decisions: [],
      now: T,
      policy: { orderSoftDependencies: false },
    });
    expect(s.cycles).toEqual([["wi_x", "wi_y"]]);
    expect(s.unschedulable).toHaveLength(2);
  });

  it("strategies change the order", () => {
    const two = [item("safe"), item("hot")];
    const r = [risk("fire", 3, 4, ["hot"])]; // high, within the default appetite
    const cp = computeSchedule({
      plan,
      items: two,
      dependencies: [],
      risks: r,
      decisions: [],
      now: T,
      policy: { strategy: "fifo" },
    });
    expect(cp.ready.map((x) => x.slug)).toEqual(["hot", "safe"]); // fifo ignores risk: equal age, alphabetical tie-break
    expect(cp.priorities["wi_hot"]!.score).toBe(cp.priorities["wi_safe"]!.score);
    const rf = computeSchedule({
      plan,
      items: two,
      dependencies: [],
      risks: r,
      decisions: [],
      now: T,
      policy: { strategy: "risk-first" },
    });
    expect(rf.ready[0]!.slug).toBe("hot");
    const compact = compactSchedule(rf, two);
    expect(compact).toMatchObject({
      strategy: "risk-first",
      ready: [{ slug: "hot" }, { slug: "safe" }],
      risk: { open: 1, highestLevel: "high" },
    });
  });

  it("marks a self-dependent item unschedulable, while a soft self-reference is just ignored", () => {
    const s = computeSchedule({
      plan,
      items: [item("loop"), item("after")],
      dependencies: [dep("loop", "loop"), dep("after", "loop")],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(s.cycles).toEqual([["wi_loop"]]);
    expect(s.unschedulable.map((u) => [u.slug, u.reason])).toEqual([["loop", "dependency cycle: loop -> loop"]]);
    // The item behind it waits like it would for any pending upstream (the dispatcher marks it blocked later).
    expect(s.waiting.map((w) => [w.slug, w.waitingOn.map((o) => o.detail)])).toEqual([
      ["after", ["waiting for loop to be done (currently pending)"]],
    ]);
    expect(s.waves).toEqual([]);
    expect(explainWorkItem(s, [item("loop")], "wi_loop")).toContain("cannot run: dependency cycle: loop -> loop");
    const soft = computeSchedule({
      plan,
      items: [item("loop")],
      dependencies: [dep("loop", "loop", { type: "soft" })],
      risks: [],
      decisions: [],
      now: T,
    });
    expect(soft.cycles).toEqual([]);
    expect(soft.ready.map((r) => r.slug)).toEqual(["loop"]);
    expect(soft.ignoredSoftDependencies).toEqual([{ dependencyId: "dep_loop_loop", from: "wi_loop", to: "wi_loop" }]);
    expect(soft.waves).toEqual([["wi_loop"]]);
  });

  it("fails the dependants of a superseded decision and keeps those of a deferred one waiting", () => {
    const withStatus = (status: Decision["status"]) =>
      computeSchedule({
        plan,
        items,
        dependencies: deps,
        risks: [],
        decisions: [{ ...decisions[0]!, status }],
        now: T,
      });
    const superseded = withStatus("superseded");
    expect(superseded.dependencyStates["dep_api_store"]).toEqual({
      state: "failed",
      detail: "decision store was superseded",
    });
    expect(superseded.unschedulable).toEqual([
      { workItemId: "wi_api", slug: "api", reason: "decision store was superseded", dependencyIds: ["dep_api_store"] },
    ]);
    expect(superseded.openDecisions).toEqual([]);
    const deferred = withStatus("deferred");
    expect(deferred.unschedulable).toEqual([]);
    expect(deferred.waiting.find((w) => w.slug === "api")!.waitingOn.map((o) => o.detail)).toEqual([
      "waiting for core to produce spec",
      "waiting for decision store (deferred)",
    ]);
    expect(deferred.openDecisions).toEqual([
      { decisionId: "dec_store", key: "store", title: "store", blocks: ["wi_api"] },
    ]);
    // A decision missing from the snapshot altogether is a failure too, not an endless wait.
    const missing = computeSchedule({ plan, items, dependencies: deps, risks: [], decisions: [], now: T });
    expect(missing.dependencyStates["dep_api_store"]).toEqual({
      state: "failed",
      detail: "decision dec_store is not in the plan",
    });
  });

  it("keeps a stage-level dependency satisfied when its upstream fails after producing the stage", () => {
    const coreFailedAfterSpec = items.map((i) =>
      i.slug === "core" ? { ...i, status: "failed" as const, produced: { spec: "art_1" } } : i,
    );
    const decided = [{ ...decisions[0]!, status: "decided" as const, chosen: "sqlite" }];
    const s = computeSchedule({
      plan,
      items: coreFailedAfterSpec,
      dependencies: deps,
      risks: [],
      decisions: decided,
      now: T,
    });
    expect(s.dependencyStates["dep_api_core@spec"]).toEqual({ state: "satisfied", detail: "core produced spec" });
    expect(s.settled.failed).toEqual(["wi_core"]);
    expect(s.unschedulable).toEqual([]);
    expect(s.ready.map((r) => r.slug)).toContain("api");
    // The same failure fails a plain edge on core, which waits for the whole item ...
    const whole = computeSchedule({
      plan,
      items: coreFailedAfterSpec,
      dependencies: deps.map((d) =>
        d.id === "dep_api_core@spec" ? { ...d, target: { kind: "work-item" as const, workItemId: "wi_core" } } : d,
      ),
      risks: [],
      decisions: decided,
      now: T,
    });
    expect(whole.unschedulable.map((u) => [u.slug, u.reason])).toEqual([["api", "core is failed"]]);
    // ... and a stage the upstream never got to produce.
    const noSpec = computeSchedule({
      plan,
      items: coreFailedAfterSpec.map((i) => (i.slug === "core" ? { ...i, produced: {} } : i)),
      dependencies: deps,
      risks: [],
      decisions: decided,
      now: T,
    });
    expect(noSpec.unschedulable.map((u) => [u.slug, u.reason])).toEqual([["api", "core is failed"]]);
  });

  it("policy flags: holdAboveAppetite off only reports, mitigateFirst off drops the factor, weights override the preset", () => {
    const base = { plan, items, dependencies: deps, risks, decisions, now: T };
    const reported = computeSchedule({ ...base, policy: { holdAboveAppetite: false } });
    expect(reported.held).toEqual([]);
    expect(reported.ready.map((r) => r.slug).sort()).toEqual(["core", "risky"]);
    expect(reported.exposure["wi_risky"]).toMatchObject({ level: "critical" }); // still visible, just not a hold
    expect(reported.priorities["wi_risky"]!.reasons).toContain("exposed to critical risk: boom");
    expect(reported.policy).toMatchObject({ holdAboveAppetite: false, riskAppetite: "high" });

    const noMitigation = computeSchedule({ ...base, policy: { mitigateFirst: false } });
    expect(noMitigation.priorities["wi_api"]!.factors.mitigation).toBe(0);
    expect(noMitigation.priorities["wi_api"]!.reasons.some((r) => r.startsWith("mitigates"))).toBe(false);
    expect(noMitigation.priorities["wi_api"]!.reasons).toContain("priority high");

    // Weights: one item carries a high risk, the other a high priority; zeroing `risk` flips the order.
    const two = [item("safe", { priority: "high" }), item("hot")];
    const fire = [risk("fire", 3, 4, ["hot"])];
    const riskFirst = computeSchedule({
      plan,
      items: two,
      dependencies: [],
      risks: fire,
      decisions: [],
      now: T,
      policy: { strategy: "risk-first" },
    });
    expect(riskFirst.ready.map((r) => r.slug)).toEqual(["hot", "safe"]);
    const noRisk = computeSchedule({
      plan,
      items: two,
      dependencies: [],
      risks: fire,
      decisions: [],
      now: T,
      policy: { strategy: "risk-first", weights: { risk: 0 } },
    });
    expect(noRisk.ready.map((r) => r.slug)).toEqual(["safe", "hot"]);
    expect(noRisk.priorities["wi_hot"]!.factors.risk).toBe(1); // the factor is still reported; only its weight is gone
    // The plan's own policy is the base the per-call overrides sit on.
    const strict = { ...plan, policy: { ...plan.policy, strategy: "risk-first" as const, weights: { risk: 0 } } };
    expect(
      computeSchedule({ plan: strict, items: two, dependencies: [], risks: fire, decisions: [], now: T }).ready.map(
        (r) => r.slug,
      ),
    ).toEqual(["safe", "hot"]);
    expect(
      computeSchedule({
        plan: strict,
        items: two,
        dependencies: [],
        risks: fire,
        decisions: [],
        now: T,
        policy: { strategy: "fifo" },
      }),
    ).toMatchObject({ strategy: "fifo", policy: { weights: { risk: 0 } } });
  });
});

describe("artifact signals", () => {
  it("slugifies without a leading or trailing hyphen, even when cut", () => {
    expect(slugify("  Where do Sessions live?  ")).toBe("where-do-sessions-live");
    const long = slugify("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbb"); // 47 a's, cut lands on the "-"
    expect(long).toBe("a".repeat(47));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(slugify("***")).toBe("item");
  });
  it("bounds authored plan keys the way slugify bounds generated ones", () => {
    expect(PlanKeySchema.safeParse("a".repeat(SLUG_MAX_LENGTH)).success).toBe(true);
    expect(PlanKeySchema.safeParse("a".repeat(SLUG_MAX_LENGTH + 1)).success).toBe(false);
    expect(PlanKeySchema.safeParse("auth-").success).toBe(false);
    expect(PlanKeySchema.safeParse("-auth").success).toBe(false);
    expect(PlanKeySchema.safeParse("auth-flow").success).toBe(true);
    // Anything slugify produces is a valid key.
    for (const text of ["  Where do Sessions live?  ", "a".repeat(47) + " bbbbbbbb", "x".repeat(200), "***"])
      expect(PlanKeySchema.safeParse(slugify(text)).success).toBe(true);
  });
  it("lifts risks, decisions and dependencies from generic front matter", () => {
    const s = extractPlanSignals({
      kind: "spec",
      name: "spec",
      data: {
        status: "ready",
        risks: [
          "Flaky integration tests",
          { key: "pii", title: "PII in logs", likelihood: 2, impact: 5, affects: ["api"] },
        ],
        dependencies: [
          "billing@spec",
          { on: "auth", requiredBy: "build" },
          42,
          "@spec",
          "decision:",
          { on: "soft:x", type: "blocks" },
        ],
        decisions: [
          { key: "cache", title: "Cache layer", options: [{ key: "redis", name: "Redis" }], chosen: "redis" },
        ],
      },
    });
    expect(s.risks.map((r) => r.key)).toEqual(["flaky-integration-tests", "pii"]);
    expect(s.dependencies).toEqual(["billing@spec", { on: "auth", requiredBy: "build" }]);
    expect(s.decisions[0]).toMatchObject({ key: "cache", chosen: "redis" });
    expect(s.issues).toEqual([
      "dependencies[2]: not a dependency reference",
      "dependencies[3]: invalid dependency reference '@spec'",
      "dependencies[4]: invalid dependency reference 'decision:'",
      "dependencies[5]: invalid dependency reference 'soft:x': type 'soft' conflicts with type 'blocks'",
    ]);
  });
  it("reads risk registers and decision matrices", () => {
    expect(
      extractPlanSignals({ kind: "risk-register", name: "riskRegister", data: { risks: [{ key: "a", title: "A" }] } })
        .risks,
    ).toHaveLength(1);
    expect(
      extractPlanSignals({ kind: "risk-register", name: "riskRegister", data: { risks: [{ title: 5 }] } }).issues[0],
    ).toMatch(/risk-register/);
    expect(
      extractPlanSignals({
        kind: "decision-matrix",
        name: "decisionMatrix",
        data: { key: "k", title: "K", options: [{ key: "x", name: "X" }] },
      }).decisions,
    ).toHaveLength(1);
  });
  it("runs extra extractors", () => {
    const s = extractPlanSignals({ kind: "review", name: "review", data: { blocking: 2 } }, [
      () => ({
        risks: [
          {
            key: "review-blockers",
            title: "Blocking review findings",
            likelihood: 3,
            impact: 3,
            description: "",
            category: "technical",
            triggers: [],
            affects: [],
            mitigatedBy: [],
          },
        ],
      }),
    ]);
    expect(s.risks[0]!.key).toBe("review-blockers");
  });
});

describe("mermaid", () => {
  it("renders items, dependency types, decisions and externals", () => {
    const md = planToMermaid({
      items: [item("a"), item("b", { status: "done" })],
      dependencies: [
        dep("a", "b", { stage: "spec", requiredBy: "build" }),
        { ...dep("a", "b"), id: "d2", type: "soft" },
        { ...dep("a", "b"), id: "d3", target: { kind: "decision", decisionId: "dec_k" } },
        { ...dep("a", "b"), id: "d4", target: { kind: "external", key: "vendor" } },
      ],
      decisions: [decision("k", { status: "decided", chosen: "x" })],
    });
    expect(md).toContain("wi_a -->|@spec #build| wi_b");
    expect(md).toContain("wi_a -.-> wi_b");
    expect(md).toContain('dec_k{"decision: k<br/><small>decided = x</small>"}:::decision');
    expect(md).toContain('ext_vendor[["external: vendor"]]:::external');
    expect(md).toContain(":::done");
  });
});
