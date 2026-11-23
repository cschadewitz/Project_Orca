/**
 * Checks the #706 support matrix against the case catalogue and the repository, so a tier is
 * never claimed beyond its evidence and a case is never silently skipped.
 *
 *   node tools/guard-qualification/check-support-matrix.js
 *
 * Exit 0 with nothing printed when the matrix holds; otherwise one line per problem, exit 1.
 * Whether the cases *pass* is the suite's job (tools/test/enforcement-acceptance-706.test.js);
 * this checks what the matrix may claim given which cases exist and which files back it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
const TIERS = ["none", "A", "B", "C"];
/** Categories a tier C claim may not exclude without naming the gap as a residual risk. */
const MUST_COVER_FOR_C = ["lifecycle", "bypass"];

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
export function checkSupportMatrix(matrix, catalogue, exists = (p) => existsSync(join(REPO_ROOT, p))) {
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
    const ev = agent.evidence ?? {};
    for (const p of [...(ev.connectivity ?? []), ev.installed, ev.connected].filter(Boolean))
      if (!exists(p)) problems.push(`${at}: evidence ${p} does not exist`);
    if (tier >= 1) {
      if ((ev.connectivity ?? []).length === 0) problems.push(`${at}: tier A needs connectivity evidence`);
      if (agent.routes.length === 0) problems.push(`${at}: tier A needs at least one enforcement route`);
      if ((agent.unsupportedRoutes ?? []).length === 0)
        problems.push(`${at}: tier A must list the routes ORCA does not cover`);
      if ((agent.residualRisks ?? []).length === 0) problems.push(`${at}: a tier claim must list its residual risks`);
    }
    if (tier >= 2 && !ev.installed)
      problems.push(`${at}: tier B needs an installed acceptance run (evidence.installed)`);
    if (tier >= 3) {
      if (!ev.connected) problems.push(`${at}: tier C needs a connected proof receipt (evidence.connected)`);
      for (const r of agent.routes) {
        const path = paths.get(r);
        for (const id of Object.keys(path?.excluded ?? {})) {
          const c = byId.get(id);
          if (c && MUST_COVER_FOR_C.includes(c.category) && !(agent.residualRisks ?? []).some((x) => x.includes(id)))
            problems.push(`${at}: tier C on ${r} excludes ${c.category} case ${id}; name it in residualRisks`);
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
