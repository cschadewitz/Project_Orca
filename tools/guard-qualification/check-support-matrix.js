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
export function receiptProblems(receipt, agent, route, kind, neededCases) {
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
  if (!(receipt.checks?.connects === "pass" && receipt.checks?.uncoveredRoutesRefused === "pass"))
    problems.push("needs checks.connects and checks.uncoveredRoutesRefused passing");
  if (kind === "connected") problems.push(...connectedEvidenceProblems(receipt));
  return problems;
}

/**
 * A connected receipt must show, per call, the refusal text, the approvals for that exact call
 * and an independently observed effect, kept apart, and the outcome must follow from them: a
 * refusal or an absent result alone never shows that nothing ran.
 */
export function connectedEvidenceProblems(receipt) {
  const problems = [];
  for (const c of receipt.cases ?? []) {
    const calls = c.calls ?? [];
    if (calls.length === 0) {
      problems.push(`case ${c.id}: no per-call evidence`);
      continue;
    }
    for (const call of calls) {
      if (call.strayApprovals) {
        problems.push(`case ${c.id}: an approval matched no call of its turn`);
        continue;
      }
      if (!("refusal" in call) || !Array.isArray(call.approvals) || typeof call.evidence !== "string")
        problems.push(`case ${c.id}: a call without refusal, approvals and evidence kept apart`);
      else if (call.effect !== "observed" && call.effect !== "none")
        problems.push(`case ${c.id}: ${call.tool} has effect ${call.effect}, not observed or none`);
      else if ((call.outcome === "allow") !== (call.effect === "observed"))
        problems.push(`case ${c.id}: ${call.tool} outcome ${call.outcome} does not follow from effect ${call.effect}`);
      else if (call.outcome === "ask" && call.approvals.length === 0)
        problems.push(`case ${c.id}: ${call.tool} counted as asked with no approval for that call`);
    }
  }
  return problems;
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

/** @returns {string[]} one message per problem; empty when the matrix holds */
export function checkSupportMatrix(
  matrix,
  catalogue,
  exists = (p) => existsSync(join(REPO_ROOT, p)),
  readReceipt = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")),
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
  }
  // A connected path runs a live agent through one route end to end, and proves that route.
  for (const path of matrix.paths) {
    if (!path.connected) {
      if (path.proves !== undefined) problems.push(`path ${path.id}: only a connected path proves a route`);
      continue;
    }
    const proved = paths.get(path.proves);
    if (!proved || proved.connected) problems.push(`path ${path.id}: proves ${path.proves}, which is not a route path`);
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
        ...provers.map((p) => ({ tier: 3, kind: "connected", route: p.id, cases: casesFor(p, catalogue) })),
      ].filter((r) => r.tier <= tier);
      if (tier === 3 && provers.length === 0)
        problems.push(`${at}: tier C on ${route} needs a connected path that proves it`);
      const met = new Set();
      for (const need of required) {
        const good = receipts.filter(
          ({ receipt }) => receiptProblems(receipt, agent, need.route, need.kind, need.cases).length === 0,
        );
        if (good.length > 0) {
          met.add(need.route);
          continue;
        }
        if (need.tier === 3) continue;
        const why = receipts.flatMap(({ file, receipt }) =>
          receiptProblems(receipt, agent, need.route, need.kind, need.cases).map((p) => `${file}: ${p}`),
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
          (p) =>
            met.has(p.id) &&
            !Object.keys(p.excluded ?? {}).some((id) => MUST_COVER_FOR_C.includes(byId.get(id)?.category)),
        );
        if (covered.length === 0) {
          for (const p of provers) {
            if (!met.has(p.id)) {
              const why = receipts.flatMap(({ file, receipt }) =>
                receiptProblems(receipt, agent, p.id, "connected", casesFor(p, catalogue)).map((x) => `${file}: ${x}`),
              );
              problems.push(
                `${at}: tier C on ${route} needs a passing connected receipt from ${p.id} for ${agent.id} ${pin.agentVersion} on ${pin.host}` +
                  (why.length ? ` (${why.join("; ")})` : ""),
              );
            }
            for (const id of Object.keys(p.excluded ?? {})) {
              const c = byId.get(id);
              if (c && MUST_COVER_FOR_C.includes(c.category))
                problems.push(`${at}: tier C on ${route} excludes ${c.category} case ${id} on ${p.id}`);
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
