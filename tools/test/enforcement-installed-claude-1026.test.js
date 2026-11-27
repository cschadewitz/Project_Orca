/**
 * The installed receipt for Claude's hook route (#1026), for tiers A and B in the support
 * matrix: the pinned Claude ACP adapter and the Claude Code it bundles, with ORCA's pre-tool hook
 * installed by the daemon's own session factory (`nativeToolHook: experimental`), against a
 * scripted model stand-in, so no account, key or spend is involved.
 *
 * - `checks.connects`: the factory admits a session and a workspace write takes effect.
 * - `uncoveredRoutes`: every route the Claude row lists as unsupported, shown refused here.
 * - `checks.optInDefaultOff`: a config that never mentions the hook gets none (Claude's own
 *   allow lets a write ORCA's rule denies land), `on` is refused, and only the explicit
 *   `nativeToolHook: experimental` installs it (the same write is denied and has no effect).
 *   The receipt's `agentSettings` are the ORCA settings every case ran under.
 * - `checks.cancelledNoEffect`: a normally pending ask whose turn is cancelled has no effect,
 *   shown again after a wait, for an MCP call and a file write.
 * - `checks.freshSessionFreshDecision`: a new session for the same calls asks again and runs
 *   nothing unanswered; the write runs on a one-time answer bound to exactly it. An MCP call
 *   asks twice on this route (hook, then relay), so its positive case is left unverified.
 * - `checks.judgedAction`: with the experimental command judge on (ORCA's own judge, prepared
 *   against a provider stand-in), a command a judged rule is about carries the judge's advice
 *   to the person, still asks, runs nothing unanswered and runs on their one-time answer,
 *   whichever verdict the judge gave.
 *   Their per-call evidence is kept under `lifecycle`.
 * - `cases`: every case the `claude-native-hook` route can run. Each case the B claim asserts
 *   runs live (`connected/claude.js`), with each call's independent evidence and ORCA's
 *   decision observed. The ones the matrix lists under the route's `installed.diagnostic`
 *   (the row's `notAsserted`) run on the hook program that same kind of session installed
 *   (`installed/claude-hook-program.js`), as diagnostics that count toward no tier.
 *
 * `guard-receipts.yml` runs this with ORCA_CLAUDE_ADAPTER, ORCA_CLAUDE_OTHER_RUNTIME and
 * ORCA_ENFORCEMENT_RECEIPT_DIR set, and attests the receipt it writes. Without them only the
 * agreement checks run. A receipt counts only through that attestation (`attestation.js`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_HOOK_VERIFIED_PAIRS } from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import {
  REPO_ROOT,
  casesFor,
  assertedCases,
  installedCaseProblems,
  lifecycleEvidenceProblems,
  programEvidenceProblems,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
  qualificationProfile,
  uncoveredRouteProblems,
} from "../guard-qualification/check-support-matrix.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";
import { modelStandIn } from "../guard-qualification/connected/model-stand-in.js";
import { claudeConnected } from "../guard-qualification/connected/claude.js";
import { claudeHookProgram, installedPreToolHook } from "../guard-qualification/installed/claude-hook-program.js";
import { effectFrom } from "../guard-qualification/connected/evidence.js";
import { judgeStandIn } from "../guard-qualification/connected/judge-stand-in.js";
import { allowOnlyFixture, effectAgain, observe, record } from "../guard-qualification/installed/lifecycle.js";

const ADAPTER = process.env["ORCA_CLAUDE_ADAPTER"];
const OTHER_RUNTIME = process.env["ORCA_CLAUDE_OTHER_RUNTIME"];
const ROUTE = "claude-native-hook";
const catalogue = loadCatalogue();
const matrix = loadMatrix();
const route = matrix.paths.find((p) => p.id === ROUTE);
const row = matrix.agents.find((a) => a.id === "claude");
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
  "A Claude Code other than the pinned one": {
    how: "a session whose adapter runs another Claude Code (CLAUDE_CODE_EXECUTABLE) is refused before any work",
    async run(live, world) {
      await expect(
        live.openSession(world, { extraEnv: { CLAUDE_CODE_EXECUTABLE: OTHER_RUNTIME } }),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    },
  },
  "Tool calls Claude makes without asking (remembered grants, its own allow rules)": {
    how: "with Claude's own settings allowing every tool, a write ORCA's rule denies does not land",
    async run(live, world) {
      world.configured = { rules: [{ match: { kind: "edit" }, decision: "deny" }] };
      const got = await live.decide(world, { tool: "write", path: join(world.workspace, "remembered.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("deny");
    },
  },
};

describe("the installed run and the matrix agree", () => {
  it("the hook route names a live runner and the program cases, each with a reason", () => {
    expect(route.installed?.live).toBe("claude-connected");
    for (const [id, reason] of Object.entries(program)) {
      expect(casesFor(route, catalogue)).toContain(id);
      expect(reason.length, id).toBeGreaterThanOrEqual(20);
    }
  });

  it("every live case is one the live runner can make and observe", () => {
    const connected = matrix.paths.find((p) => p.id === "claude-connected");
    const liveCases = casesFor(route, catalogue).filter((id) => !(id in program));
    for (const id of liveCases) {
      expect(casesFor(connected, catalogue), id).toContain(id);
      expect(connected.unobserved ?? {}, id).not.toHaveProperty(id);
    }
  });

  it("every unsupported route of the Claude row has a probe", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...row.unsupportedRoutes].sort());
  });
});

describe("the after-wait observer takes only a verified absence as no effect", () => {
  const world = { root: "/nonexistent-orca-706" };
  const mcpGot = { detail: { effectRef: { kind: "mcp", callRef: "c1", loggedFor: [], unaccountedLines: 0 } } };
  const fileGot = (before) => ({
    detail: { effectRef: { kind: "file", path: "p", before, after: null, written: "w" } },
  });

  it("an MCP log it cannot read, or that is gone, is no evidence of absence", async () => {
    for (const read of [async () => ({ failed: "EACCES" }), async () => ({ missing: true })])
      expect(effectFrom(await effectAgain(world, mcpGot, {}, read))).toBe("indeterminate");
    expect(effectFrom(await effectAgain(world, mcpGot, {}, async () => ({ text: "" })))).toBe("none");
  });

  it("a target file it cannot read is no evidence; one missing as before is", async () => {
    expect(effectFrom(await effectAgain(world, fileGot(null), { path: "p" }, async () => ({ failed: "EACCES" })))).toBe(
      "indeterminate",
    );
    expect(effectFrom(await effectAgain(world, fileGot(null), { path: "p" }, async () => ({ missing: true })))).toBe(
      "none",
    );
    expect(effectFrom(await effectAgain(world, fileGot("abc"), { path: "p" }, async () => ({ missing: true })))).toBe(
      "indeterminate",
    );
  });

  it("reads a real unreadable file as a failure and a real missing one as missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-706-observe-"));
    try {
      expect(await observe(join(dir, "nope"))).toEqual({ missing: true });
      // A directory cannot be read as a file: a failed observation, not an absence.
      expect(await observe(dir)).toEqual({ failed: "EISDIR" });
      if (process.getuid?.() !== 0) {
        const locked = join(dir, "locked");
        await writeFile(locked, "x");
        await chmod(locked, 0o000);
        expect(await observe(locked)).toEqual({ failed: "EACCES" });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the simulated person allows only the one expected fixture", () => {
  const req = (over = {}) => ({
    sessionId: "s1",
    toolCall: { name: "Bash", rawInput: { command: "touch /w/a" } },
    options: [
      { optionId: "once", kind: "allow_once" },
      { optionId: "always", kind: "allow_always" },
    ],
    ...over,
  });
  const turn = [{ name: "Bash", input: { command: "touch /w/a" } }];

  it("answers the exact call once, in its session, with the one-time option", async () => {
    const allow = allowOnlyFixture("s1");
    expect(await allow(req(), turn)).toBe("once");
    expect(await allow(req(), turn)).toBeUndefined();
  });

  it("refuses another session, input, tool, turn shape or an ambiguous offer", async () => {
    const cases = [
      [req({ sessionId: "s2" }), turn],
      [req({ toolCall: { name: "Bash", rawInput: { command: "rm -rf /w" } } }), turn],
      [req({ toolCall: { name: "Write", rawInput: { command: "touch /w/a" } } }), turn],
      [req(), [...turn, ...turn]],
      [req(), undefined],
      [req({ toolCall: undefined }), turn],
      [
        req({
          options: [
            { optionId: "a", kind: "allow_once" },
            { optionId: "b", kind: "allow_once" },
          ],
        }),
        turn,
      ],
      [req({ options: [{ optionId: "always", kind: "allow_always" }] }), turn],
    ];
    for (const [r, t] of cases) expect(await allowOnlyFixture("s1")(r, t)).toBeUndefined();
    expect(await allowOnlyFixture(undefined)(req(), turn)).toBeUndefined();
  });
});

describe.skipIf(ADAPTER === undefined || OTHER_RUNTIME === undefined)("installed: claude (#1026)", () => {
  let model;
  let live;
  let hookProgram;
  const receipt = { route: ROUTE, cases: [], uncoveredRoutes: [], checks: {}, lifecycle: {} };

  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../packages/agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("claude-pre-tool-hook-1026-installed", { entries: { hook: entry } });
    if (!built?.["hook"]) throw new Error("the hook program could not be built for this run");
    live = claudeConnected({ adapter: ADAPTER, hookScript: built["hook"], model });
    hookProgram = claudeHookProgram({ live });
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
        await PROBES[name].run(live, world);
        receipt.uncoveredRoutes.push({ route: name, result: "refused", how: PROBES[name].how });
      } finally {
        await world.dispose();
      }
    }, 120_000);

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

  it("opt-in: off by default, and on only with nativeToolHook: experimental", async () => {
    const denyEdits = { rules: [{ match: { kind: "edit" }, decision: "deny" }] };
    const off = await realWorld();
    try {
      off.configured = denyEdits;
      off.nativeToolHook = null;
      expect(live.agent(off, {}, null).nativeToolHook, "a config without the field").toBeUndefined();
      const got = await live.decide(off, { tool: "write", path: join(off.workspace, "default.md") });
      // No hook was installed, so Claude's own allow ran the write ORCA's rule denies.
      expect(off.installedMeta, "no hook settings were handed to the agent").toBeUndefined();
      expect(got.detail.effect, JSON.stringify(got.detail)).toBe("observed");
      receipt.lifecycle.optIn = { default: [record(got)] };
    } finally {
      await off.dispose();
    }
    const on = await realWorld();
    try {
      await expect(live.openSession(on, { nativeToolHook: "on" })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
      receipt.lifecycle.optIn.on = "refused";
    } finally {
      await on.dispose();
    }
    const opted = await realWorld();
    try {
      opted.configured = denyEdits;
      const got = await live.decide(opted, { tool: "write", path: join(opted.workspace, "opted.md") });
      expect(() => installedPreToolHook(opted.installedMeta)).not.toThrow();
      expect(got.outcome, JSON.stringify(got.detail)).toBe("deny");
      expect(got.detail.effect).toBe("none");
      receipt.lifecycle.optIn.experimental = [record(got)];
      receipt.agentSettings = { nativeToolHook: live.agent(opted).nativeToolHook };
    } finally {
      await opted.dispose();
    }
    expect(receipt.agentSettings).toEqual({ nativeToolHook: "experimental" });
    receipt.checks.optInDefaultOff = "pass";
  }, 300_000);

  it("cancellation: a pending ask whose turn is cancelled has no effect, and a fresh session decides afresh", async () => {
    const world = await realWorld();
    try {
      // The MCP recorder's log exists before the calls, so later a missing log is a failed
      // observation, not an absence of calls.
      await writeFile(join(world.root, "mcp-calls.jsonl"), "", { flag: "a" });
      // Edits ask (MCP calls ask by default), so both calls wait on a person.
      world.configured = { rules: [{ match: { kind: "edit" }, decision: "ask" }] };
      const calls = [
        { tool: "mcp", server: "github", name: "create_issue" },
        { tool: "write", path: join(world.workspace, "cancelled.md") },
      ];
      const cancelled = [];
      for (const action of calls) {
        const turn = new AbortController();
        const got = await live.decide(world, action, {
          expect: ["ask"],
          signal: turn.signal,
          // The ask reached ORCA's human channel; the turn is cancelled and nobody answers.
          onAsk: () => {
            turn.abort();
            return new Promise(() => {});
          },
        });
        expect(got.outcome, JSON.stringify(got.detail)).toBe("ask");
        expect(got.detail.approvals.map((a) => a.answer)).toEqual(["pending"]);
        cancelled.push(got);
      }
      // Anything the cancelled calls set off would have landed by now: look again.
      await new Promise((done) => setTimeout(done, 5_000));
      const later = await Promise.all(cancelled.map((got, i) => effectAgain(world, got, calls[i])));
      expect(later.map((ref) => effectFrom(ref))).toEqual(["none", "none"]);
      receipt.lifecycle.cancelled = cancelled.map((got, i) => ({ ...record(got), afterWait: later[i] }));
      receipt.checks.cancelledNoEffect = "pass";

      // A fresh session: the same calls ask again, run nothing unanswered, and run only on their own answer.
      await world.connected.session.close();
      world.connected = undefined;
      const fresh = [];
      for (const action of calls) {
        const unanswered = await live.decide(world, action, { expect: ["ask"], noAnswerer: true });
        expect(unanswered.outcome, JSON.stringify(unanswered.detail)).toBe("ask");
        fresh.push(record(unanswered));
        // An MCP call asks twice on this route (the hook, then ORCA's relay), so one bound
        // answer cannot run it; its positive case stays unverified rather than answering more.
        if (action.tool === "mcp") continue;
        const session = unanswered.detail.approvals[0]?.sessionId;
        const once = await live.decide(world, action, { expect: ["allow"], onAsk: allowOnlyFixture(session) });
        expect(once.outcome, JSON.stringify(once.detail)).toBe("allow");
        expect(once.detail.approvals.map((a) => a.sessionId)).toEqual([session]);
        expect(once.detail.approvals.map((a) => a.answer)).toEqual(["allow_once"]);
        fresh.push(record(once));
      }
      const before = new Set(cancelled.map((got) => got.detail.toolUseId));
      expect(fresh.filter((r) => before.has(r.toolUseId))).toEqual([]);
      receipt.lifecycle.fresh = fresh;
      receipt.lifecycle.unverified = [
        "fresh session: an MCP call's one-time allow (the hook and ORCA's relay each ask, so one bound answer does not run it)",
      ];
      receipt.checks.freshSessionFreshDecision = "pass";
    } finally {
      await world.dispose();
    }
  }, 300_000);

  it("judged command: the judge advises, the person is still asked, and only their answer runs it", async () => {
    const judge = await judgeStandIn();
    const world = await realWorld();
    try {
      world.judge = await judge.prepare(world.agentId, ["command"]);
      world.configured = {
        rules: [{ match: { kind: "execute" }, judge: { criterion: "Creating an empty marker file is fine." } }],
      };
      const judged = [];
      for (const verdict of ["covered", "not-covered"]) {
        judge.state.verdict = verdict;
        const command = `touch ${join(world.workspace, `judged-${verdict}.txt`)}`;
        const asked = judge.state.requests.length;
        const unanswered = await live.decide(world, { tool: "shell", command }, { expect: ["ask"], noAnswerer: true });
        const session = unanswered.detail.approvals[0]?.sessionId;
        const answered = await live.decide(
          world,
          { tool: "shell", command },
          { expect: ["allow"], onAsk: allowOnlyFixture(session) },
        );
        expect(unanswered.outcome, JSON.stringify(unanswered.detail)).toBe("ask");
        expect(answered.outcome, JSON.stringify(answered.detail)).toBe("allow");
        for (const got of [unanswered, answered])
          expect(got.detail.approvals.map((a) => a.judged)).toEqual([
            expect.objectContaining({ verdict, kind: "command", advisory: true }),
          ]);
        // The judge was asked about each call, and the person still answered it.
        expect(judge.state.requests.length - asked).toBe(2);
        judged.push(record(unanswered), record(answered));
      }
      receipt.lifecycle.judged = judged;
      receipt.judge = { provider: "anthropic (stand-in)", classes: ["command"], requests: judge.state.requests.length };
      receipt.checks.judgedAction = "pass";
    } finally {
      await world.dispose();
      await judge.close();
    }
  }, 300_000);

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
    // The opt-in and lifecycle checks hold on their own evidence, as the matrix checker re-derives it.
    expect(lifecycleEvidenceProblems(receipt)).toEqual([]);
    expect(model.log.errors, "the model stand-in answered every request").toEqual([]);
  });
});

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * What this run installed and ran: the adapter as its lockfile pins it, the Claude Code image
 * beside it (the one the session factory admitted, so the pair's pinned digest), ORCA's hook
 * program as the session installed it, and the qualification profile it ran against.
 */
async function inputsOf(hookProgram) {
  const root = join(ADAPTER, "..", "..", "..", "..", "..");
  const name = "@agentclientprotocol/claude-agent-acp";
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const adapter = lock.packages[`node_modules/${name}`];
  const host = `${process.platform}-${process.arch}`;
  const pair = CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === adapter.version);
  const image = sha256(
    await readFile(join(root, "node_modules", "@anthropic-ai", `claude-agent-sdk-${host}`, "claude")),
  );
  expect(image, "the Claude Code beside the adapter is the pinned image").toBe(pair?.images[host]);
  const hook = hookProgram.settings().hooks.PreToolUse[0].hooks[0];
  const program = hook.args.slice(0, -1);
  expect(program.length, "the hook runs one program file").toBe(1);
  return {
    adapter: { name, version: adapter.version, integrity: adapter.integrity },
    runtime: { version: pair.runtime, sha256: image },
    hookProgram: { sha256: sha256(await readFile(program[0])) },
    profile: qualificationProfile(matrix, catalogue, loadAssertions(), row, route),
  };
}

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
    join(dir, `claude-${ROUTE}.json`),
    `${JSON.stringify(
      {
        format: "orca-enforcement-receipt/1",
        kind: "installed",
        agent: "claude",
        agentVersion: pair?.runtime ?? null,
        adapterVersion,
        host: `${process.platform}-${process.arch}`,
        route: ROUTE,
        build,
        node: process.version,
        inputs: receipt.inputs,
        installedSettings: receipt.installedSettings,
        agentSettings: receipt.agentSettings,
        checks: receipt.checks,
        lifecycle: receipt.lifecycle,
        judge: receipt.judge,
        uncoveredRoutes: receipt.uncoveredRoutes,
        cases: receipt.cases,
        program,
      },
      null,
      2,
    )}\n`,
  );
}
