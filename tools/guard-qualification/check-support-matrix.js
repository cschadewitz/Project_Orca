/**
 * Checks the #706 support matrix against the case catalogue and the repository, so a tier is
 * never claimed beyond its evidence and a case is never silently skipped.
 *
 *   node tools/guard-qualification/check-support-matrix.js
 *
 * Exit 0 with nothing printed when the matrix holds; otherwise one line per problem, exit 1.
 * Whether the synthetic cases *pass* is the suite's job (tools/test/enforcement-acceptance-706.test.js),
 * and synthetic results never count toward a tier. The receipt checks are structural only, and
 * promotion above `none` is refused outright (`PROMOTION_ENABLED`) until receipts are bound to
 * an independently trusted run.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectFrom } from "./connected/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
const TIERS = ["none", "A", "B", "C"];
/**
 * Off until a receipt is bound to an independently trusted run (who ran it, on what, and that
 * the file was not written by hand). Until then the receipt checks are structural only and
 * every promotion above `none` is refused.
 */
export const PROMOTION_ENABLED = false;
export const PROMOTION_DISABLED =
  "tier promotion is disabled: receipt checks are structural only until a receipt is bound to an independently trusted run (#706)";

/** Categories a tier C claim's connected path may not exclude. A named residual is not proof. */
const MUST_COVER_FOR_C = ["lifecycle", "bypass"];

/**
 * Why `receipt` does not back a claim for `agent` on `route`: wrong kind, another agent,
 * adapter version, host, route or build, a duplicate, failed or missing case, or a missing
 * connectivity check (every tier needs tier A's). Structural only. Empty when it holds.
 */
export function receiptProblems(receipt, agent, route, kind, neededCases, assertions = loadAssertions()) {
  const problems = [];
  if (receipt?.format !== "orca-enforcement-receipt/1") return ["not an orca-enforcement-receipt/1"];
  if (receipt.kind !== kind) problems.push(`kind ${receipt.kind}, needs ${kind}`);
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
    // The checks below are structural: a receipt file says what it says. Until a receipt is
    // bound to an independently trusted run, no structure is enough to promote a row.
    if (!PROMOTION_ENABLED) problems.push(`${at}: ${PROMOTION_DISABLED}`);

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
      const met = new Set();
      for (const need of required) {
        const good = receipts.filter(
          ({ receipt }) => receiptProblems(receipt, agent, need.route, need.kind, need.cases, assertions).length === 0,
        );
        if (good.length > 0) {
          met.add(need.route);
          continue;
        }
        if (need.tier === 3) continue;
        const why = receipts.flatMap(({ file, receipt }) =>
          receiptProblems(receipt, agent, need.route, need.kind, need.cases, assertions).map((p) => `${file}: ${p}`),
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkSupportMatrix(loadMatrix(), loadCatalogue());
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
