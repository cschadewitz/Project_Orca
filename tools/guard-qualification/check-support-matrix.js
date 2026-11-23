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

/** Categories a tier C claim may not exclude on any of its routes. A named residual is not proof. */
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
    for (const r of agent.routes) if (!paths.has(r)) problems.push(`${at}: route ${r} has no path in the suite`);
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
      // Tiers are cumulative: each one needs the receipt of every tier below it too.
      const required = [
        { tier: 1, kind: "installed", cases: [] },
        { tier: 2, kind: "installed", cases: casesFor(path, catalogue) },
        { tier: 3, kind: "connected", cases: casesFor(path, catalogue) },
      ].filter((r) => r.tier <= tier);
      for (const need of required) {
        const good = receipts.filter(
          ({ receipt }) => receiptProblems(receipt, agent, route, need.kind, need.cases).length === 0,
        );
        if (good.length > 0) continue;
        const why = receipts.flatMap(({ file, receipt }) =>
          receiptProblems(receipt, agent, route, need.kind, need.cases).map((p) => `${file}: ${p}`),
        );
        problems.push(
          `${at}: tier ${TIERS[need.tier]} on ${route} needs a passing ${need.kind} receipt for ${agent.id} ${pin.agentVersion} on ${pin.host}` +
            (why.length ? ` (${why.join("; ")})` : ""),
        );
      }
      if (tier === 3)
        for (const id of Object.keys(path.excluded ?? {})) {
          const c = byId.get(id);
          if (c && MUST_COVER_FOR_C.includes(c.category))
            problems.push(`${at}: tier C on ${route} excludes ${c.category} case ${id}`);
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
