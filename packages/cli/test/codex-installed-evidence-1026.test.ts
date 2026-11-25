/**
 * Installed-session evidence for Codex's hook route (#1026), checks-only: the smallest set Cal
 * asked for first. The pinned Codex ACP adapter and the Codex it depends on run in sessions the
 * daemon's own session factory opens (`nativeToolHook: experimental`), against a scripted stand-in
 * for the model, so no account, key or spend is involved.
 *
 * Four cases, each in its own disposable workspace and session: a harmless shell command and a
 * harmless patch, each once allowed and once denied by a configured rule. For each:
 *
 * - **the effect is observed apart from the hook and from ORCA**: the workspace's whole tree
 *   (every path and its bytes' digest) before and after, so an allowed action shows exactly its
 *   change and a denied one shows none;
 * - **the call reached Codex's tool path**: the tool output Codex handed back to the model for it,
 *   which for a denied call carries ORCA's refusal as Codex reports it. A denial with no such
 *   output would be a call never made, not a call refused, and fails the case.
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
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { CODEX_HOOK_VERIFIED_PAIRS, LocalHost, openAcpSession, type OpenSessionOptions } from "@orca/agents";
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
  // The adapter takes sandbox and approvals from its session mode: full access leaves whether a
  // call runs to ORCA's hook alone, so an effect or its absence is the hook's doing.
  adapterMode: "agent-full-access",
  codex: { sandbox_mode: "danger-full-access", approval_policy: "never", model: "gpt-5.5 (scripted stand-in)" },
} as const;

/** What these cases do not cover, and why; recorded so nothing reads as more than it is. */
const NOT_COVERED = [
  "MCP tool calls (follow-up PR)",
  "cancellation of a pending call, and a fresh session after it (follow-up PR)",
  "the experimental judge (tracked separately)",
  "Codex's own sandbox and approvals (off in this configuration, so that the hook alone decides)",
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
  const open = async (id: string, rule: unknown) => {
    const base = join(root, id);
    const configDir = join(base, "config");
    const workspace = join(base, "work");
    const codexHome = join(base, "codex-home");
    for (const dir of [configDir, workspace, codexHome]) await mkdir(dir, { recursive: true });
    const asks: string[] = [];
    const askPermission: OpenSessionOptions["askPermission"] = async (req) => {
      asks.push(req.toolCall.title ?? "");
      return req.options.find((o) => o.kind === "reject_once")?.optionId;
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
          sandbox_mode: SETTINGS.codex.sandbox_mode,
          approval_policy: SETTINGS.codex.approval_policy,
        }),
        INITIAL_AGENT_MODE: SETTINGS.adapterMode,
        ORCA_1026_KEY: "sk-orca-1026-test",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      permissions: { rules: [rule] },
      nativeToolHook: SETTINGS.nativeToolHook,
    });
    const session = await makeSessionFactory({ configDir, storeDir: ".orca" }, openAcpSession, {
      runtime: process.execPath,
      script: hookScript,
    })({
      host: new LocalHost({ id: "local", type: "local" }),
      agent,
      cwd: workspace,
      askPermission,
      logger: silentLogger,
      handshakeTimeoutMs: 60_000,
    });
    return { session, workspace, asks };
  };

  for (const c of CASES)
    it(`${c.id}: ${c.action}`, async () => {
      const { session, workspace, asks } = await open(c.id, c.rule);
      const before = await tree(workspace);
      const outputsBefore = model.outputs.length;
      try {
        await session.prompt(script(c.step));
      } finally {
        await session.close();
      }
      const after = await tree(workspace);
      const outputs = model.outputs.slice(outputsBefore);
      const changed = changes(before, after);
      const expected = Object.fromEntries(
        Object.entries(c.expect).map(([path, content]) => [path, [null, sha256(content)] as [null, string]]),
      );
      const denied = Object.keys(c.expect).length === 0;
      const refusal = outputs.find((o) => o.includes("Denied by ORCA"));
      const passed =
        JSON.stringify(changed) === JSON.stringify(expected) &&
        outputs.length === 1 &&
        (denied ? refusal !== undefined : refusal === undefined) &&
        asks.length === 0;
      results.push({
        id: c.id,
        action: c.action,
        rule: c.rule,
        expected: denied ? "no effect" : "exactly this change",
        workspace: { before, after, changed },
        toolOutput: outputs,
        orcaRefusalReported: refusal !== undefined,
        humanAsks: asks,
        passed,
      });
      // Exactly the expected change, or none; the call made once; ORCA's refusal reported only
      // when denied; and nobody asked.
      expect(changed).toEqual(expected);
      expect(outputs).toHaveLength(1);
      if (denied) expect(refusal).toBeDefined();
      else expect(refusal).toBeUndefined();
      expect(asks).toEqual([]);
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
      cases: results,
      notCovered: NOT_COVERED,
    };
    expect(record.agent.codexImageSha256).not.toBeNull();
    expect(results.every((r) => r["passed"] === true)).toBe(true);
    if (RECEIPT_DIR) {
      await mkdir(RECEIPT_DIR, { recursive: true });
      await writeFile(join(RECEIPT_DIR, RECORD), JSON.stringify(record, null, 2) + "\n");
    }
  });
});
