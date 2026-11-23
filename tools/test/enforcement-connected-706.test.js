/**
 * #706 connected proof: the suite's cases through a live Claude Code, its ACP adapter and ORCA's
 * session factory with the pre-tool hook installed (`connected/claude.js`), against a model
 * stand-in, so no account, key or model spend is involved. `claude-hook-acceptance.yml`
 * installs the pinned adapter and runs this with `ORCA_CLAUDE_ADAPTER` (its entry point) and
 * `ORCA_CLAUDE_OTHER_RUNTIME` (a Claude Code that is not the pinned one) set; without them only
 * the agreement checks run.
 *
 * Set ORCA_ENFORCEMENT_RECEIPT_DIR to also write the run's connected receipt: the pinned pair,
 * host, ORCA commit, per-case results with every call's evidence (refusal text, approvals for
 * that call, observed effect), the exclusions and every call Claude Code refused on its own
 * before ORCA could answer. A receipt written here is evidence for review; the support
 * matrix promotes nothing on it until receipts are bound to a trusted run.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_HOOK_VERIFIED_PAIRS } from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import {
  REPO_ROOT,
  casesFor,
  connectedEvidenceProblems,
  loadCatalogue,
  loadMatrix,
  qualifyingCases,
} from "../guard-qualification/check-support-matrix.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";
import { modelStandIn } from "../guard-qualification/connected/model-stand-in.js";
import { claudeConnected } from "../guard-qualification/connected/claude.js";

const ADAPTER = process.env["ORCA_CLAUDE_ADAPTER"];
const OTHER_RUNTIME = process.env["ORCA_CLAUDE_OTHER_RUNTIME"];
const catalogue = loadCatalogue();
const matrix = loadMatrix();
const listed = matrix.paths.find((p) => p.id === "claude-connected");

/** A world on the real clock: the hook is another process and reads real time. */
const realWorld = () =>
  createWorld({
    now: Date.now,
    setNow: (t) => new Promise((done) => setTimeout(done, Math.max(0, t - Date.now()))),
  });

describe("the connected path and the matrix agree", () => {
  it("claude-connected is in the matrix with the same capabilities, proving the hook route", () => {
    const path = claudeConnected({ adapter: "", hookScript: "", model: { url: "", log: {} } });
    expect(listed).toBeDefined();
    expect(listed.connected).toBe(true);
    expect(listed.proves).toBe("claude-native-hook");
    expect([...path.capabilities].sort()).toEqual([...listed.capabilities].sort());
  });
});

describe.skipIf(ADAPTER === undefined || OTHER_RUNTIME === undefined)("connected: claude (#706)", () => {
  let model;
  let path;
  const receipt = { cases: [], unobservedCalls: [], checks: {} };

  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../packages/agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("claude-pre-tool-hook-706-connected", { entries: { hook: entry } });
    if (!built?.["hook"]) throw new Error("the hook program could not be built for this run");
    path = claudeConnected({ adapter: ADAPTER, hookScript: built["hook"], model });
  });

  afterAll(async () => {
    model?.server.close();
    if (model) await once(model.server, "close").catch(() => undefined);
    await writeReceipt(receipt);
  });

  it("connects: the factory admits the session and a workspace write takes effect", async () => {
    const world = await realWorld();
    try {
      const target = join(world.workspace, "connects.md");
      const got = await path.decide(world, { tool: "write", path: target });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("allow");
      receipt.checks.connects = "pass";
    } finally {
      await world.dispose();
    }
  }, 120_000);

  // One check, for one case: a session whose Claude Code is not the pinned image is refused. It
  // says nothing about other routes the agent may have, so it is not uncoveredRoutesRefused.
  it("unpinned runtime: refuses a session on a Claude Code other than the pinned one, before any work", async () => {
    const world = await realWorld();
    try {
      await expect(
        path.openSession(world, { extraEnv: { CLAUDE_CODE_EXECUTABLE: OTHER_RUNTIME } }),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
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
        // Every call's evidence goes in the receipt: the refusal text, the approvals for that
        // exact call, and the independently observed effect, kept apart.
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
    for (const id of Object.keys(listed.unobserved ?? {}))
      expect(connectedEvidenceProblems(receipt, [id]), id).toEqual([
        `case ${id}: ORCA's decision was not observed for any call`,
      ]);
    expect(model.log.errors, "the model stand-in answered every request").toEqual([]);
  });
});

async function writeReceipt(receipt) {
  const dir = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
  if (!dir || !ADAPTER) return;
  const adapterVersion = JSON.parse(await readFile(join(ADAPTER, "..", "..", "package.json"), "utf8")).version;
  const pair = CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === adapterVersion);
  const build =
    process.env["GITHUB_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "enforcement-claude-connected.json"),
    `${JSON.stringify(
      {
        format: "orca-enforcement-receipt/1",
        kind: "connected",
        agent: "claude",
        agentVersion: pair?.runtime ?? null,
        adapterVersion,
        host: `${process.platform}-${process.arch}`,
        route: "claude-connected",
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
