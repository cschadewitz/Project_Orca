/**
 * Installed-session evidence for Codex's hook route (#1026), checks-only: the smallest set Cal
 * asked for first. The pinned Codex ACP adapter and the Codex it depends on run in sessions the
 * daemon's own session factory opens (`nativeToolHook: experimental`), against a scripted stand-in
 * for the model, so no account, key or spend is involved.
 *
 * Codex runs with its native protections as a session gets them: the adapter's default mode and
 * Codex's own sandbox and approval settings, none of them set or relaxed here. Any native
 * approval Codex asks for stays in the flow: it reaches ORCA as it would in use, and when it
 * reaches the person, the test answers as the person (once, for this call only).
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
 * and named in the record: MCP calls, cancellation and restart (a follow-up), the judge, and the
 * route's known limitations, which stay documented from existing evidence and are not re-created
 * or counted as passes.
 *
 * `guard-receipts.yml` (job `codex`) runs this with ORCA_CODEX_ADAPTER set to the pinned adapter's
 * entry point. Without it there is nothing to run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger, type HookTelemetryLine } from "@orca/core";
import {
  CODEX_HOOK_VERIFIED_PAIRS,
  LocalHost,
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

/** The adapter's mode that turns Codex's sandbox and approvals off; a case must not run in it. */
const FULL_ACCESS_MODE = "agent-full-access";

/** What these cases do not cover, and why; recorded so nothing reads as more than it is. */
const NOT_COVERED = [
  "MCP tool calls (follow-up PR)",
  "cancellation of a pending call, and a fresh session after it (follow-up PR)",
  "the experimental judge (tracked separately)",
  "known limitation, documented, not re-created here: Codex lets a call through when its hook runner fails after the startup probe",
  "known limitation, documented, not re-created here: text typed into a running command (write_stdin) is never hooked",
  "known limitation, documented, not re-created here: an ORCA ask blocks the call (Codex cannot pause for a person)",
];

interface Case {
  id: string;
  action: string;
  rule: unknown;
  step: Step;
  /** The workspace's change expected: path -> exact content, or nothing at all. */
  expect: Record<string, string>;
}

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
  const open = async (id: string, rule: unknown, allow: boolean) => {
    const base = join(root, id);
    const configDir = join(base, "config");
    const workspace = join(base, "work");
    const codexHome = join(base, "codex-home");
    for (const dir of [configDir, workspace, codexHome]) await mkdir(dir, { recursive: true });
    // A native approval that reaches the person is answered as the person would for this
    // harmless call: once, for this call only; allowed in an allow case, refused in a deny case.
    const personAsked: { title: string; answer: string | undefined }[] = [];
    const askPermission: OpenSessionOptions["askPermission"] = async (req) => {
      const kind = allow ? "allow_once" : "reject_once";
      const answer = req.options.find((o) => o.kind === kind)?.optionId;
      personAsked.push({ title: req.toolCall.title ?? "", answer: answer === undefined ? undefined : kind });
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
        }),
        ORCA_1026_KEY: "sk-orca-1026-test",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      permissions: { rules: [rule] },
      nativeToolHook: SETTINGS.nativeToolHook,
      diagnostics: SETTINGS.diagnostics,
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
    return { session, workspace, personAsked, native, hookLines, recorded: session.hookTelemetry !== undefined };
  };

  for (const c of CASES)
    it(`${c.id}: ${c.action}`, async () => {
      const allow = Object.keys(c.expect).length > 0;
      const { session, workspace, personAsked, native, hookLines, recorded } = await open(c.id, c.rule, allow);
      // The mode the adapter reports for the session, with its own description of it.
      const modeOption = session.configOptions.find((o) => o.category === "mode");
      const mode = modeOption?.currentValue ?? null;
      const modeChoices =
        modeOption?.type === "select" ? modeOption.options.flatMap((o) => ("options" in o ? o.options : [o])) : [];
      const modeDescribed = modeChoices.find((o) => o.value === mode);
      const before = await tree(workspace);
      const outputsBefore = model.outputs.length;
      try {
        await session.prompt(script(c.step));
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
      // The session ran with Codex's native protections, and nothing contradicts the expected outcome.
      expect(mode).not.toBe(FULL_ACCESS_MODE);
      expect(failures).toEqual([]);
    }, 180_000);

  it("records the exact build, agent, platform and settings beside the cases", async () => {
    expect(results.map((r) => r["id"])).toEqual(CASES.map((c) => c.id));
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
