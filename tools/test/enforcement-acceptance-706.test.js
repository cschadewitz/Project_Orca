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
    expect(PATHS.map((p) => p.id).sort()).toEqual(matrix.paths.map((p) => p.id).sort());
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
  const claude = () => structuredClone(matrix.agents.find((a) => a.id === "claude"));
  const check = (agents, paths = matrix.paths) => checkSupportMatrix({ ...matrix, agents, paths }, catalogue);

  it("tier B without an installed run", () => {
    expect(check([{ ...claude(), tier: "B" }])).toContain(
      "agent claude: tier B needs an installed acceptance run (evidence.installed)",
    );
  });

  it("tier C without a connected receipt", () => {
    const agent = { ...claude(), tier: "C" };
    agent.evidence.installed = "tools/guard-qualification/cases.json";
    expect(check([agent])).toContain("agent claude: tier C needs a connected proof receipt (evidence.connected)");
  });

  it("tier C over an excluded lifecycle case not named as a residual risk", () => {
    const agent = { ...claude(), tier: "C", routes: ["claude-native-hook"] };
    agent.evidence.installed = "tools/guard-qualification/cases.json";
    agent.evidence.connected = "tools/guard-qualification/cases.json";
    expect(check([agent])).toContain(
      "agent claude: tier C on claude-native-hook excludes lifecycle case L08; name it in residualRisks",
    );
  });

  it("evidence that does not exist, and tier A without listed gaps", () => {
    const agent = { ...claude(), unsupportedRoutes: [] };
    agent.evidence.connectivity = ["docs/no-such-file.md"];
    expect(check([agent])).toEqual([
      "agent claude: evidence docs/no-such-file.md does not exist",
      "agent claude: tier A must list the routes ORCA does not cover",
    ]);
  });

  it("a case neither run nor excluded, and an exclusion of a case the path can run", () => {
    const paths = structuredClone(matrix.paths);
    const hook = paths.find((p) => p.id === "claude-native-hook");
    delete hook.excluded.L08;
    hook.excluded.L01 = "Not run here for a reason somebody made up.";
    expect(check(matrix.agents, paths)).toEqual([
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
