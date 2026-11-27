/**
 * The installed receipt for the Claude Agent SDK route (#1128), for the `claude-sdk` row: the
 * person's own Claude Code at the pinned version, driven through the pinned Agent SDK by the
 * daemon's session factory for a `driver: claude-agent-sdk` agent with `nativeToolHook:
 * experimental`, against a scripted model stand-in, so no account, key or spend is involved.
 *
 * What ran is what the receipt names. The factory, the bridge it opens and the SDK it drives are
 * one bundle (`installed/claude-sdk-factory.js`, built by `childBundle`) that this run imports
 * and opens every session through; `inputs.bridge.sha256` is that file's digest. The Claude Code
 * image is read from the running process (`/proc/<pid>/exe`), and the settings the SDK handed it
 * (`--setting-sources`, `--permission-mode`) from that process's own command line.
 *
 * - `checks.connects`: the factory admits a session and a workspace write takes effect.
 * - `uncoveredRoutes`: every route the row lists as unsupported, shown refused here.
 * - `cases`: every case of `claude-sdk-hook` the live runner (`claude-sdk-connected`) can make
 *   and observe, run live, with each call's independent evidence and ORCA's decision. The
 *   route's other cases (`notRun`) are not in this receipt: a live agent cannot make them, or
 *   Claude refuses them before ORCA answers. They run on the route itself in the #706 suite.
 * - Lifecycle evidence for tier B (#1129), under `lifecycle`, each call's effect observed apart
 *   from ORCA: `checks.cancelledNoEffect` (a pending ask whose turn is cancelled has no effect,
 *   shown again after a wait, for an MCP call and a file write), `checks.freshSessionFreshDecision`
 *   (a new session asks again, runs nothing unanswered, and runs each call on a one-time answer
 *   bound to it; on this route that holds for the MCP call too), and
 *   `checks.decisionTimeoutBlocks` (a call whose policy cannot be read within ORCA's decision
 *   timeout is blocked and nothing runs). A Claude Code that could not block on a failed hook is
 *   not the pinned image, and the unsupported-route probe shows that refused.
 *
 * `claude-sdk-acceptance.yml` runs this with ORCA_CLAUDE_SDK_CLAUDE and
 * ORCA_ENFORCEMENT_RECEIPT_DIR set and keeps the receipt it writes, unsigned. Without them only
 * the agreement checks run. No tier rests on it until a signed run records it (#1128).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { closeSync, constants as fsConstants, existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_SDK_DECISION_TIMEOUT_MS,
  CLAUDE_SDK_VERIFIED_PAIRS,
  permissionPolicyPath,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import {
  REPO_ROOT,
  casesFor,
  installedCaseProblems,
  installedInputProblems,
  lifecycleEvidenceProblems,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
  qualificationProfile,
  rowReceiptProblems,
  uncoveredRouteProblems,
} from "../guard-qualification/check-support-matrix.js";
import { SCENARIOS } from "../guard-qualification/scenarios.js";
import { createWorld } from "../guard-qualification/world.js";
import { modelStandIn } from "../guard-qualification/connected/model-stand-in.js";
import { claudeSdkConnected } from "../guard-qualification/connected/claude-sdk.js";
import { effectFrom } from "../guard-qualification/connected/evidence.js";
import { allowOnlyFixture, effectAgain, record } from "../guard-qualification/installed/lifecycle.js";

const CLAUDE = process.env["ORCA_CLAUDE_SDK_CLAUDE"];
const ROUTE = "claude-sdk-hook";
const SDK = "@anthropic-ai/claude-agent-sdk";
const catalogue = loadCatalogue();
const matrix = loadMatrix();
const route = matrix.paths.find((p) => p.id === ROUTE);
const runner = matrix.paths.find((p) => p.id === route.installed?.live);
const row = matrix.agents.find((a) => a.id === "claude-sdk");

/** The route's cases the live runner makes and observes; the rest are not in this receipt. */
const liveCases = casesFor(route, catalogue).filter(
  (id) => runner && casesFor(runner, catalogue).includes(id) && !(id in (runner.unobserved ?? {})),
);
const notRun = Object.fromEntries(
  casesFor(route, catalogue)
    .filter((id) => !liveCases.includes(id))
    .map((id) => [
      id,
      id in (runner?.unobserved ?? {})
        ? `Claude refuses the call before ORCA answers: ${runner.unobserved[id]}`
        : "A live agent cannot make this call; it runs on claude-sdk-hook in the #706 suite.",
    ]),
);

const realWorld = () =>
  createWorld({
    now: Date.now,
    setNow: (t) => new Promise((done) => setTimeout(done, Math.max(0, t - Date.now()))),
  });

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * How each of the row's unsupported routes is shown refused on the installed agent. Every
 * entry the row lists must have one; the agreement test below holds them together.
 */
const PROBES = {
  "Remote sessions over SSH": {
    how: "the session factory refuses a driver: claude-agent-sdk session on an SSH host before any agent starts",
    async run(live, world) {
      const ssh = { id: "remote", spec: { id: "remote", type: "ssh" } };
      await expect(live.openSession(world, { host: ssh })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    },
  },
  "A Claude Code other than the pinned one": {
    how: "a session on the pinned image with one byte appended (same --version) is refused before any work",
    async run(live, world) {
      const altered = join(world.root, "altered-claude");
      await copyFile(CLAUDE, altered);
      await appendFile(altered, Buffer.from([0]));
      await chmod(altered, 0o755);
      await expect(live.openSession(world, { command: altered })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    },
  },
};

describe("the SDK installed run and the matrix agree", () => {
  it("the SDK route names claude-sdk-connected as its live runner", () => {
    expect(route.installed?.live).toBe("claude-sdk-connected");
    expect(runner?.proves).toBe(ROUTE);
  });

  it("every unsupported route of the claude-sdk row has a probe", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...row.unsupportedRoutes].sort());
  });

  it("the cases left out are exactly the ones the live runner cannot make or observe", () => {
    expect(liveCases.length).toBeGreaterThan(0);
    expect(Object.keys(notRun).sort()).toEqual(["A02", "A04", "B01", "F05", "P03"]);
  });
});

describe("reads what the SDK handed Claude from its command line", () => {
  it("takes --flag=value and --flag value, and an empty list as none", () => {
    expect(
      settingsFrom(["claude", "--setting-sources=", "--permission-mode=default", "--input-format", "stream-json"]),
    ).toEqual({ settingSources: [], permissionMode: "default" });
    expect(settingsFrom(["claude", "--setting-sources", "user,project", "--permission-mode", "plan"])).toEqual({
      settingSources: ["user", "project"],
      permissionMode: "plan",
    });
    // Absent flags are not taken as defaults.
    expect(settingsFrom(["claude"])).toEqual({ settingSources: undefined, permissionMode: undefined });
  });
});

describe("the timeout fixture releases its FIFO without blocking", () => {
  it.skipIf(process.platform === "win32")(
    "with no reader it removes the FIFO; with a waiting read it ends that read",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "orca-1129-fifo-"));
      try {
        const fifo = join(dir, "sidecar");
        execFileSync("mkfifo", [fifo]);
        expect(releaseFifo(fifo)).toBe(false);
        expect(existsSync(fifo)).toBe(false);
        expect(releaseFifo(fifo)).toBe(false);
        execFileSync("mkfifo", [fifo]);
        const read = readFile(fifo, "utf8");
        // Give the read time to reach open(), where it waits for a writer.
        await new Promise((done) => setTimeout(done, 300));
        expect(releaseFifo(fifo)).toBe(true);
        expect(existsSync(fifo)).toBe(false);
        expect(await read).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(CLAUDE === undefined || process.platform !== "linux")("installed: claude sdk (#1128)", () => {
  let model;
  let live;
  let bundle;
  const receipt = { route: ROUTE, cases: [], uncoveredRoutes: [], checks: {}, lifecycle: {}, observed: undefined };

  beforeAll(async () => {
    const built = childBundle("claude-sdk-factory-1128-installed", {
      entries: { factory: "tools/guard-qualification/installed/claude-sdk-factory.js" },
    });
    if (!built?.["factory"]) throw new Error("the session factory could not be bundled for this run");
    bundle = built["factory"];
    model = await modelStandIn();
    live = claudeSdkConnected({ claude: CLAUDE, model, factory: await import(pathToFileURL(bundle).href) });
  });

  afterAll(async () => {
    model?.server.close();
    if (model) await once(model.server, "close").catch(() => undefined);
    await writeReceipt(receipt, bundle);
  });

  it("connects: the factory admits the session, a workspace write takes effect, and Claude ran as pinned", async () => {
    const world = await realWorld();
    try {
      const got = await live.decide(world, { tool: "write", path: join(world.workspace, "connects.md") });
      expect(got.outcome, JSON.stringify(got.detail)).toBe("allow");
      // The session is still open: read what is running for it.
      const [proc, ...others] = await claudeChildren();
      expect(others, "one Claude Code for the one open session").toEqual([]);
      receipt.observed = proc;
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

  for (const c of catalogue.cases.filter((x) => liveCases.includes(x.id)))
    it(
      `${c.id} (live) ${c.title}`,
      async () => {
        const world = await realWorld();
        const entry = { id: c.id, contract: c.contract, via: "live", result: "fail" };
        receipt.cases.push(entry);
        try {
          await SCENARIOS[c.id](world, live);
          entry.result = "pass";
        } finally {
          entry.calls = world.callRecords ?? [];
          await world.dispose();
        }
      },
      // L02 waits out a real one-minute grant.
      300_000,
    );

  // #1129: a pending ask whose turn is cancelled has no effect, and a fresh session decides
  // afresh. On this route an MCP call asks once (Claude's ask, in canUseTool) and the relay
  // runs it on that one-time answer, so its positive case is shown too.
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
        const session = unanswered.detail.approvals[0]?.sessionId;
        const once = await live.decide(world, action, {
          expect: ["allow"],
          onAsk: allowOnlyFixture(session, sdkToolName),
        });
        expect(once.outcome, JSON.stringify(once.detail)).toBe("allow");
        expect(once.detail.approvals.map((a) => a.sessionId)).toEqual([session]);
        expect(once.detail.approvals.map((a) => a.answer)).toEqual(["allow_once"]);
        fresh.push(record(once));
      }
      const before = new Set(cancelled.map((got) => got.detail.toolUseId));
      expect(fresh.filter((r) => before.has(r.toolUseId))).toEqual([]);
      receipt.lifecycle.fresh = fresh;
      receipt.checks.freshSessionFreshDecision = "pass";
      // Re-derived from the evidence, as the matrix checker reads it.
      expect(lifecycleEvidenceProblems(receipt, ["cancelledNoEffect", "freshSessionFreshDecision"])).toEqual([]);
    } finally {
      await world.dispose();
    }
  }, 300_000);

  // #1129: a decision that cannot be made in time blocks. In a session already shown live and
  // deciding (a first command runs), the policy sidecar becomes a FIFO nobody writes, so ORCA's
  // policy read hangs. With every command allowed by rule, only that hang can stop the next
  // one. Its decision time is measured between the model stand-in handing Claude the call and
  // receiving its result, so session startup is outside it; a refusal for any other reason
  // would come sooner than the deadline. The read is then released without blocking, and a
  // third command in the same session runs at once, so nothing is left waiting.
  it("decision timeout: a call whose policy cannot be read in time is blocked, and nothing runs", async () => {
    const world = await realWorld();
    const sidecar = permissionPolicyPath(world.configDir);
    let release = () => false;
    try {
      world.configured = { rules: [{ match: { kind: "execute" }, decision: "allow" }] };
      const touch = (name) => ({ tool: "shell", command: `touch ${join(world.workspace, name)}` });
      const ready = await live.decide(world, touch("ready.txt"));
      expect(ready.outcome, JSON.stringify(ready.detail)).toBe("allow");
      expect(ready.detail.effect).toBe("observed");

      execFileSync("mkfifo", [sidecar]);
      release = () => releaseFifo(sidecar);
      const got = await live.decide(world, touch("timed-out.txt"));
      const decidedMs = decisionTime(model.log, got.detail.toolUseId);
      // A reader was still waiting on the FIFO when the call was decided: the hang was the read.
      const pendingRead = release();
      expect(got.outcome, JSON.stringify(got.detail)).toBe("block");
      expect(got.detail.effect).toBe("none");
      expect(got.detail.approvals).toEqual([]);
      expect(pendingRead, "ORCA's policy read was waiting on the sidecar").toBe(true);
      expect(decidedMs, "decided at ORCA's decision deadline, not before").toBeGreaterThanOrEqual(
        CLAUDE_SDK_DECISION_TIMEOUT_MS,
      );
      expect(decidedMs, "and soon after it").toBeLessThan(CLAUDE_SDK_DECISION_TIMEOUT_MS + 5_000);

      const after = await live.decide(world, touch("after.txt"));
      expect(after.outcome, JSON.stringify(after.detail)).toBe("allow");
      expect(after.detail.effect).toBe("observed");
      expect(decisionTime(model.log, after.detail.toolUseId)).toBeLessThan(CLAUDE_SDK_DECISION_TIMEOUT_MS);
      receipt.lifecycle.decisionTimeout = {
        ready: record(ready),
        timedOut: { ...record(got), decidedMs, timeoutMs: CLAUDE_SDK_DECISION_TIMEOUT_MS, pendingRead },
        after: record(after),
      };
      receipt.checks.decisionTimeoutBlocks = "pass";
    } finally {
      release();
      await world.dispose();
    }
  }, 120_000);

  it("binds the receipt to what ran: the SDK, the Claude Code image, the bundled bridge and its settings", async () => {
    expect(receipt.observed, "the connects check read the running Claude Code").toBeDefined();
    const { exeSha256, settingSources, permissionMode } = receipt.observed;
    const pair = CLAUDE_SDK_VERIFIED_PAIRS.find((p) => p.sdk === CLAUDE_AGENT_SDK_VERSION);
    expect(exeSha256, "the Claude Code that ran is the pinned image").toBe(pair?.images["linux-x64"]);
    receipt.inputs = {
      sdk: await sdkInput(),
      runtime: { version: pair.claudeCode, sha256: exeSha256 },
      bridge: { sha256: sha256(await readFile(bundle)), what: "installed/claude-sdk-factory.js, bundled" },
      settingSources,
      permissionMode,
      profile: qualificationProfile(matrix, catalogue, loadAssertions(), row, route),
    };
    receipt.agentSettings = {
      driver: "claude-agent-sdk",
      nativeToolHook: live.agent({ agentId: "x", root: "/x" }).nativeToolHook,
    };
    expect(receipt.agentSettings.nativeToolHook).toBe("experimental");
  });

  it("the receipt holds: every live case, every uncovered route, the inputs as the checker reads them", () => {
    receipt.checks.uncoveredRoutesRefused =
      uncoveredRouteProblems(receipt, row).length === 0 &&
      receipt.uncoveredRoutes.length === row.unsupportedRoutes.length
        ? "pass"
        : "fail";
    expect(receipt.checks.uncoveredRoutesRefused).toBe("pass");
    expect(receipt.cases.map((c) => c.id)).toEqual(liveCases);
    const shaped = { ...receipt, kind: "installed", driver: "claude-agent-sdk", agent: row.id };
    expect(rowReceiptProblems(shaped, row)).toEqual([]);
    expect(installedCaseProblems(shaped, liveCases, loadAssertions(), route)).toEqual([]);
    // The row is not pinned yet, so only the inputs' own shape and settings are checked here.
    const pinnedToThis = {
      ...row,
      pin: {
        artifacts: {
          sdkIntegrity: receipt.inputs.sdk.integrity,
          runtimeSha256: receipt.inputs.runtime.sha256,
          bridgeSha256: receipt.inputs.bridge.sha256,
        },
      },
    };
    expect(
      installedInputProblems(
        shaped,
        pinnedToThis,
        qualificationProfile(matrix, catalogue, loadAssertions(), row, route),
      ),
    ).toEqual([]);
    expect(model.log.errors, "the model stand-in answered every request").toEqual([]);
  });
});

/**
 * Release whatever waits to read `fifo`, without ever blocking: a writer opened non-blocking
 * succeeds only if a reader is waiting (else ENXIO), and closing it hands every waiting reader
 * an empty file. The FIFO is removed first, so no later read can wait on it. Returns whether a
 * reader was waiting; a second call finds nothing and returns false.
 */
function releaseFifo(fifo) {
  let fd;
  try {
    fd = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
  } catch {
    // ENXIO: no reader waiting. ENOENT: already released.
  }
  rmSync(fifo, { force: true });
  if (fd === undefined) return false;
  closeSync(fd);
  return true;
}

/** How long Claude took to answer a call, as the model stand-in saw it: tool use to its result. */
function decisionTime(log, toolUseId) {
  const call = log.calls.find((c) => c.toolUseId === toolUseId);
  const result = log.results.find((r) => r.toolUseId === toolUseId);
  if (!call || !result) throw new Error(`the model stand-in did not see ${toolUseId} and its result`);
  return result.at - call.at;
}

/** The tool's name on an ask from the SDK bridge (`askRequest` in permission-bridge.ts). */
const sdkToolName = (req) => req.toolCall?._meta?.claudeAgentSdk?.toolName;

/** `--setting-sources` and `--permission-mode` as a Claude Code command line carries them. */
export function settingsFrom(argv) {
  const value = (flag) => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
      if (argv[i] === flag) return argv[i + 1];
    }
    return undefined;
  };
  const sources = value("--setting-sources");
  return {
    settingSources: sources === undefined ? undefined : sources.split(",").filter(Boolean),
    permissionMode: value("--permission-mode"),
  };
}

/**
 * The Claude Code processes this run's sessions started: children of this process (the factory
 * runs in it) with a Claude Code command line, each with the digest of the image the kernel
 * runs for it and the settings its command line carries.
 */
async function claudeChildren() {
  const found = [];
  for (const pid of (await readdir("/proc")).filter((n) => /^\d+$/.test(n))) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      if (Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) !== process.pid) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (!argv.some((a) => a.startsWith("--permission-mode"))) continue;
      found.push({ pid: Number(pid), exeSha256: sha256(await readFile(`/proc/${pid}/exe`)), ...settingsFrom(argv) });
    } catch {
      // Gone, or not ours to read.
    }
  }
  return found;
}

/** The Agent SDK the bundle inlined: its installed version and the lockfile's integrity for it. */
async function sdkInput() {
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, "packages", "agents", "node_modules", SDK, "package.json"), "utf8"),
  );
  expect(manifest.version, "the installed SDK is the pinned one").toBe(CLAUDE_AGENT_SDK_VERSION);
  const lock = await readFile(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  const at = lock.indexOf(`\n  '${SDK}@${manifest.version}':\n`);
  const integrity = at < 0 ? undefined : /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lock.slice(at, at + 400))?.[1];
  expect(integrity, "the lockfile pins the SDK's integrity").toMatch(/^sha512-/);
  return { name: SDK, version: manifest.version, integrity };
}

async function writeReceipt(receipt, bundle) {
  const dir = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
  if (!dir || !CLAUDE || !bundle) return;
  const version = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  const build =
    process.env["GITHUB_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `claude-sdk-${ROUTE}.json`),
    `${JSON.stringify(
      {
        format: "orca-enforcement-receipt/1",
        kind: "installed",
        driver: "claude-agent-sdk",
        agent: row.id,
        agentVersion: version,
        sdkVersion: CLAUDE_AGENT_SDK_VERSION,
        host: `${process.platform}-${process.arch}`,
        route: ROUTE,
        build,
        node: process.version,
        inputs: receipt.inputs,
        agentSettings: receipt.agentSettings,
        checks: receipt.checks,
        lifecycle: receipt.lifecycle,
        uncoveredRoutes: receipt.uncoveredRoutes,
        cases: receipt.cases,
        notRun,
      },
      null,
      2,
    )}\n`,
  );
}
