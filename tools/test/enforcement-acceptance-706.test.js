/**
 * #706 enforcement acceptance suite, synthetic half: every case in
 * tools/guard-qualification/cases.json runs against every enforcement path that can be asked
 * it, through ORCA's real decision code, and the support matrix may claim only what that and
 * the repository back.
 *
 * Set ORCA_ENFORCEMENT_RECEIPT_DIR to also write one JSON receipt per path: the cases run,
 * their result and the exclusions, for the connected proof and the support matrix to cite.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMOTABLE_TIERS,
  PROMOTION_DISABLED,
  UNVERIFIED,
  REPO_ROOT,
  casesFor,
  checkSupportMatrix,
  loadCatalogue,
  loadMatrix,
  loadAssertions,
  qualificationProfile,
  qualifyingCases,
} from "../guard-qualification/check-support-matrix.js";
import { PATHS } from "../guard-qualification/paths.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";

const catalogue = loadCatalogue();
const matrix = loadMatrix();
const receipts = new Map();

describe("the catalogue, the scenarios and the matrix agree", () => {
  it("every catalogued case has a scenario, and every scenario is catalogued", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(catalogue.cases.map((c) => c.id).sort());
  });

  it("every path in the suite is in the matrix with the same capabilities", () => {
    // Connected paths run a live agent and are checked by enforcement-connected-706.test.js.
    expect(PATHS.map((p) => p.id).sort()).toEqual(
      matrix.paths
        .filter((p) => !p.connected)
        .map((p) => p.id)
        .sort(),
    );
    for (const path of PATHS) {
      const listed = matrix.paths.find((p) => p.id === path.id);
      expect([...path.capabilities].sort(), path.id).toEqual([...listed.capabilities].sort());
    }
  });

  it("the support matrix holds", () => {
    expect(checkSupportMatrix(matrix, catalogue)).toEqual([]);
  });

  it("the suite's page names every case", async () => {
    const page = await readFile(
      join(REPO_ROOT, "docs/preparation/tool-execution-guards/acceptance-suite-706.md"),
      "utf8",
    );
    for (const c of catalogue.cases) expect(page, c.id).toContain(`| ${c.id} |`);
  });
});

describe("the matrix checker refuses claims beyond the evidence", () => {
  const build = "0123456789abcdef0123456789abcdef01234567";
  const artifacts = {
    adapterIntegrity: "sha512-abc",
    runtimeSha256: "a".repeat(64),
    hookProgramSha256: "b".repeat(64),
  };
  const pin = { agentVersion: "2.1.330", adapterVersion: "0.109.1", host: "linux-x64", build, artifacts };
  /** Replaced in each check by the profile the checker recomputes for the receipt's route. */
  const CURRENT_PROFILE = "current profile";
  const installedSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "/usr/bin/node", args: ["/h.js", "/c.json"], timeout: 10, onFailure: "block" },
          ],
        },
      ],
    },
  };
  const claude = (extra = {}) => ({
    ...structuredClone(matrix.agents.find((a) => a.id === "claude")),
    // The structure tests claim the ask route; the hook route's rules are tested with hookAgent.
    routes: ["acp-ask"],
    notAsserted: [],
    pin,
    ...extra,
  });
  const acpCases = casesFor(
    matrix.paths.find((p) => p.id === "acp-ask"),
    catalogue,
  );
  /**
   * The structure tests run every installed case live, through a fixture runner whose committed
   * inventory (below) is one Write that ORCA must deny per case; each route path gets an
   * `installed` entry naming it and no diagnostics. The evidence rules are tested on their own.
   */
  const withInstalled = (paths) => paths.map((p) => (p.connected ? p : { ...p, installed: { live: "fixture-live" } }));
  /** A write ORCA denied: the file is as it was, bound to this call's own tool_use id. */
  const denied = {
    toolUseId: "toolu_1_0",
    tool: "Write",
    expected: ["deny"],
    outcome: "deny",
    orcaDecision: "observed",
    refusal: "orca-deny",
    approvals: [],
    effect: "none",
    effectRef: { kind: "file", path: "p", before: null, after: null, written: "w" },
  };
  /** Each case run live on the installed agent, one denied Write with its own tool_use id. */
  const liveCases = (ids) =>
    ids.map((id) => ({ id, result: "pass", via: "live", calls: [{ ...denied, toolUseId: `toolu_${id}` }] }));
  const testPaths = withInstalled(matrix.paths);
  const shownRefused = matrix.agents
    .find((a) => a.id === "claude")
    .unsupportedRoutes.map((route) => ({
      route,
      result: "refused",
      how: "shown refused on the installed agent by a probe",
    }));
  const receipt = (extra = {}) => ({
    format: "orca-enforcement-receipt/1",
    kind: "installed",
    uncoveredRoutes: shownRefused,
    agent: "claude",
    agentVersion: "2.1.330",
    adapterVersion: "0.109.1",
    host: "linux-x64",
    route: "acp-ask",
    build,
    checks: { connects: "pass", uncoveredRoutesRefused: "pass" },
    cases: liveCases(acpCases),
    inputs: {
      adapter: { version: "0.109.1", integrity: artifacts.adapterIntegrity },
      runtime: { sha256: artifacts.runtimeSha256 },
      hookProgram: { sha256: artifacts.hookProgramSha256 },
      profile: CURRENT_PROFILE,
    },
    installedSettings,
    ...extra,
  });
  /**
   * A stand-in for the committed assertion inventory: every case the connected path runs makes
   * one Write that ORCA must deny, which is what the fixture receipts below record. Other
   * connected paths keep their committed inventories.
   */
  const inventoryFor = (paths) => {
    const connected = paths.find((p) => p.id === "claude-connected");
    return {
      format: "orca-706-assertions/1",
      paths: {
        ...loadAssertions().paths,
        "claude-connected": Object.fromEntries(
          casesFor(connected, catalogue).map((id) => [id, [{ tool: "Write", expected: ["deny"] }]]),
        ),
        "fixture-live": Object.fromEntries(catalogue.cases.map((c) => [c.id, [{ tool: "Write", expected: ["deny"] }]])),
      },
      // The committed program inventories: the diagnostics count toward no tier.
      programs: Object.fromEntries(
        Object.entries(loadAssertions().programs).filter(
          ([id]) => paths.find((p) => p.id === id)?.installed?.diagnostic,
        ),
      ),
    };
  };
  /**
   * The structural checks, with every receipt's attestation taken as verified and every tier
   * promotable: what the checker will require once promotion is enabled.
   */
  const attested = () => [];
  const check = (
    agent,
    files = {},
    paths = testPaths,
    assertions = inventoryFor(paths),
    verify = attested,
    promotable = ["A", "B", "C"],
  ) =>
    checkSupportMatrix(
      { ...matrix, agents: [{ ...agent, receipts: Object.keys(files) }], paths },
      catalogue,
      (p) => p in files,
      (p) => current(files[p], agent, paths, assertions),
      assertions,
      verify,
      promotable,
    );
  /** The receipt as a run against the requirements under test would have written it. */
  const current = (r, agent, paths, assertions) => {
    if (r?.inputs?.profile !== CURRENT_PROFILE) return r;
    const route = paths.find((p) => p.id === r.route);
    if (!route) return r;
    const profile = qualificationProfile({ ...matrix, paths }, catalogue, assertions, agent, route);
    return { ...r, inputs: { ...r.inputs, profile } };
  };
  const structural = (problems) => problems;
  const needs = (tier, kind = tier === "C" ? "connected" : "installed", route = "acp-ask") =>
    `agent claude: tier ${tier} on ${route} needs a passing ${kind} receipt for claude 2.1.330 on linux-x64`;

  it("promotes nothing yet, whatever the receipts show", () => {
    expect(PROMOTABLE_TIERS).toEqual([]);
    for (const tier of ["A", "B", "C"]) {
      const kind = tier === "C" ? "connected" : "installed";
      expect(
        check(claude({ tier }), { "r.json": receipt({ kind }) }, testPaths, undefined, attested, PROMOTABLE_TIERS)[0],
      ).toBe(`agent claude: ${PROMOTION_DISABLED}`);
    }
  });

  it("refuses a verifier test receipt, whatever else it shows", () => {
    expect(check(claude({ tier: "A" }), { "r.json": receipt({ scope: "verifier-test" }) })).toEqual([
      `${needs("A")} (r.json: a verifier-test receipt, never evidence)`,
    ]);
  });

  it("counts a receipt only when its attestation verifies", () => {
    // A complete, passing receipt holds tier A and B when its attestation verifies.
    expect(check(claude({ tier: "A" }), { "r.json": receipt() })).toEqual([]);
    expect(check(claude({ tier: "B" }), { "r.json": receipt() })).toEqual([]);
    // The same receipt, with nothing verifying it (the function's default), is not evidence.
    const unverified = checkSupportMatrix(
      { ...matrix, agents: [{ ...claude({ tier: "A" }), receipts: ["r.json"] }], paths: testPaths },
      catalogue,
      (p) => p === "r.json",
      () => current(receipt(), claude(), testPaths, inventoryFor(testPaths)),
      inventoryFor(testPaths),
      undefined,
      ["A"],
    );
    expect(unverified).toEqual([`${needs("A")} (r.json: ${UNVERIFIED})`]);
    // A verifier's refusal is reported against the receipt, and the tier is not met.
    const forged = () => ["attestation does not verify: no matching attestations found"];
    expect(check(claude({ tier: "B" }), { "r.json": receipt() }, testPaths, inventoryFor(testPaths), forged)).toEqual([
      `${needs("A")} (r.json: attestation does not verify: no matching attestations found)`,
      `${needs("B")} (r.json: attestation does not verify: no matching attestations found)`,
    ]);
  });

  it("any tier without a pinned version, adapter version, host and exact build", () => {
    for (const bad of [null, { ...pin, adapterVersion: undefined }, { ...pin, build: "main" }])
      expect(structural(check(claude({ tier: "A", pin: bad })))).toEqual([
        "agent claude: tier A needs a pinned agent version, adapter version, host and exact build",
      ]);
  });

  it("any tier without a receipt: a file path or a named residual is not proof", () => {
    expect(structural(check(claude({ tier: "A" })))).toEqual([needs("A")]);
    expect(structural(check(claude({ tier: "B" })))).toEqual([needs("A"), needs("B")]);
  });

  it("a receipt for another version, adapter, host, route or build, or a synthetic one", () => {
    for (const [extra, why] of [
      [{ agentVersion: "2.1.329" }, "agentVersion 2.1.329"],
      [{ adapterVersion: "0.109.0" }, "adapterVersion 0.109.0"],
      [{ host: "darwin-arm64" }, "host darwin-arm64"],
      // A run on another route also ran against that route's requirements.
      [
        { route: "claude-native-hook" },
        "route claude-native-hook; r.json: ran against other requirements than the matrix states now (profile differs)",
      ],
      [{ build: "f".repeat(40) }, `build ${"f".repeat(40)}, expected ${build}`],
      [{ kind: "synthetic" }, "kind synthetic, needs installed"],
    ])
      expect(structural(check(claude({ tier: "A" }), { "r.json": receipt(extra) }))).toEqual([
        `${needs("A")} (r.json: ${why})`,
      ]);
  });

  it("a receipt with a duplicate, failed or missing case, or without the connectivity checks", () => {
    const dup = receipt({ cases: [...receipt().cases, { id: "L01", result: "pass" }] });
    expect(structural(check(claude({ tier: "B" }), { "r.json": dup }))[0]).toContain("duplicate case L01");
    const failed = receipt({ cases: [{ id: "L01", result: "fail" }] });
    expect(structural(check(claude({ tier: "B" }), { "r.json": failed }))[0]).toContain("a case did not pass");
    expect(structural(check(claude({ tier: "B" }), { "r.json": receipt({ cases: [] }) }))).toEqual([
      expect.stringContaining("missing L01,"),
    ]);
    // Cumulative: tier B without tier A's checks fails A, even with every case passing.
    expect(structural(check(claude({ tier: "B" }), { "r.json": receipt({ checks: {} }) }))).toEqual([
      expect.stringContaining(`${needs("A")} (r.json: needs checks.connects`),
      expect.stringContaining(`${needs("B")} (r.json: needs checks.connects`),
    ]);
  });

  const hookCases = casesFor(
    matrix.paths.find((p) => p.id === "claude-native-hook"),
    catalogue,
  );
  // The tier C rules on their own: a connected path that observes every lifecycle and bypass
  // case. The real matrix does not (B01 is unobserved on claude-connected), tested below.
  const idealPaths = structuredClone(testPaths);
  delete idealPaths.find((p) => p.id === "claude-connected").unobserved.B01;
  const connectedCases = qualifyingCases(
    idealPaths.find((p) => p.id === "claude-connected"),
    catalogue,
  );
  const checkC = (agent, files, paths = idealPaths, assertions) => check(agent, files, paths, assertions);
  const evidence = [denied];
  const onHook = (kind) =>
    kind === "connected"
      ? receipt({
          kind,
          route: "claude-connected",
          // A connected receipt makes no route-coverage claim; that is the installed receipts'.
          checks: { connects: "pass", unpinnedRuntimeRefused: "pass" },
          // Every call has its own tool_use id across the receipt.
          cases: connectedCases.map((id, i) => ({
            id,
            result: "pass",
            calls: evidence.map((call) => ({ ...call, toolUseId: `toolu_case${i}` })),
          })),
        })
      : receipt({
          kind,
          route: "claude-native-hook",
          cases: liveCases(hookCases),
        });
  const hookAgent = (extra = {}) => claude({ tier: "C", routes: ["claude-native-hook"], ...extra });

  it("tier C needs the installed receipts below it as well as the connected one", () => {
    expect(structural(checkC(hookAgent(), { "c.json": onHook("connected") }))).toEqual([
      `${needs("A", "installed", "claude-native-hook")} (c.json: kind connected, needs installed; c.json: route claude-connected; c.json: needs checks.uncoveredRoutesRefused passing)`,
      `${needs("B", "installed", "claude-native-hook")} (c.json: kind connected, needs installed; c.json: route claude-connected; c.json: missing ${hookCases.filter((id) => !connectedCases.includes(id)).join(",")}; c.json: needs checks.uncoveredRoutesRefused passing)`,
    ]);
    expect(structural(checkC(hookAgent(), { "i.json": onHook("installed"), "c.json": onHook("connected") }))).toEqual(
      [],
    );
  });

  it("tier C needs its connected receipt from a connected path that proves the route", () => {
    // An installed-style receipt relabelled connected, on the route itself, is not that.
    const relabelled = { ...onHook("installed"), kind: "connected" };
    expect(structural(checkC(hookAgent(), { "i.json": onHook("installed"), "c.json": relabelled }))).toEqual([
      expect.stringMatching(
        /^agent claude: tier C on claude-native-hook needs a passing connected receipt from claude-connected .*c\.json: route claude-native-hook/,
      ),
    ]);
    // acp-ask has no connected path proving it.
    expect(structural(check(claude({ tier: "C" }), { "i.json": receipt() }))).toEqual([
      "agent claude: tier C on acp-ask needs a connected path that proves it",
    ]);
  });

  it("tier C on a connected receipt whose calls do not carry independent evidence", () => {
    const withCalls = (calls) => {
      const r = onHook("connected");
      r.cases[0] = { ...r.cases[0], calls };
      return r;
    };
    // The narrow runtime check is the connected receipt's own; route coverage is not, and the
    // installed receipts still need it.
    const noRuntimeCheck = { ...onHook("connected"), checks: { connects: "pass", uncoveredRoutesRefused: "pass" } };
    expect(structural(checkC(hookAgent(), { "i.json": onHook("installed"), "c.json": noRuntimeCheck }))[0]).toContain(
      "c.json: needs checks.unpinnedRuntimeRefused passing",
    );
    const noRouteCoverage = { ...onHook("installed"), checks: { connects: "pass" } };
    expect(
      structural(checkC(hookAgent(), { "i.json": noRouteCoverage, "c.json": onHook("connected") })).join("\n"),
    ).toContain("i.json: needs checks.uncoveredRoutesRefused passing");
    const first = connectedCases[0];
    const ran = { ...denied.effectRef, after: "w" };
    for (const [calls, why, required = 1] of [
      [[], `case ${first}: no per-call evidence`],
      // The recorded effect is re-derived from the evidence, not trusted.
      [[{ ...denied, effectRef: ran }], `case ${first}: Write: its evidence shows effect observed, not none`],
      [[{ ...denied, outcome: "allow" }], `case ${first}: Write: outcome allow does not follow from its evidence`],
      [
        [{ ...denied, outcome: "ask", refusal: null }],
        `case ${first}: Write: outcome ask does not follow from its evidence`,
      ],
      [
        [{ ...denied, outcome: "ask", refusal: null, approvals: [{ toolCallId: "toolu_9_0", answer: "reject_once" }] }],
        `case ${first}: Write: an approval is bound to another call`,
      ],
      [
        [{ ...denied, toolUseId: undefined }],
        `case ${first}: Write: needs its tool_use id, approvals, refusal and effect evidence`,
      ],
      // An absence counted over the turn, not bound to this call, is not "none".
      [
        [
          {
            ...denied,
            tool: "mcp__github__create_issue",
            effectRef: { kind: "mcp", loggedFor: [], unaccountedLines: 1 },
          },
        ],
        `case ${first}: mcp__github__create_issue: its evidence shows effect indeterminate, not none`,
      ],
      [
        [{ ...denied, orcaDecision: "unobserved", unobservedBecause: "tool-not-offered", outcome: "unobserved:x" }],
        `case ${first}: Write: ORCA's decision was not observed (tool-not-offered)`,
      ],
      // A passing control in the same case cannot stand in for a required call left unobserved.
      [
        [
          denied,
          {
            ...denied,
            toolUseId: "toolu_x_1",
            orcaDecision: "unobserved",
            unobservedBecause: "edit-of-missing-file",
            outcome: "unobserved:x",
          },
        ],
        `case ${first}: Write: ORCA's decision was not observed (edit-of-missing-file)`,
        2,
      ],
      // The assertion and its accepted outcomes come from the committed inventory, not the receipt.
      [
        [{ ...denied, expected: undefined }],
        `case ${first}: Write: bound to nothing, the inventory's assertion accepts deny`,
      ],
      [
        [{ ...denied, expected: ["ask"] }],
        `case ${first}: Write: bound to ask, the inventory's assertion accepts deny`,
      ],
      [
        [
          {
            ...denied,
            expected: ["ask"],
            outcome: "ask",
            refusal: null,
            approvals: [{ toolCallId: "toolu_1_0", answer: "reject_once" }],
          },
        ],
        `case ${first}: Write: outcome ask is not one its assertion accepts (deny)`,
      ],
      [[{ ...denied, tool: "Edit" }], `case ${first}: Edit: the inventory's call 1 is Write`],
      [[denied, { ...denied, toolUseId: "toolu_x_1" }], `case ${first}: 2 calls, the inventory requires 1`],
      [[denied, denied], `tool_use id used by more than one call: toolu_1_0`],
      [
        [{ strayApprovals: [{ toolCallId: "toolu_9_0", title: "Write a.md" }] }],
        `case ${first}: an approval matched no call of its turn`,
      ],
    ]) {
      const assertions = inventoryFor(idealPaths);
      assertions.paths["claude-connected"][first] = [{ tool: "Write", expected: ["deny"], calls: required }];
      const problems = structural(
        checkC(hookAgent(), { "i.json": onHook("installed"), "c.json": withCalls(calls) }, idealPaths, assertions),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(
        "tier C on claude-native-hook needs a passing connected receipt from claude-connected",
      );
      expect(problems[0]).toContain(`c.json: ${why}`);
    }
  });

  it("tier C when the committed assertion inventory does not list the case or the route", () => {
    const first = connectedCases[0];
    const files = { "i.json": onHook("installed"), "c.json": onHook("connected") };
    const noCase = inventoryFor(idealPaths);
    delete noCase.paths["claude-connected"][first];
    const problems = checkC(hookAgent(), files, idealPaths, noCase);
    expect(problems[0]).toBe(`path claude-connected: case ${first} has no committed assertion inventory`);
    expect(problems.join("\n")).toContain(`c.json: case ${first}: not in the assertion inventory`);
    const noRoute = { format: "orca-706-assertions/1", paths: {} };
    expect(checkC(hookAgent(), files, idealPaths, noRoute).join("\n")).toContain(
      "c.json: no committed assertion inventory for route claude-connected",
    );
  });

  it("the committed assertion inventory lists exactly the cases the connected path runs", () => {
    const assertions = loadAssertions();
    const connected = matrix.paths.find((p) => p.id === "claude-connected");
    expect(Object.keys(assertions.paths["claude-connected"]).sort()).toEqual(casesFor(connected, catalogue).sort());
  });

  it("tier C when its connected path excludes a lifecycle case, named residual or not", () => {
    const paths = structuredClone(idealPaths);
    const connected = paths.find((p) => p.id === "claude-connected");
    connected.capabilities = connected.capabilities.filter((c) => c !== "answerer");
    connected.excluded.L08 = "Pretend this path could not reach ORCA's answerer at all.";
    const agent = hookAgent({ residualRisks: ["L08: not followed through the live agent"] });
    expect(structural(check(agent, { "i.json": onHook("installed"), "c.json": onHook("connected") }, paths))).toEqual([
      "agent claude: tier C on claude-native-hook excludes lifecycle case L08 on claude-connected",
    ]);
  });

  it("tier C when its connected path cannot observe ORCA's decision for a bypass case", () => {
    const paths = structuredClone(testPaths);
    paths.find((p) => p.id === "claude-connected").unobserved.B01 = "Pretend the agent refuses these calls first.";
    expect(
      structural(checkC(hookAgent(), { "i.json": onHook("installed"), "c.json": onHook("connected") }, paths)),
    ).toEqual([
      "agent claude: tier C on claude-native-hook does not observe ORCA's decision for bypass case B01 on claude-connected",
    ]);
  });

  it("only a connected path lists unobserved cases, and only cases it runs", () => {
    const paths = structuredClone(matrix.paths);
    paths.find((p) => p.id === "acp-ask").unobserved = { L01: "Not a connected path, so it cannot say this." };
    paths.find((p) => p.id === "claude-connected").unobserved.F01 = "It does not run this case at all.";
    expect(checkSupportMatrix({ ...matrix, paths }, catalogue)).toEqual([
      "path acp-ask: only a connected path lists unobserved cases",
      "path claude-connected: lists F01 as unobserved, but does not run it",
    ]);
  });

  it("a connected path is not a route, and proves only a route", () => {
    const paths = structuredClone(matrix.paths);
    paths.find((p) => p.id === "claude-connected").proves = "claude-connected";
    paths.find((p) => p.id === "acp-ask").proves = "claude-native-hook";
    expect(check(claude({ routes: ["claude-connected"] }), {}, paths)).toEqual([
      "path acp-ask: only a connected path proves a route",
      "path claude-connected: proves claude-connected, which is not a route path",
      "agent claude: route claude-connected is a connected path, not a route",
    ]);
  });

  it("a receipt that does not exist", () => {
    expect(
      checkSupportMatrix(
        { ...matrix, agents: [claude({ receipts: ["tools/guard-qualification/receipts/nope.json"] })] },
        catalogue,
      ),
    ).toEqual(["agent claude: receipt tools/guard-qualification/receipts/nope.json does not exist"]);
  });

  it("a case neither run nor excluded, and an exclusion of a case the path can run", () => {
    const paths = structuredClone(matrix.paths);
    const hook = paths.find((p) => p.id === "claude-native-hook");
    delete hook.excluded.L08;
    hook.excluded.L01 = "Not run here for a reason somebody made up.";
    expect(checkSupportMatrix({ ...matrix, paths }, catalogue)).toEqual([
      "path claude-native-hook: excludes L01, which it can run; run it instead",
      "path claude-native-hook: case L08 is neither run nor excluded with a reason",
    ]);
  });
});

for (const path of PATHS) {
  const listed = matrix.paths.find((p) => p.id === path.id);
  const runs = casesFor(listed, catalogue);
  const receipt = { path: path.id, cases: [], excluded: listed.excluded ?? {} };
  receipts.set(path.id, receipt);

  describe(`path ${path.id}`, () => {
    let world;
    let now;
    beforeEach(async () => {
      // Rule lifetimes are judged by Date.now on both routes; only Date is faked, so file I/O
      // and timers behave normally.
      now = Date.parse("2026-11-23T10:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"], now });
      world = await createWorld({ now: () => Date.now(), setNow: (ms) => vi.setSystemTime(ms) }, path);
    });
    afterEach(async () => {
      vi.useRealTimers();
      await world.dispose();
    });

    for (const c of catalogue.cases.filter((x) => runs.includes(x.id))) {
      it(`${c.id} ${c.title}`, async () => {
        try {
          await SCENARIOS[c.id](world, path);
          receipt.cases.push({ id: c.id, contract: c.contract, result: "pass" });
        } catch (error) {
          receipt.cases.push({ id: c.id, contract: c.contract, result: "fail" });
          throw error;
        }
      });
    }
  });
}

afterAll(async () => {
  const dir = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  for (const [id, receipt] of receipts) {
    await writeFile(
      join(dir, `enforcement-${id}.json`),
      `${JSON.stringify({ format: "orca-enforcement-receipt/1", kind: "synthetic", node: process.version, ...receipt }, null, 2)}\n`,
    );
  }
});
