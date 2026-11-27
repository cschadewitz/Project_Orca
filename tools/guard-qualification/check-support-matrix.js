/**
 * Checks the #706 support matrix against the case catalogue and the repository, so a tier is
 * never claimed beyond its evidence and a case is never silently skipped.
 *
 *   node tools/guard-qualification/check-support-matrix.js
 *
 * Exit 0 with nothing printed when the matrix holds; otherwise one line per problem, exit 1.
 * Whether the synthetic cases *pass* is the suite's job (tools/test/enforcement-acceptance-706.test.js),
 * and synthetic results never count toward a tier. A receipt backs a tier only when it is
 * bound to the run that produced it (`attestation.js`): from the command line every receipt's
 * GitHub artifact attestation is verified; called as a function without a verifier, every
 * receipt counts as unverified. No tier is promoted yet (`PROMOTABLE_TIERS` is empty): the
 * receipt producer is guard-receipts.yml, whose end-to-end check (`e2e-check.js`) must accept a
 * real qualifying receipt and refuse a real failing one and a tampered copy (#1026); A and B
 * open in a reviewed change after that has run on main.
 *
 *   node tools/guard-qualification/check-support-matrix.js --release
 *
 * also refuses a promoted row whose certified build is stale against HEAD (the release gate).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attestationProblems, staleProblems } from "./attestation.js";
import { effectFrom } from "./connected/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
const TIERS = ["none", "A", "B", "C"];

/**
 * What a row pins, by the driver its agent runs on (#1128). An ACP row pins its agent and the
 * ACP adapter, with the adapter's lockfile integrity, the runtime image and ORCA's hook program.
 * A Claude Agent SDK row (`driver: "claude-agent-sdk"`) has no adapter or hook program: it pins
 * Claude Code and the Agent SDK, with the SDK's lockfile integrity, the Claude Code image ORCA
 * ran and the digest of the code that decides a call in ORCA's process (`bridgeSha256`). A row
 * and its receipts share one driver, so a receipt from one route never backs the other's row.
 */
export const PIN_SHAPES = Object.freeze({
  acp: Object.freeze({
    versions: ["agentVersion", "adapterVersion"],
    artifacts: ["adapterIntegrity", "runtimeSha256", "hookProgramSha256"],
    needs: "a pinned agent version, adapter version, host and exact build",
  }),
  "claude-agent-sdk": Object.freeze({
    versions: ["agentVersion", "sdkVersion"],
    artifacts: ["sdkIntegrity", "runtimeSha256", "bridgeSha256"],
    needs: "a pinned agent version, SDK version, host and exact build",
  }),
});

/** The driver a row or receipt names; one that names none is an ACP one. */
export const driverOf = (rowOrReceipt) => rowOrReceipt?.driver ?? "acp";

/** The pin shape for a row or receipt, or undefined for a driver ORCA has none for. */
export const pinShape = (rowOrReceipt) => PIN_SHAPES[driverOf(rowOrReceipt)];

/** Whether `pin` names every version, the host and an exact build, as `shape` requires. */
const completePin = (pin, shape) =>
  Boolean(pin) &&
  shape.versions.every((v) => Boolean(pin[v])) &&
  Boolean(pin.host) &&
  /^[0-9a-f]{40}$/.test(pin.build ?? "");
/**
 * Tiers a row may be promoted to on attested receipts: none yet. A and B open in a separate,
 * reviewed change once guard-receipts.yml has produced, verified and checked end to end
 * (`e2e-check.js`) real receipts on main; C waits for #1026's independent observer.
 */
export const PROMOTABLE_TIERS = [];
export const PROMOTION_DISABLED =
  "tier promotion is disabled until guard-receipts.yml's receipts and end-to-end check are reviewed on main (#1026)";
/**
 * Scoped assurance (#1026): a narrower claim than a tier, kept in its own field (`scoped`) so the
 * `tier` enum never holds a starred value and the base tier is unchanged by it. Absent by
 * default. It names one route, the exact installed build, agent, adapter, host, artifacts and
 * ORCA settings, the cases it covers, every case of the route it does not cover with a reason,
 * what stays refused or human-controlled, and attested installed receipts that show all of it.
 * Nothing renders it as a badge; this only checks that a claim written in it holds.
 */
export const SCOPED_LEVELS = ["A", "B"];
/**
 * The `route:level` scopes a row may claim. Like tier promotion, a populated `scoped` claim is
 * refused unless its route and level are listed here, and each listed scope must meet its
 * route's eligibility requirements (`scopedEligibilityProblems`) in the committed matrix.
 *
 * Claude's native hook route is enabled at A only. B stays off: the route lists recovery checks
 * (the hook timing out, the hook failing to start) as unverified, and a required recovery check
 * that is missing leaves B off (#1026). Enabling a scope awards nothing by itself: a row holds a
 * claim only with an attested installed receipt on the exact build it pins.
 */
export const SCOPED_ENABLED = ["claude-native-hook:A"];
export const SCOPED_DISABLED =
  "scoped claims are disabled until a reviewed change enables this route and level (#1026)";
/** Installed checks every scoped claim needs: the opt-in is off by default and explicit. */
export const SCOPED_CHECKS = ["optInDefaultOff"];
/**
 * Further checks a scoped B claim needs: a normally pending request that is cancelled has no
 * observed effect, and a fresh session needs a fresh decision rather than carrying over the
 * cancelled request's authorization. Without them B stays off.
 */
export const SCOPED_B_CHECKS = ["cancelledNoEffect", "freshSessionFreshDecision"];

/**
 * Why `scope` (`route:level`) may not be enabled on the matrix's `paths`. Any level needs a route
 * path (not a connected one) with a live installed runner, and no known fail-open path where
 * fail-closed is required (`knownFailOpen`). B also needs every recovery check verified: the
 * route must say so with an empty `recoveryUnverified`; a route that lists one, or says nothing,
 * stays at A.
 */
export function scopedEligibilityProblems(scope, paths) {
  const [route, level, ...rest] = String(scope).split(":");
  if (rest.length || !SCOPED_LEVELS.includes(level))
    return [`must be route:level with level ${SCOPED_LEVELS.join(" or ")}`];
  const path = paths.get(route);
  if (!path || path.connected) return [`${route} is not a route path`];
  const problems = [];
  if (!path.installed?.live) problems.push(`${route} has no live installed runner`);
  for (const f of path.knownFailOpen ?? []) problems.push(`${route} has a known fail-open path: ${f}`);
  if (level === "B") {
    if (!Array.isArray(path.recoveryUnverified))
      problems.push(`${route} does not say which recovery checks are unverified`);
    else for (const r of path.recoveryUnverified) problems.push(`${route}: recovery check unverified: ${r}`);
  }
  return problems;
}

/** What a receipt is when nothing verified its attestation (the function's default). */
export const UNVERIFIED = "attestation not verified (run check-support-matrix.js, which verifies it)";

/** Categories a tier C claim's connected path may not exclude. A named residual is not proof. */
const MUST_COVER_FOR_C = ["lifecycle", "bypass"];

/**
 * Why `receipt` does not back a claim for `agent` on `route`: wrong kind, another agent,
 * adapter version, host, route or build, a duplicate, failed or missing case, or a missing
 * connectivity check (every tier needs tier A's). Structural only. Empty when it holds.
 */
export function receiptProblems(
  receipt,
  agent,
  route,
  kind,
  neededCases,
  assertions = loadAssertions(),
  routePath = undefined,
  profile = undefined,
) {
  const problems = [];
  if (receipt?.format !== "orca-enforcement-receipt/1") return ["not an orca-enforcement-receipt/1"];
  if (receipt.kind !== kind) problems.push(`kind ${receipt.kind}, needs ${kind}`);
  // A receipt made to test the verifier (`e2e-check.js`) is never evidence, whatever it shows.
  if (receipt.scope !== undefined) problems.push(`a ${receipt.scope} receipt, never evidence`);
  if (receipt.agent !== agent.id) problems.push(`agent ${receipt.agent}`);
  if (driverOf(receipt) !== driverOf(agent)) problems.push(`driver ${driverOf(receipt)}, needs ${driverOf(agent)}`);
  for (const v of (pinShape(agent) ?? PIN_SHAPES.acp).versions)
    if (receipt[v] !== agent.pin?.[v]) problems.push(`${v} ${receipt[v]}`);
  if (receipt.host !== agent.pin?.host) problems.push(`host ${receipt.host}`);
  if (receipt.route !== route) problems.push(`route ${receipt.route}`);
  if (receipt.build !== agent.pin?.build) problems.push(`build ${receipt.build}, expected ${agent.pin?.build}`);
  const ids = (receipt.cases ?? []).map((c) => c.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length) problems.push(`duplicate case ${[...new Set(duplicates)].join(",")}`);
  const results = new Map((receipt.cases ?? []).map((c) => [c.id, c.result]));
  if ([...results.values()].some((r) => r !== "pass")) problems.push("a case did not pass");
  const missing = neededCases.filter((id) => results.get(id) !== "pass");
  if (missing.length) problems.push(`missing ${missing.join(",")}`);
  if (receipt.checks?.connects !== "pass") problems.push("needs checks.connects passing");
  // Route coverage (every route the agent has outside ORCA's is refused) is an installed
  // receipt's claim. A connected receipt proves one route end to end and does not make it.
  if (kind === "installed" && receipt.checks?.uncoveredRoutesRefused !== "pass")
    problems.push("needs checks.uncoveredRoutesRefused passing");
  // Checked only on what claims to be installed evidence; any other kind is refused above.
  if (kind === "installed" && receipt.kind === "installed") {
    problems.push(...uncoveredRouteProblems(receipt, agent));
    problems.push(...installedInputProblems(receipt, agent, profile));
    problems.push(...installedCaseProblems(receipt, neededCases, assertions, routePath));
  }
  if (kind === "connected") {
    // The connected run's own narrow check (a session on an unpinned runtime is refused), kept
    // apart from the route coverage above, which it does not show.
    if (receipt.checks?.unpinnedRuntimeRefused !== "pass") problems.push("needs checks.unpinnedRuntimeRefused passing");
    problems.push(...connectedEvidenceProblems(receipt, neededCases, assertions));
  }
  return problems;
}

/**
 * A connected receipt must bind every call to the assertion it serves and to its own evidence,
 * and this re-derives each outcome from that evidence rather than trusting it. Which calls a
 * case makes, in order, and the outcomes each one's assertion accepts come from the committed
 * inventory (`connected/assertions.json`, for the receipt's route), not from the receipt: a
 * case whose calls are missing, extra, out of order, for another tool, or bound to other
 * outcomes than the inventory's does not qualify, nor does a case the inventory does not list.
 * Every call has a tool_use id used by no other call, approvals carrying its own id, and an
 * `effectRef` from which the effect is recomputed (`connected/evidence.js`). The outcome must
 * follow (allow only with the effect observed; deny, block and ask only with it proven none and
 * ORCA's text or an approval for that call) and be one the inventory's assertion accepts. A case
 * qualifies only if every one of its calls does: a call the agent refused before ORCA answered
 * (`orcaDecision: "unobserved"`) leaves its case nonqualifying, whatever its other calls show.
 */
export function connectedEvidenceProblems(
  receipt,
  neededCases = (receipt.cases ?? []).map((c) => c.id),
  assertions = loadAssertions(),
) {
  const problems = [];
  const inventory = assertions.paths?.[receipt.route];
  if (!inventory) return [`no committed assertion inventory for route ${receipt.route}`];
  const ids = (receipt.cases ?? []).flatMap((c) => (c.calls ?? []).map((call) => call.toolUseId)).filter(Boolean);
  const reused = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (reused.length) problems.push(`tool_use id used by more than one call: ${reused.join(",")}`);
  for (const c of (receipt.cases ?? []).filter((x) => neededCases.includes(x.id))) {
    const calls = c.calls ?? [];
    if (calls.length === 0) {
      problems.push(`case ${c.id}: no per-call evidence`);
      continue;
    }
    const required = inventoryCalls(inventory[c.id]);
    if (!required) {
      problems.push(`case ${c.id}: not in the assertion inventory`);
      continue;
    }
    const made = calls.filter((call) => !call.strayApprovals);
    if (made.length !== required.length)
      problems.push(`case ${c.id}: ${made.length} calls, the inventory requires ${required.length}`);
    for (const call of calls) {
      if (call.strayApprovals) {
        problems.push(`case ${c.id}: an approval matched no call of its turn`);
        continue;
      }
      const at = `case ${c.id}: ${call.tool}`;
      if (
        typeof call.toolUseId !== "string" ||
        !Array.isArray(call.approvals) ||
        !call.effectRef ||
        !("refusal" in call)
      ) {
        problems.push(`${at}: needs its tool_use id, approvals, refusal and effect evidence`);
        continue;
      }
      const want = required[made.indexOf(call)];
      if (!want) {
        problems.push(`${at}: bound to no assertion in the inventory`);
        continue;
      }
      if (call.tool !== want.tool)
        problems.push(`${at}: the inventory's call ${made.indexOf(call) + 1} is ${want.tool}`);
      if (!sameList(call.expected, want.expected))
        problems.push(
          `${at}: bound to ${listText(call.expected)}, the inventory's assertion accepts ${listText(want.expected)}`,
        );
      if (call.approvals.some((a) => a.toolCallId !== call.toolUseId))
        problems.push(`${at}: an approval is bound to another call`);
      const effect = effectFrom(call.effectRef);
      if (effect !== call.effect) problems.push(`${at}: its evidence shows effect ${effect}, not ${call.effect}`);
      if (call.orcaDecision === "unobserved") {
        problems.push(`${at}: ORCA's decision was not observed (${call.unobservedBecause ?? "unknown"})`);
        continue;
      }
      if (call.orcaDecision !== "observed") {
        problems.push(`${at}: orcaDecision must be observed or unobserved`);
        continue;
      }
      const follows =
        call.outcome === "allow"
          ? effect === "observed"
          : effect === "none" &&
            ((call.outcome === "deny" && call.refusal === "orca-deny") ||
              (call.outcome === "block" && call.refusal === "orca-block") ||
              (call.outcome === "ask" && call.approvals.length > 0));
      if (!follows) problems.push(`${at}: outcome ${call.outcome} does not follow from its evidence`);
      else if (!want.expected.includes(call.outcome))
        problems.push(`${at}: outcome ${call.outcome} is not one its assertion accepts (${want.expected.join("|")})`);
    }
  }
  return problems;
}

/**
 * An installed receipt's route coverage, entry by entry: every route the row lists as
 * unsupported must be shown refused or asked about on the installed agent, saying how. A route
 * that cannot be refused is not an unsupported route but a residual risk, and is listed there.
 */
export function uncoveredRouteProblems(receipt, agent) {
  const problems = [];
  const shown = new Map((receipt.uncoveredRoutes ?? []).map((r) => [r.route, r]));
  for (const route of agent.unsupportedRoutes ?? []) {
    const r = shown.get(route);
    if (!r) problems.push(`uncovered route not shown refused: ${route}`);
    else if (!["refused", "asked"].includes(r.result) || typeof r.how !== "string" || r.how.trim().length < 20)
      problems.push(`uncovered route needs result refused or asked, and how it was shown: ${route}`);
  }
  return problems;
}

/**
 * How each case of an installed receipt ran, from the route's `installed` entry in the matrix.
 * Only one class of evidence holds a case toward A or B:
 *
 * - `live`: through the real installed agent, driven by the runner of the connected path
 *   `installed.live` names, with every call's evidence checked exactly as a connected receipt's
 *   is, against that path's committed assertion inventory (`connectedEvidenceProblems`). A call
 *   whose decision by ORCA was not observed never counts, whatever its outcome.
 *
 * Cases the route lists under `installed.diagnostic` (the agent cannot make the call, or
 * refuses it before ORCA answers) are outside the claim: `assertedCases` leaves them out, the
 * row names them in `notAsserted`, and their runs on ORCA's installed program (`via:
 * "program"`) are diagnostics (`programEvidenceProblems`) that count toward no tier. A route
 * with no `installed` entry has no installed runner, so no installed receipt holds it beyond A.
 */
export function installedCaseProblems(receipt, neededCases, assertions, routePath) {
  if (neededCases.length === 0) return [];
  const spec = routePath?.installed;
  if (!spec) return [`route ${receipt.route} has no installed runner in the matrix`];
  const problems = [];
  const live = [];
  for (const c of (receipt.cases ?? []).filter((x) => neededCases.includes(x.id))) {
    if (c.via === "live") live.push(c.id);
    else
      problems.push(`case ${c.id}: needs the installed agent's observed outcome (via live), not ${c.via ?? "nothing"}`);
  }
  if (live.length) {
    if (!spec.live) problems.push(`route ${receipt.route}: no live runner for cases ${live.join(",")}`);
    else
      problems.push(
        ...connectedEvidenceProblems({ ...receipt, route: spec.live }, live, assertions).map(
          (p) => `${p} (live, on ${spec.live})`,
        ),
      );
  }
  return problems;
}

/** The cases a tier B claim on `path` asserts: those it runs, less its installed diagnostics. */
export function assertedCases(path, catalogue) {
  return casesFor(path, catalogue).filter((id) => !(id in (path.installed?.diagnostic ?? {})));
}

/**
 * The diagnostic evidence of the cases an installed receipt ran on ORCA's installed program
 * (a route's `installed.diagnostic`), re-derived rather than trusted. It counts toward no tier:
 * the installed runner asserts it holds, and a reader sees what ORCA's program did. The runs each case makes, in order, which arguments they use (the
 * installed ones or a case's replacement) and the outcomes each accepts come from the committed
 * program inventory (`assertions.programs`, for the receipt's route). Each run must be of the
 * command the session installed (`receipt.installedSettings`), record the digest of the bytes
 * it was sent, and keep its exit code, stdout and stderr, from which the outcome is derived as
 * Claude Code would: a non-zero exit blocks, no output allows, otherwise the hook's
 * `permissionDecision`. A case with no runs in the inventory (F03) is held by the installed
 * settings themselves (`installedSettingsProblems`).
 */
export function programEvidenceProblems(receipt, neededCases, assertions = loadAssertions()) {
  const inventory = assertions.programs?.[receipt.route];
  if (!inventory) return [`no committed program inventory for route ${receipt.route}`];
  const problems = [];
  const settingsProblems = installedSettingsProblems(receipt.installedSettings);
  problems.push(...settingsProblems.map((p) => `installed settings: ${p}`));
  const command =
    settingsProblems.length === 0 ? receipt.installedSettings.hooks.PreToolUse[0].hooks[0].command : undefined;
  for (const c of (receipt.cases ?? []).filter((x) => neededCases.includes(x.id))) {
    const at = `case ${c.id} (program)`;
    const entries = inventory[c.id];
    if (!Array.isArray(entries)) {
      problems.push(`${at}: not in the program inventory`);
      continue;
    }
    const required = entries.flatMap((e) => Array.from({ length: e.calls ?? 1 }, () => e));
    const calls = c.calls ?? [];
    if (!Array.isArray(calls) || calls.length !== required.length) {
      problems.push(`${at}: ${calls.length ?? 0} runs, the inventory requires ${required.length}`);
      continue;
    }
    calls.forEach((call, i) => {
      const want = required[i];
      const run = `${at}: run ${i + 1}`;
      if (
        typeof call?.input?.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(call.input.sha256) ||
        !Number.isInteger(call.input.bytes) ||
        !Number.isInteger(call.exitCode) ||
        typeof call.stdout !== "string" ||
        typeof call.stderr !== "string"
      ) {
        problems.push(`${run}: needs its input digest, exit code, stdout and stderr`);
        return;
      }
      if (command !== undefined && call.command !== command) problems.push(`${run}: not the installed command`);
      if (call.args !== want.args)
        problems.push(`${run}: ran with ${call.args} arguments, the inventory's run uses ${want.args}`);
      const outcome = programOutcome(call);
      if (outcome !== call.outcome) problems.push(`${run}: its output shows ${outcome}, not ${call.outcome}`);
      else if (!want.expected.includes(outcome))
        problems.push(`${run}: outcome ${outcome} is not one the inventory accepts (${want.expected.join("|")})`);
      if (want.surfaceLimit !== undefined)
        for (const [name, text] of [
          ["stdout", call.stdout],
          ["stderr", call.stderr],
        ])
          if (Buffer.byteLength(text) > want.surfaceLimit)
            problems.push(`${run}: ${name} is ${Buffer.byteLength(text)} bytes, over ${want.surfaceLimit}`);
    });
  }
  return problems;
}

/** The outcome Claude Code takes from one run of a command hook (as `paths.js` `hookOutcome`). */
function programOutcome(call) {
  if (call.exitCode !== 0) return "block";
  if (call.stdout === "") return "allow";
  let decision;
  try {
    decision = JSON.parse(call.stdout)?.hookSpecificOutput?.permissionDecision;
  } catch {
    return "invalid:output";
  }
  return decision === "ask" || decision === "deny" ? decision : `invalid:${String(decision)}`;
}

/**
 * Why the settings a session installed in the agent do not hold ORCA's hook in front of every
 * tool: one PreToolUse entry matching every tool, one exec-form command hook with an absolute
 * executable, a bounded timeout and `onFailure: "block"`, and nothing else in the settings.
 */
export function installedSettingsProblems(settings) {
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries) || entries.length !== 1) return ["needs exactly one PreToolUse entry"];
  const problems = [];
  if (entries[0].matcher !== "*") problems.push("the PreToolUse entry must match every tool");
  const hooks = entries[0].hooks;
  if (!Array.isArray(hooks) || hooks.length !== 1) return [...problems, "needs exactly one hook"];
  const hook = hooks[0];
  if (hook.type !== "command") problems.push("the hook must be a command hook");
  if (hook.onFailure !== "block") problems.push("a hook that fails must block");
  if (!(hook.timeout > 0 && hook.timeout <= 30)) problems.push("needs a timeout of at most 30 seconds");
  if (typeof hook.command !== "string" || !hook.command.startsWith("/")) problems.push("needs an absolute executable");
  else if (/[;&|`$]/.test(hook.command)) problems.push("needs the exec form, not a shell line");
  if (!Array.isArray(hook.args)) problems.push("needs its arguments as a list");
  if (Object.keys(settings).join() !== "hooks") problems.push("changes more of the agent's settings than its hooks");
  return problems;
}

/**
 * What an installed receipt ran: the adapter as installed (its lockfile integrity), the digest
 * of the runtime image it ran and of ORCA's hook program, and the qualification profile (a
 * digest of what the route had to show when it ran, recomputed here). Each must match the
 * row's pin (`pin.artifacts`, set from the receipt by `record-receipts.js`), and the profile
 * must match the requirements as committed now.
 */
export function installedInputProblems(receipt, agent, profile) {
  const inputs = receipt.inputs;
  const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  const sri = (v) => typeof v === "string" && v.startsWith("sha512-");
  if (driverOf(agent) === "claude-agent-sdk") {
    // The SDK route: the Agent SDK as installed, the Claude Code image ORCA ran, the code that
    // decides a call in ORCA's process, and the settings ORCA passed to the SDK: none loaded,
    // Claude's own check in its default mode.
    if (
      !sri(inputs?.sdk?.integrity) ||
      !hex(inputs?.runtime?.sha256) ||
      !hex(inputs?.bridge?.sha256) ||
      !hex(inputs?.profile) ||
      !Array.isArray(inputs?.settingSources) ||
      inputs?.permissionMode === undefined
    )
      return [
        "needs inputs: the SDK's integrity, the runtime and bridge digests, the setting sources, the permission mode and the profile",
      ];
  } else if (
    !sri(inputs?.adapter?.integrity) ||
    !hex(inputs.runtime?.sha256) ||
    !hex(inputs.hookProgram?.sha256) ||
    !hex(inputs.profile)
  )
    return ["needs inputs: the adapter's integrity, the runtime and hook program digests, and the profile"];
  const problems = [];
  if (driverOf(agent) === "claude-agent-sdk") {
    if (inputs.settingSources.length !== 0)
      problems.push(`loaded Claude settings (${inputs.settingSources.join(",")}); the route loads none`);
    if (inputs.permissionMode !== "default")
      problems.push(`ran Claude in permission mode ${String(inputs.permissionMode)}, not default`);
  }
  if (profile !== undefined && inputs.profile !== profile)
    problems.push("ran against other requirements than the matrix states now (profile differs)");
  const pinned = agent.pin?.artifacts ?? {};
  for (const [name, value] of Object.entries(artifactsOf(receipt)))
    if (pinned[name] !== value) problems.push(`${name} ${value} is not the row's pinned ${pinned[name] ?? "nothing"}`);
  return problems;
}

/** The artifact digests a row pins from an installed receipt. */
export function artifactsOf(receipt) {
  if (driverOf(receipt) === "claude-agent-sdk")
    return {
      sdkIntegrity: receipt.inputs?.sdk?.integrity,
      runtimeSha256: receipt.inputs?.runtime?.sha256,
      bridgeSha256: receipt.inputs?.bridge?.sha256,
    };
  return {
    adapterIntegrity: receipt.inputs?.adapter?.integrity,
    runtimeSha256: receipt.inputs?.runtime?.sha256,
    hookProgramSha256: receipt.inputs?.hookProgram?.sha256,
  };
}

/**
 * The digest of what an installed receipt on `routePath` must show for `agent`: the route and
 * its live runner as the matrix states them, the catalogue entries of the cases it runs, the
 * row's unsupported routes, and the committed inventories its evidence is checked against. A
 * receipt from a run against other requirements does not hold the ones committed now.
 */
export function qualificationProfile(matrix, catalogue, assertions, agent, routePath) {
  const live = routePath.installed?.live;
  const ids = casesFor(routePath, catalogue);
  const profile = {
    format: "orca-qualification-profile/1",
    route: routePath,
    live: matrix.paths.find((p) => p.id === live) ?? null,
    cases: catalogue.cases.filter((c) => ids.includes(c.id)),
    unsupportedRoutes: [...(agent.unsupportedRoutes ?? [])].sort(),
    notAsserted: [...(agent.notAsserted ?? [])].sort(),
    inventories: {
      live: (live && assertions.paths?.[live]) ?? null,
      program: assertions.programs?.[routePath.id] ?? null,
    },
  };
  return createHash("sha256").update(canonical(profile)).digest("hex");
}

/** JSON with object keys sorted, so equal values have one text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The inventory's calls for one case, one entry per call; undefined when it lists none. */
function inventoryCalls(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries.flatMap((e) => Array.from({ length: e.calls ?? 1 }, () => e));
}
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const listText = (a) => (Array.isArray(a) ? a.join("|") : "nothing");

/** The committed inventory of each connected path's assertions: trusted, unlike a receipt. */
export function loadAssertions() {
  return JSON.parse(readFileSync(join(here, "connected", "assertions.json"), "utf8"));
}

export function loadCatalogue() {
  return JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
}

export function loadMatrix() {
  return JSON.parse(readFileSync(join(here, "support-matrix.json"), "utf8"));
}

/** Which cases a path runs: every case whose needs it has. The rest must be excluded. */
export function casesFor(path, catalogue) {
  return catalogue.cases.filter((c) => c.needs.every((n) => path.capabilities.includes(n))).map((c) => c.id);
}

/**
 * The cases a connected receipt from `path` qualifies on: those it runs, less the ones it lists
 * as `unobserved` (run as diagnostics, but the agent refuses the calls before ORCA answers).
 */
export function qualifyingCases(path, catalogue) {
  return casesFor(path, catalogue).filter((id) => !(id in (path.unobserved ?? {})));
}

/** Cases a path does not cover as evidence: excluded, or run without ORCA's decision observed. */
const notCovered = (path) => [...Object.keys(path.excluded ?? {}), ...Object.keys(path.unobserved ?? {})];

/** @returns {string[]} one message per problem; empty when the matrix holds */
export function checkSupportMatrix(
  matrix,
  catalogue,
  exists = (p) => existsSync(join(REPO_ROOT, p)),
  readReceipt = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")),
  assertions = loadAssertions(),
  verifyReceipt = () => [UNVERIFIED],
  promotable = PROMOTABLE_TIERS,
  scopedEnabled = SCOPED_ENABLED,
) {
  const problems = [];
  const ids = new Set(catalogue.cases.map((c) => c.id));
  const byId = new Map(catalogue.cases.map((c) => [c.id, c]));
  if (ids.size !== catalogue.cases.length) problems.push("cases.json: duplicate case id");
  for (const c of catalogue.cases) {
    if (!catalogue.categories[c.category]) problems.push(`${c.id}: unknown category ${c.category}`);
    if (!Array.isArray(c.contract) || c.contract.some((r) => !/^C\d\d$/.test(r)))
      problems.push(`${c.id}: contract rows must be acceptance.md ids (C01-C30)`);
  }

  const paths = new Map();
  for (const path of matrix.paths) {
    if (paths.has(path.id)) problems.push(`path ${path.id}: listed twice`);
    paths.set(path.id, path);
    const runs = new Set(casesFor(path, catalogue));
    for (const [id, reason] of Object.entries(path.excluded ?? {})) {
      if (!ids.has(id)) problems.push(`path ${path.id}: excludes unknown case ${id}`);
      else if (runs.has(id)) problems.push(`path ${path.id}: excludes ${id}, which it can run; run it instead`);
      if (typeof reason !== "string" || reason.trim().length < 20)
        problems.push(`path ${path.id}: exclusion of ${id} needs a reason a reader can check`);
    }
    for (const id of ids)
      if (!runs.has(id) && !(id in (path.excluded ?? {})))
        problems.push(`path ${path.id}: case ${id} is neither run nor excluded with a reason`);
    for (const [id, reason] of Object.entries(path.unobserved ?? {})) {
      if (!path.connected) problems.push(`path ${path.id}: only a connected path lists unobserved cases`);
      if (!runs.has(id)) problems.push(`path ${path.id}: lists ${id} as unobserved, but does not run it`);
      if (typeof reason !== "string" || reason.trim().length < 20)
        problems.push(`path ${path.id}: unobserved ${id} needs a reason a reader can check`);
    }
  }
  for (const path of matrix.paths)
    for (const field of ["knownFailOpen", "recoveryUnverified"])
      if (
        path[field] !== undefined &&
        (!Array.isArray(path[field]) || path[field].some((x) => typeof x !== "string" || x.trim().length < 20))
      )
        problems.push(`path ${path.id}: ${field} must list what a reader can check`);
  // Each enabled scope meets its route's eligibility requirements, whatever any row claims.
  for (const scope of scopedEnabled)
    for (const p of scopedEligibilityProblems(scope, paths)) problems.push(`scoped ${scope}: ${p}`);
  // A connected path runs a live agent through one route end to end, and proves that route.
  for (const path of matrix.paths) {
    if (!path.connected) {
      if (path.proves !== undefined) problems.push(`path ${path.id}: only a connected path proves a route`);
      continue;
    }
    const proved = paths.get(path.proves);
    if (!proved || proved.connected) problems.push(`path ${path.id}: proves ${path.proves}, which is not a route path`);
    // Every case it runs has its calls and their accepted outcomes committed, so a receipt is
    // checked against what the case must assert rather than what the receipt says it asserted.
    const inventory = assertions.paths?.[path.id] ?? {};
    const runs = new Set(casesFor(path, catalogue));
    for (const id of runs)
      if (!inventoryCalls(inventory[id]))
        problems.push(`path ${path.id}: case ${id} has no committed assertion inventory`);
    for (const [id, entries] of Object.entries(inventory)) {
      if (!runs.has(id)) problems.push(`path ${path.id}: the assertion inventory lists ${id}, which it does not run`);
      for (const e of entries ?? [])
        if (typeof e.tool !== "string" || !Array.isArray(e.expected) || e.expected.length === 0)
          problems.push(`path ${path.id}: assertion inventory for ${id} needs a tool and accepted outcomes per call`);
    }
  }

  // A route's installed diagnostics have their program runs and accepted outcomes committed.
  for (const path of matrix.paths) {
    const program = path.installed?.diagnostic ?? {};
    const inventory = assertions.programs?.[path.id] ?? {};
    const runs = new Set(casesFor(path, catalogue));
    for (const id of Object.keys(program)) {
      if (!runs.has(id)) problems.push(`path ${path.id}: lists ${id} as an installed diagnostic, but does not run it`);
      if (!Array.isArray(inventory[id]))
        problems.push(`path ${path.id}: diagnostic case ${id} has no committed program inventory`);
    }
    for (const [id, entries] of Object.entries(inventory)) {
      if (!(id in program))
        problems.push(`path ${path.id}: the program inventory lists ${id}, not an installed diagnostic`);
      for (const e of entries ?? [])
        if (!["installed", "replaced"].includes(e.args) || !Array.isArray(e.expected) || e.expected.length === 0)
          problems.push(`path ${path.id}: program inventory for ${id} needs arguments and accepted outcomes per run`);
    }
  }

  const agents = new Set();
  for (const agent of matrix.agents) {
    const at = `agent ${agent.id}`;
    if (agents.has(agent.id)) problems.push(`${at}: listed twice`);
    agents.add(agent.id);
    const tier = TIERS.indexOf(agent.tier);
    if (tier < 0) {
      problems.push(`${at}: unknown tier ${agent.tier}`);
      continue;
    }
    for (const r of agent.routes) {
      if (!paths.has(r)) problems.push(`${at}: route ${r} has no path in the suite`);
      else if (paths.get(r).connected) problems.push(`${at}: route ${r} is a connected path, not a route`);
    }
    const receipts = [];
    for (const file of agent.receipts ?? []) {
      if (!exists(file)) {
        problems.push(`${at}: receipt ${file} does not exist`);
        continue;
      }
      receipts.push({ file, receipt: readReceipt(file) });
    }
    // A receipt says what it says; only one bound to the run that produced it is evidence. Every
    // listed receipt is verified, at any tier: one that a verifier refuses is never listed.
    for (const r of receipts) {
      r.trust = verifyReceipt(r.file, r.receipt);
      if (tier === 0 && r.trust.some((p) => p !== UNVERIFIED))
        problems.push(`${at}: receipt ${r.file}: ${r.trust.join("; ")}`);
    }
    // The cases a tier B claim leaves out are named on the row, so the claim reads as its scope.
    const diagnostics = [
      ...new Set(agent.routes.flatMap((r) => Object.keys(paths.get(r)?.installed?.diagnostic ?? {}))),
    ].sort();
    const named = [...(agent.notAsserted ?? [])].sort();
    if (named.join() !== diagnostics.join())
      problems.push(
        `${at}: notAsserted must name exactly its routes' installed diagnostics (${diagnostics.join(",") || "none"})`,
      );
    if (agent.scoped !== undefined && !scopedEnabled.includes(`${agent.scoped?.route}:${agent.scoped?.level}`))
      problems.push(`${at}: scoped: ${SCOPED_DISABLED}`);
    if (agent.scoped !== undefined)
      problems.push(
        ...scopedProblems(matrix, catalogue, assertions, agent, paths, exists, readReceipt, verifyReceipt).map(
          (p) => `${at}: scoped: ${p}`,
        ),
      );
    if (tier === 0) continue;
    if (!promotable.includes(agent.tier)) problems.push(`${at}: ${PROMOTION_DISABLED}`);

    const pin = agent.pin;
    const shape = pinShape(agent);
    if (!shape) {
      problems.push(`${at}: driver ${driverOf(agent)} has no pin shape`);
      continue;
    }
    if (!completePin(pin, shape)) {
      problems.push(`${at}: tier ${agent.tier} needs ${shape.needs}`);
      continue;
    }
    if (agent.routes.length === 0) problems.push(`${at}: tier ${agent.tier} needs at least one enforcement route`);
    if ((agent.unsupportedRoutes ?? []).length === 0)
      problems.push(`${at}: a tier claim must list the uncovered routes`);
    if ((agent.residualRisks ?? []).length === 0) problems.push(`${at}: a tier claim must list its residual risks`);
    for (const route of agent.routes) {
      const path = paths.get(route);
      if (!path) continue;
      // Tiers are cumulative: each one needs the receipt of every tier below it too. Tier C's
      // receipt comes from a connected path that proves this route, and covers that path's cases.
      const provers = matrix.paths.filter((p) => p.connected && p.proves === route);
      const required = [
        { tier: 1, kind: "installed", route, cases: [] },
        { tier: 2, kind: "installed", route, cases: assertedCases(path, catalogue) },
        ...provers.map((p) => ({ tier: 3, kind: "connected", route: p.id, cases: qualifyingCases(p, catalogue) })),
      ].filter((r) => r.tier <= tier);
      if (tier === 3 && provers.length === 0)
        problems.push(`${at}: tier C on ${route} needs a connected path that proves it`);
      const profile = qualificationProfile(matrix, catalogue, assertions, agent, path);
      const met = new Set();
      for (const need of required) {
        const good = receipts.filter(
          ({ receipt, trust }) =>
            trust.length === 0 &&
            receiptProblems(
              receipt,
              agent,
              need.route,
              need.kind,
              need.cases,
              assertions,
              paths.get(need.route),
              profile,
            ).length === 0,
        );
        if (good.length > 0) {
          met.add(need.route);
          continue;
        }
        if (need.tier === 3) continue;
        const why = receipts.flatMap(({ file, receipt, trust }) =>
          [
            ...receiptProblems(
              receipt,
              agent,
              need.route,
              need.kind,
              need.cases,
              assertions,
              paths.get(need.route),
              profile,
            ),
            ...trust,
          ].map((p) => `${file}: ${p}`),
        );
        problems.push(
          `${at}: tier ${TIERS[need.tier]} on ${route} needs a passing ${need.kind} receipt for ${agent.id} ${pin.agentVersion} on ${pin.host}` +
            (why.length ? ` (${why.join("; ")})` : ""),
        );
      }
      if (tier === 3 && provers.length > 0) {
        // One connected path that proves the route, with a passing receipt and no lifecycle or
        // bypass case excluded, is enough.
        const covered = provers.filter(
          (p) => met.has(p.id) && !notCovered(p).some((id) => MUST_COVER_FOR_C.includes(byId.get(id)?.category)),
        );
        if (covered.length === 0) {
          for (const p of provers) {
            if (!met.has(p.id)) {
              const why = receipts.flatMap(({ file, receipt }) =>
                receiptProblems(receipt, agent, p.id, "connected", qualifyingCases(p, catalogue), assertions).map(
                  (x) => `${file}: ${x}`,
                ),
              );
              problems.push(
                `${at}: tier C on ${route} needs a passing connected receipt from ${p.id} for ${agent.id} ${pin.agentVersion} on ${pin.host}` +
                  (why.length ? ` (${why.join("; ")})` : ""),
              );
            }
            for (const id of notCovered(p)) {
              const c = byId.get(id);
              if (c && MUST_COVER_FOR_C.includes(c.category))
                problems.push(
                  `${at}: tier C on ${route} ${id in (p.excluded ?? {}) ? "excludes" : "does not observe ORCA's decision for"} ${c.category} case ${id} on ${p.id}`,
                );
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Why `agent.scoped` does not hold. Every listed receipt must be attested, installed, on the
 * scoped pin and route, carry the scoped settings and pass every covered case and the checks
 * its level needs. Empty when it holds.
 */
export function scopedProblems(
  matrix,
  catalogue,
  assertions,
  agent,
  paths,
  exists = () => false,
  readReceipt = () => undefined,
  verifyReceipt = () => [UNVERIFIED],
) {
  const s = agent.scoped;
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["must be an object when present"];
  const problems = [];
  if (!SCOPED_LEVELS.includes(s.level)) problems.push(`level ${s.level}, must be one of ${SCOPED_LEVELS.join(", ")}`);
  const path = paths.get(s.route);
  if (!agent.routes.includes(s.route) || !path || path.connected) {
    problems.push(`route ${s.route} is not one of the row's routes`);
    return problems;
  }
  const pin = s.pin;
  const shape = pinShape(agent) ?? PIN_SHAPES.acp;
  if (!completePin(pin, shape) || shape.artifacts.some((k) => typeof pin.artifacts?.[k] !== "string"))
    problems.push(`needs ${shape.needs.replace(" and exact build", ", exact build and artifact digests")}`);
  const settings = s.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).length === 0)
    problems.push("needs the ORCA settings the claim holds under");

  const asserted = assertedCases(path, catalogue);
  const runs = casesFor(path, catalogue);
  const covers = Array.isArray(s.covers) ? s.covers : [];
  if (covers.length === 0) problems.push("needs the cases it covers");
  if (new Set(covers).size !== covers.length) problems.push("covers a case twice");
  for (const id of covers)
    if (!asserted.includes(id)) problems.push(`covers ${id}, which ${s.route} does not assert on an installed agent`);
  if (s.level === "B")
    for (const id of asserted)
      if (!covers.includes(id)) problems.push(`B covers every asserted case; ${id} is missing`);
  // Everything the route does not cover as evidence is named, with a reason, so the claim reads as its scope.
  const uncovered = [
    ...new Set([...runs.filter((id) => !covers.includes(id)), ...Object.keys(path.excluded ?? {})]),
  ].sort();
  const excludes = s.excludes && typeof s.excludes === "object" ? s.excludes : {};
  if (Object.keys(excludes).sort().join() !== uncovered.join())
    problems.push(`excludes must name exactly the cases it does not cover (${uncovered.join(",") || "none"})`);
  for (const [id, reason] of Object.entries(excludes))
    if (typeof reason !== "string" || reason.trim().length < 20)
      problems.push(`exclusion of ${id} needs a reason a reader can check`);
  for (const list of ["stillOff", "unverified"])
    if (!Array.isArray(s[list]) || s[list].length === 0 || s[list].some((x) => typeof x !== "string" || !x.trim()))
      problems.push(
        `needs ${list}: ${list === "stillOff" ? "what stays refused or human-controlled" : "what it does not verify"}`,
      );
  if (!["verified", "unverified"].includes(s.judge)) problems.push("judge must say verified or unverified");
  if (problems.length) return problems;

  const checks = [
    ...SCOPED_CHECKS,
    ...(s.level === "B" ? SCOPED_B_CHECKS : []),
    ...(s.judge === "verified" ? ["judgedAction"] : []),
  ];
  const pinned = { ...agent, pin };
  const profile = qualificationProfile(matrix, catalogue, assertions, agent, path);
  const files = Array.isArray(s.receipts) ? s.receipts : [];
  if (files.length === 0) problems.push("needs an attested installed receipt");
  const refused = [];
  for (const file of files) {
    if (!exists(file)) {
      problems.push(`receipt ${file} does not exist`);
      continue;
    }
    const receipt = readReceipt(file);
    const why = [
      ...verifyReceipt(file, receipt),
      ...receiptProblems(receipt, pinned, s.route, "installed", covers, assertions, path, profile),
      ...(canonical(receipt?.agentSettings) === canonical(settings)
        ? []
        : ["agentSettings are not the scoped settings"]),
      ...checks.filter((c) => receipt?.checks?.[c] !== "pass").map((c) => `needs checks.${c} passing`),
      ...lifecycleEvidenceProblems(
        receipt,
        checks.filter((c) => c in LIFECYCLE_EVIDENCE),
      ),
    ];
    if (why.length === 0) return problems;
    refused.push(...why.map((p) => `${file}: ${p}`));
  }
  // One receipt that backs every part of the claim is enough; otherwise say why each falls short.
  return [...problems, ...refused];
}

/**
 * Whether a call's evidence after a wait (`afterWait`) is about the same target as its first:
 * the same kind, and the same call id, file or command. Its effect is recomputed, not trusted.
 */
function sameTarget(first, later) {
  if (!first || !later || first.kind !== later.kind) return false;
  if (first.kind === "mcp") return first.callRef === later.callRef;
  if (first.kind === "file") return first.path === later.path && first.before === later.before;
  if (first.kind === "shell") return first.command === later.command;
  return false;
}

/** The receipt's `lifecycle` evidence each scoped check stands on. */
const LIFECYCLE_EVIDENCE = {
  optInDefaultOff: "optIn",
  cancelledNoEffect: "cancelled",
  freshSessionFreshDecision: "fresh",
  judgedAction: "judged",
};

/**
 * Why a receipt's `lifecycle` evidence does not show the `checks` it claims. A check's "pass" is
 * not taken on its word: each call's effect is recomputed from its `effectRef`
 * (`connected/evidence.js`), evidence that neither ORCA nor the agent writes.
 *
 * - `optInDefaultOff`: with the field left out, a write ORCA's rule denies took effect (no hook
 *   was installed); `on` was refused; with `experimental`, the same kind of write was denied and
 *   had no effect.
 * - `cancelledNoEffect`: every cancelled call was asked about in one session, never answered,
 *   and had no effect; its evidence taken again after a wait (`afterWait`, the same target)
 *   shows none either.
 * - `freshSessionFreshDecision`: in one new session, not the cancelled asks' one, calls with no
 *   answer had no effect, calls answered once took effect, each on its own ask, and none is a
 *   cancelled call.
 * Every ask is bound to its call (`toolCallId` is the call's `toolUseId`) and to its session.
 * - `judgedAction`: every judged call reached the person with the judge's advisory verdict;
 *   unanswered it had no effect, answered once it took effect. The judge allowed nothing itself.
 */
export function lifecycleEvidenceProblems(receipt, checks = Object.keys(LIFECYCLE_EVIDENCE)) {
  const problems = [];
  const life = receipt?.lifecycle ?? {};
  const effect = (r) => (r?.effectRef ? effectFrom(r.effectRef) : "indeterminate");
  const answers = (r) => (r?.approvals ?? []).map((a) => a.answer);
  const list = (v) => (Array.isArray(v) ? v : []);
  // Each ask is bound to its own call and to the session it was asked in.
  const bound = (r) =>
    (r?.approvals ?? []).every(
      (a) => a.toolCallId === r.toolUseId && typeof a.sessionId === "string" && a.sessionId !== "",
    );
  const sessions = (rs) => new Set(rs.flatMap((r) => (r.approvals ?? []).map((a) => a.sessionId)));
  for (const [name, rs] of [
    ["cancelled", list(life.cancelled)],
    ["fresh", list(life.fresh)],
    ["judged", list(life.judged)],
  ])
    if (rs.some((r) => !r?.toolUseId || !bound(r)))
      problems.push(`lifecycle.${name}: an ask is not bound to its own call and session`);
  if (checks.includes("optInDefaultOff")) {
    const o = life.optIn ?? {};
    if (list(o.default).length === 0 || list(o.default).some((r) => effect(r) !== "observed"))
      problems.push("lifecycle.optIn: without the field, the denied write did not take effect (a hook was in force)");
    if (o.on !== "refused") problems.push("lifecycle.optIn: nativeToolHook: on was not refused");
    if (
      list(o.experimental).length === 0 ||
      list(o.experimental).some((r) => r.outcome !== "deny" || effect(r) !== "none")
    )
      problems.push("lifecycle.optIn: with experimental, the write was not denied without effect");
  }
  const cancelled = list(life.cancelled);
  if (checks.includes("cancelledNoEffect")) {
    if (cancelled.length === 0) problems.push("lifecycle.cancelled: no cancelled call");
    for (const r of cancelled)
      if (
        r.outcome !== "ask" ||
        answers(r).length === 0 ||
        answers(r).some((a) => a !== "pending") ||
        effect(r) !== "none" ||
        !sameTarget(r.effectRef, r.afterWait) ||
        effectFrom(r.afterWait) !== "none"
      )
        problems.push(`lifecycle.cancelled: ${r.toolUseId ?? "a call"} was not a pending ask without effect`);
    if (cancelled.length > 0 && sessions(cancelled).size !== 1)
      problems.push("lifecycle.cancelled: the cancelled asks are not one session's");
  }
  if (checks.includes("judgedAction")) {
    const judged = list(life.judged);
    const advised = (r) =>
      (r.approvals ?? []).length > 0 &&
      r.approvals.every((a) => a.judged?.advisory === true && typeof a.judged?.verdict === "string");
    const unanswered = judged.filter((r) => advised(r) && answers(r).every((a) => a === "no-answer"));
    const once = judged.filter((r) => advised(r) && answers(r).every((a) => a === "allow_once"));
    if (unanswered.length === 0 || once.length === 0 || unanswered.length + once.length !== judged.length)
      problems.push("lifecycle.judged: needs judged calls the person was asked about, unanswered and answered once");
    for (const r of unanswered)
      if (effect(r) !== "none") problems.push(`lifecycle.judged: ${r.toolUseId} ran on the judge's advice alone`);
    for (const r of once)
      if (effect(r) !== "observed") problems.push(`lifecycle.judged: ${r.toolUseId} did not run on its answer`);
  }
  if (checks.includes("freshSessionFreshDecision")) {
    const fresh = list(life.fresh);
    const before = new Set(cancelled.map((r) => r.toolUseId));
    const unanswered = fresh.filter((r) => answers(r).length > 0 && answers(r).every((a) => a === "no-answer"));
    const once = fresh.filter((r) => answers(r).length > 0 && answers(r).every((a) => a === "allow_once"));
    if (unanswered.length === 0 || once.length === 0 || unanswered.length + once.length !== fresh.length)
      problems.push("lifecycle.fresh: needs calls asked again, both unanswered and answered once");
    for (const r of unanswered)
      if (effect(r) !== "none") problems.push(`lifecycle.fresh: ${r.toolUseId} ran without an answer`);
    for (const r of once)
      if (effect(r) !== "observed") problems.push(`lifecycle.fresh: ${r.toolUseId} did not run on its answer`);
    if (fresh.some((r) => !r.toolUseId || before.has(r.toolUseId)))
      problems.push("lifecycle.fresh: a call is not the fresh session's own");
    const old = sessions(cancelled);
    const now = sessions(fresh);
    if (fresh.length > 0 && (now.size !== 1 || [...now].some((id) => old.has(id))))
      problems.push("lifecycle.fresh: the asks are not one new session's");
  }
  return problems;
}

/**
 * Why promoted rows are not current at HEAD: each row above `none`, and each scoped claim, must pin a build whose
 * certified code and requirements HEAD has not changed (`attestation.js`, `staleProblems`). The release gate.
 */
export function releaseProblems(matrix, repoRoot = REPO_ROOT, stale = staleProblems) {
  return matrix.agents.flatMap((a) => [
    ...(a.tier !== "none" && a.pin?.build ? stale(repoRoot, a.pin.build).map((p) => `agent ${a.id}: ${p}`) : []),
    ...(a.scoped?.pin?.build ? stale(repoRoot, a.scoped.pin.build).map((p) => `agent ${a.id}: scoped: ${p}`) : []),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = loadMatrix();
  const read = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8"));
  const problems = checkSupportMatrix(matrix, loadCatalogue(), undefined, read, loadAssertions(), (file, receipt) =>
    attestationProblems(REPO_ROOT, file, receipt),
  );
  if (process.argv.includes("--release")) problems.push(...releaseProblems(matrix));
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
