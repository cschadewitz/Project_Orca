// The feature flag registry (packages/core/src/features.ts, docs/WORKSTREAMS.md).
import { describe, expect, it } from "vitest";
import { FEATURES, featureRegistry, type FeatureFlag } from "../src/features.js";

const planner: FeatureFlag = { name: "planner-v2", stage: "incubating", issue: 1, summary: "the new planner" };
const flags: FeatureFlag[] = [
  planner,
  { name: "remote-judge", stage: "experimental", issue: 2, summary: "a remote judge" },
  { name: "live-counts", stage: "stable", issue: 3, summary: "live counts" },
];
const registry = featureRegistry(flags);

describe("the feature flag registry", () => {
  it("keeps an incubating flag off unless ORCA_INCUBATING names it or says all", () => {
    expect(registry.enabled("planner-v2", { env: {} })).toBe(false);
    // Configuration cannot reach it: an opt-in is ignored.
    expect(registry.enabled("planner-v2", { env: {}, optIns: { "planner-v2": true } })).toBe(false);
    expect(registry.enabled("planner-v2", { env: { ORCA_INCUBATING: "other, planner-v2" } })).toBe(true);
    expect(registry.enabled("planner-v2", { env: { ORCA_INCUBATING: "all" } })).toBe(true);
    expect(registry.enabled("planner-v2", { env: { ORCA_INCUBATING: "planner" } })).toBe(false);
  });

  it("turns an experimental flag on by the owner's opt-in or ORCA_EXPERIMENTAL, never by ORCA_INCUBATING", () => {
    expect(registry.enabled("remote-judge", { env: {} })).toBe(false);
    expect(registry.enabled("remote-judge", { env: {}, optIns: { "remote-judge": true } })).toBe(true);
    expect(registry.enabled("remote-judge", { env: { ORCA_EXPERIMENTAL: "remote-judge" } })).toBe(true);
    expect(registry.enabled("remote-judge", { env: { ORCA_INCUBATING: "all" } })).toBe(false);
    // `all` belongs to the incubating test switch only: no blanket opt-in to every experiment.
    expect(registry.enabled("remote-judge", { env: { ORCA_EXPERIMENTAL: "all" } })).toBe(false);
    expect(registry.enabled("remote-judge", { env: { ORCA_EXPERIMENTAL: "all,other" } })).toBe(false);
    expect(registry.enabled("planner-v2", { env: { ORCA_INCUBATING: "all" } })).toBe(true);
  });

  it("keeps a stable flag on", () => {
    expect(registry.enabled("live-counts", { env: {} })).toBe(true);
  });

  it("throws on an unknown name, so a typo fails loudly", () => {
    expect(() => registry.enabled("planer-v2", { env: {} })).toThrow(/unknown feature flag "planer-v2"/);
  });

  it("lists the flags at a stage", () => {
    expect(registry.atStage("incubating").map((f) => f.name)).toEqual(["planner-v2"]);
  });

  it.each([
    ["a name that is not kebab-case", [{ ...planner, name: "PlannerV2" }], /not kebab-case/],
    ["a name listed twice", [planner, planner], /listed twice/],
    ["no tracking issue", [{ ...planner, issue: 0 }], /no tracking issue/],
  ] satisfies [string, FeatureFlag[], RegExp][])("refuses %s", (_, list, message) => {
    expect(() => featureRegistry(list)).toThrow(message);
  });

  it("holds a well-formed product list, with no incubating flag on by default", () => {
    const product = featureRegistry(FEATURES);
    for (const flag of product.atStage("incubating")) expect(product.enabled(flag.name, { env: {} })).toBe(false);
  });
});
