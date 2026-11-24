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
 * receipt counts as unverified. Rows may be promoted to A or B (`PROMOTABLE_TIERS`): the
 * receipt producer is guard-receipts.yml, whose end-to-end check (`e2e-check.js`) accepts a
 * real qualifying receipt and refuses a real failing one and a tampered copy on every run (#1026).
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
 * Tiers a row may be promoted to on attested receipts: A and B, whose receipts guard-receipts.yml
 * produces and checks end to end (`e2e-check.js`). C waits for #1026's independent observer.
 */
export const PROMOTABLE_TIERS = ["A", "B"];
export const PROMOTION_DISABLED = "tier C promotion waits for an independent observer (#1026)";
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
  if (receipt.fault !== undefined) problems.push(`a run with an injected fault (${receipt.fault})`);
  if (receipt.agent !== agent.id) problems.push(`agent ${receipt.agent}`);
  if (receipt.agentVersion !== agent.pin?.agentVersion) problems.push(`agentVersion ${receipt.agentVersion}`);
  if (receipt.adapterVersion !== agent.pin?.adapterVersion) problems.push(`adapterVersion ${receipt.adapterVersion}`);
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
 * How each case of an installed receipt ran on the installed agent, from the route's `installed`
 * entry in the matrix:
 *
 * - `live`: through the real agent, driven by the runner of the connected path `installed.live`
 *   names, with every call's evidence checked exactly as a connected receipt's is, against that
 *   path's committed assertion inventory (`connectedEvidenceProblems`);
 * - `program`: through ORCA's installed program as the agent would run it (the hook script,
 *   the context file and settings the session factory wrote), only for the cases
 *   `installed.program` lists, each with the reason a live agent cannot make that call.
 *
 * A route with no `installed` entry has no installed runner, so no installed receipt holds it
 * beyond tier A.
 */
export function installedCaseProblems(receipt, neededCases, assertions, routePath) {
  if (neededCases.length === 0) return [];
  const spec = routePath?.installed;
  if (!spec) return [`route ${receipt.route} has no installed runner in the matrix`];
  const problems = [];
  const program = spec.program ?? {};
  const live = [];
  const onProgram = [];
  for (const c of (receipt.cases ?? []).filter((x) => neededCases.includes(x.id))) {
    if (c.via === "program") {
      if (!(c.id in program)) problems.push(`case ${c.id}: run on the program, but a live agent can make it`);
      else onProgram.push(c.id);
    } else if (c.via === "live") live.push(c.id);
    else problems.push(`case ${c.id}: needs via live or program`);
  }
  if (onProgram.length) problems.push(...programEvidenceProblems(receipt, onProgram, assertions));
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

/**
 * The evidence of the cases an installed receipt ran on ORCA's installed program, re-derived
 * rather than trusted. The runs each case makes, in order, which arguments they use (the
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
  if (
    typeof inputs?.adapter?.integrity !== "string" ||
    !inputs.adapter.integrity.startsWith("sha512-") ||
    !hex(inputs.runtime?.sha256) ||
    !hex(inputs.hookProgram?.sha256) ||
    !hex(inputs.profile)
  )
    return ["needs inputs: the adapter's integrity, the runtime and hook program digests, and the profile"];
  const problems = [];
  if (profile !== undefined && inputs.profile !== profile)
    problems.push("ran against other requirements than the matrix states now (profile differs)");
  const pinned = agent.pin?.artifacts ?? {};
  for (const [name, value] of Object.entries(artifactsOf(receipt)))
    if (pinned[name] !== value) problems.push(`${name} ${value} is not the row's pinned ${pinned[name] ?? "nothing"}`);
  return problems;
}

/** The artifact digests a row pins from an installed receipt. */
export function artifactsOf(receipt) {
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

  // A route's installed program cases have their runs and accepted outcomes committed too.
  for (const path of matrix.paths) {
    const program = path.installed?.program ?? {};
    const inventory = assertions.programs?.[path.id] ?? {};
    const runs = new Set(casesFor(path, catalogue));
    for (const id of Object.keys(program)) {
      if (!runs.has(id)) problems.push(`path ${path.id}: runs ${id} on its installed program, but does not run it`);
      if (!Array.isArray(inventory[id]))
        problems.push(`path ${path.id}: program case ${id} has no committed inventory`);
    }
    for (const [id, entries] of Object.entries(inventory)) {
      if (!(id in program)) problems.push(`path ${path.id}: the program inventory lists ${id}, not a program case`);
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
    if (tier === 0) continue;
    if (!promotable.includes(agent.tier)) problems.push(`${at}: ${PROMOTION_DISABLED}`);
    // A receipt says what it says; only one bound to the run that produced it is evidence.
    for (const r of receipts) r.trust = verifyReceipt(r.file, r.receipt);

    const pin = agent.pin;
    if (!pin || !pin.agentVersion || !pin.adapterVersion || !pin.host || !/^[0-9a-f]{40}$/.test(pin.build ?? "")) {
      problems.push(`${at}: tier ${agent.tier} needs a pinned agent version, adapter version, host and exact build`);
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
        { tier: 2, kind: "installed", route, cases: casesFor(path, catalogue) },
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
 * Why promoted rows are not current at HEAD: each row above `none` must pin a build whose
 * certified code and requirements HEAD has not changed (`attestation.js`, `staleProblems`). The release gate.
 */
export function releaseProblems(matrix, repoRoot = REPO_ROOT, stale = staleProblems) {
  return matrix.agents
    .filter((a) => a.tier !== "none" && a.pin?.build)
    .flatMap((a) => stale(repoRoot, a.pin.build).map((p) => `agent ${a.id}: ${p}`));
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
