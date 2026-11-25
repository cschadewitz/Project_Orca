/**
 * Installed-session evidence for Codex's hook route (#1026), checks-only: the smallest set Cal
 * asked for first. The pinned Codex ACP adapter and the Codex it depends on run in sessions the
 * daemon's own session factory opens (`nativeToolHook: experimental`), against a scripted stand-in
 * for the model, so no account, key or spend is involved.
 *
 * Codex runs with its native protections as a session gets them: the adapter's default mode and
 * Codex's own sandbox and approval settings, none of them set or relaxed here. The test never
 * gives a native approval: a native request that reaches the person is recorded and refused, so
 * an allowed action that needs one stays without effect and its case unverified.
 *
 * Four cases, each in its own disposable workspace and session: a harmless shell command and a
 * harmless patch, each once allowed and once denied by a configured ORCA rule. Each case records
 * three things apart:
 *
 * - **ORCA's decision**: what ORCA's hook answered for the call, from the hook's tool-call
 *   record (#1000), with Codex's own report of an ORCA refusal beside it;
 * - **the native decision**: the session's mode, and every native approval request with how it
 *   was answered and by whom;
 * - **the observed effect**: the workspace's whole tree (every path and its bytes' digest) before
 *   and after, taken apart from the hook, ORCA and Codex.
 *
 * A case is `verified` only when those agree: ORCA decided as configured, the effect is exactly the
 * expected change (or none, when denied), and for a denial no native refusal could have caused
 * the absence of an effect. A case that cannot establish ORCA's decision under the native
 * safeguards (no hook record, a native refusal, a sandbox that kept an allowed call from running)
 * is `unverified`, with the reason, and does not fail the run. Only evidence that contradicts the
 * expected outcome (an effect after a denial, an unexpected change, ORCA deciding otherwise than
 * configured) is `failed`, and fails it.
 *
 * It writes one JSON record with the exact ORCA build, adapter, Codex, platform and settings the
 * cases ran with, to `ORCA_ENFORCEMENT_RECEIPT_DIR` when set. **It is evidence, not a tier or a
 * scoped label**: nothing here signs, stages, promotes or changes a protection. Not covered here,
 * and named in the record: the judge, and the
 * route's known limitations, which stay documented from existing evidence and are not re-created
 * or counted as passes.
 *
 * `guard-receipts.yml` (job `codex`) runs this with ORCA_CODEX_ADAPTER set to the pinned adapter's
 * entry point. Without it there is nothing to run.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type HookTelemetryLine } from "@orca/core";
import {
  CODEX_HOOK_VERIFIED_PAIRS,
  LocalHost,
  type AgentSession,
  openAcpSession,
  type OpenSessionOptions,
  type PermissionRuleRecord,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";
import { makeSessionFactory } from "../src/bootstrap.js";
import { modelStandIn, patch, script, shell, type ModelStandIn, type Step } from "./codex-model-stand-in.js";

const ADAPTER = process.env["ORCA_CODEX_ADAPTER"];
const RECEIPT_DIR = process.env["ORCA_ENFORCEMENT_RECEIPT_DIR"];
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RECORD = "codex-installed-evidence.json";

/** The settings every case runs with, recorded as they are passed. */
const SETTINGS = {
  nativeToolHook: "experimental",
  // Neither is set: the adapter's own default mode, and with it Codex's sandbox and approval
  // policy. The mode each session reports is recorded per case.
  adapterMode: "adapter default (INITIAL_AGENT_MODE not set)",
  codex: {
    sandbox_mode: "not set (from the adapter's mode)",
    approval_policy: "not set (from the adapter's mode)",
    model: "gpt-5.5 (scripted stand-in)",
  },
  // Only so that ORCA's decision is recorded apart from Codex's output; diagnostic, decides nothing.
  diagnostics: { toolCalls: "keep" },
} as const;

/**
 * The mode the pinned adapter (codex-acp 2.9.0) opens a session in when none is set: "Auto
 * review", Codex's workspace-write sandbox with on-request approvals. Each session has to report
 * exactly this before it is prompted; a missing, unknown or other mode stops the case.
 */
const EXPECTED_MODE = "agent";

/** What these cases do not cover, and why; recorded so nothing reads as more than it is. */
const NOT_COVERED = [
  "NOT VERIFIED for 0.8: an installed ORCA-judged Codex action. The hook route blocks on an ORCA ask, and Codex's default native review is separate from ORCA's judge and does not hand that decision to ORCA's human prompt. No other path is added and no approval is loosened to fill the gap; the hook opt-in shown here is not evidence that ORCA judge advice is available on this route.",
  "known limitation, documented, not re-created here: Codex lets a call through when its hook runner fails after the startup probe",
  "known limitation, documented, not re-created here: text typed into a running command (write_stdin) is never hooked",
  "known limitation, documented, not re-created here: an ORCA ask blocks the call (Codex cannot pause for a person)",
];

interface Case {
  id: string;
  action: string;
  rule: unknown;
  /** The one call the scripted model makes, given the case's workspace. */
  step: Step | ((workspace: string) => Step);
  /** The workspace's change expected: path -> exact content, or nothing at all. */
  expect: Record<string, string>;
  /** What the case adds to Codex's config: an MCP server, say. Nothing that loosens a protection. */
  codex?: (base: string, workspace: string) => Promise<Record<string, unknown>>;
}

/**
 * A stdio MCP server with one tool, `touch`, that can write one file only: the target the harness
 * names on its command line, inside the case's disposable workspace. The tool takes no input; a
 * call to another tool, or with any argument at all, is refused with an error and writes
 * nothing. The target is created exclusively (never overwritten, never through a link).
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
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", description: "write the one file this server was started for", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
  else if (m.method === "tools/call") {
    const args = m.params?.arguments;
    if (m.params?.name !== "touch") return refuse(m.id, "unknown tool");
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0)) return refuse(m.id, "touch takes no arguments");
    try { writeFileSync(target, "mcp", { flag: "wx" }); } catch { return refuse(m.id, "target exists or cannot be created"); }
    out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

/** Write the server next to (not inside) the workspace; return its path. */
async function writeMcpTouch(dir: string): Promise<string> {
  const server = join(dir, "mcp-touch.mjs");
  await writeFile(server, MCP_TOUCH_SERVER, "utf8");
  return server;
}

/**
 * The config a case adds for the server: its one target is `file` in the case's workspace,
 * fixed here by the harness. Codex starts it under its default settings: no tool approval mode
 * is set, so Codex's own MCP approval policy applies as it would in use.
 */
const mcpTouch =
  (file: string) =>
  async (base: string, workspace: string): Promise<Record<string, unknown>> => {
    const server = await writeMcpTouch(base);
    // A model Codex does not defer MCP tools for, so the scripted model can call one directly.
    return { model: "gpt-5", mcp_servers: { t: { command: process.execPath, args: [server, join(workspace, file)] } } };
  };

/** The scripted model's call: the tool, with no arguments. */
const MCP_CALL: Step = { tool: "touch", namespace: "mcp__t", args: {} };

const CASES: Case[] = [
  {
    id: "shell-allow",
    action: "shell: echo orca-1026 > shell-allowed.txt",
    rule: { match: { kind: "execute", titlePattern: "^echo orca-1026 > shell-allowed\\.txt$" }, decision: "allow" },
    step: shell("echo orca-1026 > shell-allowed.txt"),
    expect: { "shell-allowed.txt": "orca-1026\n" },
  },
  {
    id: "shell-deny",
    action: "shell: echo orca-1026 > shell-denied.txt",
    rule: { match: { kind: "execute", titlePattern: "^echo orca-1026 > shell-denied\\.txt$" }, decision: "deny" },
    step: shell("echo orca-1026 > shell-denied.txt"),
    expect: {},
  },
  {
    id: "patch-allow",
    action: "apply_patch: add patch-allowed.txt",
    rule: { match: { kind: "edit", scope: "workspace" }, decision: "allow" },
    step: patch("*** Add File: patch-allowed.txt", "+orca-1026"),
    expect: { "patch-allowed.txt": "orca-1026\n" },
  },
  {
    id: "patch-deny",
    action: "apply_patch: add patch-denied.txt",
    rule: { match: { kind: "edit" }, decision: "deny" },
    step: patch("*** Add File: patch-denied.txt", "+orca-1026"),
    expect: {},
  },
  {
    id: "mcp-allow",
    action: "mcp: t.touch (its one target: mcp-allowed.txt)",
    rule: { match: { titlePattern: "^t: touch$" }, decision: "allow" },
    step: MCP_CALL,
    expect: { "mcp-allowed.txt": "mcp" },
    codex: mcpTouch("mcp-allowed.txt"),
  },
  {
    id: "mcp-deny",
    action: "mcp: t.touch (its one target: mcp-denied.txt)",
    rule: { match: { titlePattern: "^t: touch$" }, decision: "deny" },
    step: MCP_CALL,
    expect: {},
    codex: mcpTouch("mcp-denied.txt"),
  },
];

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

/** What changed between two trees: path -> [before, after]. */
function changes(before: Record<string, string>, after: Record<string, string>) {
  const out: Record<string, [string | null, string | null]> = {};
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (before[path] !== after[path]) out[path] = [before[path] ?? null, after[path] ?? null];
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

describe("the MCP fixture writes only the target the harness names", () => {
  it("refuses another tool or any argument without writing, and writes its target once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-1026-mcp-touch-"));
    try {
      const server = await writeMcpTouch(dir);
      const target = join(dir, "work", "target.txt");
      const elsewhere = join(dir, "elsewhere.txt");
      await mkdir(join(dir, "work"));
      const child = spawn(process.execPath, [server, target], { stdio: ["pipe", "pipe", "inherit"] });
      const replies = new Map<number, Record<string, unknown>>();
      const waiting = new Map<number, () => void>();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const m = JSON.parse(line) as Record<string, unknown> & { id: number };
        replies.set(m.id, m);
        waiting.get(m.id)?.();
      });
      let id = 0;
      const call = async (method: string, params: unknown) => {
        const n = ++id;
        const replied = new Promise<void>((resolve) => waiting.set(n, resolve));
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
        await replied;
        return replies.get(n)!;
      };
      try {
        await call("initialize", { protocolVersion: "2025-06-18" });
        for (const params of [
          { name: "touch", arguments: { file: elsewhere } },
          { name: "touch", arguments: { extra: 1 } },
          { name: "touch", arguments: [] },
          { name: "other", arguments: {} },
        ])
          expect(await call("tools/call", params)).toHaveProperty("error");
        expect(await readFile(target, "utf8").catch(() => undefined)).toBeUndefined();
        expect(await readFile(elsewhere, "utf8").catch(() => undefined)).toBeUndefined();
        expect(await call("tools/call", { name: "touch", arguments: {} })).toHaveProperty("result");
        expect(await readFile(target, "utf8")).toBe("mcp");
        // Never overwritten: a second call is refused and leaves the file as it was.
        expect(await call("tools/call", { name: "touch", arguments: {} })).toHaveProperty("error");
        expect(await readdir(dir)).toEqual(expect.arrayContaining(["mcp-touch.mjs", "work"]));
        expect((await readdir(dir)).length).toBe(2);
      } finally {
        child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(ADAPTER === undefined)("installed-session evidence for Codex's hook route (#1026)", () => {
  let model: ModelStandIn;
  let hookScript: string;
  let root: string;
  const results: Record<string, unknown>[] = [];

  beforeAll(async () => {
    model = await modelStandIn();
    const entry = fileURLToPath(new URL("../../agents/src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const built = childBundle("codex-installed-evidence-1026", { entries: { hook: entry } })?.["hook"];
    if (!built) throw new Error("the hook program could not be built for this run");
    hookScript = built;
    root = await mkdtemp(join(tmpdir(), "orca-1026-codex-evidence-"));
  });

  afterAll(async () => {
    model.server.close();
    await once(model.server, "close").catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** One disposable workspace, config directory and Codex home, and a session the factory opens. */
  const open = async (
    id: string,
    rule: unknown,
    extra?: Case["codex"],
    /** The agent's `nativeToolHook`: `experimental` unless the case sets `on`, or leaves it out. */
    hook: "on" | "experimental" | "left out" = SETTINGS.nativeToolHook,
  ) => {
    const base = join(root, id);
    const configDir = join(base, "config");
    const workspace = join(base, "work");
    const codexHome = join(base, "codex-home");
    for (const dir of [configDir, workspace, codexHome]) await mkdir(dir, { recursive: true });
    const added = (await extra?.(base, workspace)) ?? {};
    // A native approval that reaches the person is recorded and refused: the test never acts
    // as the person to let a call through.
    const personAsked: { title: string; answer: string | undefined }[] = [];
    const askPermission: OpenSessionOptions["askPermission"] = async (req) => {
      const answer = req.options.find((o) => o.kind === "reject_once")?.optionId;
      personAsked.push({ title: req.toolCall.title ?? "", answer: answer === undefined ? undefined : "reject_once" });
      return answer;
    };
    // Every native approval request ORCA answered, by its policy or by the person.
    // (Its file and MCP requests carry an `fs:` or `mcp:` prefix and are not approvals.)
    const native: { title: string; decision: string; rule?: PermissionRuleRecord }[] = [];
    const onPermission: OpenSessionOptions["onPermission"] = (info) => {
      if (/^(fs|mcp):/.test(info.decision)) return;
      native.push({ title: info.title, decision: info.decision, ...(info.rule ? { rule: info.rule } : {}) });
    };
    const agent = AgentSpecSchema.parse({
      id: "codex",
      command: process.execPath,
      args: [ADAPTER],
      env: {
        CODEX_HOME: codexHome,
        CODEX_CONFIG: JSON.stringify({
          model: "gpt-5.5",
          model_provider: "standin",
          model_providers: {
            standin: { name: "standin", base_url: model.url, wire_api: "responses", env_key: "ORCA_1026_KEY" },
          },
          ...added,
        }),
        ORCA_1026_KEY: "sk-orca-1026-test",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      permissions: { rules: [rule] },
      ...(hook === "left out" ? {} : { nativeToolHook: hook }),
      // The hook's record is all the diagnostics give; without a hook they record nothing.
      ...(hook === "experimental" ? { diagnostics: SETTINGS.diagnostics } : {}),
    });
    const session = await makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
      runtime: process.execPath,
      script: hookScript,
    })({
      host: new LocalHost({ id: "local", type: "local" }),
      agent,
      cwd: workspace,
      askPermission,
      onPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    // ORCA's decisions, as the hook recorded them for this session.
    const hookLines: HookTelemetryLine[] = [];
    session.hookTelemetry?.attach(async (lines) => {
      hookLines.push(...lines);
    });
    return {
      session,
      workspace,
      personAsked,
      native,
      hookLines,
      recorded: session.hookTelemetry !== undefined,
      codexAdded: added,
    };
  };

  for (const c of CASES)
    it(`${c.id}: ${c.action}`, async () => {
      const allow = Object.keys(c.expect).length > 0;
      const { session, workspace, personAsked, native, hookLines, recorded, codexAdded } = await open(
        c.id,
        c.rule,
        c.codex,
      );
      // The mode the adapter reports for the session, with its own description of it.
      const modeOption = session.configOptions.find((o) => o.category === "mode");
      const mode = modeOption?.currentValue ?? null;
      const modeChoices =
        modeOption?.type === "select" ? modeOption.options.flatMap((o) => ("options" in o ? o.options : [o])) : [];
      const modeDescribed = modeChoices.find((o) => o.value === mode);
      const before = await tree(workspace);
      const outputsBefore = model.outputs.length;
      try {
        // The pinned adapter's mode, reported explicitly, before anything is asked of it.
        expect(mode).toBe(EXPECTED_MODE);
        await session.prompt(script(typeof c.step === "function" ? c.step(workspace) : c.step));
        // The hook hands its record to a detached writer after answering, so it can land a
        // little after the call: read the spool until it does, within the writer's deadline.
        for (const until = Date.now() + 5_000; session.hookTelemetry && hookLines.length === 0 && Date.now() < until;) {
          await session.hookTelemetry.drain();
          if (hookLines.length === 0) await delay(100);
        }
      } finally {
        await session.close();
      }
      const after = await tree(workspace);
      const outputs = model.outputs.slice(outputsBefore);
      const changed = changes(before, after);
      const expected = Object.fromEntries(
        Object.entries(c.expect).map(([path, content]) => [path, [null, sha256(content)] as [null, string]]),
      );
      const orcaDecisions = hookLines.map((l) => l.decision);
      const refusal = outputs.find((o) => o.includes("Denied by ORCA"));
      // Any native approval answered other than with an allow.
      const nativeRefused =
        native.some((n) => !/allow/.test(n.decision)) || personAsked.some((a) => a.answer !== "allow_once");

      const effect = Object.keys(changed).length === 0 ? "none" : sameJson(changed, expected) ? "expected" : "other";
      const failures: string[] = [];
      if (!allow && effect !== "none") failures.push("an effect was observed after ORCA was configured to deny");
      if (effect === "other") failures.push("the workspace changed other than expected");
      if (orcaDecisions.some((d) => d !== (allow ? "allow" : "deny")))
        failures.push(`ORCA's hook decided ${orcaDecisions.join(", ")}, not ${allow ? "allow" : "deny"}`);
      if (allow && refusal !== undefined) failures.push("Codex reported an ORCA refusal for an allowed call");

      const unverified: string[] = [];
      if (!recorded || orcaDecisions.length === 0) unverified.push("ORCA's hook left no record of its decision");
      else if (orcaDecisions.length !== 1)
        unverified.push(`ORCA's hook recorded ${orcaDecisions.length} decisions, not one`);
      if (outputs.length !== 1) unverified.push(`Codex returned ${outputs.length} tool outputs, not one`);
      if (!allow && refusal === undefined) unverified.push("Codex did not report ORCA's refusal for the call");
      if (!allow && nativeRefused) unverified.push("a native refusal could also account for the absence of an effect");
      if (allow && effect === "none")
        unverified.push(
          "ORCA allowed the call, but it had no effect under the native safeguards (native refusal or sandbox)",
        );

      const status = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
      results.push({
        id: c.id,
        action: c.action,
        rule: c.rule,
        codexConfigAdded: codexAdded,
        status,
        reasons: failures.length > 0 ? failures : unverified,
        orca: {
          configured: allow ? "allow" : "deny",
          hookDecisions: hookLines.map((l) => ({
            tool: l.tool,
            kind: l.kind ?? null,
            title: l.title ?? null,
            decision: l.decision,
            rule: l.rule ?? null,
          })),
          refusalReportedByCodex: refusal !== undefined,
        },
        native: {
          mode,
          modeName: modeDescribed?.name ?? null,
          modeDescription: modeDescribed?.description ?? null,
          approvalsAnsweredByOrca: native,
          approvalsAnsweredAsThePerson: personAsked,
        },
        effect: { expected: allow ? "exactly this change" : "no effect", observed: effect, before, after, changed },
        toolOutput: outputs,
      });
      // Nothing contradicts the expected outcome.
      expect(failures).toEqual([]);
    }, 180_000);

  /** ORCA's decisions for the session: read the spool until `n` have landed, within the writer's deadline. */
  const settle = async (session: AgentSession, lines: unknown[], n: number) => {
    for (const until = Date.now() + 5_000; session.hookTelemetry && lines.length < n && Date.now() < until;) {
      await session.hookTelemetry.drain();
      if (lines.length < n) await delay(100);
    }
  };
  const modeOf = (session: AgentSession) =>
    session.configOptions.find((o) => o.category === "mode")?.currentValue ?? null;
  const hookRecord = (lines: HookTelemetryLine[]) =>
    lines.map((l) => ({ tool: l.tool, title: l.title ?? null, decision: l.decision, rule: l.rule ?? null }));

  it("shell-cancel: no late completion marker after an allowed command's turn is cancelled", async () => {
    // The command marks that it started, waits, then would write a completion marker. The turn
    // is cancelled once the start mark is seen; the completion marker must not appear, even
    // after the wait. That is all this shows: not that the run had no other effect. The start
    // mark is expected, and any other change is recorded as observed (`leftBehind`).
    const cmd = "echo started > started.txt; sleep 4; echo done > done.txt";
    const rule = {
      match: { kind: "execute", titlePattern: "^echo started > started\\.txt; sleep 4; echo done > done\\.txt$" },
      decision: "allow",
    };
    const { session, workspace, personAsked, native, hookLines, recorded } = await open("shell-cancel", rule);
    const mode = modeOf(session);
    const before = await tree(workspace);
    const outputsBefore = model.outputs.length;
    let started = false;
    let cancelled = false;
    try {
      expect(mode).toBe(EXPECTED_MODE);
      const turn = session.prompt(script(shell(cmd)));
      for (const until = Date.now() + 20_000; Date.now() < until;) {
        started = (await readFile(join(workspace, "started.txt"), "utf8").catch(() => undefined)) !== undefined;
        if (started) break;
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
        await session.cancel();
        cancelled = true;
      }
      await turn.catch(() => undefined);
      // Longer than the command's own wait: a command still running would have written by now.
      await delay(6_000);
      await settle(session, hookLines, 1);
    } finally {
      await session.close();
    }
    const after = await tree(workspace);
    const changed = changes(before, after);
    const outputs = model.outputs.slice(outputsBefore);
    const decisions = hookLines.map((l) => l.decision);
    const finished = "done.txt" in after;
    // Anything else the cancelled command's run left in the workspace, recorded as observed.
    const leftBehind = Object.keys(changed).filter((path) => path !== "started.txt" && path !== "done.txt");

    const failures: string[] = [];
    if (decisions.some((d) => d !== "allow")) failures.push(`ORCA's hook decided ${decisions.join(", ")}, not allow`);
    if (cancelled && finished) failures.push("the command's result appeared after the turn was cancelled");
    const unverified: string[] = [];
    if (!recorded || decisions.length === 0) unverified.push("ORCA's hook left no record of its decision");
    if (!started)
      unverified.push("the command never started under the native safeguards, so cancellation could not be observed");
    const status = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
    results.push({
      id: "shell-cancel",
      action: `shell: ${cmd}, turn cancelled once started.txt appears`,
      rule,
      status,
      reasons: failures.length > 0 ? failures : unverified,
      orca: { configured: "allow", hookDecisions: hookRecord(hookLines) },
      native: { mode, approvalsAnsweredByOrca: native, approvalsAnsweredAsThePerson: personAsked },
      effect: {
        expected:
          "no late completion marker (done.txt) observed after the cancel, waiting past the command's own sleep; not proof of no effects: started.txt is expected and other changes are recorded in leftBehind",
        started,
        cancelled,
        finished,
        leftBehind,
        before,
        after,
        changed,
      },
      toolOutput: outputs,
    });
    expect(failures).toEqual([]);
  }, 180_000);

  it("restart-fresh-decision: a fresh session decides again under the rules it starts with", async () => {
    // Same workspace and Codex home across both sessions, so whatever Codex keeps between
    // sessions is kept. The first allows the command; the second starts with a deny for it.
    const cmd = "echo orca-1026 >> restart.txt";
    const match = { kind: "execute", titlePattern: "^echo orca-1026 >> restart\\.txt$" };
    const first = await open("restart-fresh-decision", { match, decision: "allow" });
    const firstMode = modeOf(first.session);
    try {
      expect(firstMode).toBe(EXPECTED_MODE);
      await first.session.prompt(script(shell(cmd)));
      await settle(first.session, first.hookLines, 1);
    } finally {
      await first.session.close();
    }
    const between = await tree(first.workspace);

    const second = await open("restart-fresh-decision", { match, decision: "deny" });
    const secondMode = modeOf(second.session);
    const outputsBefore = model.outputs.length;
    try {
      expect(secondMode).toBe(EXPECTED_MODE);
      await second.session.prompt(script(shell(cmd)));
      await settle(second.session, second.hookLines, 1);
    } finally {
      await second.session.close();
    }
    const after = await tree(second.workspace);
    const changed = changes(between, after);
    const outputs = model.outputs.slice(outputsBefore);
    const decisions = second.hookLines.map((l) => l.decision);
    const firstDecisions = first.hookLines.map((l) => ({ title: l.title ?? null, decision: l.decision }));
    // Whether the first session's call had its effect: recorded, never required or implied.
    const firstEffectObserved = "restart.txt" in between;
    const refusal = outputs.find((o) => o.includes("Denied by ORCA"));
    const nativeRefused = second.native.some((n) => !/allow/.test(n.decision)) || second.personAsked.length > 0;

    const failures: string[] = [];
    if (firstDecisions.some((d) => d.decision !== "allow"))
      failures.push(`the first session's hook decided ${firstDecisions.map((d) => d.decision).join(", ")}, not allow`);
    if (Object.keys(changed).length > 0) failures.push("the second session's call had an effect under a deny");
    if (decisions.some((d) => d !== "deny"))
      failures.push(`the second session's hook decided ${decisions.join(", ")}, not deny`);
    const unverified: string[] = [];
    if (!second.recorded || decisions.length !== 1)
      unverified.push("the second session's hook did not record exactly one decision");
    if (refusal === undefined) unverified.push("Codex did not report ORCA's refusal in the second session");
    if (nativeRefused) unverified.push("a native refusal could also account for the absence of an effect");
    // What the second session alone establishes: a verified deny in a fresh session.
    const freshDeny = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
    // The allow-to-deny transition also needs the first session's allow, for exactly this call.
    if (!first.recorded || firstDecisions.length !== 1 || firstDecisions[0]!.title !== cmd)
      unverified.push("the first session's hook did not record exactly one allow for this exact call");
    const status = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
    results.push({
      id: "restart-fresh-decision",
      action: `shell: ${cmd}, allowed in one session, then the same call in a fresh session started with a deny`,
      rule: { first: { match, decision: "allow" }, second: { match, decision: "deny" } },
      // `status` is the allow-to-deny transition; `freshDeny` is the second session alone.
      status,
      freshDeny,
      reasons: failures.length > 0 ? failures : unverified,
      orca: {
        first: { configured: "allow", hookDecisions: hookRecord(first.hookLines) },
        second: {
          configured: "deny",
          hookDecisions: hookRecord(second.hookLines),
          refusalReportedByCodex: refusal !== undefined,
        },
      },
      native: {
        mode: { first: firstMode, second: secondMode },
        first: { approvalsAnsweredByOrca: first.native, approvalsAnsweredAsThePerson: first.personAsked },
        second: { approvalsAnsweredByOrca: second.native, approvalsAnsweredAsThePerson: second.personAsked },
      },
      effect: {
        expected: "no change in the second session; the first session's effect is recorded, not required",
        firstEffectObserved,
        between,
        after,
        changed,
      },
      toolOutput: outputs,
    });
    expect(failures).toEqual([]);
  }, 180_000);

  // The opt-in journey: the same harmless call under the same ORCA deny rule, with the hook
  // omitted, `on`, and `experimental`. Each is a fresh session in its own workspace.
  const optInCmd = (file: string) => `echo orca-1026 > ${file}`;
  const optInRule = (file: string) => ({
    match: { kind: "execute", titlePattern: `^echo orca-1026 > ${file.replace(".", "\\.")}$` },
    decision: "deny",
  });

  it("optin-omitted: without nativeToolHook no hook is installed, so ORCA's deny rule does not stop the call", async () => {
    const file = "optin-omitted.txt";
    const rule = optInRule(file);
    const { session, workspace, personAsked, native, hookLines } = await open(
      "optin-omitted",
      rule,
      undefined,
      "left out",
    );
    const mode = modeOf(session);
    const before = await tree(workspace);
    const outputsBefore = model.outputs.length;
    const hookInstalled = session.hookTelemetry !== undefined;
    try {
      expect(mode).toBe(EXPECTED_MODE);
      await session.prompt(script(shell(optInCmd(file))));
    } finally {
      await session.close();
    }
    const after = await tree(workspace);
    const changed = changes(before, after);
    const outputs = model.outputs.slice(outputsBefore);
    const refusal = outputs.find((o) => o.includes("Denied by ORCA"));
    const ran = sameJson(changed, { [file]: [null, sha256("orca-1026\n")] });

    const failures: string[] = [];
    if (refusal !== undefined) failures.push("Codex reported an ORCA refusal with the hook omitted");
    if (hookLines.length > 0) failures.push("a hook decision was recorded with the hook omitted");
    if (Object.keys(changed).length > 0 && !ran) failures.push("the workspace changed other than expected");
    const unverified: string[] = [];
    if (!ran)
      unverified.push(
        "the call had no effect under the native safeguards, so the absence of ORCA's hook is not shown by an effect",
      );
    const status = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
    results.push({
      id: "optin-omitted",
      action: `shell: ${optInCmd(file)}, nativeToolHook omitted, ORCA rule deny`,
      rule,
      status,
      reasons: failures.length > 0 ? failures : unverified,
      orca: { nativeToolHook: null, configured: "deny", hookInstalled, refusalReportedByCodex: refusal !== undefined },
      native: { mode, approvalsAnsweredByOrca: native, approvalsAnsweredAsThePerson: personAsked },
      effect: {
        expected: "the call runs: ORCA's deny is not enforced without the hook",
        observed: ran,
        before,
        after,
        changed,
      },
      toolOutput: outputs,
    });
    expect(hookInstalled).toBe(false);
    expect(failures).toEqual([]);
  }, 180_000);

  it("optin-on: nativeToolHook: on is refused before Codex starts", async () => {
    const file = "optin-on.txt";
    const rule = optInRule(file);
    const base = join(root, "optin-on");
    const outputsBefore = model.outputs.length;
    let refusedWith: string | undefined;
    try {
      const opened = await open("optin-on", rule, undefined, "on");
      await opened.session.close();
    } catch (error) {
      refusedWith = error instanceof Error ? error.message : String(error);
    }
    // Codex writes into its home as soon as it starts; an empty home means it never did.
    const codexHome = await readdir(join(base, "codex-home"));
    const workspace = await tree(join(base, "work"));
    const failures: string[] = [];
    if (refusedWith === undefined) failures.push("the session opened");
    else if (!/nativeToolHook: on/.test(refusedWith)) failures.push("refused, but not for nativeToolHook: on");
    if (codexHome.length > 0) failures.push("Codex started before the refusal");
    if (Object.keys(workspace).length > 0) failures.push("the workspace changed");
    if (model.outputs.length !== outputsBefore) failures.push("the model was reached");
    results.push({
      id: "optin-on",
      action: "open a session with nativeToolHook: on",
      rule,
      status: failures.length > 0 ? "failed" : "verified",
      reasons: failures,
      orca: { nativeToolHook: "on", refusedWith: refusedWith ?? null },
      effect: { expected: "refused before Codex starts: empty Codex home and workspace", codexHome, workspace },
    });
    expect(failures).toEqual([]);
  }, 180_000);

  it("optin-experimental: nativeToolHook: experimental installs the hook, and ORCA's deny holds", async () => {
    const file = "optin-experimental.txt";
    const rule = optInRule(file);
    const { session, workspace, personAsked, native, hookLines, recorded } = await open("optin-experimental", rule);
    const mode = modeOf(session);
    const before = await tree(workspace);
    const outputsBefore = model.outputs.length;
    const hookInstalled = session.hookTelemetry !== undefined;
    try {
      expect(mode).toBe(EXPECTED_MODE);
      await session.prompt(script(shell(optInCmd(file))));
      await settle(session, hookLines, 1);
    } finally {
      await session.close();
    }
    const after = await tree(workspace);
    const changed = changes(before, after);
    const outputs = model.outputs.slice(outputsBefore);
    const decisions = hookLines.map((l) => l.decision);
    const refusal = outputs.find((o) => o.includes("Denied by ORCA"));
    const nativeRefused = native.some((n) => !/allow/.test(n.decision)) || personAsked.length > 0;
    const failures: string[] = [];
    if (Object.keys(changed).length > 0) failures.push("an effect was observed after ORCA was configured to deny");
    if (decisions.some((d) => d !== "deny")) failures.push(`ORCA's hook decided ${decisions.join(", ")}, not deny`);
    const unverified: string[] = [];
    if (!recorded || decisions.length !== 1) unverified.push("ORCA's hook did not record exactly one decision");
    if (refusal === undefined) unverified.push("Codex did not report ORCA's refusal for the call");
    if (nativeRefused) unverified.push("a native refusal could also account for the absence of an effect");
    const status = failures.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "verified";
    results.push({
      id: "optin-experimental",
      action: `shell: ${optInCmd(file)}, nativeToolHook: experimental, ORCA rule deny`,
      rule,
      status,
      reasons: failures.length > 0 ? failures : unverified,
      orca: {
        nativeToolHook: "experimental",
        configured: "deny",
        hookInstalled,
        hookDecisions: hookRecord(hookLines),
        refusalReportedByCodex: refusal !== undefined,
      },
      native: { mode, approvalsAnsweredByOrca: native, approvalsAnsweredAsThePerson: personAsked },
      effect: { expected: "no effect", before, after, changed },
      toolOutput: outputs,
    });
    expect(hookInstalled).toBe(true);
    expect(failures).toEqual([]);
  }, 180_000);

  it("records the exact build, agent, platform and settings beside the cases", async () => {
    expect(results.map((r) => r["id"])).toEqual([
      ...CASES.map((c) => c.id),
      "shell-cancel",
      "restart-fresh-decision",
      "optin-omitted",
      "optin-on",
      "optin-experimental",
    ]);
    const adapterDir = dirname(dirname(ADAPTER!));
    const adapterPkg = JSON.parse(await readFile(join(adapterDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const codexPkgPath = createRequire(join(adapterDir, "package.json")).resolve("@openai/codex/package.json");
    const codexPkg = JSON.parse(await readFile(codexPkgPath, "utf8")) as { version: string };
    const pair = CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === adapterPkg.version);
    const orcaPkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    const record = {
      kind: "orca.codex-installed-evidence",
      version: 1,
      route: "codex-native-hook",
      // Evidence of the cases below on this build only: not a tier, not a scoped label.
      claim: "none",
      build: {
        orcaVersion: orcaPkg.version,
        commit: process.env["GITHUB_SHA"] ?? git("rev-parse", "HEAD"),
        treeClean: git("status", "--porcelain") === "",
        hookProgramSha256: sha256(await readFile(hookScript)),
        node: process.version,
        run: process.env["GITHUB_RUN_ID"] ?? null,
      },
      agent: {
        adapter: `${adapterPkg.name}@${adapterPkg.version}`,
        adapterEntrySha256: sha256(await readFile(ADAPTER!)),
        codex: codexPkg.version,
        // The image digest ORCA's admission accepts for this adapter on this platform; each
        // session above was admitted only after the running Codex was hashed against it.
        codexImageSha256: pair?.images[`${platform()}-${arch()}`] ?? null,
      },
      platform: { os: platform(), arch: arch(), kernel: release() },
      settings: SETTINGS,
      summary: {
        verified: results.filter((r) => r["status"] === "verified").map((r) => r["id"]),
        unverified: results.filter((r) => r["status"] === "unverified").map((r) => r["id"]),
      },
      cases: results,
      notCovered: NOT_COVERED,
    };
    expect(record.agent.codexImageSha256).not.toBeNull();
    expect(results.some((r) => r["status"] === "failed")).toBe(false);
    if (RECEIPT_DIR) {
      await mkdir(RECEIPT_DIR, { recursive: true });
      await writeFile(join(RECEIPT_DIR, RECORD), JSON.stringify(record, null, 2) + "\n");
    }
  });
});
