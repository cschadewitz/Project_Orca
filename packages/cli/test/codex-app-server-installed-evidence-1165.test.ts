/**
 * Installed-session evidence for the Codex app-server route (#1165), checks-only. The pinned
 * Codex (ORCA_CODEX_BIN, its native binary as npm installs it) runs `codex app-server` in
 * sessions opened with the options ORCA's session factory maps for this driver
 * (`codexAppServerSessionOptions`), against a scripted stand-in for the model, so no account,
 * key or spend is involved.
 *
 * Codex runs with its native protections as the driver gives them, none relaxed: approval
 * policy `on-request`, approvals reviewer `user` (ORCA's ask bridge), a `workspace-write`
 * sandbox, and every MCP call asked about. The test never gives an affirmative approval
 * itself: an ask that ORCA's policy puts to a person is recorded and declined, so every allow
 * here is ORCA's configured rule.
 *
 * Each case records three things apart:
 *
 * - **ORCA's decision**: what ORCA's policy decided for each ask Codex sent (`onPermission`);
 * - **Codex's decision**: each ask Codex sent and the answer that went back, read by the harness
 *   itself at the process's stdio (methods, ids and outcomes only, never params or values), each
 *   correlated with ORCA's decision for it; whether ORCA asked for a thread; and the thread
 *   policy ORCA verified. Evidence the harness could not read is `unverified`, never zero;
 * - **the observed effect**: the workspace's whole tree (every path and its bytes' digest)
 *   before and after, read apart from ORCA and Codex.
 *
 * A case is `verified` only when those agree. One that cannot establish ORCA's decision under
 * the native safeguards (Codex asked nothing, or its sandbox kept an allowed call from
 * running) is `unverified` with the reason, and does not fail the run; only contradicting
 * evidence is `failed`. A case that shows a documented limitation is `known limitation`. The
 * record goes to `ORCA_ENFORCEMENT_RECEIPT_DIR` when set, however the run ends, and says whether
 * it is complete and which cases it lacks. **It is evidence, not a tier or a
 * scoped label**: nothing here signs, stages, promotes or changes a protection.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import {
  CODEX_VERIFIED_IMAGES,
  LocalHost,
  openCodexAppServerSession,
  type AgentProcessHandle,
  type AgentSession,
  type CodexVerifiedConfig,
  type OpenSessionOptions,
} from "@orca/agents";
import { codexAppServerSessionOptions } from "../src/codex-app-server-factory.js";
import { modelStandIn, script, shell, type ModelStandIn, type Step } from "./codex-model-stand-in.js";
import { correlate as correlateWire, newWire, tapStdio, type Decision, type Wire } from "./codex-app-server-wire.js";

const CODEX = process.env["ORCA_CODEX_BIN"];
const RECEIPT_DIR = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RECORD = "codex-app-server-installed-evidence.json";

/** The thread policy the driver runs every session with, as the factory maps it. */
const SETTINGS = {
  driver: "codex-app-server",
  thread: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" },
  mcp: { default_tools_approval_mode: "prompt" },
  model: "gpt-5 (scripted stand-in)",
  personAnswers: "every ask put to a person is recorded and declined: no affirmative approval is given by the test",
} as const;

/** What these cases do not cover, and why; recorded so nothing reads as more than it is. */
const NOT_COVERED = [
  "known limitation: Codex decides which calls run inside its sandbox without asking, so ORCA has no decision for them (the sandboxed-unasked case records one)",
  "known limitation: Codex's turn/interrupt ends the turn without always stopping a command it started; ORCA reports such a cancel as unconfirmed or not carried out and takes no further prompt (#1299; the shell-cancel case records one)",
  "not covered: ORCA's optional pre-tool hook on this route (#1161), whose runner keeps Codex's fail-open behaviour",
  "not covered: the judge; on this driver it advises on commands only",
  "not covered: SSH hosts (#1166); the driver runs on ORCA's own machine only",
  "not covered: a real model, which may make calls in shapes the stand-in does not",
];

/** A command the model asks to run outside the sandbox, which Codex asks about under `on-request`. */
const escalated = (cmd: string): Step => ({
  tool: "exec_command",
  args: { cmd, sandbox_permissions: "require_escalated", justification: "ORCA's #1165 evidence" },
});

/**
 * A stdio MCP server with one tool, `touch`, annotated read-only (Codex's own approval would let
 * it through), that writes only the target the harness names on its command line, once.
 */
const MCP_TOUCH_SERVER = `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
const target = process.argv[2];
if (process.argv.length !== 3 || !target || !isAbsolute(target)) process.exit(2);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const refuse = (id, message) => out({ jsonrpc: "2.0", id, error: { code: -32602, message } });
createInterface({ input: process.stdin }).on("line", (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "touch", version: "1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "write the one file this server was started for", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
  else if (m.method === "tools/call") {
    if (m.params?.name !== "touch") return refuse(m.id, "unknown tool");
    try { writeFileSync(target, "mcp", { flag: "wx" }); } catch { return refuse(m.id, "target exists or cannot be created"); }
    out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;
const MCP_CALL: Step = { tool: "touch", namespace: "mcp__t", args: {} };

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, by relative path, with its content's digest; links and others by kind. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = relative(dir, path);
      if (entry.isDirectory()) {
        out[`${name}/`] = "dir";
        await walk(path);
      } else if (entry.isFile()) out[name] = sha256(await readFile(path));
      else out[name] = entry.isSymbolicLink() ? "link" : "other";
    }
  };
  await walk(dir);
  return out;
}

/** What changed between two trees: path -> [before, after]. Directories alone are left out: a sandboxed run leaves its mount points. */
function changes(before: Record<string, string>, after: Record<string, string>) {
  const out: Record<string, [string | null, string | null]> = {};
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!path.endsWith("/") && before[path] !== after[path]) out[path] = [before[path] ?? null, after[path] ?? null];
  return out;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

type Status = "verified" | "unverified" | "failed" | "known limitation";
const statusOf = (failures: string[], unverified: string[]): Status =>
  failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";

describe.skipIf(CODEX === undefined)("installed-session evidence for the Codex app-server route (#1165)", () => {
  let model: ModelStandIn;
  let root: string;
  const results: Record<string, unknown>[] = [];

  beforeAll(async () => {
    model = await modelStandIn();
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1165-evidence-")));
  });
  afterAll(async () => {
    model.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Codex's config.toml: `more` lines that are top-level keys go first, table lines after ORCA's provider. */
  const configToml = (more: string[] = []) => {
    const table = more.findIndex((l) => l.startsWith("["));
    const top = table === -1 ? more : more.slice(0, table);
    const tables = table === -1 ? [] : more.slice(table);
    return (
      [
        ...top,
        `model = "gpt-5"`,
        `model_provider = "standin"`,
        `[model_providers.standin]`,
        `name = "standin"`,
        `base_url = "${model.url}"`,
        `wire_api = "responses"`,
        `env_key = "ORCA_1165_KEY"`,
        ...tables,
      ].join("\n") + "\n"
    );
  };

  /** One disposable workspace and Codex home, and a session opened with the factory's options for this driver. */
  const open = async (
    id: string,
    rules: unknown[],
    more: { command?: string; mcpTarget?: string; codexConfig?: string[]; base?: string } = {},
  ) => {
    const base = more.base ?? join(root, id);
    const workspace = join(base, "work");
    const codexHome = join(base, "codex-home");
    await mkdir(workspace, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), configToml(more.codexConfig));
    const mcpServers = [];
    if (more.mcpTarget) {
      const server = join(base, "mcp-touch.mjs");
      await writeFile(server, MCP_TOUCH_SERVER);
      mcpServers.push({ name: "t", command: process.execPath, args: [server, join(workspace, more.mcpTarget)] });
    }
    const decisions: Decision[] = [];
    const personAsked: { title: string; answer: "decline" }[] = [];
    const askPermission: OpenSessionOptions["askPermission"] = async (req) => {
      personAsked.push({ title: req.toolCall.title ?? "", answer: "decline" });
      return "decline";
    };
    const verified: CodexVerifiedConfig[] = [];
    const host = new LocalHost({ id: "local", type: "local" });
    const spawned: AgentProcessHandle[] = [];
    const wires: Wire[] = [];
    const spawnAgent = host.spawnAgent.bind(host);
    host.spawnAgent = async (...args: Parameters<typeof spawnAgent>) => {
      const handle = await spawnAgent(...args);
      spawned.push(handle);
      const wire = newWire();
      wires.push(wire);
      tapStdio(handle, wire);
      return handle;
    };
    const agent = AgentSpecSchema.parse({
      id: "codex",
      command: more.command ?? CODEX,
      driver: "codex-app-server",
      env: { CODEX_HOME: codexHome, ORCA_1165_KEY: "sk-orca-1165-test", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      permissions: { default: "ask", rules },
      mcpServers,
    });
    const options = codexAppServerSessionOptions(
      {
        host,
        agent,
        cwd: workspace,
        askPermission,
        onPermission: (info) =>
          decisions.push({
            ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
            title: info.title,
            decision: info.decision,
          }),
        logger: silentLogger,
      },
      "0.0.0-evidence",
    );
    const opened = openCodexAppServerSession({ ...options, onVerifiedConfig: (v) => verified.push(v) });
    return { opened, workspace, decisions, personAsked, verified, spawned, wires };
  };

  /** ORCA's policy decisions (`allow`, `deny`, `ask:*`), apart from the driver's own unasked declines. */
  const policyDecisions = (decisions: readonly Decision[]) => decisions.filter((d) => !d.decision.startsWith("codex:"));
  type Opened = Awaited<ReturnType<typeof open>>;
  /** Each ask on the wire with ORCA's decision and the answer that went back (`codex-app-server-wire.ts`). */
  const correlate = (s: Opened) => correlateWire(s.wires, s.decisions, s.spawned.length);
  const nativeOf = (s: Opened) => ({
    threadPolicy: s.verified.at(-1)
      ? {
          approvalPolicy: s.verified.at(-1)!.approvalPolicy,
          approvalsReviewer: s.verified.at(-1)!.approvalsReviewer,
          sandbox: s.verified.at(-1)!.sandbox,
        }
      : "unverified",
    processesStarted: s.spawned.length,
    asksSentByCodex: correlate(s).askCount,
    exchangeObserved: correlate(s).observed,
    threadRequests: s.wires.flatMap((w) => w.threadRequests),
    asks: correlate(s).rows,
    unaskedDeclines: s.decisions.filter((d) => d.decision.startsWith("codex:")),
    askedThePerson: s.personAsked,
  });

  interface AskCase {
    id: string;
    action: string;
    rule: unknown;
    steps: Step[];
    /** The workspace's change expected: path -> exact content, or nothing at all. */
    expect: Record<string, string>;
    /** How many ORCA decisions the case expects, one per call Codex asks about. */
    asks: number;
    mcpTarget?: string;
  }
  const ASK_CASES: AskCase[] = [
    {
      id: "shell-allow",
      action: "escalated shell: echo orca-1165 > shell-allowed.txt",
      rule: { match: { kind: "execute", titlePattern: "echo orca-1165 > shell-allowed\\.txt" }, decision: "allow" },
      steps: [escalated("echo orca-1165 > shell-allowed.txt")],
      expect: { "shell-allowed.txt": "orca-1165\n" },
      asks: 1,
    },
    {
      id: "shell-allow-asks-again",
      action: "escalated shell, twice: echo orca-1165 >> again.txt; an allow covers one call only",
      rule: { match: { kind: "execute", titlePattern: "echo orca-1165 >> again\\.txt" }, decision: "allow" },
      steps: [escalated("echo orca-1165 >> again.txt"), escalated("echo orca-1165 >> again.txt")],
      expect: { "again.txt": "orca-1165\norca-1165\n" },
      asks: 2,
    },
    {
      id: "shell-deny",
      action: "escalated shell: echo orca-1165 > shell-denied.txt",
      rule: { match: { kind: "execute", titlePattern: "echo orca-1165 > shell-denied\\.txt" }, decision: "deny" },
      steps: [escalated("echo orca-1165 > shell-denied.txt")],
      expect: {},
      asks: 1,
    },
    {
      id: "mcp-readonly-allow",
      action: "mcp: t.touch, annotated read-only (its one target: mcp-allowed.txt)",
      rule: { match: { kind: "other", titlePattern: "^t: touch$" }, decision: "allow" },
      steps: [MCP_CALL],
      expect: { "mcp-allowed.txt": "mcp" },
      asks: 1,
      mcpTarget: "mcp-allowed.txt",
    },
    {
      id: "mcp-readonly-deny",
      action: "mcp: t.touch, annotated read-only (its one target: mcp-denied.txt)",
      rule: { match: { kind: "other", titlePattern: "^t: touch$" }, decision: "deny" },
      steps: [MCP_CALL],
      expect: {},
      asks: 1,
      mcpTarget: "mcp-denied.txt",
    },
  ];

  for (const c of ASK_CASES)
    it(`${c.id}: ${c.action}`, async () => {
      const allow = Object.keys(c.expect).length > 0;
      const s = await open(c.id, [c.rule], c.mcpTarget ? { mcpTarget: c.mcpTarget } : {});
      const session = await s.opened;
      const before = await tree(s.workspace);
      const outputsBefore = model.outputs.length;
      try {
        await session.prompt(script(...c.steps), { timeoutMs: 90_000 });
      } finally {
        await session.close();
      }
      const after = await tree(s.workspace);
      const changed = changes(before, after);
      const outputs = model.outputs.slice(outputsBefore);
      const expected = Object.fromEntries(
        Object.entries(c.expect).map(([path, content]) => [path, [null, sha256(content)] as [null, string]]),
      );
      const decided = policyDecisions(s.decisions).map((d) => d.decision);
      const effect = Object.keys(changed).length === 0 ? "none" : sameJson(changed, expected) ? "expected" : "other";
      const failures: string[] = [];
      if (!allow && effect !== "none") failures.push("an effect was observed after ORCA was configured to deny");
      if (effect === "other") failures.push("the workspace changed other than expected");
      if (decided.some((d) => d !== (allow ? "allow" : "deny")))
        failures.push(`ORCA decided ${decided.join(", ")}, not ${allow ? "allow" : "deny"}`);
      if (s.personAsked.length > 0) failures.push("ORCA put a call to a person that its rule decides");
      const wire = correlate(s);
      failures.push(...wire.failures);
      const unverified: string[] = [...wire.unverified];
      if (wire.observed && wire.asks.length !== c.asks)
        unverified.push(`Codex sent ${wire.asks.length} asks, not ${c.asks}`);
      if (allow && effect === "none")
        unverified.push("ORCA allowed the call, but it had no effect under the native safeguards (sandbox)");
      const status = statusOf(failures, unverified);
      results.push({
        id: c.id,
        action: c.action,
        rule: c.rule,
        status,
        reasons: failures.length > 0 ? failures : unverified,
        orca: { configured: allow ? "allow" : "deny", decisions: policyDecisions(s.decisions) },
        native: nativeOf(s),
        effect: { expected: allow ? "exactly this change" : "no effect", observed: effect, before, after, changed },
        toolOutput: outputs,
      });
      expect(failures).toEqual([]);
    }, 180_000);

  it("sandboxed-unasked: a call Codex runs in its sandbox without asking gets no ORCA decision (known limitation)", async () => {
    // ORCA is configured to deny it; Codex does not ask about a plain sandboxed command under
    // on-request, so ORCA's rule is never consulted. Recorded as the route's limitation; its
    // effect is whatever the sandbox does on this machine.
    const rule = { match: { kind: "execute", titlePattern: "unasked\\.txt" }, decision: "deny" };
    const s = await open("sandboxed-unasked", [rule]);
    const session = await s.opened;
    const before = await tree(s.workspace);
    const outputsBefore = model.outputs.length;
    try {
      await session.prompt(script(shell("echo orca-1165 > unasked.txt")), { timeoutMs: 90_000 });
    } finally {
      await session.close();
    }
    const after = await tree(s.workspace);
    const changed = changes(before, after);
    const decided = policyDecisions(s.decisions);
    const wire = correlate(s);
    const failures: string[] = [...wire.failures];
    // That ORCA decided otherwise than configured contradicts the evidence; a deny that held is not this limitation.
    if (decided.some((d) => d.decision !== "deny"))
      failures.push(`ORCA decided ${decided.map((d) => d.decision).join(", ")}`);
    // The limitation is shown only by the wire: Codex sent no ask at all for the call.
    const unasked = wire.observed && wire.asks.length === 0 && decided.length === 0;
    const status: Status = failures.length
      ? "failed"
      : unasked
        ? "known limitation"
        : wire.unverified.length
          ? "unverified"
          : "verified";
    results.push({
      id: "sandboxed-unasked",
      action: "sandboxed shell (no escalation): echo orca-1165 > unasked.txt",
      rule,
      status,
      reasons:
        failures.length > 0
          ? failures
          : unasked
            ? [
                "Codex sent no ask for the call (read on the wire) and ran or tried it in its sandbox; ORCA's deny rule was never consulted",
              ]
            : wire.unverified,
      orca: { configured: "deny", decisions: decided },
      native: nativeOf(s),
      effect: { observed: Object.keys(changed).length ? "changed" : "none", before, after, changed },
      toolOutput: model.outputs.slice(outputsBefore),
    });
    expect(failures).toEqual([]);
  }, 180_000);

  it("shell-cancel: no late completion marker after an allowed command's turn is cancelled", async () => {
    const cmd = "echo started > started.txt; sleep 4; echo done > done.txt";
    const rule = {
      match: { kind: "execute", titlePattern: "echo started > started\\.txt; sleep 4" },
      decision: "allow",
    };
    const s = await open("shell-cancel", [rule]);
    const session = await s.opened;
    const before = await tree(s.workspace);
    const outputsBefore = model.outputs.length;
    let started = false;
    let cancelled = false;
    // Times relative to the prompt, for telling a late completion from one before the cancel.
    const t0 = Date.now();
    const at: { startedSeen?: number; cancelSent?: number; cancelReturned?: number; turnEnded?: number } = {};
    let stopReason: string | undefined;
    /** ORCA's own account of whether the cancel ended the command (#1299). */
    let orcaCancel: string | undefined;
    try {
      const turn = session.prompt(script(escalated(cmd)), { timeoutMs: 90_000 });
      for (const until = Date.now() + 30_000; Date.now() < until;) {
        started = (await readFile(join(s.workspace, "started.txt"), "utf8").catch(() => undefined)) !== undefined;
        if (started) {
          at.startedSeen = Date.now() - t0;
          break;
        }
        const done = await Promise.race([
          turn.then(
            () => true,
            () => true,
          ),
          delay(100).then(() => false),
        ]);
        if (done) break;
      }
      if (started) {
        at.cancelSent = Date.now() - t0;
        await session.cancel();
        at.cancelReturned = Date.now() - t0;
        cancelled = true;
      }
      stopReason = await turn.then(
        (t) => ((orcaCancel = t.cancel), t.stopReason),
        (e: unknown) => `rejected: ${e instanceof Error ? e.message.slice(0, 200) : "?"}`,
      );
      at.turnEnded = Date.now() - t0;
      // Longer than the command's own wait: a command still running would have written by now.
      await delay(6_000);
    } finally {
      await session.close();
    }
    const after = await tree(s.workspace);
    const decided = policyDecisions(s.decisions).map((d) => d.decision);
    const finished = "done.txt" in after;
    const doneWritten = await stat(join(s.workspace, "done.txt")).then(
      (st) => Math.round(st.mtimeMs) - t0,
      () => undefined,
    );
    const wire = correlate(s);
    const failures: string[] = [...wire.failures];
    if (decided.some((d) => d !== "allow")) failures.push(`ORCA decided ${decided.join(", ")}, not allow`);
    // ORCA claiming the cancel ended the command while its result still appeared contradicts it;
    // ORCA saying it could not confirm that, or that the command ran on, is a truthful report of
    // a limitation of Codex's interrupt, not a pass (#1299).
    const limitations: string[] = [];
    if (cancelled && finished && (orcaCancel === "confirmed" || orcaCancel === undefined))
      failures.push(
        `the command's result appeared after the turn was cancelled, and ORCA reported the cancel as ${orcaCancel ?? "nothing"}`,
      );
    else if (cancelled && finished)
      limitations.push(
        `the command's result appeared after the turn was cancelled; ORCA reported the cancel as ${orcaCancel}` +
          (orcaCancel === "unconfirmed" ? " and took no further prompt" : ""),
      );
    else if (cancelled && orcaCancel === "unconfirmed")
      limitations.push("Codex never reported the command ended, so ORCA reported the cancel as unconfirmed");
    const unverified: string[] = [...wire.unverified];
    if (cancelled && !finished && orcaCancel === "not-carried-out")
      unverified.push("ORCA reported the command completed after the cancel, but its result did not appear");
    if (wire.observed && wire.asks.length !== 1) unverified.push(`Codex sent ${wire.asks.length} asks, not 1`);
    if (!started) unverified.push("the command never started, so cancellation could not be observed");
    results.push({
      id: "shell-cancel",
      action: `escalated shell: ${cmd}, turn cancelled once started.txt appears`,
      rule,
      status:
        failures.length === 0 && unverified.length === 0 && limitations.length > 0
          ? "known limitation"
          : statusOf(failures, unverified),
      reasons: failures.length > 0 ? failures : unverified.length > 0 ? unverified : limitations,
      orca: { configured: "allow", decisions: policyDecisions(s.decisions), cancel: orcaCancel ?? null },
      native: nativeOf(s),
      effect: {
        expected: "no completion marker (done.txt) after the cancel, waiting past the command's own sleep",
        started,
        cancelled,
        finished,
        changed: changes(before, after),
      },
      // Milliseconds from the prompt: when ORCA saw started.txt, sent and finished the cancel,
      // saw the turn end, and when done.txt was written (its mtime), with the turn's stop reason.
      timing: {
        ...at,
        doneWritten,
        stopReason,
        // What Codex itself reported on the wire, on the same clock.
        codexCommands: s.wires
          .flatMap((w) => w.commands)
          .map((c) => ({
            status: c.status,
            started: c.startedAt - t0,
            completed: c.completedAt === null ? null : c.completedAt - t0,
          })),
        codexTurns: s.wires.flatMap((w) => w.turns).map((t) => ({ status: t.status, completed: t.completedAt - t0 })),
      },
      toolOutput: model.outputs.slice(outputsBefore),
    });
    expect(failures).toEqual([]);
  }, 180_000);

  it("crash-restart: after the app-server is killed, the restarted thread still decides each call by ORCA's policy", async () => {
    const allowRule = {
      match: { kind: "execute", titlePattern: "echo orca-1165 > before-crash\\.txt" },
      decision: "allow",
    };
    const denyRule = {
      match: { kind: "execute", titlePattern: "echo orca-1165 > after-crash\\.txt" },
      decision: "deny",
    };
    const s = await open("crash-restart", [allowRule, denyRule]);
    const session: AgentSession = await s.opened;
    const before = await tree(s.workspace);
    try {
      await session.prompt(script(escalated("echo orca-1165 > before-crash.txt")), { timeoutMs: 90_000 });
      process.kill(s.spawned[0]!.pid!, "SIGKILL");
      await s.spawned[0]!.exited;
      await session.prompt(script(escalated("echo orca-1165 > after-crash.txt")), { timeoutMs: 90_000 });
    } finally {
      await session.close();
    }
    const restarted = s.spawned.length === 2;
    const after = await tree(s.workspace);
    const changed = changes(before, after);
    const decided = policyDecisions(s.decisions).map((d) => d.decision);
    const wire = correlate(s);
    const failures: string[] = [...wire.failures];
    if ("after-crash.txt" in after) failures.push("the call ORCA denies after the restart had an effect");
    if (decided.some((d, i) => d !== (i === 0 ? "allow" : "deny")))
      failures.push(`ORCA decided ${decided.join(", ")}, not allow then deny`);
    const unverified: string[] = [...wire.unverified];
    if (!restarted) unverified.push("the session did not restart Codex exactly once");
    // One ask on each process: the first before the crash, the second on the restarted thread.
    const perProcess = s.wires.map((w) => w.asks.length);
    if (!sameJson(perProcess, [1, 1]))
      unverified.push(`Codex's asks per process were ${JSON.stringify(perProcess)}, not [1,1]`);
    const resumed = s.wires[1]?.threadRequests.map((r) => `${r.method}:${r.answered ?? "unanswered"}`) ?? [];
    if (!sameJson(resumed, ["thread/resume:thread"]))
      unverified.push(`the restarted process's thread requests were ${JSON.stringify(resumed)}`);
    if (!("before-crash.txt" in after)) unverified.push("the call ORCA allowed before the crash had no effect");
    results.push({
      id: "crash-restart",
      action: "allowed escalated shell, SIGKILL the app-server, then a denied escalated shell on the restarted thread",
      rule: { allow: allowRule, deny: denyRule },
      status: statusOf(failures, unverified),
      reasons: failures.length > 0 ? failures : unverified,
      orca: { decisions: policyDecisions(s.decisions) },
      native: {
        ...nativeOf(s),
        asksPerProcess: s.wires.map((w) => w.asks.length),
        configVerifications: s.verified.length,
      },
      effect: { expected: "before-crash.txt only", changed },
    });
    expect(failures).toEqual([]);
  }, 240_000);

  /** A case whose session must be refused before anything runs. */
  const refusedCase = async (id: string, action: string, more: Parameters<typeof open>[2], reason: RegExp) => {
    const s = await open(id, [], more);
    const error = await s.opened.then(
      async (session) => (await session.close(), undefined),
      (e: unknown) => e as OrcaError,
    );
    const failures: string[] = [];
    if (!error) failures.push("the session opened");
    else if (!reason.test(error.message)) failures.push(`refused for another reason: ${error.message}`);
    // Whether ORCA asked any Codex it started for a thread, read on the wire. With no process
    // started there was none to ask.
    const threadRequests = s.wires.flatMap((w) => w.threadRequests);
    if (threadRequests.length > 0) failures.push("ORCA asked Codex for a thread before refusing");
    // A process the harness could not observe leaves whether a thread was asked for unknown.
    const observed = s.wires.length === s.spawned.length && s.wires.every((w) => w.attached && w.seen.fromCodex > 0);
    const unverified =
      s.spawned.length > 0 && !observed ? ["the harness did not observe the started process's exchange"] : [];
    results.push({
      id,
      action,
      status: statusOf(failures, unverified),
      reasons: failures.length > 0 ? failures : unverified,
      orca: {
        refusal: error
          ? {
              code: error.code,
              message: error.message,
              reason: (error.details as { reason?: unknown } | undefined)?.reason ?? null,
            }
          : null,
      },
      native: {
        processesStarted: s.spawned.length,
        // Read on each started process's stdio; "none started" when there was no process to ask.
        threadRequested: s.spawned.length === 0 ? "none started" : observed ? threadRequests.length > 0 : "unverified",
        threadRequests,
      },
    });
    expect(failures).toEqual([]);
    return s;
  };

  it("unknown-pin: a Codex build ORCA has not verified is refused before it is started", async () => {
    const other = join(root, "unknown-pin-codex");
    await copyFile(CODEX!, other);
    await appendFile(other, Buffer.from([0]));
    await chmod(other, 0o755);
    const s = await refusedCase(
      "unknown-pin",
      "the pinned binary with one byte appended",
      { command: other },
      /not a build ORCA verified/,
    );
    expect(s.spawned).toHaveLength(0);
  }, 120_000);

  it("unmanaged-config: Codex's own config that changes ORCA's policy is refused before a thread starts", async () => {
    await refusedCase(
      "unmanaged-config",
      'Codex config.toml sets approval_policy = "never"',
      { codexConfig: [`approval_policy = "never"`] },
      /approval_policy/,
    );
  }, 120_000);

  it("unmanaged-mcp: an MCP server in Codex's own config is refused before a thread starts", async () => {
    await refusedCase(
      "unmanaged-mcp",
      "Codex config.toml adds an MCP server",
      { codexConfig: [`[mcp_servers.own]`, `command = "${process.execPath}"`] },
      /adds the MCP server own/,
    );
  }, 120_000);

  const EXPECTED_CASES = [
    ...ASK_CASES.map((c) => c.id),
    "sandboxed-unasked",
    "shell-cancel",
    "crash-restart",
    "unknown-pin",
    "unmanaged-config",
    "unmanaged-mcp",
  ];

  /** The record of what ran, complete or not: a run that stopped early says which cases it lacks. */
  const buildRecord = async () => {
    const orcaPkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    const target = `${platform()}-${arch()}`;
    const by = (status: Status) => results.filter((r) => r["status"] === status).map((r) => r["id"]);
    const binary = sha256(await readFile(CODEX!));
    const ran = new Set(results.map((r) => r["id"] as string));
    const missing = EXPECTED_CASES.filter((id) => !ran.has(id));
    return {
      kind: "orca.codex-app-server-installed-evidence",
      version: 2,
      route: "codex-app-server-ask",
      // Evidence of the cases below on this build only: not a tier, not a scoped label.
      claim: "none",
      // An incomplete run is not evidence that anything held: it names the cases it lacks.
      complete: missing.length === 0,
      missing,
      build: {
        orcaVersion: orcaPkg.version,
        commit: process.env["GITHUB_SHA"] ?? git("rev-parse", "HEAD"),
        treeClean: git("status", "--porcelain") === "",
        node: process.version,
        run: process.env["GITHUB_RUN_ID"] ?? null,
      },
      agent: {
        codexBinarySha256: binary,
        /** The verified Codex version whose image this binary is, for this machine. */
        verifiedAs: Object.entries(CODEX_VERIFIED_IMAGES).find(([, images]) => images[target] === binary)?.[0] ?? null,
        pinned: Object.fromEntries(
          Object.entries(CODEX_VERIFIED_IMAGES).map(([v, images]) => [v, images[target] ?? null]),
        ),
      },
      platform: { os: platform(), arch: arch(), kernel: release() },
      settings: SETTINGS,
      summary: {
        verified: by("verified"),
        unverified: by("unverified"),
        knownLimitation: by("known limitation"),
        failed: by("failed"),
      },
      cases: results,
      notCovered: NOT_COVERED,
    };
  };

  // Written however the run ends, before anything about it is asserted: a contradicting case
  // fails the run and still leaves its record for the upload.
  afterAll(async () => {
    if (!RECEIPT_DIR) return;
    await mkdir(RECEIPT_DIR, { recursive: true });
    await writeFile(join(RECEIPT_DIR, RECORD), JSON.stringify(await buildRecord(), null, 2) + "\n");
  });

  it("records the evidence: every case ran, none contradicted, on a verified build", async () => {
    const record = await buildRecord();
    expect(record.missing).toEqual([]);
    expect(record.agent.verifiedAs).not.toBeNull();
    expect(record.summary.failed).toEqual([]);
  });
});
