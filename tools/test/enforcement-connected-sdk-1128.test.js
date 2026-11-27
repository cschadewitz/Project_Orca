/**
 * #706 connected proof on the Claude Agent SDK route (#1128): the suite's cases through a live
 * Claude Code driven by the Claude Agent SDK, in a session ORCA's own factory opened for a
 * `driver: claude-agent-sdk` agent (`connected/claude-sdk.js`), against a model stand-in, so no
 * account, key or model spend is involved. `claude-sdk-acceptance.yml` installs the pinned
 * Claude Code and runs this with `ORCA_CLAUDE_SDK_CLAUDE` set; without it only the agreement
 * checks run.
 *
 * Set ORCA_ENFORCEMENT_RECEIPT_DIR to also write the run's connected receipt, in the same shape
 * as `claude-connected`'s. It is evidence for review: the route holds no tier.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_SDK_VERIFIED_PAIRS } from "@orca/agents";
import {
  REPO_ROOT,
  casesFor,
  connectedEvidenceProblems,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
  qualifyingCases,
} from "../guard-qualification/check-support-matrix.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";
import { modelStandIn } from "../guard-qualification/connected/model-stand-in.js";
import { claudeSdkConnected } from "../guard-qualification/connected/claude-sdk.js";

const CLAUDE = process.env["ORCA_CLAUDE_SDK_CLAUDE"];
const catalogue = loadCatalogue();
const matrix = loadMatrix();
const listed = matrix.paths.find((p) => p.id === "claude-sdk-connected");

/** A world on the real clock: Claude Code runs in real time. */
const realWorld = () =>
  createWorld({
    now: Date.now,
    setNow: (t) => new Promise((done) => setTimeout(done, Math.max(0, t - Date.now()))),
  });

describe("the SDK connected path and the matrix agree", () => {
  it("claude-sdk-connected is in the matrix with the same capabilities, proving the SDK route", () => {
    const path = claudeSdkConnected({ claude: "", model: { url: "", log: {} } });
    expect(listed).toBeDefined();
    expect(listed.connected).toBe(true);
    expect(listed.proves).toBe("claude-sdk-hook");
    expect([...path.capabilities].sort()).toEqual([...listed.capabilities].sort());
  });

  it("the committed assertion inventory lists exactly the cases the SDK connected path runs", () => {
    expect(Object.keys(loadAssertions().paths["claude-sdk-connected"]).sort()).toEqual(
      casesFor(listed, catalogue).sort(),
    );
  });
});

describe.skipIf(CLAUDE === undefined || process.platform === "win32")("connected: claude sdk (#1128)", () => {
  let model;
  let path;
  const receipt = { route: "claude-sdk-connected", cases: [], unobservedCalls: [], checks: {} };

  beforeAll(async () => {
    model = await modelStandIn();
    path = claudeSdkConnected({ claude: CLAUDE, model });
  });

  afterAll(async () => {
    model?.server.close();
    if (model) await once(model.server, "close").catch(() => undefined);
    await writeReceipt(receipt);
  });

  it("connects: the factory admits the session and a workspace write takes effect", async () => {
    const world = await realWorld();
    try {
      const got = await path.decide(world, { tool: "write", path: join(world.workspace, "connects.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("allow");
      receipt.checks.connects = "pass";
    } finally {
      await world.dispose();
    }
  }, 120_000);

  // One check, for one case: a session whose Claude Code is not the pinned image is refused. The
  // other image is the pinned one a byte longer, so `claude --version` still names the pin.
  it("unpinned runtime: refuses a session on a Claude Code other than the pinned image, before any work", async () => {
    const world = await realWorld();
    try {
      const altered = join(world.root, "altered-claude");
      await copyFile(CLAUDE, altered);
      await appendFile(altered, Buffer.from([0]));
      await chmod(altered, 0o755);
      await expect(path.openSession(world, { command: altered })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
      receipt.checks.unpinnedRuntimeRefused = "pass";
    } finally {
      await world.dispose();
    }
  }, 120_000);

  const runs = new Set(casesFor(listed, catalogue));
  for (const c of catalogue.cases.filter((x) => runs.has(x.id)))
    it(
      `${c.id} ${c.title}`,
      async () => {
        const world = await realWorld();
        const entry = { id: c.id, contract: c.contract, result: "fail" };
        receipt.cases.push(entry);
        try {
          await SCENARIOS[c.id](world, path);
          entry.result = "pass";
        } finally {
          entry.calls = world.callRecords ?? [];
          for (const r of world.agentRefusals ?? []) receipt.unobservedCalls.push({ case: c.id, ...r });
          await world.dispose();
        }
      },
      // L02 waits out a real one-minute grant.
      300_000,
    );

  it("every call of every case carries evidence the matrix checker accepts", () => {
    expect(receipt.cases.map((c) => c.id)).toEqual([...runs]);
    expect(connectedEvidenceProblems(receipt, qualifyingCases(listed, catalogue))).toEqual([]);
    // A case listed as unobserved really had no call where ORCA's decision was observed.
    for (const id of Object.keys(listed.unobserved ?? {})) {
      const problems = connectedEvidenceProblems(receipt, [id]);
      expect(problems.length, id).toBeGreaterThan(0);
      for (const p of problems)
        expect(p, id).toMatch(new RegExp(`^case ${id}: .*ORCA's decision was not observed \\(`));
    }
    expect(model.log.errors, "the model stand-in answered every request").toEqual([]);
  });
});

async function writeReceipt(receipt) {
  const dir = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
  if (!dir || !CLAUDE) return;
  const version = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  const pair = CLAUDE_SDK_VERIFIED_PAIRS.find((p) => p.claudeCode === version);
  const build =
    process.env["GITHUB_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "enforcement-claude-sdk-connected.json"),
    `${JSON.stringify(
      {
        format: "orca-enforcement-receipt/1",
        kind: "connected",
        agent: "claude",
        agentVersion: version,
        sdkVersion: pair?.sdk ?? null,
        host: `${process.platform}-${process.arch}`,
        route: "claude-sdk-connected",
        build,
        node: process.version,
        checks: receipt.checks,
        cases: receipt.cases,
        excluded: listed.excluded ?? {},
        unobserved: listed.unobserved ?? {},
        unobservedCalls: receipt.unobservedCalls,
      },
      null,
      2,
    )}\n`,
  );
}
