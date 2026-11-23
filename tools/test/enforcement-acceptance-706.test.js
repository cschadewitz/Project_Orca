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
  PROMOTION_DISABLED,
  PROMOTION_ENABLED,
  REPO_ROOT,
  casesFor,
  checkSupportMatrix,
  loadCatalogue,
  loadMatrix,
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
  const pin = { agentVersion: "2.1.330", adapterVersion: "0.109.1", host: "linux-x64", build };
  const claude = (extra = {}) => ({
    ...structuredClone(matrix.agents.find((a) => a.id === "claude")),
    pin,
    ...extra,
  });
  const acpCases = casesFor(
    matrix.paths.find((p) => p.id === "acp-ask"),
    catalogue,
  );
  const receipt = (extra = {}) => ({
    format: "orca-enforcement-receipt/1",
    kind: "installed",
    agent: "claude",
    agentVersion: "2.1.330",
    adapterVersion: "0.109.1",
    host: "linux-x64",
    route: "acp-ask",
    build,
    checks: { connects: "pass", uncoveredRoutesRefused: "pass" },
    cases: acpCases.map((id) => ({ id, result: "pass" })),
    ...extra,
  });
  const check = (agent, files = {}, paths = matrix.paths) =>
    checkSupportMatrix(
      { ...matrix, agents: [{ ...agent, receipts: Object.keys(files) }], paths },
      catalogue,
      (p) => p in files,
      (p) => files[p],
    );
  /** Every promotion is refused today, so each result leads with that; the rest is structure. */
  const structural = (problems) => {
    expect(problems[0]).toBe(`agent claude: ${PROMOTION_DISABLED}`);
    return problems.slice(1);
  };
  const needs = (tier, kind = tier === "C" ? "connected" : "installed", route = "acp-ask") =>
    `agent claude: tier ${tier} on ${route} needs a passing ${kind} receipt for claude 2.1.330 on linux-x64`;

  it("refuses every promotion while receipts are not bound to a trusted run", () => {
    expect(PROMOTION_ENABLED).toBe(false);
    for (const tier of ["A", "B", "C"])
      expect(
        check(claude({ tier }), { "r.json": receipt({ kind: tier === "C" ? "connected" : "installed" }) })[0],
      ).toBe(`agent claude: ${PROMOTION_DISABLED}`);
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
      [{ route: "claude-native-hook" }, "route claude-native-hook"],
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
  const connectedCases = casesFor(
    matrix.paths.find((p) => p.id === "claude-connected"),
    catalogue,
  );
  const onHook = (kind) =>
    kind === "connected"
      ? receipt({ kind, route: "claude-connected", cases: connectedCases.map((id) => ({ id, result: "pass" })) })
      : receipt({ kind, route: "claude-native-hook", cases: hookCases.map((id) => ({ id, result: "pass" })) });
  const hookAgent = (extra = {}) => claude({ tier: "C", routes: ["claude-native-hook"], ...extra });

  it("tier C needs the installed receipts below it as well as the connected one", () => {
    expect(structural(check(hookAgent(), { "c.json": onHook("connected") }))).toEqual([
      `${needs("A", "installed", "claude-native-hook")} (c.json: kind connected, needs installed; c.json: route claude-connected)`,
      `${needs("B", "installed", "claude-native-hook")} (c.json: kind connected, needs installed; c.json: route claude-connected; c.json: missing ${hookCases.filter((id) => !connectedCases.includes(id)).join(",")})`,
    ]);
    expect(structural(check(hookAgent(), { "i.json": onHook("installed"), "c.json": onHook("connected") }))).toEqual(
      [],
    );
  });

  it("tier C needs its connected receipt from a connected path that proves the route", () => {
    // An installed-style receipt relabelled connected, on the route itself, is not that.
    const relabelled = { ...onHook("installed"), kind: "connected" };
    expect(structural(check(hookAgent(), { "i.json": onHook("installed"), "c.json": relabelled }))).toEqual([
      expect.stringMatching(
        /^agent claude: tier C on claude-native-hook needs a passing connected receipt from claude-connected .*c\.json: route claude-native-hook/,
      ),
    ]);
    // acp-ask has no connected path proving it.
    expect(structural(check(claude({ tier: "C" }), { "i.json": receipt() }))).toEqual([
      "agent claude: tier C on acp-ask needs a connected path that proves it",
    ]);
  });

  it("tier C when its connected path excludes a lifecycle case, named residual or not", () => {
    const paths = structuredClone(matrix.paths);
    const connected = paths.find((p) => p.id === "claude-connected");
    connected.capabilities = connected.capabilities.filter((c) => c !== "answerer");
    connected.excluded.L08 = "Pretend this path could not reach ORCA's answerer at all.";
    const agent = hookAgent({ residualRisks: ["L08: not followed through the live agent"] });
    expect(structural(check(agent, { "i.json": onHook("installed"), "c.json": onHook("connected") }, paths))).toEqual([
      "agent claude: tier C on claude-native-hook excludes lifecycle case L08 on claude-connected",
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
      world = await createWorld({ now: () => Date.now(), setNow: (ms) => vi.setSystemTime(ms) });
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
