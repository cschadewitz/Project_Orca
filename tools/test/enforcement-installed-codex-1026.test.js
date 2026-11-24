/**
 * The installed receipt for Codex's hook route (#1026), for tiers A and B in the support matrix:
 * the pinned Codex ACP adapter and Codex, with ORCA's pre-tool hook installed by the daemon's own
 * session factory (`nativeToolHook: experimental`) inside its fail-closed line, against a
 * scripted stand-in for the OpenAI Responses API, so no account, key or spend is involved.
 *
 * - `checks.connects`: the factory admits a session and a workspace write takes effect.
 * - `uncoveredRoutes`: every route the Codex row lists as unsupported, shown refused here.
 * - `cases`: every case the `codex-native-hook` route can run. A case a live agent can make
 *   runs live (`connected/codex.js`) with each call's independent evidence; the ones the
 *   matrix lists under the route's `installed.diagnostic` run on the hook program that same
 *   kind of session installed (`installed/codex-hook-program.js`), as diagnostics only.
 *
 * `guard-receipts.yml` runs this with ORCA_CODEX_ADAPTER, ORCA_CODEX_OTHER_RUNTIME and
 * ORCA_ENFORCEMENT_RECEIPT_DIR set, and attests the receipt it writes. Without them only the
 * agreement checks run. A receipt counts only through that attestation (`attestation.js`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODEX_HOOK_FAILED_REASON, CODEX_HOOK_VERIFIED_PAIRS } from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import {
  REPO_ROOT,
  assertedCases,
  casesFor,
  installedCaseProblems,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
  programEvidenceProblems,
  qualificationProfile,
  uncoveredRouteProblems,
} from "../guard-qualification/check-support-matrix.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";
import { codexModelStandIn } from "../guard-qualification/connected/codex-model-stand-in.js";
import { codexConnected } from "../guard-qualification/connected/codex.js";
import { codexHookProgram } from "../guard-qualification/installed/codex-hook-program.js";

const ADAPTER = process.env["ORCA_CODEX_ADAPTER"];
const OTHER_RUNTIME = process.env["ORCA_CODEX_OTHER_RUNTIME"];
const ROUTE = "codex-native-hook";
const FAILING_HOOK = fileURLToPath(
  new URL("../guard-qualification/installed/failing-hook-program.js", import.meta.url),
);
const catalogue = loadCatalogue();
const matrix = loadMatrix();
const route = matrix.paths.find((p) => p.id === ROUTE);
const row = matrix.agents.find((a) => a.id === "codex");
const program = route.installed?.diagnostic ?? {};

const realWorld = () =>
  createWorld({
    now: Date.now,
    setNow: (t) => new Promise((done) => setTimeout(done, Math.max(0, t - Date.now()))),
  });

/**
 * How each of the row's unsupported routes is shown refused on the installed agent. Every
 * entry the row lists must have one; the agreement test below holds them together.
 */
const PROBES = {
  "Remote sessions over SSH while the hook is on": {
    how: "the session factory refuses a hooked session on an SSH host before any agent starts",
    async run(live, world) {
      const ssh = { spec: { id: "remote", type: "ssh" } };
      await expect(live.openSession(world, { host: ssh })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    },
  },
  "A Codex other than the pinned one": {
    how: "a session whose adapter runs another Codex (CODEX_PATH) is refused before any work",
    async run(live, world) {
      await expect(live.openSession(world, { extraEnv: { CODEX_PATH: OTHER_RUNTIME } })).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
    },
  },
  "An agent whose own CODEX_CONFIG already sets hooks": {
    how: "a session whose agent's CODEX_CONFIG sets its own hooks is refused before any work",
    async run(live, world) {
      const own = { ...live.codexConfig(world), hooks: { PreToolUse: [] } };
      await expect(live.openSession(world, { extraEnv: { CODEX_CONFIG: JSON.stringify(own) } })).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        message: expect.stringContaining("already sets hooks"),
      });
    },
  },
  "Tool calls Codex makes without asking (its full-access mode, its own approval settings)": {
    how: "with Codex in full-access mode (no sandbox, no approvals of its own), a patch ORCA's rule denies does not land",
    async run(live, world) {
      world.configured = { rules: [{ match: { kind: "edit" }, decision: "deny" }] };
      const got = await live.decide(world, { tool: "write", path: join(world.workspace, "unasked.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("deny");
    },
  },
  "Hosted web search, which runs at the model provider": {
    how: "with the agent's own CODEX_CONFIG asking for live web search, the session offers the model no web_search tool",
    async run(live, world, model) {
      const own = { ...live.codexConfig(world), web_search: "live" };
      const session = await live.openSession(world, { extraEnv: { CODEX_CONFIG: JSON.stringify(own) } });
      try {
        const before = model.log.requests;
        await session.prompt("ready?");
        expect(model.log.requests).toBeGreaterThan(before);
        expect(model.log.offered).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]));
        expect(model.log.offered).not.toContain("web_search");
      } finally {
        await session.close();
      }
    },
  },
  "ORCA's hook program failing during the session (a crash, a bad exit or output, a hang)": {
    how: "a hook program that passes the startup probe and then exits 1, exits 2 quietly, answers with other output, is killed or hangs has every later shell call blocked by the fail-closed line ORCA installs around it",
    async run(live, world, _model, realHook) {
      for (const failure of ["exit-1", "quiet-exit-2", "garbage", "killed", "hang"]) {
        const w = await realWorld();
        try {
          w.configured = { default: "allow", rules: [] };
          w.sessionOptions = {
            hookScript: FAILING_HOOK,
            extraEnv: { ORCA_1026_REAL_HOOK: realHook, ORCA_1026_HOOK_FAILURE: failure },
          };
          const got = await live.decide(w, { tool: "shell", command: `echo ran-${failure}` });
          expect([failure, got.outcome, got.detail.effect], JSON.stringify(got.detail)).toEqual([
            failure,
            "block",
            "none",
          ]);
          expect(got.detail.result).toContain(CODEX_HOOK_FAILED_REASON);
        } finally {
          await w.dispose();
        }
      }
    },
  },
  "A call ORCA would ask a person about: Codex cannot pause a call from a hook": {
    how: "a patch outside the workspace, which ORCA asks about, is blocked by the hook and asks nobody",
    async run(live, world) {
      const got = await live.decide(world, { tool: "write", path: join(world.outside, "asked.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("ask");
      expect(got.detail.outcome).toBe("block");
      expect(world.asked).toEqual([]);
    },
  },
};

describe("the installed run and the matrix agree", () => {
  it("the hook route names a live runner and the program cases, each with a reason", () => {
    expect(route.installed?.live).toBe("codex-connected");
    for (const [id, reason] of Object.entries(program)) {
      expect(casesFor(route, catalogue)).toContain(id);
      expect(reason.length, id).toBeGreaterThanOrEqual(20);
    }
  });

  it("every live case is one the live runner can make and observe", () => {
    const connected = matrix.paths.find((p) => p.id === "codex-connected");
    const liveCases = casesFor(route, catalogue).filter((id) => !(id in program));
    for (const id of liveCases) {
      expect(casesFor(connected, catalogue), id).toContain(id);
      expect(connected.unobserved ?? {}, id).not.toHaveProperty(id);
    }
  });

  it("every unsupported route of the Codex row has a probe", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...row.unsupportedRoutes].sort());
  });
});

describe.skipIf(ADAPTER === undefined || OTHER_RUNTIME === undefined)("installed: codex (#1026)", () => {
  let model;
  let live;
  let hookProgram;
  let hookScript;
  const receipt = { route: ROUTE, cases: [], uncoveredRoutes: [], checks: {} };

  beforeAll(async () => {
    model = await codexModelStandIn();
    const entry = fileURLToPath(new URL("../../packages/agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("codex-pre-tool-hook-1026-installed", { entries: { hook: entry } });
    if (!built?.["hook"]) throw new Error("the hook program could not be built for this run");
    hookScript = built["hook"];
    live = codexConnected({ adapter: ADAPTER, hookScript, model });
    hookProgram = codexHookProgram({ live });
  });

  afterAll(async () => {
    model?.server.close();
    if (model) await once(model.server, "close").catch(() => undefined);
    await writeReceipt(receipt);
  });

  it("connects: the factory admits the session and a workspace write takes effect", async () => {
    const world = await realWorld();
    try {
      const got = await live.decide(world, { tool: "write", path: join(world.workspace, "connects.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("allow");
      // The settings this session installed are the ones the program cases run.
      await hookProgram.installed(world);
      receipt.checks.connects = "pass";
    } finally {
      await world.dispose();
    }
  }, 120_000);

  for (const name of Object.keys(PROBES))
    it(`uncovered route refused: ${name}`, async () => {
      const world = await realWorld();
      try {
        await PROBES[name].run(live, world, model, hookScript);
        receipt.uncoveredRoutes.push({ route: name, result: "refused", how: PROBES[name].how });
      } finally {
        await world.dispose();
      }
      // The failing-program probe waits out a hang the fail-closed line stops at 25 seconds.
    }, 240_000);

  for (const c of catalogue.cases.filter((x) => casesFor(route, catalogue).includes(x.id))) {
    const via = c.id in program ? "program" : "live";
    it(
      `${c.id} (${via}) ${c.title}`,
      async () => {
        const world = await realWorld();
        const entry = { id: c.id, contract: c.contract, via, result: "fail" };
        receipt.cases.push(entry);
        try {
          await SCENARIOS[c.id](world, via === "program" ? hookProgram : live);
          entry.result = "pass";
        } finally {
          entry.calls = (via === "live" ? world.callRecords : world.programCalls) ?? [];
          await world.dispose();
        }
      },
      // L02 waits out a real one-minute grant.
      300_000,
    );
  }

  it("binds the receipt to what ran: the adapter, the runtime image and the hook program", async () => {
    receipt.inputs = await inputsOf(hookProgram);
    receipt.installedSettings = hookProgram.settings();
  });

  it("the receipt holds: every case, every uncovered route, every live call's evidence", () => {
    receipt.checks.uncoveredRoutesRefused =
      uncoveredRouteProblems(receipt, row).length === 0 &&
      receipt.uncoveredRoutes.length === row.unsupportedRoutes.length
        ? "pass"
        : "fail";
    expect(receipt.checks.uncoveredRoutesRefused).toBe("pass");
    expect(receipt.cases.map((c) => c.id)).toEqual(casesFor(route, catalogue));
    expect(
      installedCaseProblems({ ...receipt, route: ROUTE }, assertedCases(route, catalogue), loadAssertions(), route),
    ).toEqual([]);
    // The diagnostics hold too, though they count toward no tier.
    expect(programEvidenceProblems({ ...receipt, route: ROUTE }, Object.keys(program), loadAssertions())).toEqual([]);
    expect(receipt.inputs.profile).toBe(qualificationProfile(matrix, catalogue, loadAssertions(), row, route));
    expect(model.log.errors, "the model stand-in answered every request").toEqual([]);
  });
});

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * What this run installed and ran: the adapter as its lockfile pins it, the Codex image beside
 * it (the one the session factory admitted, so the pair's pinned digest), ORCA's hook program
 * as the session installed it, and the qualification profile it ran against.
 */
async function inputsOf(hookProgram) {
  const root = join(ADAPTER, "..", "..", "..", "..", "..");
  const name = "@agentclientprotocol/codex-acp";
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const adapter = lock.packages[`node_modules/${name}`];
  const host = `${process.platform}-${process.arch}`;
  const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === adapter.version);
  const target = { "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl" }[host];
  const image = sha256(
    await readFile(join(root, "node_modules", "@openai", `codex-${host}`, "vendor", target ?? "", "bin", "codex")),
  );
  expect(image, "the Codex beside the adapter is the pinned image").toBe(pair?.images[host]);
  const words = /timeout -s KILL \d+ '(?:[^']|'\\'')*' ('(?:[^']|'\\'')*') '--codex'/.exec(
    hookProgram.settings().hooks.PreToolUse[0].hooks[0].command,
  );
  const program = words[1].slice(1, -1).replaceAll(`'\\''`, "'");
  return {
    adapter: { name, version: adapter.version, integrity: adapter.integrity },
    runtime: { version: pair.runtime, sha256: image },
    hookProgram: { sha256: sha256(await readFile(program)) },
    profile: qualificationProfile(matrix, catalogue, loadAssertions(), row, route),
  };
}

async function writeReceipt(receipt) {
  const dir = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
  if (!dir || !ADAPTER) return;
  const adapterVersion = JSON.parse(await readFile(join(ADAPTER, "..", "..", "package.json"), "utf8")).version;
  const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === adapterVersion);
  const build =
    process.env["GITHUB_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `codex-${ROUTE}.json`),
    `${JSON.stringify(
      {
        format: "orca-enforcement-receipt/1",
        kind: "installed",
        agent: "codex",
        agentVersion: pair?.runtime ?? null,
        adapterVersion,
        host: `${process.platform}-${process.arch}`,
        route: ROUTE,
        build,
        node: process.version,
        inputs: receipt.inputs,
        installedSettings: receipt.installedSettings,
        checks: receipt.checks,
        uncoveredRoutes: receipt.uncoveredRoutes,
        cases: receipt.cases,
        program,
      },
      null,
      2,
    )}\n`,
  );
}
