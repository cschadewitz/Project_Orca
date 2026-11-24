/**
 * What an installed receipt must show for tiers A and B (#1026): every route the row lists as
 * unsupported shown refused or asked about on the installed agent, and every case run either
 * live through the real agent with per-call evidence, or, only where a live agent cannot make
 * the call, on ORCA's installed program.
 */
import { describe, expect, it } from "vitest";
import { installedCaseProblems, uncoveredRouteProblems } from "../guard-qualification/check-support-matrix.js";

const agent = { id: "claude", unsupportedRoutes: ["Remote sessions over SSH while the hook is on"] };
const how = "a hooked session on an SSH host is refused before it opens";

describe("an installed receipt shows every uncovered route refused or asked about", () => {
  it("holds when each is shown, with how", () => {
    expect(
      uncoveredRouteProblems(
        { uncoveredRoutes: [{ route: agent.unsupportedRoutes[0], result: "refused", how }] },
        agent,
      ),
    ).toEqual([]);
    expect(
      uncoveredRouteProblems({ uncoveredRoutes: [{ route: agent.unsupportedRoutes[0], result: "asked", how }] }, agent),
    ).toEqual([]);
  });

  it("refuses a route not shown, shown as anything else, or without how", () => {
    expect(uncoveredRouteProblems({}, agent)).toEqual([
      "uncovered route not shown refused: Remote sessions over SSH while the hook is on",
    ]);
    for (const r of [
      { route: agent.unsupportedRoutes[0], result: "allowed", how },
      { route: agent.unsupportedRoutes[0], result: "refused" },
      { route: agent.unsupportedRoutes[0], result: "refused", how: "trust me" },
    ])
      expect(uncoveredRouteProblems({ uncoveredRoutes: [r] }, agent)).toEqual([
        "uncovered route needs result refused or asked, and how it was shown: Remote sessions over SSH while the hook is on",
      ]);
  });
});

describe("each installed case runs live, or on the program only where a live agent cannot", () => {
  const route = {
    id: "claude-native-hook",
    installed: { live: "claude-connected", program: { F01: "a live agent builds the hook's input itself" } },
  };
  const assertions = {
    format: "orca-706-assertions/1",
    paths: { "claude-connected": { L03: [{ tool: "Write", expected: ["deny"] }] } },
  };
  const denied = {
    toolUseId: "toolu_1",
    tool: "Write",
    expected: ["deny"],
    outcome: "deny",
    orcaDecision: "observed",
    refusal: "orca-deny",
    approvals: [],
    effect: "none",
    effectRef: { kind: "file", path: "p", before: null, after: null, written: "w" },
  };
  const receipt = (cases) => ({ route: "claude-native-hook", cases });

  it("holds for live cases with evidence and program cases the route lists", () => {
    expect(
      installedCaseProblems(
        receipt([
          { id: "L03", result: "pass", via: "live", calls: [denied] },
          { id: "F01", result: "pass", via: "program" },
        ]),
        ["L03", "F01"],
        assertions,
        route,
      ),
    ).toEqual([]);
  });

  it("refuses a route with no installed runner", () => {
    expect(installedCaseProblems(receipt([]), ["L03"], assertions, { id: "acp-ask" })).toEqual([
      "route claude-native-hook has no installed runner in the matrix",
    ]);
    // Tier A's receipt runs no case and needs no runner.
    expect(installedCaseProblems(receipt([]), [], assertions, { id: "acp-ask" })).toEqual([]);
  });

  it("refuses a case on the program that a live agent can make, or one that says neither", () => {
    expect(
      installedCaseProblems(receipt([{ id: "L03", result: "pass", via: "program" }]), ["L03"], assertions, route),
    ).toEqual(["case L03: run on the program, but a live agent can make it"]);
    expect(installedCaseProblems(receipt([{ id: "L03", result: "pass" }]), ["L03"], assertions, route)).toEqual([
      "case L03: needs via live or program",
    ]);
  });

  it("checks a live case's calls as a connected receipt's are", () => {
    const ran = { ...denied, effectRef: { ...denied.effectRef, after: "w" } };
    expect(
      installedCaseProblems(
        receipt([{ id: "L03", result: "pass", via: "live", calls: [ran] }]),
        ["L03"],
        assertions,
        route,
      ),
    ).toEqual([
      "case L03: Write: its evidence shows effect observed, not none (live, on claude-connected)",
      "case L03: Write: outcome deny does not follow from its evidence (live, on claude-connected)",
    ]);
    expect(
      installedCaseProblems(receipt([{ id: "L03", result: "pass", via: "live" }]), ["L03"], assertions, route),
    ).toEqual(["case L03: no per-call evidence (live, on claude-connected)"]);
    expect(
      installedCaseProblems(
        receipt([{ id: "L03", result: "pass", via: "live", calls: [denied] }]),
        ["L03"],
        assertions,
        {
          ...route,
          installed: { program: {} },
        },
      ),
    ).toEqual(["route claude-native-hook: no live runner for cases L03"]);
  });
});
