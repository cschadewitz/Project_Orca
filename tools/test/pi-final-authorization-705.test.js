/** #705 Pi final-action proposal: pinned upstream bytes, strictly applied diffs, synthetic stubs; no shell or provider. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateStrictPermission, selectStrictPermissionOption, strictDecisionBinding } from "@orca/core";
import { actionFixture, complete, NOW, stateFixture } from "../../packages/agents/test/strict-permission-fixtures.ts";

const root = new URL("../../", import.meta.url);
const fixtures = new URL("tools/test/fixtures/provider-enforcement-704-705/", root);
const proposal = new URL("pi-proposal/", fixtures);
const PI = "4a080252f06caf63a525d7873c5d94d3c23887e0";
const PI_ACP = "b0581c9c1d675e634234674484247008b03d69b4";
const ALLOW = "final-allow-once";
const REJECT = "final-reject-once";
const unknown = { state: "unknown", reason: "offline fixture: qualification unavailable" };

let manifest;
let pins;
const upstream = new Map();
const patched = new Map();
let bash;
let patchedBash;
let acp;
let patchedAcp;
let rpc;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]))
    .digest("hex");

/** Strict unified-diff application: every context and removed line must match the pinned bytes. */
function applyUnifiedDiff(source, diff) {
  const lines = source.split("\n");
  const patch = diff.split("\n");
  expect(patch.at(-1)).toBe("");
  expect(diff).not.toContain("\\ No newline at end of file");
  const out = [];
  let at = 0;
  let i = patch.findIndex((line) => line.startsWith("@@ "));
  expect(i).toBeGreaterThan(0);
  while (i < patch.length - 1) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch[i]);
    expect(header, patch[i]).not.toBeNull();
    const [oldStart, oldCount, newStart, newCount] = header.slice(1).map(Number);
    expect(oldStart - 1).toBeGreaterThanOrEqual(at);
    out.push(...lines.slice(at, oldStart - 1));
    at = oldStart - 1;
    expect(out.length).toBe(newStart - 1);
    let removed = 0;
    let added = 0;
    for (i++; i < patch.length - 1 && !patch[i].startsWith("@@ "); i++) {
      const [mark, text] = [patch[i][0], patch[i].slice(1)];
      if (mark === " " || mark === "-") {
        expect(lines[at], `pinned line ${at + 1}`).toBe(text);
        at++;
        removed++;
      }
      if (mark === " " || mark === "+") {
        out.push(text);
        added++;
      }
      expect([" ", "-", "+"]).toContain(mark);
    }
    expect([removed, added]).toEqual([oldCount, newCount]);
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

function once(text, marker) {
  const index = text.indexOf(marker);
  expect(index, marker).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(marker, index + 1), marker).toBe(-1);
  return index;
}

/** The exact text from `start` up to, not including, `end`. Both markers must be unique. */
const slice = (text, start, end) => text.slice(once(text, start), once(text, end));

async function pureModule(source) {
  // Only digest-checked upstream text plus the reviewed ORCA scaffolding written in this file.
  const code = stripTypeScriptTypes(source);
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// ORCA test scaffolding replacing bash.ts's imports. No process, filesystem, network or shell access:
// spawn only records its arguments, so command strings stay inert data.
const BASH_STUBS = `
export const host = { events: [], exitCode: 0, onAccess: undefined };
const constants = { F_OK: 0 };
const osConstants = { signals: {} };
async function fsAccess(path) { host.events.push(["access", path]); if (host.onAccess) await host.onAccess(path); }
function spawn(file, args, options) {
  host.events.push(["spawn", { file, args: [...args], cwd: options.cwd, env: { ...options.env } }]);
  const stream = { on() {} };
  return { pid: undefined, signalCode: null, stdout: stream, stderr: stream, stdin: { on() {}, end() {} } };
}
async function waitForChildProcess() { return host.exitCode; }
function getShellConfig(shellPath) { host.events.push(["shell-config", shellPath ?? null]); return { shell: "/fixture/bin/sh", args: ["-c"] }; }
function getShellEnv() { return { FIXTURE: "public", PI_SESSION_ID: "old" }; }
function killProcessTree(pid) { host.events.push(["kill", pid]); }
function trackDetachedChildPid() {}
function untrackDetachedChildPid() {}
const Type = { Object: (shape) => shape, String: (o) => o ?? {}, Number: (o) => o ?? {}, Boolean: (o) => o ?? {}, Optional: (s) => s };
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

function bashModule(source) {
  const at = once(source, "\nconst MAX_TIMEOUT_MS") + 1;
  // Only import declarations are dropped; the stubs above replace every one of them.
  const header = source
    .slice(0, at)
    .split(/;\n/)
    .map((statement) => statement.trim());
  expect(header.filter(Boolean).every((statement) => statement.startsWith("import "))).toBe(true);
  const body = source.slice(at);
  expect(body).not.toMatch(/^\s*import\s|import\(|require\(|child_process|process\.env/m);
  return pureModule(`${BASH_STUBS}\n${body}`);
}

function rpcModule(source) {
  const channel = slice(
    source,
    "\t// Pending extension UI requests waiting for response",
    "\t/**\n\t * Create an extension UI context that uses the RPC protocol.",
  );
  const pure = slice(source, "/** The options a final-action request offers.", "/**\n * Run in RPC mode.");
  const binding = source.split("\n").find((line) => line.includes("finalActionCheck: () => (finalActionAuthorization"));
  const receive = slice(
    source,
    "\t\t// Opt in to typed final bash authorization;",
    "\t\tconst command = parsed as RpcCommand;",
  );
  return pureModule(`
    // ORCA test scaffolding: output is captured in memory; nothing is written to stdout.
    export const host = { outputs: [], onOutput: undefined };
    function output(value) { const copy = JSON.parse(JSON.stringify(value)); host.outputs.push(copy); host.onOutput?.(copy); }
    async function waitForRawStdoutBackpressure() {}
    ${pure}
    ${channel}
    export const bindings = { ${binding} };
    export async function receive(parsed) {
    ${receive}
    }
    export { authorizeFinalAction, finalActionDecision, finalActionRequest, pendingExtensionRequests };
  `);
}

function acpModule(source, typed) {
  const constants = source.slice(
    once(source, "type PermissionResponse ="),
    once(source, "const CHOICE_OPTION_PREFIX = 'choice-'\n") + "const CHOICE_OPTION_PREFIX = 'choice-'\n".length,
  );
  const methods = slice(source, "  private async handleExtensionUiRequest(", "\n}\n\nfunction extensionUiToolCall(");
  const functions = slice(source, "function extensionUiToolCall(", "function formatAutoRetryMessage(");
  return pureModule(`
    ${constants}
    // ORCA test scaffolding: the upstream methods run against injected synthetic connections.
    export class FixtureSession {
      constructor(deps) { Object.assign(this, { updates: [] }, deps); }
      emit(update) { this.updates.push(update); }
      ${methods}
    }
    ${functions}
    ${typed ? "export { finalActionPermissionRequest, finalActionSelection };" : ""}
  `);
}

beforeAll(async () => {
  manifest = JSON.parse(await readFile(new URL("manifest.json", proposal), "utf8"));
  pins = JSON.parse(
    await readFile(new URL("docs/preparation/provider-enforcement-704-705/source-pins.json", root), "utf8"),
  );
  for (const entry of manifest.upstream) {
    const bytes = await readFile(new URL(entry.path, proposal));
    expect(bytes.byteLength, entry.id).toBe(entry.bytes);
    expect(sha256(bytes), entry.id).toBe(entry.sha256);
    expect(gitBlob(bytes), entry.id).toBe(entry.gitBlobSha);
    upstream.set(entry.id, bytes.toString("utf8"));
  }
  for (const entry of manifest.proposed) {
    const bytes = await readFile(new URL(entry.path, proposal));
    expect(bytes.byteLength, entry.path).toBe(entry.bytes);
    expect(sha256(bytes), entry.path).toBe(entry.sha256);
    const diff = bytes.toString("utf8");
    expect(diff).toContain(`index ${entry.preImageBlob}..${entry.postImageBlob} 100644\n`);
    expect(diff).toContain(`--- a/${entry.upstreamPath}\n+++ b/${entry.upstreamPath}\n`);
    if (!entry.upstream) continue;
    const pinned = manifest.upstream.find((source) => source.id === entry.upstream);
    expect(pinned.upstreamPath).toBe(entry.upstreamPath);
    expect(pinned.gitBlobSha).toBe(entry.preImageBlob);
    const result = applyUnifiedDiff(upstream.get(entry.upstream), diff);
    expect(gitBlob(Buffer.from(result)), entry.path).toBe(entry.postImageBlob);
    patched.set(entry.upstream, result);
  }
  bash = await bashModule(upstream.get("pi-bash"));
  patchedBash = await bashModule(patched.get("pi-bash"));
  acp = await acpModule(upstream.get("pi-acp-session"), false);
  patchedAcp = await acpModule(patched.get("pi-acp-session"), true);
  rpc = await rpcModule(patched.get("pi-rpc-mode"));
});

async function runBash(
  mod,
  { toolCallId = "call-a", command = "printf fixture", options, ctx, signal, onUpdate, onAccess } = {},
) {
  mod.host.events.length = 0;
  mod.host.onAccess = onAccess;
  const definition = mod.createBashToolDefinition("/fixture/session", { exposeSessionEnvironment: false, ...options });
  return definition.execute(toolCallId, { command }, signal, onUpdate, ctx);
}

const spawns = (mod) => mod.host.events.filter(([kind]) => kind === "spawn").map(([, value]) => value);

function recordingCheck(decide) {
  const seen = [];
  return {
    seen,
    options: {
      finalCheck: () => async (action, signal) => {
        seen.push(action);
        return decide(action, signal);
      },
    },
  };
}

// ORCA test-side reduced model, not a production adapter: one ACP permission request to canonical
// evidence. Option effects come from this synthetic table keyed by option id under the proposed
// revision, never from the request's kind, name or text. No reviewed or landed revision exists.
const SYNTHETIC_QUALIFIED = new Map([
  [ALLOW, { kind: "allow_once", effect: "this-invocation" }],
  [REJECT, { kind: "reject_once", effect: "this-invocation" }],
]);

function canonicalAction(request) {
  const base = actionFixture();
  const toolCall = request.toolCall;
  const typed = toolCall.kind === "execute" && !toolCall.toolCallId.startsWith("pi-ui-");
  const invocation = { ...base.invocation, invocationId: toolCall.toolCallId };
  const cwd = toolCall.rawInput?.cwd;
  return {
    ...base,
    bindingRef: `test:final:${toolCall.toolCallId}`,
    invocation,
    effectiveCwd: typed && typeof cwd === "string" ? complete(cwd) : unknown,
    offeredChoices: request.options.map((option) => {
      const qualified = typed ? SYNTHETIC_QUALIFIED.get(option.optionId) : undefined;
      if (!qualified)
        return {
          optionId: option.optionId,
          kind: "unknown",
          effect: "unknown",
          qualificationRef: unknown,
          grantScopeAndLifetime: unknown,
        };
      return {
        optionId: option.optionId,
        ...qualified,
        qualificationRef: complete("test:synthetic-unreviewed-proposal"),
        grantScopeAndLifetime: complete({
          scopeRef: invocation.invocationId,
          expiresAt: new Date(NOW + 5000).toISOString(),
          maximumUses: 1,
        }),
      };
    }),
  };
}

/** Only the local executor has a (synthetic) capture-owner precondition; anything else is unqualified. */
function canonicalDecision(request) {
  const action = canonicalAction(request);
  const local = request.toolCall.rawInput?.executor === "local";
  const state = local ? stateFixture(action) : { ...stateFixture(action), coverageAndState: unknown };
  const result = evaluateStrictPermission(action, state, NOW, "test:review");
  const optionId = result.phase === "final" ? selectStrictPermissionOption(action, result.verdict, NOW) : undefined;
  return { result, optionId };
}

const acpAnswer = (request) => {
  const { optionId } = canonicalDecision(request);
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
};

describe("pinned provenance", () => {
  it("pins verbatim Pi and pi-acp bytes to the #713 record and applies every diff to its pinned pre-image", () => {
    expect(manifest.nativePin).toMatchObject({ revision: PI, version: "1.4.0" });
    expect(manifest.adapterPin).toMatchObject({ revision: PI_ACP, version: "0.0.34", nativeCorrespondence: "unknown" });
    const recorded = Object.fromEntries(pins.excerpts.map((excerpt) => [excerpt.id, excerpt]));
    const byId = Object.fromEntries(manifest.upstream.map((entry) => [entry.id, entry]));
    expect(byId["pi-bash"].gitBlobSha).toBe(recorded["pi-spawn"].sourceBlobSha);
    expect(byId["pi-acp-session"].gitBlobSha).toBe(recorded["pi-ui"].sourceBlobSha);
    for (const entry of manifest.upstream) {
      expect(entry.revision).toBe(entry.repository === "svkozak/pi-acp" ? PI_ACP : PI);
      expect(entry.url).toBe(`https://github.com/${entry.repository}/blob/${entry.revision}/${entry.upstreamPath}`);
    }
    const agentSession = manifest.proposed.find((entry) => entry.upstreamPath.endsWith("agent-session.ts"));
    expect(agentSession.preImageBlob).toBe(recorded["pi-dispatch"].sourceBlobSha);
    expect(patched.size).toBe(4);
    expect(manifest.status).toMatch(/^proposal-only-not-submitted/);
  });

  it("matches the existing #713 pi-ui and pi-resolve excerpts line for line", async () => {
    const lines = (text, from, to) =>
      `${text
        .split("\n")
        .slice(from - 1, to)
        .join("\n")}\n`;
    const read = (name) => readFile(new URL(name, fixtures), "utf8");
    expect(lines(upstream.get("pi-acp-session"), 957, 1029)).toBe(await read("pi-ui.txt"));
    expect(lines(upstream.get("pi-bash"), 268, 275)).toBe(await read("pi-resolve.txt"));
  });
});

describe("pinned Pi bash: early input is not the dispatched action", () => {
  it("prefix, effective context cwd and spawnHook change what dispatch receives after tool_call", async () => {
    const input = "printf fixture";
    await runBash(bash, {
      command: input,
      ctx: { cwd: "/fixture/context" },
      options: {
        commandPrefix: "printf prefix",
        spawnHook: (context) => ({ ...context, command: `${context.command}-hooked`, cwd: "/fixture/hooked" }),
      },
    });
    expect(spawns(bash)).toEqual([
      {
        file: "/fixture/bin/sh",
        args: ["-c", "printf prefix\nprintf fixture-hooked"],
        cwd: "/fixture/hooked",
        env: { FIXTURE: "public" },
      },
    ]);
    expect(input).toBe("printf fixture");
  });

  it("reads the spawn context again at dispatch, after resolution", async () => {
    let retained;
    await runBash(bash, {
      options: { spawnHook: (context) => (retained = { ...context }) },
      onUpdate: () => {
        if (retained) retained.command = "printf mutated-after-resolution";
      },
    });
    expect(spawns(bash)[0].args).toEqual(["-c", "printf mutated-after-resolution"]);
  });

  it("starts the local shell when aborted during its working-directory await", async () => {
    const controller = new AbortController();
    await expect(runBash(bash, { signal: controller.signal, onAccess: () => controller.abort() })).rejects.toThrow(
      "Command aborted",
    );
    expect(spawns(bash)).toHaveLength(1);
  });
});

describe("proposed Pi final check", () => {
  it("keeps the native path byte-for-byte when no protected check is bound", async () => {
    const options = {
      commandPrefix: "printf prefix",
      spawnHook: (context) => ({ ...context, cwd: "/fixture/hooked" }),
    };
    await runBash(bash, { options, ctx: { cwd: "/fixture/context" } });
    const native = structuredClone(bash.host.events);
    await runBash(patchedBash, {
      options: { ...options, finalCheck: () => undefined },
      ctx: { cwd: "/fixture/context" },
    });
    expect(patchedBash.host.events).toEqual(native);
  });

  it("checks the final command, cwd, env and resolved shell and dispatches exactly that", async () => {
    const check = recordingCheck((action) => ({ outcome: "allow", action }));
    await runBash(patchedBash, {
      ctx: { cwd: "/fixture/context" },
      options: {
        ...check.options,
        commandPrefix: "printf prefix",
        spawnHook: (context) => ({ ...context, command: `${context.command}-hooked`, env: { FIXTURE: "hooked" } }),
      },
    });
    const [action] = check.seen;
    expect(action).toEqual({
      toolCallId: "call-a",
      toolName: "bash",
      executor: "local",
      shell: { shell: "/fixture/bin/sh", args: ["-c"] },
      command: "printf prefix\nprintf fixture-hooked",
      cwd: "/fixture/context",
      env: { FIXTURE: "hooked" },
      timeout: undefined,
      transformations: ["commandPrefix", "contextCwd", "spawnHook"],
    });
    expect(Object.isFrozen(action) && Object.isFrozen(action.env) && Object.isFrozen(action.shell.args)).toBe(true);
    expect(spawns(patchedBash)).toEqual([
      { file: action.shell.shell, args: ["-c", action.command], cwd: action.cwd, env: { ...action.env } },
    ]);
    // The shell is resolved once, before the check, and dispatch reuses that resolution.
    expect(patchedBash.host.events.filter(([kind]) => kind === "shell-config")).toHaveLength(1);
  });

  it("dispatches the checked values when the retained spawn context mutates during the check", async () => {
    let retained;
    const check = recordingCheck(async (action) => {
      retained.command = "printf mutated-during-check";
      retained.cwd = "/fixture/elsewhere";
      retained.env.FIXTURE = "mutated";
      return { outcome: "allow", action };
    });
    await runBash(patchedBash, {
      options: { ...check.options, spawnHook: (context) => (retained = { ...context, env: { ...context.env } }) },
    });
    expect(spawns(patchedBash)).toEqual([
      { file: "/fixture/bin/sh", args: ["-c", "printf fixture"], cwd: "/fixture/session", env: { FIXTURE: "public" } },
    ]);
  });

  it("a checker that tries to rewrite the frozen action fails closed with no dispatch", async () => {
    const check = recordingCheck((action) => {
      action.command = "printf rewritten";
      return { outcome: "allow", action };
    });
    await expect(runBash(patchedBash, { options: check.options })).rejects.toThrow(TypeError);
    expect(spawns(patchedBash)).toEqual([]);
  });

  it("names custom operations as unqualified and the canonical checker refuses them", async () => {
    const executed = [];
    const operations = { exec: async (...args) => executed.push(args) && { exitCode: 0 } };
    let decision;
    const check = recordingCheck((action) => {
      const event = rpc.finalActionRequest(action);
      const request = patchedAcp.finalActionPermissionRequest("test:session", event);
      decision = canonicalDecision(request);
      return decision.optionId ? { outcome: "allow", action } : { outcome: "block", reason: "unqualified executor" };
    });
    await expect(runBash(patchedBash, { options: { ...check.options, operations } })).rejects.toThrow(
      "Blocked by final action check: unqualified executor",
    );
    expect(check.seen[0]).toMatchObject({ executor: "custom", shell: undefined });
    expect(decision.result).toMatchObject({
      verdict: { outcome: "indeterminate", reason: "coverage-or-state-unavailable" },
    });
    expect(executed).toEqual([]);
    expect(patchedBash.host.events.filter(([kind]) => kind === "shell-config")).toEqual([]);
  });

  it("does not let a decision for one invocation authorize another with identical input", async () => {
    const pending = new Map();
    const check = recordingCheck(
      (action) => new Promise((resolve) => pending.set(action.toolCallId, { action, resolve })),
    );
    const a = runBash(patchedBash, { toolCallId: "call-a", options: check.options });
    await Promise.resolve();
    const b = runBash(patchedBash, { toolCallId: "call-b", options: check.options });
    await Promise.resolve();
    const { toolCallId: _a, ...left } = pending.get("call-a").action;
    const { toolCallId: _b, ...right } = pending.get("call-b").action;
    expect(left).toEqual(right);
    pending.get("call-b").resolve({ outcome: "allow", action: pending.get("call-a").action });
    pending.get("call-a").resolve({ outcome: "allow", action: pending.get("call-a").action });
    await expect(b).rejects.toThrow("no decision for this action");
    await expect(a).resolves.toBeDefined();
    expect(spawns(patchedBash)).toHaveLength(1);
  });

  it.each([
    ["a thrown checker error", () => Promise.reject(new Error("checker unavailable")), "checker unavailable"],
    ["no decision", () => undefined, "no decision for this action"],
    [
      "an allow for an equal copy",
      (action) => ({ outcome: "allow", action: { ...action } }),
      "no decision for this action",
    ],
    ["a block", () => ({ outcome: "block", reason: "policy says no" }), "policy says no"],
    ["an unrecognized outcome", (action) => ({ outcome: "allow_once", action }), "no decision for this action"],
  ])("preserves native error blocking for %s", async (_label, decide, message) => {
    await expect(runBash(patchedBash, { options: recordingCheck(decide).options })).rejects.toThrow(message);
    expect(spawns(patchedBash)).toEqual([]);
  });

  it("an abort during the check await prevents dispatch even after an allow", async () => {
    const controller = new AbortController();
    const check = recordingCheck((action) => {
      controller.abort();
      return { outcome: "allow", action };
    });
    await expect(runBash(patchedBash, { signal: controller.signal, options: check.options })).rejects.toThrow(
      "Command aborted",
    );
    expect(spawns(patchedBash)).toEqual([]);
    // A custom executor has no abort check of its own, so the post-check recheck is what stops it.
    const executed = [];
    const operations = { exec: async (...args) => executed.push(args) && { exitCode: 0 } };
    const late = new AbortController();
    const custom = recordingCheck((action) => {
      late.abort();
      return { outcome: "allow", action };
    });
    await expect(
      runBash(patchedBash, { signal: late.signal, options: { ...custom.options, operations } }),
    ).rejects.toThrow("Command aborted");
    expect(executed).toEqual([]);
  });

  it("an abort during the local working-directory await no longer starts the shell", async () => {
    const controller = new AbortController();
    const check = recordingCheck((action) => ({ outcome: "allow", action }));
    await expect(
      runBash(patchedBash, { signal: controller.signal, options: check.options, onAccess: () => controller.abort() }),
    ).rejects.toThrow("Command aborted");
    expect(spawns(patchedBash)).toEqual([]);
  });
});

/** Fresh frozen action as the patched bash tool would build it; the parser only reads fields. */
const finalAction = (toolCallId = "call-a", cwd = "test:cwd") =>
  Object.freeze({
    toolCallId,
    toolName: "bash",
    executor: "local",
    shell: Object.freeze({ shell: "/fixture/bin/sh", args: Object.freeze(["-c"]) }),
    command: "printf fixture",
    cwd,
    env: Object.freeze({ FIXTURE: "public", SECRET_FIXTURE: "never-sent" }),
    timeout: undefined,
    transformations: Object.freeze([]),
  });

const respond = (id, body) => rpc.receive({ type: "extension_ui_response", id, ...body });

describe("proposed Pi RPC typed authorization over the pinned one-shot dialog channel", () => {
  it("is off until negotiated, and the negotiation reply is the only evidence it is on", async () => {
    // Module state is shared with later tests; this runs first and enables it once.
    expect(rpc.bindings.finalActionCheck()).toBeUndefined();
    rpc.host.outputs.length = 0;
    await rpc.receive({ type: "enable_final_action_authorization", id: "negotiate-1" });
    expect(rpc.host.outputs).toEqual([
      { id: "negotiate-1", type: "response", command: "enable_final_action_authorization", success: true },
    ]);
    expect(rpc.bindings.finalActionCheck()).toBe(rpc.authorizeFinalAction);
  });

  it("sends final command and cwd with environment names only, and allows only its own offered allow", async () => {
    const action = finalAction();
    rpc.host.outputs.length = 0;
    const decision = rpc.authorizeFinalAction(action, undefined);
    const [request] = rpc.host.outputs;
    expect(request).toMatchObject({
      type: "extension_ui_request",
      method: "authorize_final_action",
      toolCallId: "call-a",
      command: "printf fixture",
      cwd: "test:cwd",
      executor: "local",
      envKeys: ["FIXTURE", "SECRET_FIXTURE"],
      options: [
        { optionId: ALLOW, kind: "allow_once", effect: "this-invocation" },
        { optionId: REJECT, kind: "reject_once", effect: "this-invocation" },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("never-sent");
    await respond(request.id, { authorization: { toolCallId: "call-a", optionId: ALLOW } });
    const result = await decision;
    expect(result.outcome).toBe("allow");
    expect(result.action).toBe(action);
  });

  it.each([
    ["generic select text", { value: ALLOW }],
    ["a generic confirm", { confirmed: true }],
    ["arbitrary text", { value: "Allow" }],
    ["the offered reject", { authorization: { toolCallId: "call-a", optionId: REJECT } }],
    ["a recognized but unoffered id", { authorization: { toolCallId: "call-a", optionId: "yes" } }],
    ["another tool call", { authorization: { toolCallId: "call-b", optionId: ALLOW } }],
    ["a synthetic UI identity", { authorization: { toolCallId: "pi-ui-1", optionId: ALLOW } }],
    ["a cancel carrying an allow", { cancelled: true, authorization: { toolCallId: "call-a", optionId: ALLOW } }],
  ])("blocks %s", async (_label, body) => {
    rpc.host.outputs.length = 0;
    const decision = rpc.authorizeFinalAction(finalAction(), undefined);
    await respond(rpc.host.outputs[0].id, body);
    await expect(decision).resolves.toMatchObject({ outcome: "block" });
  });

  it("ignores replayed, unknown and late responses and binds each request id to its own call", async () => {
    rpc.host.outputs.length = 0;
    const controller = new AbortController();
    const first = rpc.authorizeFinalAction(finalAction("call-a"), controller.signal);
    const second = rpc.authorizeFinalAction(finalAction("call-b"), undefined);
    const [a, b] = rpc.host.outputs.map((output) => output.id);
    await respond("unknown-id", { authorization: { toolCallId: "call-a", optionId: ALLOW } });
    await respond(a, { authorization: { toolCallId: "call-b", optionId: ALLOW } });
    await expect(first).resolves.toMatchObject({ outcome: "block" });
    await respond(a, { authorization: { toolCallId: "call-a", optionId: ALLOW } });
    expect(rpc.pendingExtensionRequests.has(a)).toBe(false);
    expect(rpc.pendingExtensionRequests.has(b)).toBe(true);
    const third = rpc.authorizeFinalAction(finalAction("call-c"), controller.signal);
    const c = rpc.host.outputs.at(-1).id;
    controller.abort();
    await expect(third).resolves.toMatchObject({ outcome: "block" });
    await respond(c, { authorization: { toolCallId: "call-c", optionId: ALLOW } });
    await respond(b, { authorization: { toolCallId: "call-b", optionId: ALLOW } });
    await expect(second).resolves.toMatchObject({ outcome: "allow" });
    await respond(b, { authorization: { toolCallId: "call-b", optionId: ALLOW } });
    expect(rpc.pendingExtensionRequests.size).toBe(0);
  });
});

/** Synthetic ACP session for the upstream methods. Nothing here is a real client or provider. */
function acpSession(mod, { requestPermission, open = ["call-a"] } = {}) {
  const sent = [];
  const asked = [];
  const session = new mod.FixtureSession({
    sessionId: "test:session",
    cancelRequested: false,
    pendingTurn: { turn: 1 },
    currentToolCalls: new Map(open.map((id) => [id, "in_progress"])),
    proc: { sendExtensionUiResponse: async (response) => sent.push(response) },
    conn: {
      requestPermission: async (request) => {
        asked.push(structuredClone(request));
        return requestPermission(request, session);
      },
    },
  });
  return { session, sent, asked };
}

const typedEvent = (overrides = {}) => ({
  type: "extension_ui_request",
  id: "ui-1",
  ...rpc.finalActionRequest(finalAction()),
  ...overrides,
});

describe("pinned pi-acp generic UI is not exact-command authority", () => {
  it("maps arbitrary select text to allow_once choices on a synthetic pi-ui identity", async () => {
    const { session, sent, asked } = acpSession(acp, {
      requestPermission: () => ({ outcome: { outcome: "selected", optionId: "choice-1" } }),
    });
    await session.handleExtensionUiRequest({
      id: "ui-1",
      method: "select",
      title: "Run printf fixture?",
      options: ["Run it", "allow_once", "printf other"],
    });
    const [request] = asked;
    expect(request.toolCall).toMatchObject({ toolCallId: "pi-ui-ui-1", kind: "other" });
    expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "allow_once", "allow_once"]);
    expect(sent).toEqual([{ id: "ui-1", value: "allow_once" }]);
    const action = canonicalAction(request);
    const allow = {
      ...strictDecisionBinding(action),
      outcome: "allow",
      authorizedBy: { kind: "human", acceptedAnswerRef: "test:answer" },
    };
    expect(selectStrictPermissionOption(action, allow, NOW)).toBeUndefined();
    expect(rpc.finalActionDecision(finalAction(), sent[0])).toMatchObject({ outcome: "block" });
  });

  it("the patched adapter leaves generic select unchanged and still never emits an authorization", async () => {
    const { session, sent } = acpSession(patchedAcp, {
      requestPermission: () => ({ outcome: { outcome: "selected", optionId: "choice-0" } }),
    });
    await session.handleExtensionUiRequest({ id: "ui-2", method: "select", options: [ALLOW] });
    expect(sent).toEqual([{ id: "ui-2", value: ALLOW }]);
    expect(rpc.finalActionDecision(finalAction(), sent[0])).toMatchObject({ outcome: "block" });
  });
});

describe("proposed pi-acp typed final-action request", () => {
  it("asks with Pi's own open tool call id, final command and cwd, and forwards only the selected offered id", async () => {
    const { session, sent, asked } = acpSession(patchedAcp, {
      requestPermission: () => ({ outcome: { outcome: "selected", optionId: ALLOW } }),
    });
    await session.handleExtensionUiRequest(typedEvent());
    expect(asked[0].toolCall).toMatchObject({
      toolCallId: "call-a",
      kind: "execute",
      rawInput: {
        command: "printf fixture",
        cwd: "test:cwd",
        executor: "local",
        envKeys: ["FIXTURE", "SECRET_FIXTURE"],
      },
    });
    expect(asked[0].options.map((option) => option.optionId)).toEqual([ALLOW, REJECT]);
    expect(sent).toEqual([{ id: "ui-1", authorization: { toolCallId: "call-a", optionId: ALLOW } }]);
  });

  it.each(["yes", "choice-0", "allow_always", "final-allow-always", ""])(
    "cancels a recognized-but-unoffered selection %j",
    async (optionId) => {
      const { session, sent } = acpSession(patchedAcp, {
        requestPermission: () => ({ outcome: { outcome: "selected", optionId } }),
      });
      await session.handleExtensionUiRequest(typedEvent());
      expect(sent).toEqual([{ id: "ui-1", cancelled: true }]);
    },
  );

  it.each([
    ["a synthetic UI identity", { toolCallId: "pi-ui-1" }],
    ["an unannounced tool call", { toolCallId: "call-z" }],
    ["a nested call id", { toolCallId: "call-a/1" }],
    [
      "an extra offered option",
      {
        options: [
          { optionId: ALLOW, kind: "allow_once", effect: "this-invocation" },
          { optionId: REJECT, kind: "reject_once", effect: "this-invocation" },
          { optionId: "x", kind: "allow_once", effect: "this-invocation" },
        ],
      },
    ],
    [
      "a remembered allow effect",
      {
        options: [
          { optionId: ALLOW, kind: "allow_once", effect: "remembered" },
          { optionId: REJECT, kind: "reject_once" },
        ],
      },
    ],
    ["a missing cwd", { cwd: undefined }],
    ["an unknown executor", { executor: "ssh" }],
  ])("refuses %s without asking the client", async (_label, overrides) => {
    const { session, sent, asked } = acpSession(patchedAcp, {
      // A synthetic UI id is refused by name even if something tracked it as an open call.
      open: ["call-a", "pi-ui-1"],
      requestPermission: () => ({ outcome: { outcome: "selected", optionId: ALLOW } }),
    });
    await session.handleExtensionUiRequest(typedEvent(overrides));
    expect(asked).toEqual([]);
    expect(sent).toEqual([{ id: "ui-1", cancelled: true }]);
  });

  it.each([
    ["the session is cancelled", (session) => (session.cancelRequested = true)],
    ["a new turn replaces the original", (session) => (session.pendingTurn = { turn: 2 })],
    ["the tool call closes", (session) => session.currentToolCalls.delete("call-a")],
  ])("cancels an allow that returns after %s during the await", async (_label, change) => {
    const { session, sent } = acpSession(patchedAcp, {
      requestPermission: (_request, current) => {
        change(current);
        return { outcome: { outcome: "selected", optionId: ALLOW } };
      },
    });
    await session.handleExtensionUiRequest(typedEvent());
    expect(sent).toEqual([{ id: "ui-1", cancelled: true }]);
  });

  it("cancels when the client request fails or the turn is already cancelled", async () => {
    const failing = acpSession(patchedAcp, {
      requestPermission: () => Promise.reject(new Error("client unavailable")),
    });
    await failing.session.handleExtensionUiRequest(typedEvent());
    expect(failing.sent).toEqual([{ id: "ui-1", cancelled: true }]);
    const cancelled = acpSession(patchedAcp, {
      requestPermission: () => ({ outcome: { outcome: "selected", optionId: ALLOW } }),
    });
    cancelled.session.cancelRequested = true;
    await cancelled.session.handleExtensionUiRequest(typedEvent());
    expect(cancelled.asked).toEqual([]);
    expect(cancelled.sent).toEqual([{ id: "ui-1", cancelled: true }]);
  });
});

describe("bounded synthetic chain through canonical admission", () => {
  /** Patched bash -> patched RPC channel -> patched pi-acp -> canonical reduced model -> back. Stubs only. */
  async function chain({ spawnHook, ctxCwd = "test:cwd", answer = acpAnswer } = {}) {
    const { session, asked } = acpSession(patchedAcp, { requestPermission: answer });
    session.proc.sendExtensionUiResponse = (response) => rpc.receive({ type: "extension_ui_response", ...response });
    rpc.host.onOutput = (event) => {
      if (event.type === "extension_ui_request") void session.handleExtensionUiRequest(event);
    };
    try {
      const run = runBash(patchedBash, {
        ctx: { cwd: ctxCwd },
        options: { finalCheck: () => rpc.bindings.finalActionCheck(), ...(spawnHook ? { spawnHook } : {}) },
      });
      return {
        outcome: await run.then(
          () => "dispatched",
          (error) => error.message,
        ),
        asked,
      };
    } finally {
      rpc.host.onOutput = undefined;
    }
  }

  it("positive control: a synthetic matching rule selects the qualified option and dispatches the checked action", async () => {
    const { outcome, asked } = await chain();
    expect(outcome).toBe("dispatched");
    expect(canonicalDecision(asked[0]).result).toMatchObject({ phase: "final", verdict: { outcome: "allow" } });
    expect(spawns(patchedBash)).toEqual([
      { file: "/fixture/bin/sh", args: ["-c", "printf fixture"], cwd: "test:cwd", env: { FIXTURE: "public" } },
    ]);
    // Certifies nothing: synthetic provider coverage, synthetic qualification, stubbed spawn.
    expect(actionFixture().coverage.provider).toBe("synthetic");
  });

  it("a spawnHook cwd change after tool_call reaches canonical admission and leaves the rule unmatched", async () => {
    const { outcome, asked } = await chain({ spawnHook: (context) => ({ ...context, cwd: "test:other-cwd" }) });
    expect(asked[0].toolCall.rawInput.cwd).toBe("test:other-cwd");
    expect(canonicalDecision(asked[0]).result).toMatchObject({ verdict: { outcome: "require-human" } });
    expect(outcome).toMatch(/^Blocked by final action check/);
    expect(spawns(patchedBash)).toEqual([]);
  });

  it("a checker failure on the client side blocks without dispatch", async () => {
    const { outcome } = await chain({ answer: () => Promise.reject(new Error("checker unavailable")) });
    expect(outcome).toMatch(/^Blocked by final action check/);
    expect(spawns(patchedBash)).toEqual([]);
  });
});
