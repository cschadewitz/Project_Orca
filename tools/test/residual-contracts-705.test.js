/**
 * #705 residual contract proposals for Gemini, Pi and Codex. Three kinds of evidence, kept apart:
 *  - "pinned": unmodified upstream excerpts, digest-checked, run with labelled synthetic stubs;
 *  - "source-reviewed": static assertions on pinned text that is not executed here (Rust, bridge TS);
 *  - "proposed": ORCA-written reference models of contracts no upstream has reviewed or shipped.
 * No provider, shell, hook, policy file, sandbox, network or credential is touched; every command,
 * cwd and environment value below is inert data. Nothing here is installed-tested.
 */
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateStrictPermission } from "@orca/core";
import { actionFixture, complete, NOW, stateFixture } from "../../packages/agents/test/strict-permission-fixtures.ts";

const root = new URL("../../", import.meta.url);
const fixtures = new URL("tools/test/fixtures/provider-enforcement-704-705/", root);
const residual = new URL("residual-705/", fixtures);
const GEMINI = "6006c14a4decfe4b891c6263ad6ad5992e404b5b";
const CODEX = "6aaac694803004a63c6f393d153c96d22521a6b9";
const CODEX_ACP_230 = "344a520632e4c8c02f781a7a20490dfac52d4d0a";
const unknown = { state: "unknown", reason: "offline fixture: fact not supplied" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest("hex");

let manifest;
let pins;
const text = new Map(); // id → excerpt text, from this packet or read-only from the merged packets
let outcomes;

async function pureModule(source) {
  // Only digest-checked upstream text plus the labelled ORCA scaffolding written in this file.
  const code = stripTypeScriptTypes(source);
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** Strict unified-diff application: every context and removed line must match. */
function applyUnifiedDiff(source, diff) {
  const lines = source.split("\n");
  const patch = diff.split("\n");
  expect(patch.at(-1)).toBe("");
  const out = [];
  let at = 0;
  let i = patch.findIndex((line) => line.startsWith("@@ "));
  expect(i).toBeGreaterThan(0);
  while (i < patch.length - 1) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch[i]);
    expect(header, patch[i]).not.toBeNull();
    const [oldStart, oldCount, newStart, newCount] = header.slice(1).map(Number);
    out.push(...lines.slice(at, oldStart - 1));
    at = oldStart - 1;
    expect(out.length).toBe(newStart - 1);
    let removed = 0;
    let added = 0;
    for (i++; i < patch.length - 1 && !patch[i].startsWith("@@ "); i++) {
      const [mark, line] = [patch[i][0], patch[i].slice(1)];
      expect([" ", "-", "+"]).toContain(mark);
      if (mark !== "+") {
        expect(lines[at], `line ${at + 1}`).toBe(line);
        at++;
        removed++;
      }
      if (mark !== "-") {
        out.push(line);
        added++;
      }
    }
    expect([removed, added]).toEqual([oldCount, newCount]);
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

async function readChecked(url, entry, label) {
  const bytes = await readFile(url);
  expect(bytes.byteLength, label).toBe(entry.bytes);
  expect(sha256(bytes), label).toBe(entry.sha256);
  return bytes;
}

beforeAll(async () => {
  manifest = JSON.parse(await readFile(new URL("manifest.json", residual), "utf8"));
  pins = JSON.parse(
    await readFile(new URL("docs/preparation/provider-enforcement-704-705/source-pins.json", root), "utf8"),
  );
  for (const entry of manifest.excerpts) {
    text.set(entry.id, (await readChecked(new URL(entry.path, residual), entry, entry.id)).toString("utf8"));
  }
  for (const entry of manifest.licenses) await readChecked(new URL(entry.path, residual), entry, entry.path);
  // Read-only reuse of the merged #743/#761 Gemini excerpts, checked against their own manifest.
  const geminiProposal = new URL("gemini-proposal/", fixtures);
  const geminiManifest = JSON.parse(await readFile(new URL("manifest.json", geminiProposal), "utf8"));
  for (const entry of geminiManifest.excerpts) {
    text.set(entry.id, (await readChecked(new URL(entry.path, root), entry, entry.id)).toString("utf8"));
  }
  outcomes = Object.fromEntries(
    [...text.get("tools-confirmation-outcome").matchAll(/^ {2}(\w+) = '([a-z_]+)',$/gm)].map((m) => [m[1], m[2]]),
  );
  expect(Object.keys(outcomes)).toHaveLength(7);
});

describe("provenance", () => {
  it("pins every excerpt to an exact revision and agrees with the existing #713/#743 records", () => {
    expect(manifest.status).toMatch(/^offline-proposal-only/);
    const revisions = {
      "google-gemini/gemini-cli": GEMINI,
      "openai/codex": CODEX,
      "agentclientprotocol/codex-acp": CODEX_ACP_230,
    };
    for (const entry of manifest.excerpts) {
      expect(entry.revision, entry.id).toBe(revisions[entry.repository]);
      expect(entry.url).toBe(
        `https://github.com/${entry.repository}/blob/${entry.revision}/${entry.upstreamPath}#L${entry.startLine}-L${entry.endLine}`,
      );
      expect(text.get(entry.id).split("\n")).toHaveLength(entry.endLine - entry.startLine + 2);
    }
    const recorded = Object.fromEntries(pins.excerpts.map((excerpt) => [excerpt.upstreamPath, excerpt]));
    const ours = Object.fromEntries(manifest.excerpts.map((entry) => [entry.id, entry]));
    // Same upstream file, same blob as the #713 record and the #761 extract.
    expect(ours["codex-allow-test"].sourceBlobSha).toBe(
      recorded["codex-rs/hooks/src/events/pre_tool_use.rs"].sourceBlobSha,
    );
    expect(ours["gemini-update-policy"].sourceBlobSha).toBe("71c5640db9bb681b4e1cd34fa0c6fa6595597359");
    expect(pins.providers.find((p) => p.id === "gemini").native.revision).toBe(GEMINI);
    expect(pins.providers.find((p) => p.id === "codex").candidate.revision).toBe(CODEX);
  });

  it("records codex-acp 2.3.0 as drift only: its declared range now includes the 0.164.0 hook candidate", () => {
    const codex = pins.providers.find((p) => p.id === "codex");
    // The research pin is unchanged: bridge 2.2.2 declares ^0.160.1, which excludes 0.164.0.
    expect(codex.adapter).toMatchObject({ version: "2.2.2", nativeDependency: "^0.160.1" });
    expect(codex.adapter.candidateWithinDeclaredNativeRange).toBe(false);
    expect(text.get("codex-acp-manifest-dependency")).toContain('"@openai/codex": "^0.164.0"');
    const caret = (range, version) => {
      // Pre-1.0 caret: same 0.minor, patch at least the floor.
      const [, minor, patch] = range.slice(1).split(".").map(Number);
      const [, vMinor, vPatch] = version.split(".").map(Number);
      return vMinor === minor && vPatch >= patch;
    };
    expect(caret("^0.160.1", "0.164.0")).toBe(false);
    expect(caret("^0.164.0", "0.164.0")).toBe(true);
    expect(manifest.pinDrift[0]).toMatchObject({
      tag: "v2.3.0",
      revision: CODEX_ACP_230,
      nativeDependency: "^0.164.0",
    });
    // A declared range is not an installed selection or a qualification.
    expect(manifest.pinDrift[0].note).toMatch(/no tuple is selected or qualified/);
  });
});

// ─── Gemini ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Pinned updatePolicy → standard update → MessageBus.publish → UPDATE_POLICY subscriber, and the pinned
 * sandbox approval store. Everything outside the excerpts is a labelled in-memory stub.
 */
async function geminiModule() {
  return pureModule(`
    // ── ORCA stubs (not Gemini code) ──
    const EventEmitter = globalThis.__orcaEventEmitter;
    const ToolConfirmationOutcome = Object.freeze(${JSON.stringify(outcomes)});
    const MessageBusType = { UPDATE_POLICY: "update-policy", TOOL_CONFIRMATION_REQUEST: "tool-confirmation-request" };
    const ApprovalMode = { DEFAULT: "default", AUTO_EDIT: "autoEdit", YOLO: "yolo", PLAN: "plan" };
    const MODES_BY_PERMISSIVENESS = ["plan", "default", "autoEdit", "yolo"];
    const EDIT_TOOL_NAMES = new Set(["replace", "write_file"]);
    const PolicyDecision = { ALLOW: "allow", DENY: "deny", ASK_USER: "ask_user" };
    const USER_POLICY_TIER = 4;
    const WORKSPACE_POLICY_TIER = 3;
    const getAlwaysAllowPriorityFraction = () => 950;
    const TOOLS_REQUIRING_NARROWING = new Set(["run_shell_command"]);
    const MCP_TOOL_PREFIX = "mcp_";
    const isSafeRegExp = () => true;
    const debugLogger = { warn() {}, debug() {}, error() {} };
    const safeJsonStringify = (value) => JSON.stringify(value);
    const makeRelative = (filePath) => filePath;
    const buildFilePathArgsPattern = (filePath) => '"file_path":"' + filePath;
    async function handleMcpPolicyUpdate() { throw new Error("not reached by these cases"); }
    export const host = { feedback: [], files: new Map(), writes: [], failOpen: undefined };
    const coreEvents = { emitFeedback: (kind, message) => host.feedback.push([kind, message]) };
    const isNodeError = (error) => error instanceof Error && "code" in error;
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const fs = {
      // Async file API for the policy updater; records, never touches disk.
      async mkdir() {},
      async readFile(file) { if (!host.files.has(file)) throw enoent(); return host.files.get(file); },
      async lstat() { return null; },
      async copyFile() {},
      async unlink() {},
      async open(file) {
        if (host.failOpen) throw host.failOpen;
        return { async writeFile(content) { host.files.set(file, content); }, async close() {} };
      },
      async rename(from, to) { host.files.set(to, host.files.get(from)); host.files.delete(from); host.writes.push(to); },
      // Sync file API for the sandbox manager.
      existsSync: () => true,
      mkdirSync() {},
      writeFileSync(file, content) { host.writes.push(file); host.files.set(file, content); },
    };
    const path = { dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/", isAbsolute: (p) => p.startsWith("/") };
    const toml = { parse: (s) => JSON.parse(s), stringify: (v) => JSON.stringify(v) };
    const crypto = { randomBytes: () => ({ toString: () => "0000" }) };
    const findMatchingRule = (rules, wanted) =>
      rules.find((r) => r.toolName === wanted.toolName && JSON.stringify(r.commandPrefix) === JSON.stringify(wanted.commandPrefix));
    const createTomlRule = (toolName, message) => ({ toolName, commandPrefix: message.commandPrefix, decision: "allow" });
    const toPathKey = (p) => p; // reduced: upstream may normalise case per platform
    // ── pinned excerpts ──
    ${text.get("policy-utils-escape-regex")}
    ${text.get("policy-utils-args-patterns")}
    ${text.get("gemini-update-policy")}
    ${text.get("scheduler-standard-policy-update")}
    ${text.get("gemini-policy-updater")}
    ${text.get("gemini-normalize-command")}
    ${text.get("gemini-dedupe-paths")}
    export class ReducedMessageBus extends EventEmitter {
      constructor() { super(); this.debug = false; this.listenerToAbortCleanup = new WeakMap(); }
      isValidMessage(message) { return typeof message?.type === "string"; } // reduced validator
      ${text.get("gemini-bus-emit")}
      ${text.get("gemini-bus-publish")}
      ${text.get("gemini-bus-subscribe")}
    }
    export class ReducedSandboxPolicyManager {
      constructor() {
        this.configPath = "/fixture/home/.gemini/policies/sandbox.toml";
        this.config = { commands: {} };
        this.sessionApprovals = {};
      }
      ${text.get("gemini-sandbox-protected-key")}
      ${text.get("gemini-sandbox-save")}
      ${text.get("gemini-sandbox-approvals")}
    }
    // The pinned sandbox-expansion callback, with its closure locals supplied.
    export function sandboxOnConfirm(context, rootCommand, effectiveAdditionalPermissions) {
      return function () {
        return { ${text.get("shell-sandbox-on-confirm")} };
      }.call({ context });
    }
  `);
}

// data: modules have no imports here, so the one Node class the bus extends is handed over explicitly.
globalThis.__orcaEventEmitter = EventEmitter;

function geminiHarness(mod) {
  const engine = { rules: [], addRule: (rule) => engine.rules.push(rule) };
  const bus = new mod.ReducedMessageBus();
  const storage = {
    getAutoSavedPolicyPath: () => "/fixture/home/.gemini/policies/auto-saved.toml",
    getWorkspaceAutoSavedPolicyPath: () => "/fixture/work/.gemini/policies/auto-saved.toml",
  };
  mod.createPolicyUpdater(engine, bus, storage);
  const modes = [];
  const context = {
    config: {
      getApprovalMode: () => "default",
      setApprovalMode: (mode) => modes.push(mode),
      isTrustedFolder: () => true,
      getWorkspacePoliciesDir: () => "/fixture/work/.gemini/policies",
      getTargetDir: () => "/fixture/work",
    },
  };
  mod.host.feedback.length = 0;
  mod.host.writes.length = 0;
  mod.host.files.clear();
  mod.host.failOpen = undefined;
  return { engine, bus, context, modes };
}

const shellTool = { name: "run_shell_command" };
const execDetails = (command, roots) => ({ type: "exec", command, rootCommands: roots });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Gemini: an updatePolicy call is not a stored-policy effect (pinned, synthetic stubs)", () => {
  let gem;
  beforeAll(async () => {
    gem = await geminiModule();
  });

  it.each(["proceed_once", "cancel"])("%s reaches updatePolicy yet stores no rule", async (outcome) => {
    const { engine, bus, context } = geminiHarness(gem);
    // The merged #743 tests record this call as "updatePolicy:<outcome>"; that log line is all it is.
    await gem.updatePolicy(shellTool, outcome, execDetails("git status", ["git"]), context, bus, undefined);
    await flush();
    expect(engine.rules).toEqual([]);
    expect(gem.host.writes).toEqual([]);
  });

  it("an always answer stores an ALLOW prefix rule synchronously, before updatePolicy yields", async () => {
    const { engine, bus, context } = geminiHarness(gem);
    const controller = new AbortController();
    let rulesWhenAbortRan;
    queueMicrotask(() => {
      rulesWhenAbortRan = engine.rules.length;
      controller.abort();
    });
    const pending = gem.updatePolicy(shellTool, "proceed_always", execDetails("git status", ["git"]), context, bus);
    const rulesOnReturn = engine.rules.length;
    await pending;
    // publish → EventEmitter.emit → subscriber's synchronous prefix → addRule, all inside the call.
    expect(rulesOnReturn).toBe(1);
    expect(rulesWhenAbortRan).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    const [rule] = engine.rules;
    expect(rule).toMatchObject({ toolName: "run_shell_command", decision: "allow", source: "Dynamic (Confirmed)" });
    expect(rule.argsPattern.test(JSON.stringify({ command: "git push --force origin main" }))).toBe(true);
    // So no cancellation can land "during" the in-memory commit; a cancel seen later is after it.
    expect(gem.host.writes).toEqual([]);
  });

  it("persistence is queued, not awaited: a failed write leaves the in-memory grant and only feedback", async () => {
    const { engine, bus, context } = geminiHarness(gem);
    gem.host.failOpen = Object.assign(new Error("EACCES"), { code: "EACCES" });
    await expect(
      gem.updatePolicy(shellTool, "proceed_always_and_save", execDetails("npm test", ["npm"]), context, bus),
    ).resolves.toBeUndefined();
    expect(engine.rules).toHaveLength(1);
    await flush();
    expect(gem.host.writes).toEqual([]);
    expect(gem.host.feedback).toEqual([["error", "Failed to persist policy for run_shell_command: EACCES"]]);
  });

  it("a successful save reaches the workspace policy file only after updatePolicy has resolved", async () => {
    const { engine, bus, context } = geminiHarness(gem);
    await gem.updatePolicy(shellTool, "proceed_always_and_save", execDetails("npm test", ["npm"]), context, bus);
    const writesAtResolve = gem.host.writes.length;
    await flush();
    expect(engine.rules).toHaveLength(1);
    expect(gem.host.writes).toEqual(["/fixture/work/.gemini/policies/auto-saved.toml"]);
    expect(writesAtResolve).toBe(0);
    expect(JSON.parse(gem.host.files.get("/fixture/work/.gemini/policies/auto-saved.toml"))).toEqual({
      rule: [{ toolName: "run_shell_command", commandPrefix: ["npm"], decision: "allow" }],
    });
  });

  it("an always answer on an edit tool also switches the session to AUTO_EDIT, outside the rule store", async () => {
    const { bus, context, modes } = geminiHarness(gem);
    await gem.updatePolicy(
      { name: "replace" },
      "proceed_always",
      { type: "edit", filePath: "/fixture/a.ts" },
      context,
      bus,
    );
    expect(modes).toEqual(["autoEdit"]);
  });
});

describe("Gemini: remembered sandbox approvals (pinned store, synthetic stubs)", () => {
  let gem;
  beforeAll(async () => {
    gem = await geminiModule();
  });

  it("a persisted read grant comes back as a write grant; a session grant keeps the distinction", () => {
    const manager = new gem.ReducedSandboxPolicyManager();
    gem.host.writes.length = 0;
    const readOnly = { fileSystem: { read: ["/fixture/data"], write: [] }, network: false };
    manager.addSessionApproval("cat", readOnly);
    expect(manager.getCommandPermissions("cat").fileSystem).toEqual({ read: ["/fixture/data"], write: [] });
    manager.addPersistentApproval("tar", readOnly);
    // allowed_paths has no read/write split, so the stored grant is wider than the one shown.
    expect(manager.getCommandPermissions("tar").fileSystem).toEqual({
      read: ["/fixture/data"],
      write: ["/fixture/data"],
    });
    expect(gem.host.writes).toEqual(["/fixture/home/.gemini/policies/sandbox.toml"]);
  });

  it("remembered approvals are keyed by the command's base name, not by the approved action", () => {
    const manager = new gem.ReducedSandboxPolicyManager();
    const grant = { fileSystem: { read: [], write: ["/fixture/home/.npm"] }, network: true };
    manager.addSessionApproval("/usr/bin/npm", grant); // approved for one `npm install` request
    for (const name of ["npm", "NPM", "C:\\tools\\npm.exe", "/opt/other/npm"]) {
      expect(manager.getCommandPermissions(name), name).toEqual({
        fileSystem: { read: [], write: ["/fixture/home/.npm"] },
        network: true,
      });
    }
    expect(manager.getCommandPermissions("__proto__").network).toBe(false);
  });

  it("the macOS and Windows managers merge the same remembered scope (source-reviewed, not run)", () => {
    for (const id of ["gemini-sandbox-macos-merge", "gemini-sandbox-windows-merge", "sandbox-linux-merge"]) {
      const source = text.get(id);
      expect(source, id).toContain("this.options.policyManager?.getCommandPermissions(commandName)");
      expect(source, id).toContain("...(persistentPermissions?.fileSystem?.write ?? [])");
      expect(source, id).toContain("persistentPermissions?.network ||");
    }
  });

  it("the sandbox-expansion callback commits synchronously when invoked, before the caller can check", async () => {
    const manager = new gem.ReducedSandboxPolicyManager();
    gem.host.writes.length = 0;
    const { onConfirm } = gem.sandboxOnConfirm({ config: { sandboxPolicyManager: manager } }, "curl", {
      fileSystem: { read: [], write: [] },
      network: true,
    });
    const pending = onConfirm("proceed_always_and_save");
    expect(manager.getCommandPermissions("curl").network).toBe(true);
    expect(gem.host.writes).toHaveLength(1);
    await pending;
  });
});

/**
 * Proposed (ORCA reference model, not Gemini code): the #743 ordering checks cancellation after
 * onConfirm and before updatePolicy. Staged commit dry-runs both pinned effects against capturing
 * doubles, checks once, then applies both in one synchronous step, so nothing interleaves.
 */
function stagedEffects() {
  const staged = { sandbox: undefined, policy: [] };
  const recorder = {
    addPersistentApproval: (name, permissions) => (staged.sandbox = ["persistent", name, permissions]),
    addSessionApproval: (name, permissions) => (staged.sandbox = ["session", name, permissions]),
  };
  return { staged, recorder };
}

describe("Gemini: three contracts for remembered scope and cancellation", () => {
  let gem;
  beforeAll(async () => {
    gem = await geminiModule();
  });

  it("counterexample for the #743 ordering: a cancel between callback and policy leaves a partial commit", async () => {
    const { engine, bus, context } = geminiHarness(gem);
    const manager = new gem.ReducedSandboxPolicyManager();
    const controller = new AbortController();
    const details = { ...execDetails("curl https://example.invalid", ["curl"]), type: "sandbox_expansion" };
    const { onConfirm } = gem.sandboxOnConfirm({ config: { sandboxPolicyManager: manager } }, "curl", {
      fileSystem: { read: [], write: [] },
      network: true,
    });
    // The #743 sequence, reduced: onConfirm; [check]; updatePolicy. The cancel lands in the await gap.
    const pending = onConfirm("proceed_always");
    queueMicrotask(() => controller.abort());
    await pending;
    let policyRan = false;
    if (!controller.signal.aborted) {
      policyRan = true;
      await gem.updatePolicy(shellTool, "proceed_always", details, context, bus);
    }
    expect(policyRan).toBe(false);
    expect(manager.getCommandPermissions("curl").network).toBe(true); // sandbox store committed
    expect(engine.rules).toEqual([]); // policy store did not
  });

  it("proposed staged commit: both stores or neither, and a dry run that equals the real effect", async () => {
    for (const cancelBeforeCommit of [true, false]) {
      const { engine, bus, context } = geminiHarness(gem);
      const manager = new gem.ReducedSandboxPolicyManager();
      const controller = new AbortController();
      const plan = stagedEffects();
      const grant = { fileSystem: { read: [], write: [] }, network: true };
      // Stage: run the pinned callback and policy derivation against capturing doubles.
      await gem
        .sandboxOnConfirm({ config: { sandboxPolicyManager: plan.recorder } }, "curl", grant)
        .onConfirm("proceed_always");
      const capture = new gem.ReducedMessageBus();
      capture.on("update-policy", (message) => plan.staged.policy.push(message));
      await gem.updatePolicy(shellTool, "proceed_always", execDetails("curl x", ["curl"]), context, capture);
      if (cancelBeforeCommit) controller.abort();
      // Check, then apply both synchronously: nothing can run between these two statements.
      if (!controller.signal.aborted) {
        const [kind, name, permissions] = plan.staged.sandbox;
        manager[kind === "persistent" ? "addPersistentApproval" : "addSessionApproval"](name, permissions);
        for (const message of plan.staged.policy) bus.emit(message.type, message);
      }
      const committed = [manager.getCommandPermissions("curl").network, engine.rules.length];
      expect(committed, `cancel before commit: ${cancelBeforeCommit}`).toEqual(
        cancelBeforeCommit ? [false, 0] : [true, 1],
      );
      // The staged message is exactly what the unstaged path publishes.
      expect(plan.staged.policy).toEqual([
        expect.objectContaining({ type: "update-policy", commandPrefix: ["curl"], persist: false }),
      ]);
    }
  });

  it("proposed per-option scope projection: computed by the same dry run, it shows what each option remembers", async () => {
    const { context } = geminiHarness(gem);
    const project = async (outcome, details) => {
      const capture = new gem.ReducedMessageBus();
      const messages = [];
      capture.on("update-policy", (message) => messages.push(message));
      await gem.updatePolicy(shellTool, outcome, details, context, capture);
      if (messages.length === 0) return null;
      const [{ commandPrefix, persist, persistScope }] = messages;
      return { toolName: shellTool.name, commandPrefix, persist, persistScope: persistScope ?? null };
    };
    const details = execDetails("git status", ["git"]);
    const projection = {
      proceed_once: await project("proceed_once", details),
      proceed_always: await project("proceed_always", details),
      proceed_always_and_save: await project("proceed_always_and_save", details),
    };
    expect(projection).toEqual({
      proceed_once: null,
      proceed_always: { toolName: "run_shell_command", commandPrefix: ["git"], persist: false, persistScope: null },
      proceed_always_and_save: {
        toolName: "run_shell_command",
        commandPrefix: ["git"],
        persist: true,
        persistScope: "workspace",
      },
    });
    // An exact-action client keeps only options that remember nothing.
    const exactOnly = Object.keys(projection).filter((id) => projection[id] === null);
    expect(exactOnly).toEqual(["proceed_once"]);
  });

  it("once-only exact authorization: the pinned disableAlwaysAllow knob offers only once/reject", async () => {
    const mod = await pureModule(`
      const ToolConfirmationOutcome = Object.freeze(${JSON.stringify(outcomes)});
      ${text.get("acp-utils-permission-options")}
    `);
    const config = (disable) => ({ getDisableAlwaysAllow: () => disable });
    const ids = (disable, permanent) =>
      mod.toPermissionOptions({ type: "exec" }, config(disable), permanent).map((o) => o.optionId);
    expect(ids(false, true)).toEqual(["proceed_always", "proceed_always_and_save", "proceed_once", "cancel"]);
    expect(ids(true, true)).toEqual(["proceed_once", "cancel"]);
    // Source-reviewed: the policy engine also skips always-allow-priority rules under this setting.
    expect(text.get("gemini-engine-skip-always")).toContain("this.disableAlwaysAllow && this.isAlwaysAllowRule(rule)");
    // It does not reach the sandbox store: a grant remembered earlier still comes back.
    const manager = new (await geminiModule()).ReducedSandboxPolicyManager();
    manager.config.commands.curl = { allowed_paths: [], allow_network: true }; // from an earlier session
    expect(manager.getCommandPermissions("curl").network).toBe(true);
  });
});

// ─── Pi ─────────────────────────────────────────────────────────────────────────────────────────

const BASH_STUBS = `
export const host = { events: [] };
const { isAbsolute, normalize } = globalThis.__orcaPosixPath; // ORCA stub for node:path (POSIX only)
const constants = { F_OK: 0 };
const osConstants = { signals: {} };
async function fsAccess(p) { host.events.push(["access", p]); }
function spawn(file, args, options) {
  host.events.push(["spawn", { file, args: [...args], cwd: options.cwd }]);
  const stream = { on() {} };
  return { pid: undefined, signalCode: null, stdout: stream, stderr: stream, stdin: { on() {}, end() {} } };
}
async function waitForChildProcess() { return 0; }
function getShellConfig() { return { shell: "/fixture/bin/sh", args: ["-c"] }; }
function getShellEnv() { return { FIXTURE: "public" }; }
function killProcessTree() {}
function trackDetachedChildPid() {}
function untrackDetachedChildPid() {}
const Type = { Object: (s) => s, String: (o) => o ?? {}, Number: (o) => o ?? {}, Boolean: (o) => o ?? {}, Optional: (s) => s };
class OutputAccumulator {
  append() {} finish() {} getLastLineBytes() { return 0; } async closeTempFile() {}
  snapshot() { return { content: "", truncation: { truncated: false } }; }
  async readFullOutput() { return { content: "", truncated: false }; }
}
const BASH_UPDATE_THROTTLE_MS = 0;
function createShellRenderers() { return {}; }
function wrapToolDefinition(definition) { return definition; }
const DEFAULT_MAX_BYTES = 1024;
const DEFAULT_MAX_LINES = 10;
function formatSize(bytes) { return String(bytes); }
`;
globalThis.__orcaPosixPath = path.posix;

function bashModule(source) {
  const at = source.indexOf("\nconst MAX_TIMEOUT_MS") + 1;
  expect(at).toBeGreaterThan(0);
  const header = source
    .slice(0, at)
    .split(/;\n/)
    .map((statement) => statement.trim());
  expect(header.filter(Boolean).every((statement) => statement.startsWith("import "))).toBe(true);
  const body = source.slice(at);
  expect(body).not.toMatch(/^\s*import\s|import\(|require\(|child_process|process\.env/m);
  return pureModule(`${BASH_STUBS}\n${body}`);
}

describe("Pi: absolute effective cwd after every transformation (proposed addendum, pinned bash)", () => {
  let proposal;
  let addendum;
  beforeAll(async () => {
    const piProposal = new URL("pi-proposal/", fixtures);
    const piManifest = JSON.parse(await readFile(new URL("manifest.json", piProposal), "utf8"));
    const upstreamEntry = piManifest.upstream.find((entry) => entry.id === "pi-bash");
    const diffEntry = piManifest.proposed.find((entry) => entry.upstream === "pi-bash");
    const pinned = await readChecked(new URL(upstreamEntry.path, piProposal), upstreamEntry, "pi-bash");
    expect(gitBlob(pinned)).toBe(upstreamEntry.gitBlobSha);
    const merged = applyUnifiedDiff(
      pinned.toString("utf8"),
      (await readChecked(new URL(diffEntry.path, piProposal), diffEntry, diffEntry.path)).toString("utf8"),
    );
    expect(gitBlob(Buffer.from(merged))).toBe(diffEntry.postImageBlob);
    const own = manifest.orcaAuthored[0];
    expect(own.preImageBlob).toBe(diffEntry.postImageBlob);
    const ownDiff = (await readChecked(new URL(own.path, residual), own, own.path)).toString("utf8");
    expect(ownDiff).toContain(`index ${own.preImageBlob}..${own.postImageBlob} 100644\n`);
    const patched = applyUnifiedDiff(merged, ownDiff);
    expect(gitBlob(Buffer.from(patched))).toBe(own.postImageBlob);
    proposal = await bashModule(merged);
    addendum = await bashModule(patched);
  });

  async function run(mod, { spawnHook, commandPrefix, ctx } = {}) {
    mod.host.events.length = 0;
    const seen = [];
    const definition = mod.createBashToolDefinition("/fixture/session", {
      exposeSessionEnvironment: false,
      spawnHook,
      commandPrefix,
      finalCheck: () => async (action) => {
        seen.push(action);
        return { outcome: "allow", action };
      },
    });
    let error;
    try {
      await definition.execute("call-a", { command: "printf fixture" }, undefined, undefined, ctx);
    } catch (caught) {
      error = caught.message;
    }
    const spawns = mod.host.events.filter(([kind]) => kind === "spawn").map(([, value]) => value);
    return { seen, spawns, error };
  }

  it.each([
    ["relative", "relative/dir"],
    ["dot-dot", "/fixture/work/../elsewhere"],
    ["dot", "/fixture/./work"],
    ["empty", ""],
  ])("refuses a %s cwd before the check and before spawn", async (_, cwd) => {
    const hook = (context) => ({ ...context, cwd });
    const before = await run(proposal, { spawnHook: hook });
    if (cwd !== "") {
      // The merged proposal checks and dispatches the unresolved string as-is.
      expect(before.seen.map((action) => action.cwd)).toEqual([cwd]);
      expect(before.spawns.map((spawned) => spawned.cwd)).toEqual([cwd]);
    }
    const after = await run(addendum, { spawnHook: hook });
    expect(after.seen).toEqual([]);
    expect(after.spawns).toEqual([]);
    expect(after.error).toMatch(/cwd must be an absolute normalized path/);
  });

  it("still binds the final transformed action: prefix, context cwd and spawnHook reach check and spawn intact", async () => {
    const { seen, spawns } = await run(addendum, {
      commandPrefix: "set -e",
      ctx: { cwd: "/fixture/context" },
      spawnHook: (context) => ({ ...context, cwd: "/fixture/hooked", command: `${context.command}; true` }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cwd: "/fixture/hooked",
      executor: "local",
      transformations: ["commandPrefix", "contextCwd", "spawnHook"],
    });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(spawns).toEqual([{ file: "/fixture/bin/sh", args: ["-c", seen[0].command], cwd: "/fixture/hooked" }]);
  });

  it("an absolute normalized cwd is necessary, not sufficient: it does not name the physical target", () => {
    // A symlinked component still reaches whatever it points to at spawn time; the check binds a
    // string, so the canonical physical-target fact stays the capture owner's to supply.
    expect(path.posix.normalize("/fixture/link/../x")).toBe("/fixture/x");
    const action = { ...actionFixture(), effectiveCwd: complete("/fixture/hooked"), resources: unknown };
    expect(evaluateStrictPermission(action, stateFixture(action), NOW, "test:review").verdict).toMatchObject({
      outcome: "indeterminate",
      reason: "required-fact:resources",
    });
  });
});

/**
 * Proposed (ORCA reference model, not Pi code): environment binding without sending values. Pi would
 * compute, per variable, HMAC-SHA256 under a per-session key the client supplied when it negotiated,
 * over length-prefixed name and value. The client holds its expected values and the key, so it can
 * match; a log or relay without the key learns names only.
 */
const lengthPrefixed = (value) => {
  const bytes = Buffer.from(value, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([size, bytes]);
};

function envBinding(env, key) {
  const names = Object.keys(env).sort();
  // envp is "NAME=value"; a name holding "=" or NUL has no single meaning there, so it is refused.
  if (names.some((name) => name === "" || /[=\0]/.test(name)) || names.some((name) => env[name].includes("\0")))
    return { status: "refused" };
  const digests = Object.fromEntries(
    names.map((name) => [
      name,
      createHmac("sha256", key).update(lengthPrefixed(name)).update(lengthPrefixed(env[name])).digest("hex"),
    ]),
  );
  return { status: "bound", names, digests };
}

/** Client side: complete only when every sent variable is one the policy expects, with its value. */
function envVerdict(binding, policy, key) {
  if (binding.status !== "bound") return "indeterminate:environment-unbound";
  const extra = binding.names.filter((name) => !(name in policy.expected));
  if (extra.length > 0) return `indeterminate:unexpected:${extra.join(",")}`;
  const missing = Object.keys(policy.expected)
    .filter((name) => !binding.names.includes(name))
    .sort();
  if (missing.length > 0) return `indeterminate:missing:${missing.join(",")}`;
  const expected = envBinding(policy.expected, key);
  for (const name of binding.names) {
    if (binding.digests[name] !== expected.digests[name]) return `deny:value-mismatch:${name}`;
  }
  return "complete";
}

describe("Pi: environment value binding versus privacy (proposed contract, reference model)", () => {
  const key = Buffer.alloc(32, 7); // synthetic per-session client key
  const base = { PATH: "/usr/bin:/bin", HOME: "/fixture/home" };
  const policy = { expected: base };

  it("names-only (the merged proposal) cannot tell two environments apart; per-key digests can", () => {
    const hostile = { ...base, PATH: "/fixture/evil:/usr/bin:/bin" };
    expect(Object.keys(hostile).sort()).toEqual(Object.keys(base).sort());
    expect(envVerdict(envBinding(base, key), policy, key)).toBe("complete");
    expect(envVerdict(envBinding(hostile, key), policy, key)).toBe("deny:value-mismatch:PATH");
    expect(envVerdict(envBinding({ ...base, BASH_ENV: "/fixture/x.sh" }, key), policy, key)).toBe(
      "indeterminate:unexpected:BASH_ENV",
    );
  });

  it.each([{}, { PATH: base.PATH }, { HOME: base.HOME }])("requires every expected environment key (%j)", (env) => {
    const verdict = envVerdict(envBinding(env, key), policy, key);
    expect(verdict).toMatch(/^indeterminate:missing:/);
    const action = {
      ...actionFixture(),
      environmentAndCredentialRefs: verdict === "complete" ? complete([]) : unknown,
    };
    expect(evaluateStrictPermission(action, stateFixture(action), NOW, "test:review").verdict).toMatchObject({
      outcome: "indeterminate",
      reason: "required-fact:environmentAndCredentialRefs",
    });
  });

  it("accepts the exact required keyset regardless of insertion order and an explicitly empty contract", () => {
    expect(envVerdict(envBinding({ HOME: base.HOME, PATH: base.PATH }, key), policy, key)).toBe("complete");
    expect(envVerdict(envBinding({}, key), { expected: {} }, key)).toBe("complete");
  });

  it("an unkeyed digest leaks low-entropy values to anyone with a guess list; a keyed one does not", () => {
    const secretish = "/tmp/payload.sh";
    const guesses = ["/etc/profile", "/tmp/payload.sh", "/fixture/x.sh"];
    const unkeyed = sha256(secretish);
    expect(guesses.find((guess) => sha256(guess) === unkeyed)).toBe(secretish);
    const keyed = envBinding({ BASH_ENV: secretish }, key).digests.BASH_ENV;
    const otherKey = Buffer.alloc(32, 9);
    expect(guesses.find((guess) => envBinding({ BASH_ENV: guess }, otherKey).digests.BASH_ENV === keyed)).toBe(
      undefined,
    );
    // Different sessions' keys make the same value unlinkable across transcripts.
    expect(envBinding(base, otherKey).digests.PATH).not.toBe(envBinding(base, key).digests.PATH);
    // The wire form carries no value bytes.
    expect(JSON.stringify(envBinding({ BASH_ENV: secretish }, key))).not.toContain(secretish);
  });

  it("names that envp cannot represent unambiguously are refused, never digested", () => {
    // {"A": "B=C"} and {"A=B": "C"} both become the envp string "A=B=C".
    expect(envBinding({ A: "B=C" }, key).status).toBe("bound");
    expect(envBinding({ "A=B": "C" }, key).status).toBe("refused");
    expect(envBinding({ A: "x\0y" }, key).status).toBe("refused");
    expect(envVerdict(envBinding({ "A=B": "C" }, key), policy, key)).toBe("indeterminate:environment-unbound");
  });

  it("only a complete client verdict can make the canonical environment fact complete", () => {
    const verdicts = [
      ["names only", undefined],
      ["digest verified", envVerdict(envBinding(base, key), policy, key)],
    ];
    const results = verdicts.map(([, verdict]) => {
      const action = {
        ...actionFixture(),
        environmentAndCredentialRefs: verdict === "complete" ? complete([]) : unknown,
      };
      return evaluateStrictPermission(action, stateFixture(action), NOW, "test:review").verdict;
    });
    expect(results[0]).toMatchObject({
      outcome: "indeterminate",
      reason: "required-fact:environmentAndCredentialRefs",
    });
    expect(results[1]).toMatchObject({ outcome: "allow" }); // synthetic fixture coverage only
  });
});

/**
 * Proposed (ORCA reference model, not Pi code): a negotiation reply that carries coverage derived
 * from the live tool registry, and a client validator that refuses any claim the registry cannot
 * support. Coverage is tied to an epoch that every authorize request echoes.
 */
function negotiationReply(registry) {
  const bash = registry.tools.bash;
  const tool = !bash
    ? { toolName: "bash", definition: "absent" }
    : {
        toolName: "bash",
        definition: bash.builtin ? "builtin" : "replaced",
        executor: bash.operations ? "custom" : "local",
        // A truthful Pi never claims its check on a replaced definition or on custom operations.
        finalCheck: bash.builtin && bash.wired && !bash.operations ? "bound" : "unbound",
      };
  return {
    type: "response",
    command: "enable_final_action_authorization",
    success: true,
    data: { contract: "orca.pi-final-action/1", coverageEpoch: registry.epoch, tools: [tool] },
  };
}

function acceptNegotiation(reply) {
  const data = reply?.success === true ? reply.data : undefined;
  if (!data) return { supported: false, reason: "no-coverage-statement" };
  if (data.contract !== "orca.pi-final-action/1" || typeof data.coverageEpoch !== "string")
    return { supported: false, reason: "unknown-contract" };
  const bash = Array.isArray(data.tools) ? data.tools.filter((tool) => tool?.toolName === "bash") : [];
  if (bash.length !== 1) return { supported: false, reason: "bash-not-stated-once" };
  const [tool] = bash;
  if (tool.finalCheck === "bound" && (tool.executor !== "local" || tool.definition !== "builtin"))
    return { supported: false, reason: "contradictory-coverage-claim" };
  if (tool.definition !== "builtin" || tool.executor !== "local" || tool.finalCheck !== "bound")
    return { supported: false, reason: `uncovered:${tool.definition}/${tool.executor}/${tool.finalCheck}` };
  return { supported: true, coverageEpoch: data.coverageEpoch };
}

describe("Pi: a coverage-bearing negotiation reply (proposed contract, reference model)", () => {
  const builtin = { builtin: true, wired: true };

  it("the merged proposal's reply states no coverage, so a strict client stays unsupported", async () => {
    const rpcDiff = await readFile(new URL("pi-proposal/proposed/pi-rpc-mode.diff", fixtures), "utf8");
    // The exact reply the merged proposal emits, read from its diff rather than restated.
    const literal =
      /output\(\{ (id, type: "response", command: "enable_final_action_authorization", success: true) \}\)/.exec(
        rpcDiff,
      );
    expect(literal).not.toBeNull();
    const reply = { id: "n1", type: "response", command: "enable_final_action_authorization", success: true };
    expect(acceptNegotiation(reply)).toEqual({ supported: false, reason: "no-coverage-statement" });
  });

  it.each([
    ["builtin local bash, wired", { epoch: "e1", tools: { bash: builtin } }, { supported: true, coverageEpoch: "e1" }],
    [
      "baseToolsOverride / extension replaces bash",
      { epoch: "e1", tools: { bash: { builtin: false, wired: false } } },
      {
        supported: false,
        reason: "uncovered:replaced/local/unbound",
      },
    ],
    [
      "custom (SSH) operations",
      { epoch: "e1", tools: { bash: { ...builtin, operations: {} } } },
      {
        supported: false,
        reason: "uncovered:builtin/custom/unbound",
      },
    ],
    [
      "no bash at all",
      { epoch: "e1", tools: {} },
      { supported: false, reason: "uncovered:absent/undefined/undefined" },
    ],
  ])("derived from the registry: %s", (_, registry, expected) => {
    expect(acceptNegotiation(negotiationReply(registry))).toEqual(expected);
  });

  it.each([
    ["a bound hook on a custom executor", { definition: "builtin", executor: "custom", finalCheck: "bound" }],
    ["a bound hook on a replaced definition", { definition: "replaced", executor: "local", finalCheck: "bound" }],
  ])("rejects an asserted claim of %s", (_, tool) => {
    const reply = negotiationReply({ epoch: "e1", tools: { bash: builtin } });
    reply.data.tools = [{ toolName: "bash", ...tool }];
    expect(acceptNegotiation(reply)).toEqual({ supported: false, reason: "contradictory-coverage-claim" });
  });

  it("generic elicitation answers and duplicate tool rows are never coverage", () => {
    expect(acceptNegotiation({ type: "extension_ui_response", id: "x", value: "Allow" })).toMatchObject({
      supported: false,
    });
    expect(acceptNegotiation({ type: "extension_ui_response", id: "x", confirmed: true })).toMatchObject({
      supported: false,
    });
    const doubled = negotiationReply({ epoch: "e1", tools: { bash: builtin } });
    doubled.data.tools.push({ ...doubled.data.tools[0], finalCheck: "unbound" });
    expect(acceptNegotiation(doubled)).toEqual({ supported: false, reason: "bash-not-stated-once" });
  });

  it("a registry change after negotiation invalidates coverage: requests must echo the epoch", () => {
    const accepted = acceptNegotiation(negotiationReply({ epoch: "e1", tools: { bash: builtin } }));
    const adapterAccepts = (request) => accepted.supported && request.coverageEpoch === accepted.coverageEpoch;
    expect(adapterAccepts({ coverageEpoch: "e1" })).toBe(true);
    // e.g. an extension reload rebinds tools; Pi would bump the epoch and the old coverage no longer applies.
    expect(adapterAccepts({ coverageEpoch: "e2" })).toBe(false);
    expect(adapterAccepts({})).toBe(false);
  });
});

// ─── Codex ──────────────────────────────────────────────────────────────────────────────────────

describe("Codex 0.164.0 / codex-acp 2.3.0: pinned contracts (source-reviewed, not executed)", () => {
  it("PreToolUse for exec_command sees {command} only; workdir, shell and sandbox fields are not in it", () => {
    const payload = text.get("codex-exec-hook-payload");
    expect(payload).toContain('tool_input: serde_json::json!({ "command": args.cmd })');
    expect(payload.match(/json!\(/g)).toHaveLength(1);
    const args = text.get("codex-exec-args");
    for (const field of [
      "shell:",
      "login:",
      "sandbox_permissions:",
      "additional_permissions:",
      "prefix_rule:",
      "workdir:",
      "environment_id:",
    ]) {
      expect(args, field).toContain(field);
      expect(payload, field).not.toContain(field.slice(0, -1));
    }
    // The hook's cwd is the environment or turn cwd, not the call's workdir.
    expect(text.get("codex-hook-cwd")).toContain(
      ".local_environment_cwd()\n        .unwrap_or_else(|| turn.cwd.clone())",
    );
    expect(text.get("codex-write-stdin-hook")).toMatch(/do not emit a second pre hook here\.\n\s+None/);
  });

  it("a failed, timed-out, ask or bare-allow hook continues; only a block or a rewrite changes dispatch", async () => {
    // The #713 parser excerpt (read-only, digest-checked) maps a runner error — timeout, spawn
    // failure — to Failed without setting should_block; its ask test pins the same for ask.
    const record = pins.excerpts.find((excerpt) => excerpt.id === "codex-parser");
    const parser = await readChecked(new URL(record.path, root), record, record.id);
    expect(parser.toString("utf8")).toMatch(/Some\(error\) => \{\n\s+status = HookRunStatus::Failed;/);
    expect(parser.toString("utf8")).toContain("should_block = true;");
    const allow = text.get("codex-allow-test");
    expect(allow).toContain("fn permission_decision_allow_without_updated_input_fails_open()");
    expect(allow).toContain("should_block: false");
    expect(allow).toContain("HookRunStatus::Failed");
    const dispatch = text.get("codex-registry-dispatch");
    expect(dispatch).toContain("PreToolUseHookResult::Blocked(message) =>");
    expect(dispatch).toContain("tool.with_updated_hook_input(invocation.clone(), updated_input)");
    expect(dispatch).toMatch(/PreToolUseHookResult::Continue \{\n\s+updated_input: None,\n\s+\} => \{\}/);
  });

  it("required managed hooks fail session start on load errors only; reload and disablement are not re-checked", () => {
    const hooks = text.get("codex-hooks-new");
    expect(hooks).toContain('"failed to load required managed hooks: {}"');
    const reconfigured = hooks.slice(hooks.indexOf("pub fn reconfigured"));
    expect(reconfigured).not.toContain("required_load_errors");
    expect(text.get("codex-hooks-disabled")).toContain("discovered.required_load_errors.clear();");
    // Untrusted or modified non-managed hooks are listed but never become handlers.
    expect(text.get("codex-hook-admission")).toContain("HookTrustStatus::Managed | HookTrustStatus::Trusted");
    expect(text.get("codex-hook-trust")).toContain("Some(_) => HookTrustStatus::Modified");
  });

  it("codex-acp 2.3.0 keeps the #594 evidence gaps and exposes only session-flag hooks", () => {
    expect(text.get("codex-acp-command-permission")).toContain("{command: stripShellPrefix(params.command)}");
    // The native approval handler still receives parsed params only: no JSON-RPC request id.
    expect(text.get("codex-acp-approval-dispatch")).toContain(
      "this.connection.onRequest(CommandExecutionApprovalRequest, async (params) => {",
    );
    expect(text.get("codex-acp-hook-trust")).toContain(
      'hooks: entry.hooks.filter(hook => hook.source === "sessionFlags")',
    );
  });
});

/**
 * Proposed (ORCA reference model, not Codex code): what a required, managed PreToolUse handler would
 * mean. The pinned column mirrors the excerpts above; it is a reduced restatement, not the Rust parser.
 */
const PINNED = {
  completedNoOutput: "continue",
  blocked: "block",
  exit2WithReason: "block",
  exit2NoReason: "continue",
  failedNonZeroExit: "continue",
  timeout: "continue",
  invalidJson: "continue",
  ask: "continue",
  bareAllow: "continue",
  notAdmittedUntrusted: "continue",
  spawnFailure: "continue",
};

function requiredHandlerOutcome(kind, { rewrittenByAnother = false } = {}) {
  // Deny-only, fail-closed: the required handler is the policy, so anything but a clean run blocks.
  // "ask" blocks here; it never pauses for a person (Codex is not Claude's permission flow).
  if (kind === "completedNoOutput") return rewrittenByAnother ? "rerun-on-final-input" : "continue";
  return "block";
}

describe("Codex: smallest native contract for a required PreToolUse handler (proposed, reference model)", () => {
  it("fails closed on every outcome the pinned parser lets through", () => {
    const table = Object.fromEntries(Object.keys(PINNED).map((kind) => [kind, requiredHandlerOutcome(kind)]));
    expect(table).toEqual({
      completedNoOutput: "continue",
      blocked: "block",
      exit2WithReason: "block",
      exit2NoReason: "block",
      failedNonZeroExit: "block",
      timeout: "block",
      invalidJson: "block",
      ask: "block",
      bareAllow: "block",
      notAdmittedUntrusted: "block",
      spawnFailure: "block",
    });
    const changed = Object.keys(PINNED).filter((kind) => PINNED[kind] !== table[kind]);
    expect(changed).toEqual([
      "exit2NoReason",
      "failedNonZeroExit",
      "timeout",
      "invalidJson",
      "ask",
      "bareAllow",
      "notAdmittedUntrusted",
      "spawnFailure",
    ]);
  });

  it("a later rewrite by any handler voids the required handler's decision until it sees the final input", () => {
    expect(requiredHandlerOutcome("completedNoOutput", { rewrittenByAnother: true })).toBe("rerun-on-final-input");
  });

  it("hook input must carry the effective exec facts, or two different actions look the same", () => {
    // Reduced mirror of the pinned one-line projection, next to the proposed one.
    const pinnedInput = (args) => ({ command: args.cmd });
    const proposedInput = (args, environmentCwd) => ({
      command: args.cmd,
      workdir: args.workdir ? path.posix.resolve(environmentCwd, args.workdir) : environmentCwd,
      shell: args.shell ?? null,
      login: args.login ?? null,
      environmentId: args.environment_id ?? null,
      sandboxPermissions: args.sandbox_permissions ?? null,
      additionalPermissions: args.additional_permissions ?? null,
      prefixRule: args.prefix_rule ?? null,
    });
    const a = { cmd: "rm -rf build" };
    const b = { cmd: "rm -rf build", workdir: "../other", sandbox_permissions: "require_escalated" };
    expect(pinnedInput(a)).toEqual(pinnedInput(b));
    expect(proposedInput(a, "/fixture/work")).not.toEqual(proposedInput(b, "/fixture/work"));
    expect(proposedInput(b, "/fixture/work").workdir).toBe("/fixture/other");
  });
});
