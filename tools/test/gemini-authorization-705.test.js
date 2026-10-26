/**
 * #705 Gemini ACP permission route: pinned upstream excerpts run before and after the proposed
 * diff, with synthetic dependencies only. No provider, shell, hook, MCP server or policy store runs;
 * command and cwd strings stay data. This is not an upstream-suite or installed-execution result.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { beforeAll, expect, it } from "vitest";
import { evaluateStrictPermission, selectStrictPermissionOption } from "@orca/core";
import {
  actionFixture,
  complete,
  NOW,
  ruleFixture,
  stateFixture,
} from "../../packages/agents/test/strict-permission-fixtures.js";

const root = new URL("../../", import.meta.url);
const proposal = new URL("tools/test/fixtures/provider-enforcement-704-705/gemini-proposal/", root);
const TARGET = "/fixture/target";
const sources = new Map();
let manifest;
let diff;
let outcomes;
let before;
let after;
let shell;

async function pureModule(source) {
  // Only digest-checked excerpts, the proposed diff and the labelled scaffolding below.
  const code = stripTypeScriptTypes(source);
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** Unified diff → files of hunks. A bare empty line is blank context, as `git apply` reads it. */
function parseDiff(text) {
  const files = [];
  let hunk;
  for (const line of text.split("\n").slice(0, -1)) {
    if (line.startsWith("--- a/")) files.push({ path: line.slice(6), hunks: [] });
    else if (line.startsWith("+++ ")) continue;
    else if (line.startsWith("@@ ")) {
      hunk = { oldStart: Number(/^@@ -(\d+)/.exec(line)[1]), lines: [] };
      files.at(-1).hunks.push(hunk);
    } else hunk.lines.push(line === "" ? { op: " ", text: "" } : { op: line[0], text: line.slice(1) });
  }
  return files;
}

/** Applies hunks to an excerpt that begins at `startLine`, refusing any context mismatch. */
function applyHunks(excerpt, startLine, hunks) {
  const lines = excerpt.split("\n");
  let shift = 0;
  for (const hunk of hunks) {
    const at = hunk.oldStart - startLine + shift;
    const old = hunk.lines.filter((line) => line.op !== "+").map((line) => line.text);
    expect(lines.slice(at, at + old.length), `hunk at ${hunk.oldStart}`).toEqual(old);
    const next = hunk.lines.filter((line) => line.op !== "-").map((line) => line.text);
    lines.splice(at, old.length, ...next);
    shift += next.length - old.length;
  }
  return lines.join("\n");
}

function excerptFor(upstreamPath, hunk) {
  const oldLength = hunk.lines.filter((line) => line.op !== "+").length;
  return manifest.excerpts.find(
    (entry) =>
      entry.upstreamPath === upstreamPath &&
      entry.startLine <= hunk.oldStart &&
      hunk.oldStart + oldLength - 1 <= entry.endLine,
  );
}

async function runToolModule(runToolSource) {
  return pureModule(`
    // Synthetic stand-ins, not Gemini code: an enum mirror checked against the pinned enum
    // excerpt, a minimal zod-shaped enum parser and the response schema's two branches.
    const ToolConfirmationOutcome = Object.freeze(${JSON.stringify(outcomes)});
    const z = {
      nativeEnum: (values) => ({
        parse(value) {
          if (Object.values(values).includes(value)) return value;
          throw new Error("Invalid enum value");
        },
      }),
    };
    const RequestPermissionResponseSchema = {
      parse(response) {
        const outcome = response?.outcome;
        if (outcome?.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
        if (outcome?.outcome === "selected" && typeof outcome.optionId === "string")
          return { outcome: { outcome: "selected", optionId: outcome.optionId } };
        throw new Error("Invalid permission response");
      },
    };
    const toAcpToolKind = (kind) => kind;
    ${sources.get("acp-utils-permission-options")}
    export async function runTool(abortSignal, fc, tool, callId, updatePolicy) {
      // Synthetic runTool frame: upstream logs, records history and reports failures here.
      const args = fc.args ?? {};
      const errorResponse = (error) => ({ errorResponse: error.message });
      ${runToolSource}
        return { result: toolResult };
      } catch (error) {
        return { thrown: error.message };
      }
    }
  `);
}

beforeAll(async () => {
  manifest = JSON.parse(await readFile(new URL("manifest.json", proposal), "utf8"));
  const pins = JSON.parse(
    await readFile(new URL("docs/preparation/provider-enforcement-704-705/source-pins.json", root), "utf8"),
  );
  const gemini = pins.providers.find((provider) => provider.id === "gemini");
  expect(manifest.revision).toBe(gemini.native.revision);
  for (const entry of [...manifest.excerpts, ...manifest.files]) {
    const bytes = await readFile(new URL(entry.path, root));
    expect(bytes.byteLength, entry.id).toBe(entry.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"), entry.id).toBe(entry.sha256);
    sources.set(entry.id, bytes.toString("utf8"));
  }
  // The earlier #713 pins for the same upstream files, read here and left unchanged.
  for (const pinned of pins.excerpts.filter((entry) => entry.id.startsWith("gemini-"))) {
    const bytes = await readFile(new URL(pinned.path, root));
    expect(createHash("sha256").update(bytes).digest("hex"), pinned.id).toBe(pinned.sha256);
    expect(pinned.revision).toBe(manifest.revision);
    sources.set(pinned.id, bytes.toString("utf8"));
    for (const entry of manifest.excerpts.filter((own) => own.upstreamPath === pinned.upstreamPath)) {
      expect(entry.sourceBlobSha, entry.id).toBe(pinned.sourceBlobSha);
    }
  }
  // The #713 permission excerpt (694-815) is the leading part of this proposal's 694-840 excerpt.
  expect(sources.get("acp-session-run-tool").startsWith(sources.get("gemini-permission"))).toBe(true);

  outcomes = Object.fromEntries(
    [...sources.get("tools-confirmation-outcome").matchAll(/^ {2}(\w+) = '([a-z_]+)',$/gm)].map((m) => [m[1], m[2]]),
  );
  expect(Object.keys(outcomes)).toHaveLength(7);

  diff = parseDiff(sources.get("proposal"));
  expect(diff.map((file) => file.path)).toEqual(manifest.files.find((file) => file.id === "proposal").targets);
  for (const file of diff) {
    for (const hunk of file.hunks) {
      const entry = excerptFor(file.path, hunk);
      expect(entry, `${file.path}@${hunk.oldStart}`).toBeDefined();
      applyHunks(sources.get(entry.id), entry.startLine, [hunk]);
    }
  }
  const session = manifest.excerpts.find((entry) => entry.id === "acp-session-run-tool");
  const sessionHunks = diff.find((file) => file.path === session.upstreamPath).hunks;
  before = await runToolModule(sources.get("acp-session-run-tool"));
  after = await runToolModule(applyHunks(sources.get("acp-session-run-tool"), session.startLine, sessionHunks));

  // The proposed shell method exactly as the diff adds it, inside a reduced invocation.
  const method = diff
    .find((file) => file.path === "packages/core/src/tools/shell.ts")
    .hunks.flatMap((hunk) => hunk.lines)
    .filter((line) => line.op === "+" && !/^\s+type /.test(line.text))
    .map((line) => line.text)
    .join("\n");
  expect(method).toContain("getAuthorizationProjection(");
  const abortBody = sources.get("gemini-abort").replace(/^ {4}\}\n/, "");
  expect(abortBody).toHaveLength(sources.get("gemini-abort").length - 6);
  shell = await pureModule(`
    import path from "node:path";
    const ToolConfirmationOutcome = Object.freeze(${JSON.stringify(outcomes)});
    // Reduced model: the real ShellToolInvocation has many more members and dependencies.
    const PARAM_ADDITIONAL_PERMISSIONS = "additional_permissions"; // upstream base-declarations.ts value
    export class ReducedShellInvocation {
      proactivePermissionsConfirmed;
      constructor(context, params) {
        this.context = context;
        this.params = params;
      }
      ${method}
    }
    // The pinned sandbox_expansion callback, with its closure inputs supplied synthetically.
    export function sandboxOnConfirmFor(rootCommand, effectiveAdditionalPermissions) {
      return ({
        ${sources.get("shell-sandbox-on-confirm")}
      }).onConfirm;
    }
    // The #713 pre-start abort excerpt after its leading brace (line 540 closes an earlier
    // block); os is synthetic and nothing is spawned.
    const os = { platform: () => "fixture" };
    export async function startProbe(signal, started) {
      ${abortBody}
      started();
      return { llmContent: "synthetic start; nothing executes" };
    }
  `);
});

const selected = (optionId) => ({ outcome: { outcome: "selected", optionId } });
const cancelled = { outcome: { outcome: "cancelled" } };
const NETWORK = { network: true, fileSystem: { read: [], write: ["/fixture/extra"] } };

/** One runTool call over synthetic session, tool, policy and callbacks; returns the ordered effect log. */
async function run(variant, scenario = {}) {
  const log = [];
  const controller = new AbortController();
  const requests = [];
  const context = {
    config: { getDisableAlwaysAllow: () => scenario.disableAlwaysAllow ?? false, getTargetDir: () => TARGET },
    messageBus: { fixture: "bus" },
  };
  const session = {
    id: "test:session",
    disposeController: new AbortController(),
    context,
    settings: { merged: { security: { enablePermanentToolApproval: scenario.permanent ?? false } } },
    async sendUpdate() {},
    connection: {
      async requestPermission(params) {
        requests.push(structuredClone(params));
        const response = scenario.respond
          ? scenario.respond({ params, controller, session })
          : selected("proceed_once");
        // Late delivery is modelled as one more turn of the event loop after any abort.
        await Promise.resolve();
        return response;
      },
    },
  };
  const sandboxOwner = {
    context: {
      config: {
        sandboxPolicyManager: {
          addPersistentApproval: (rootCommand) => log.push(`sandbox-persistent:${rootCommand}`),
          addSessionApproval: (rootCommand) => log.push(`sandbox-session:${rootCommand}`),
        },
      },
    },
  };
  const ctx = { controller, session, log };
  const details = (invocation) => {
    const own = async (outcome) => {
      log.push(`onConfirm:${outcome}`);
      await scenario.duringConfirm?.(ctx);
    };
    if (scenario.kind === "sandbox") {
      const pinned = shell.sandboxOnConfirmFor.call(sandboxOwner, "printf", invocation.params.additional_permissions);
      return {
        type: "sandbox_expansion",
        title: "Sandbox Expansion Request",
        command: invocation.params.command,
        rootCommand: "printf",
        additionalPermissions: invocation.params.additional_permissions,
        onConfirm: async (outcome) => {
          await own(outcome);
          await pinned(outcome);
        },
      };
    }
    // Synthetic exec details shaped like the pinned shell tool's; its onConfirm is a no-op upstream.
    return {
      type: "exec",
      title: "Confirm Shell Command",
      command: invocation.params.command,
      rootCommand: "printf",
      rootCommands: ["printf"],
      onConfirm: own,
    };
  };
  const members = {
    getDisplayTitle() {
      return scenario.title ?? this.params.command;
    },
    getExplanation: () => "",
    toolLocations: () => [],
    async shouldConfirmExecute() {
      this.confirmation = details(this);
      return this.confirmation;
    },
    async execute({ abortSignal }) {
      log.push("execute");
      return shell.startProbe(abortSignal, () => log.push("start"));
    },
  };
  const params = {
    command: scenario.command ?? "printf fixture",
    ...(scenario.dirPath === undefined ? {} : { dir_path: scenario.dirPath }),
    ...(scenario.additional ? { additional_permissions: scenario.additional } : {}),
  };
  let invocation;
  if (scenario.kind === "opaque") {
    // A tool that implements no projection, e.g. one whose exact action the tool cannot state.
    invocation = Object.assign(Object.create(members), { params });
  } else {
    invocation = new shell.ReducedShellInvocation(context, params);
    Object.assign(invocation, members);
    const projection = invocation.getAuthorizationProjection;
    invocation.getAuthorizationProjection = function (...args) {
      log.push("project");
      this.projectedWith = { self: this, args };
      return projection.apply(this, args);
    };
  }
  let builds = 0;
  const tool = {
    name: "run_shell_command",
    kind: "execute",
    build() {
      builds++;
      return invocation;
    },
  };
  const updatePolicy = async (...args) => {
    log.push(`updatePolicy:${args[1]}`);
    ctx.policyArgs = args;
    await scenario.duringPolicy?.(ctx);
  };
  const fc = { name: "run_shell_command", args: params };
  const result = await (variant === "before" ? before : after).runTool.call(
    session,
    controller.signal,
    fc,
    tool,
    scenario.callId ?? "call-1",
    updatePolicy,
  );
  return { result, log, requests, invocation, builds, policyArgs: ctx.policyArgs, context };
}

const effects = (log) => log.filter((entry) => entry !== "project");
const authorization = (request) => request.toolCall._meta?.authorization;

it("upstream asks with presentation fields only; the proposal adds the owner's exact projection", async () => {
  const scenario = { kind: "sandbox", dirPath: "sub/../w ork", additional: NETWORK, respond: () => cancelled };
  const old = await run("before", scenario);
  const toolCall = old.requests[0].toolCall;
  expect(Object.keys(toolCall).sort()).toEqual(["content", "kind", "locations", "status", "title", "toolCallId"]);
  const wire = JSON.stringify(old.requests[0]);
  expect(wire).not.toContain(path.resolve(TARGET, "sub/../w ork"));
  expect(wire).not.toContain("/fixture/extra");

  const next = await run("after", scenario);
  expect(authorization(next.requests[0])).toEqual({
    status: "projected",
    command: "printf fixture",
    dirPath: "sub/../w ork",
    resolvedCwd: path.resolve(TARGET, "sub/../w ork"),
    additionalPermissions: [NETWORK],
  });
  const { _meta, ...presentation } = next.requests[0].toolCall;
  expect(presentation).toEqual(toolCall);
});

it.each([
  ["printf 'a  b'\n", undefined],
  ["  bash -c 'printf hi'  ", ""],
  ["printf 'é中'\r\n", "./a/../b"],
  ["printf one \\\n  two; printf '%s' \"$HOME\"", "dir with space/ü"],
])("preserves exact command bytes and the execute() cwd expression: %j in %j", async (command, dirPath) => {
  const { requests, log } = await run("after", { command, dirPath, respond: () => cancelled });
  const projected = authorization(JSON.parse(JSON.stringify(requests[0])));
  expect(Buffer.from(projected.command)).toEqual(Buffer.from(command));
  expect(projected.dirPath).toBe(dirPath ?? null);
  expect(projected.resolvedCwd).toBe(dirPath ? path.resolve(TARGET, dirPath) : TARGET);
  expect(projected.additionalPermissions).toEqual([]);
  expect(log).not.toContain("execute");
});

it("lists each additional grant execute() would union, once", async () => {
  const proactive = { network: true };
  const { invocation } = await run("after", { kind: "sandbox", additional: NETWORK, respond: () => cancelled });
  invocation.proactivePermissionsConfirmed = proactive;
  expect(invocation.getAuthorizationProjection(invocation.confirmation).additionalPermissions).toEqual([
    NETWORK,
    proactive,
  ]);
  const exec = { type: "exec" };
  expect(invocation.getAuthorizationProjection(exec).additionalPermissions).toEqual([NETWORK, proactive]);
});

it("reports a tool without a projection as unknown, never as an empty scope", async () => {
  const { requests } = await run("after", { kind: "opaque", respond: () => cancelled });
  expect(authorization(requests[0])).toEqual({ status: "unknown" });
});

it("distinguishes same-title invocations by command and by resolved cwd only after the proposal", async () => {
  const pairs = [
    [
      { title: "Run project checks", command: "printf first" },
      { title: "Run project checks", command: "printf second" },
    ],
    [
      { command: "printf same", dirPath: "a" },
      { command: "printf same", dirPath: "b" },
    ],
  ];
  for (const [left, right] of pairs) {
    const strip = ({ requests }) => {
      const { toolCallId: _id, ...toolCall } = requests[0].toolCall;
      return { ...requests[0], toolCall };
    };
    const respond = () => cancelled;
    expect(strip(await run("before", { ...left, respond }))).toEqual(strip(await run("before", { ...right, respond })));
    const a = authorization((await run("after", { ...left, respond })).requests[0]);
    const b = authorization((await run("after", { ...right, respond })).requests[0]);
    expect(a).not.toEqual(b);
  }
});

it.each([
  ["exec", { permanent: false }, "proceed_always_and_save"],
  ["exec", { permanent: false }, "proceed_always_server"],
  ["exec", { permanent: false }, "proceed_always_tool"],
  ["exec", { permanent: false }, "modify_with_editor"],
  ["exec", { disableAlwaysAllow: true }, "proceed_always"],
  ["sandbox", { additional: NETWORK }, "proceed_always_and_save"],
  ["sandbox", { additional: NETWORK }, "proceed_always"],
])(
  "%s: a recognized but unoffered %j → %s confirms and updates policy upstream, not after",
  async (kind, options, id) => {
    const scenario = { kind, ...options, respond: () => selected(id) };
    const old = await run("before", scenario);
    const offered = old.requests[0].options.map((option) => option.optionId);
    expect(Object.values(outcomes)).toContain(id);
    expect(offered).not.toContain(id);
    expect(effects(old.log)[0]).toBe(`onConfirm:${id}`);
    expect(old.log).toContain(`updatePolicy:${id}`);
    if (kind === "sandbox") expect(old.log.some((entry) => entry.startsWith("sandbox-"))).toBe(true);

    const next = await run("after", scenario);
    expect(next.requests[0].options).toEqual(old.requests[0].options);
    expect(effects(next.log)).toEqual([]);
    expect(next.result).toEqual({ thrown: 'Permission option was not offered for tool "run_shell_command".' });
  },
);

it("rejects an unrecognized option before any effect, before and after", async () => {
  for (const variant of ["before", "after"]) {
    const { log, result } = await run(variant, { respond: () => selected("forged") });
    expect(effects(log)).toEqual([]);
    expect(result).toHaveProperty("thrown");
  }
});

it("positive control: every bounded offered option keeps its upstream effect order", async () => {
  for (const kind of ["exec", "sandbox"]) {
    const base = { kind, permanent: true, additional: kind === "sandbox" ? NETWORK : undefined };
    const { requests } = await run("after", { ...base, respond: () => cancelled });
    const offered = requests[0].options.map((option) => option.optionId);
    expect(offered.length).toBeGreaterThanOrEqual(2);
    for (const id of offered) {
      const scenario = { ...base, respond: () => selected(id) };
      const old = await run("before", scenario);
      const next = await run("after", scenario);
      expect(effects(next.log)).toEqual(effects(old.log));
      expect(effects(next.log).slice(0, 1)).toEqual([`onConfirm:${id}`]);
      expect(next.log).toContain(`updatePolicy:${id}`);
      if (id === "cancel") {
        expect(next.log).not.toContain("execute");
        expect(next.result).toEqual({ errorResponse: 'Tool "run_shell_command" was canceled by the user.' });
      } else {
        expect(effects(next.log).slice(-2)).toEqual(["execute", "start"]);
      }
    }
  }
});

it("keeps the original invocation and callback owner through projection, confirmation and policy", async () => {
  const { invocation, builds, policyArgs, context, log } = await run("after", {
    respond: () => selected("proceed_once"),
  });
  expect(builds).toBe(1);
  expect(invocation.projectedWith.self).toBe(invocation);
  expect(invocation.projectedWith.args).toEqual([invocation.confirmation]);
  expect(invocation.projectedWith.args[0]).toBe(invocation.confirmation);
  expect(policyArgs[2]).toBe(invocation.confirmation);
  expect(policyArgs[3]).toBe(context);
  expect(policyArgs[5]).toBe(invocation);
  expect(log).toEqual(["project", "onConfirm:proceed_once", "updatePolicy:proceed_once", "execute", "start"]);
});

it("rejects a response replayed from another invocation whose option this request did not offer", async () => {
  const first = await run("after", { permanent: true, respond: () => selected("proceed_always_and_save") });
  expect(first.log).toContain("updatePolicy:proceed_always_and_save");
  const captured = selected("proceed_always_and_save");
  const replay = { kind: "sandbox", additional: NETWORK, callId: "call-2", respond: () => structuredClone(captured) };
  const old = await run("before", replay);
  expect(old.log).toContain("sandbox-persistent:printf");
  const next = await run("after", replay);
  expect(effects(next.log)).toEqual([]);
});

it("residual: the same static option ID offered to both invocations is not bound to one request here", async () => {
  // Request correlation belongs to the ACP JSON-RPC layer outside these excerpts; see the proposal's questions.
  const replay = { callId: "call-2", respond: () => selected("proceed_once") };
  const next = await run("after", replay);
  expect(effects(next.log).slice(0, 2)).toEqual(["onConfirm:proceed_once", "updatePolicy:proceed_once"]);
});

it.each([
  ["cancelled turn", ({ controller }) => controller.abort()],
  ["superseding prompt", ({ controller }) => controller.abort(new Error("superseded by a newer prompt"))],
  ["disposed session", ({ session }) => session.disposeController.abort()],
])("a late selected response after a %s confirms and updates policy upstream, not after", async (_, cancel) => {
  const scenario = {
    respond: (ctx) => {
      cancel(ctx);
      return selected("proceed_always");
    },
  };
  const old = await run("before", scenario);
  expect(effects(old.log).slice(0, 2)).toEqual(["onConfirm:proceed_always", "updatePolicy:proceed_always"]);
  const next = await run("after", scenario);
  expect(effects(next.log)).toEqual([]);
  expect(next.result).toEqual({
    thrown: 'Tool "run_shell_command" was cancelled before its permission response was applied.',
  });
});

it("a late cancelled response after abort reaches no callback after the proposal", async () => {
  const respond = ({ controller }) => {
    controller.abort();
    return cancelled;
  };
  expect(effects((await run("before", { respond })).log)).toEqual(["onConfirm:cancel", "updatePolicy:cancel"]);
  expect(effects((await run("after", { respond })).log)).toEqual([]);
});

it("abort during the native callback stops the policy update; the callback's own effect is residual", async () => {
  const scenario = { respond: () => selected("proceed_always"), duringConfirm: ({ controller }) => controller.abort() };
  const old = await run("before", scenario);
  expect(effects(old.log)).toEqual(["onConfirm:proceed_always", "updatePolicy:proceed_always", "execute"]);
  expect(old.result.result.llmContent).toBe("Command was cancelled by user before it could start.");
  const next = await run("after", scenario);
  expect(effects(next.log)).toEqual(["onConfirm:proceed_always"]);
});

it("preserves the pinned shell pre-start abort when cancellation lands after the last check", async () => {
  const scenario = { respond: () => selected("proceed_once"), duringPolicy: ({ controller }) => controller.abort() };
  for (const variant of ["before", "after"]) {
    const { log, result } = await run(variant, scenario);
    expect(effects(log)).toEqual(["onConfirm:proceed_once", "updatePolicy:proceed_once", "execute"]);
    expect(result.result).toEqual({
      llmContent: "Command was cancelled by user before it could start.",
      returnDisplay: "Command cancelled by user.",
    });
  }
});

// Test input mapping, not a provider adapter: a projection is evidence about a request. ORCA does
// not own Gemini's later shell-wrapper rewrite or dispatch, so the capture owner cannot supply
// final provenance or cancellation state, and pinned source is not per-execution coverage.
const unknown = { state: "unknown", reason: "offline fixture: not established" };
function canonical(projected, { ownedDispatch = false } = {}) {
  const base = actionFixture();
  const known = projected.status === "projected";
  const action = {
    ...base,
    effectiveCwd: known ? complete(projected.resolvedCwd) : unknown,
    resources: known && projected.additionalPermissions.length === 0 ? base.resources : unknown,
    ...(ownedDispatch
      ? {}
      : {
          transformations: ["gemini:strip-shell-wrapper", "gemini:background-pid-wrapper"],
          coverage: {
            ...base.coverage,
            provider: "gemini",
            level: "observation",
            evidence: {
              sourceRefs: [manifest.excerpts[0].url],
              installedRefs: [],
              independentlyObservedEffects: false,
            },
          },
          offeredChoices: base.offeredChoices.map((choice) => ({
            ...choice,
            effect: "unknown",
            qualificationRef: unknown,
            grantScopeAndLifetime: unknown,
          })),
        }),
  };
  const rule = ruleFixture(action);
  const state = {
    ...stateFixture(action),
    coverageAndState: ownedDispatch ? complete(true) : unknown,
    rules: complete([{ ...rule, match: { ...rule.match, effectiveCwd: known ? projected.resolvedCwd : "test:cwd" } }]),
  };
  return { action, state };
}

it("a complete Gemini projection still cannot become ORCA strict authority over native dispatch", async () => {
  const projected = authorization((await run("after", { dirPath: "a", respond: () => cancelled })).requests[0]);
  const { action, state } = canonical(projected);
  const result = evaluateStrictPermission(action, state, NOW, "test:review");
  expect(result).toMatchObject({ phase: "final", verdict: { outcome: "indeterminate" } });
  expect(result.verdict.reason).toBe("coverage-or-state-unavailable");
  const claimed = evaluateStrictPermission(action, { ...state, coverageAndState: complete(true) }, NOW, "test:review");
  expect(claimed.verdict).toMatchObject({ outcome: "indeterminate", reason: "insufficient-coverage" });
  expect(selectStrictPermissionOption(action, claimed.verdict, NOW)).toBeUndefined();
});

it.each([
  ["opaque tool", { kind: "opaque" }, "required-fact:effectiveCwd"],
  ["additional scope", { kind: "sandbox", additional: NETWORK }, "required-fact:resources"],
])("unknown facts from an %s stay indeterminate even under synthetic owned coverage", async (_, scenario, reason) => {
  const projected = authorization((await run("after", { ...scenario, respond: () => cancelled })).requests[0]);
  const { action, state } = canonical(projected, { ownedDispatch: true });
  expect(evaluateStrictPermission(action, state, NOW, "test:review").verdict).toMatchObject({
    outcome: "indeterminate",
    reason,
  });
});

it("synthetic control: the same mapping allows only with synthetic owned coverage and complete facts", async () => {
  const projected = authorization((await run("after", { dirPath: "a", respond: () => cancelled })).requests[0]);
  const { action, state } = canonical(projected, { ownedDispatch: true });
  expect(action.coverage.provider).toBe("synthetic");
  const result = evaluateStrictPermission(action, state, NOW, "test:review");
  expect(result.verdict).toMatchObject({ outcome: "allow" });
  expect(selectStrictPermissionOption(action, result.verdict, NOW)).toBe("once");
});
