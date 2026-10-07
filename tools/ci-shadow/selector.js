/** Produce and revalidate SHA-bound advisory plans. Existing full checks are the sole authority. */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { changes, digest, hash, identities, sorted, snapshot, validPath } from "./git.js";
import { consumers, graph, imports, MANIFEST_PATH, TOOL_PATHS, validateManifest } from "./graph.js";

export const ARTIFACT = "orca-ci-shadow-plan";
export const SCHEMA_VERSION = 1;
export const SELECTOR_VERSION = "1.0.3";
export const loadManifest = () =>
  validateManifest(JSON.parse(readFileSync(new URL("./ownership.v1.json", import.meta.url), "utf8")));
export const selectorIdentity = (manifest) => ({
  version: SELECTOR_VERSION,
  hash: digest(
    TOOL_PATHS.map((path) => ({ path, hash: hash(readFileSync(new URL(`../../${path}`, import.meta.url))) })),
  ),
  manifestVersion: manifest.schemaVersion,
  manifestHash: digest(manifest),
});

function pathRisk(path, record, snapshots, manifest) {
  const reasons = [];
  if (!validPath(path)) reasons.push("malformed_path");
  if (/\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(path) && record.status !== "M")
    reasons.push("test_discovery_change");
  if (record.status !== "M") reasons.push("structural_path_change");
  reasons.push(
    ...manifest.fullRiskRules.filter((rule) => new RegExp(rule.pattern).test(path)).map((rule) => rule.reason),
  );
  const modes = snapshots.map((snap) => snap.files.get(path)?.mode);
  if (
    modes.some((mode) => mode !== "100644") &&
    (manifest.prosePaths.includes(path) || manifest.islands.some((island) => island.paths.includes(path)))
  )
    reasons.push("structural_mode_change");
  const island = manifest.islands.find((entry) => entry.paths.includes(path));
  if (island) {
    for (const snap of snapshots) {
      const entry = snap.files.get(path);
      try {
        if (!entry?.text || !["100644", "100755"].includes(entry.mode)) throw new Error("missing_island");
        const signature = imports(entry.text, path, island.ambientReferences[path]);
        if (
          signature.unsafe ||
          !isDeepStrictEqual(signature.dependencies, island.dependencies[path]) ||
          !isDeepStrictEqual(signature.bindings, island.importBindings[path]) ||
          !isDeepStrictEqual(signature.callTargets, island.callTargets[path]) ||
          !isDeepStrictEqual(signature.memberReferences, island.memberReferences[path])
        )
          reasons.push("unreviewed_execution_edge");
      } catch {
        reasons.push("island_graph_incomplete");
      }
    }
    return {
      path,
      tier: reasons.length ? "full" : "targeted",
      reasons: sorted(reasons.length ? reasons : ["reviewed_renderer_time_island"]),
    };
  }
  if (manifest.prosePaths.includes(path))
    return {
      path,
      tier: reasons.length ? "full" : "docs",
      reasons: sorted(reasons.length ? reasons : ["reviewed_inert_prose"]),
    };
  if (path === MANIFEST_PATH || path.startsWith("tools/ci-shadow/")) reasons.push("selector_metadata_change");
  else
    reasons.push(
      ...manifest.fullRiskRules.filter((rule) => new RegExp(rule.pattern).test(path)).map((rule) => rule.reason),
    );
  if (
    !reasons.length ||
    reasons.every((reason) => ["structural_path_change", "test_discovery_change", "malformed_path"].includes(reason))
  )
    reasons.push("unknown_or_unreviewed_path");
  return { path, tier: "full", reasons: sorted(reasons) };
}

export function createPlan({ repo, base, head, candidate, forceFull = false }, manifest = loadManifest()) {
  if (typeof forceFull !== "boolean") throw new Error("invalid_force_full");
  validateManifest(manifest);
  const identity = identities(repo, base, head, candidate);
  const snaps = [snapshot(repo, base), snapshot(repo, candidate)];
  const graphs = snaps.map((snap) => graph(snap, manifest));
  const records = [
    ...changes(repo, identity.mergeBase, head, "pr-head"),
    ...changes(repo, head, candidate, "merge-candidate"),
  ];
  const reasons = [];
  if (forceFull) reasons.push("force_full");
  if (!records.length) reasons.push("empty_change_set");
  if (graphs.some((entry) => !entry.complete)) reasons.push("unreviewed_or_incomplete_graph");
  if (!isDeepStrictEqual(graphs[0].tests, graphs[1].tests)) reasons.push("discovery_inventory_changed");
  if (!graphs[1].tests.length) reasons.push("empty_test_discovery");
  for (const snap of snaps) {
    try {
      if (digest(JSON.parse(snap.files.get(MANIFEST_PATH)?.text)) !== digest(manifest))
        reasons.push("stale_or_missing_manifest");
      if (TOOL_PATHS.some((path) => !snap.files.has(path))) reasons.push("missing_selector_source");
      else if (
        TOOL_PATHS.some(
          (path) => hash(snap.files.get(path).text) !== hash(readFileSync(new URL(`../../${path}`, import.meta.url))),
        )
      )
        reasons.push("stale_selector_source");
    } catch {
      reasons.push("stale_or_missing_manifest");
    }
  }
  const classified = records.map((record) => {
    const paths = sorted([record.path, record.oldPath].filter((path) => path !== null));
    const risks = paths.map((path) => pathRisk(path, record, snaps, manifest));
    const reachable = consumers(graphs, paths);
    return {
      ...record,
      risks,
      consumers: reachable.filter(
        (node) =>
          node.startsWith("runner:") || graphs.some((entry) => entry.tests.some((path) => node === `file:${path}`)),
      ),
    };
  });
  let tier =
    reasons.length || classified.some((record) => record.risks.some((risk) => risk.tier === "full"))
      ? "full"
      : classified.some((record) => record.risks.some((risk) => risk.tier === "targeted"))
        ? "targeted"
        : "docs";
  let vitestFiles =
    tier === "full"
      ? graphs[1].tests
      : tier === "targeted"
        ? sorted([
            ...graphs[1].tests.filter((path) => path.startsWith("packages/app/")),
            ...classified.flatMap((record) =>
              record.consumers.filter((node) => node.startsWith("file:")).map((node) => node.slice(5)),
            ),
            ...records.map((record) => record.path).filter((path) => graphs[1].tests.includes(path)),
          ])
        : [];
  const missing = vitestFiles.filter((path) => !graphs[1].tests.includes(path));
  if (missing.length || (tier === "targeted" && !vitestFiles.length)) {
    reasons.push("selected_file_missing_from_candidate_discovery");
    tier = "full";
    vitestFiles = graphs[1].tests;
  }
  const runners = tier === "docs" ? [] : manifest.runners;
  return {
    artifact: ARTIFACT,
    schemaVersion: SCHEMA_VERSION,
    shadowOnly: true,
    authority: "existing-full-checks",
    identities: identity,
    selector: selectorIdentity(manifest),
    forceFull,
    graphs: graphs.map(({ sha, tree, hash, inventoryHash, complete, tests, gaps }) => ({
      sha,
      tree,
      hash,
      inventoryHash,
      complete,
      scope: "reviewed-islands-only",
      discoveredVitestFiles: tests,
      gaps,
    })),
    changes: classified,
    wouldRun: {
      tier,
      reasonCodes: sorted([
        ...reasons,
        ...classified.flatMap((record) => record.risks.flatMap((risk) => risk.reasons)),
      ]),
      vitestFiles,
      runners,
      expectedChecks:
        tier === "full"
          ? manifest.fullChecks
          : tier === "targeted"
            ? manifest.targetedChecks
            : ["explicit-docs-verdict"],
    },
    observedResults: [],
  };
}

export function validatePlan(plan, input, manifest = loadManifest()) {
  // Full recomputation checks schema, hashes, diff, selected files and graph state; no head-only acceptance.
  const expected = createPlan(input, manifest);
  if (!isDeepStrictEqual(plan, expected)) throw new Error("stale_mismatched_or_modified_plan");
  return expected;
}

export function validateExecution(plan, report) {
  // Evidence is separate from the immutable proposal. This helper never emits an admission verdict.
  if (
    report.candidate !== plan.identities.candidate ||
    ![22, 24].includes(report.node) ||
    !["suite", "retry"].includes(report.lane) ||
    report.success !== true ||
    !Array.isArray(report.files)
  )
    throw new Error("invalid_execution_identity_or_result");
  const expected =
    report.lane === "retry"
      ? ["packages/cli/test/admission-retry-wiring.test.ts", "packages/integrations/test/admission-retry-acp.test.ts"]
      : plan.wouldRun.vitestFiles;
  if (
    !expected.length ||
    !isDeepStrictEqual(sorted(report.files.map((file) => file.path)), sorted(expected)) ||
    report.files.length !== expected.length ||
    report.files.some(
      (file) =>
        !validPath(file.path) ||
        !Number.isSafeInteger(file.passed) ||
        file.passed < 1 ||
        file.failed !== 0 ||
        file.skipped !== 0 ||
        file.status !== "passed",
    )
  )
    throw new Error("missing_duplicate_failed_or_skipped_selected_file");
  return { candidate: report.candidate, node: report.node, lane: report.lane, selectedFilesPassed: expected.length };
}
