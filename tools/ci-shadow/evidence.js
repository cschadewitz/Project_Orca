/** Normalize real Vitest reports and compare full CI evidence without granting admission. */
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, git, hash, sorted, validPath } from "./git.js";

export const RETRY_FILES = [
  "packages/cli/test/admission-retry-wiring.test.ts",
  "packages/integrations/test/admission-retry-acp.test.ts",
];
// Exact assertion identity AND unchanged test blob are required. A skip is never a pass.
export const INTENTIONAL_SKIPS = [
  {
    path: RETRY_FILES[0],
    name: "HTTP/WS and legacy start share one real admission, ownership and current authorization",
    reason: "separate mandatory retry acceptance",
  },
  {
    path: RETRY_FILES[1],
    name: "ACP metadata keeps retries stable across new sessions and distinguishes intentional new work",
    reason: "separate mandatory retry acceptance",
  },
  {
    path: "packages/integrations/test/jev-eval.live.test.ts",
    name: "custom:jev-eval against the TypeSafe API (live) records an evaluation artifact from a real answer",
    reason: "credential-dependent live provider smoke is opt-in",
  },
];
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function readJSON(path, limit = 4 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit || stat.size === 0) throw new Error("unsafe_or_oversized_json");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
}

export function atomicJSON(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(`${path}.tmp`, path);
}

export function normalizeVitest(report, root) {
  if (typeof report.success !== "boolean" || !Array.isArray(report.testResults) || !report.testResults.length)
    throw new Error("invalid_vitest_report");
  const files = report.testResults
    .map((file) => {
      if (typeof file.name !== "string" || !isAbsolute(file.name) || !["passed", "failed"].includes(file.status))
        throw new Error("invalid_vitest_file");
      // Git inventory paths use '/', while a Windows runner reports native separators.
      // Convert only the host separator; a literal POSIX backslash remains invalid.
      const runnerPath = relative(root, file.name);
      const path = runnerPath.split(sep).join("/");
      if (isAbsolute(runnerPath) || !validPath(path) || path.length > 512 || !Array.isArray(file.assertionResults))
        throw new Error("invalid_vitest_path");
      const statuses = file.assertionResults.map((test) => test.status);
      if (statuses.some((status) => !["passed", "failed", "skipped", "pending", "todo"].includes(status)))
        throw new Error("unknown_assertion_status");
      return {
        path,
        status: file.status,
        passed: statuses.filter((status) => status === "passed").length,
        failed: statuses.filter((status) => status === "failed").length,
        // Keep hashes only: no failure messages, console output, assertion text or credentials.
        skips: file.assertionResults
          .filter((test) => ["skipped", "pending"].includes(test.status))
          .map((test) => {
            if (typeof test.fullName !== "string") throw new Error("missing_skip_identity");
            return hash(test.fullName);
          })
          .sort(),
        todo: statuses.filter((status) => status === "todo").length,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("duplicate_vitest_file");
  const total = (key) => files.reduce((n, file) => n + (key === "skips" ? file.skips.length : file[key]), 0);
  if (
    report.numPassedTests !== total("passed") ||
    report.numFailedTests !== total("failed") ||
    report.numPendingTests !== total("skips") ||
    report.numTodoTests !== total("todo") ||
    report.numTotalTests !== total("passed") + total("failed") + total("skips") + total("todo")
  )
    throw new Error("inconsistent_vitest_counts");
  return { success: report.success, files };
}

export function validateIdentity(identity) {
  if (
    !exactKeys(identity, ["repository", "runId", "attempt", "event", "base", "head", "candidate", "node"]) ||
    identity.repository !== "cschadewitz/Project_Orca" ||
    !count(identity.runId) ||
    identity.runId < 1 ||
    !count(identity.attempt) ||
    identity.attempt < 1 ||
    !["pull_request", "push"].includes(identity.event) ||
    ![22, 24].includes(identity.node) ||
    ![identity.base, identity.head, identity.candidate].every(sha)
  )
    throw new Error("invalid_evidence_identity");
  return identity;
}

function validateReport(report) {
  if (
    !exactKeys(report, ["success", "files"]) ||
    typeof report.success !== "boolean" ||
    !Array.isArray(report.files) ||
    !report.files.length ||
    report.files.length > 10000
  )
    throw new Error("invalid_normalized_report");
  for (const file of report.files) {
    if (
      !exactKeys(file, ["path", "status", "passed", "failed", "skips", "todo"]) ||
      !validPath(file.path) ||
      file.path.length > 512 ||
      !["passed", "failed"].includes(file.status) ||
      ![file.passed, file.failed, file.todo].every(count) ||
      !Array.isArray(file.skips) ||
      file.skips.some((skip) => typeof skip !== "string" || !/^[a-f0-9]{64}$/.test(skip))
    )
      throw new Error("invalid_normalized_file");
  }
  if (new Set(report.files.map((file) => file.path)).size !== report.files.length)
    throw new Error("duplicate_normalized_file");
}

export function validateEvidence(evidence, identity) {
  if (
    !exactKeys(evidence, ["artifact", "schemaVersion", "identity", "suite", "retry"]) ||
    evidence.artifact !== "orca-ci-full-evidence" ||
    evidence.schemaVersion !== 1
  )
    throw new Error("invalid_evidence_schema");
  validateIdentity(evidence.identity);
  if (!isDeepStrictEqual(evidence.identity, identity)) throw new Error("stale_evidence_identity");
  for (const lane of ["suite", "retry"]) if (evidence[lane] !== null) validateReport(evidence[lane]);
  return evidence;
}

const filePassed = (file) =>
  file.status === "passed" && file.passed > 0 && file.failed === 0 && !file.skips.length && file.todo === 0;
const samePaths = (report, expected) =>
  isDeepStrictEqual(sorted(report.files.map((file) => file.path)), sorted(expected));

export function compareLane(plan, evidence, { repo, trusted, node, job, source }) {
  const selectedSteps = job?.steps?.filter((step) => step.name === "Test selected files") ?? [];
  const selected = selectedSteps.length === 1 && selectedSteps[0].conclusion === "success";
  const result = {
    node,
    status: "unknown",
    reasons: [],
    selected: plan.wouldRun.vitestFiles.length,
    omittedFailures: [],
    intentionalSkips: [],
    checks: [],
    execution: selected ? "selected" : "full",
  };
  const add = (reason) => result.reasons.push(reason);
  if (!job) add("missing_job");
  else if (job.conclusion === "cancelled") {
    result.status = "cancelled";
    add("cancelled_job");
  } else if (job.conclusion === "skipped") add("full_suite_not_run");
  else if (job.conclusion !== "success") add("incomplete_or_failed_job");
  if (!evidence) {
    add("missing_evidence");
    return result;
  }
  const expected = { ...source, ...plan.identities, node };
  delete expected.mergeBase;
  try {
    validateEvidence(evidence, expected);
  } catch {
    add("stale_or_malformed_evidence");
    return result;
  }
  // Genuine process outcomes come from GitHub's job API, separately from the artifact.
  if (plan.wouldRun.tier === "docs" && source.event === "pull_request") {
    const step = job?.steps?.filter((entry) => entry.name === "Check ordinary documentation") ?? [];
    const runtime =
      job?.steps?.filter((entry) =>
        [
          "Build",
          "Test",
          "Test selected files",
          "Test with coverage",
          "Retry admission acceptance (CLI and ACP)",
          "Smoke test the compiled build",
        ].includes(entry.name),
      ) ?? [];
    if (
      step.length !== 1 ||
      step[0].conclusion !== "success" ||
      runtime.length !== 6 ||
      runtime.some((entry) => entry.conclusion !== "skipped") ||
      evidence.suite !== null ||
      evidence.retry !== null
    )
      add("ordinary_docs_execution_not_proven");
    result.execution = "docs";
    if (!result.reasons.length) result.status = "docs_verified";
    return result;
  }
  const required = [
    "Build",
    "Retry admission acceptance (CLI and ACP)",
    selected ? "Test selected files" : node === 24 ? "Test with coverage" : "Test",
    "Smoke test the compiled build",
  ];
  if (selected) {
    required.push("Plan test execution");
    const fullSteps = job.steps.filter((step) => step.name === (node === 24 ? "Test with coverage" : "Test"));
    if (
      source.event !== "pull_request" ||
      plan.wouldRun.tier !== "targeted" ||
      !plan.graphs.every((entry) => entry.complete) ||
      fullSteps.length !== 1 ||
      fullSteps[0].conclusion !== "skipped" ||
      job.steps.some((step) => ["Test", "Test with coverage"].includes(step.name) && step.conclusion !== "skipped")
    )
      add("unproven_or_ambiguous_reduced_execution");
  }
  if (node === 24) required.push("Typecheck", "Design tokens are current", "Format", "Lint");
  for (const name of required) {
    const steps = job?.steps?.filter((step) => step.name === name) ?? [];
    result.checks.push({
      name,
      conclusion:
        steps.length === 1 && ["success", "failure", "skipped", "cancelled"].includes(steps[0].conclusion)
          ? steps[0].conclusion
          : "unknown",
    });
    if (steps.length !== 1 || steps[0].conclusion !== "success") add("missing_or_unsuccessful_required_step");
  }
  const retry = evidence.retry;
  if (!retry || !retry.success || !samePaths(retry, RETRY_FILES) || !retry.files.every(filePassed))
    add("retry_acceptance_not_proven");
  const suite = evidence.suite;
  if (!suite) {
    add("missing_suite_report");
    return result;
  }
  if (!samePaths(suite, selected ? plan.wouldRun.vitestFiles : plan.graphs[1].discoveredVitestFiles))
    add(selected ? "selected_discovery_mismatch" : "full_discovery_mismatch");
  if (!suite.success) add("failed_suite");
  for (const file of suite.files) {
    if (!filePassed(file)) {
      const policy = INTENTIONAL_SKIPS.find((skip) => skip.path === file.path);
      let allowed = false;
      if (
        !selected &&
        policy &&
        file.status === "passed" &&
        file.failed === 0 &&
        file.passed === 0 &&
        file.todo === 0 &&
        isDeepStrictEqual(file.skips, [hash(policy.name)])
      ) {
        try {
          allowed = git(repo, ["rev-parse", `${trusted}:${file.path}`]).equals(
            git(repo, ["rev-parse", `${plan.identities.candidate}:${file.path}`]),
          );
        } catch {
          allowed = false;
        }
      }
      if (allowed) result.intentionalSkips.push({ path: file.path, reason: policy.reason, status: "skipped" });
      else add("unexpected_skip_failure_or_empty_file");
    }
    if ((file.failed || file.status === "failed") && !plan.wouldRun.vitestFiles.includes(file.path))
      result.omittedFailures.push(file.path);
  }
  if (result.omittedFailures.length) add("failure_in_omitted_file");
  if (!result.reasons.length) result.status = selected ? "selected_verified" : "compared";
  return result;
}

export function compareFullEvidence(plan, lanes, input) {
  const compared = [22, 24].map((node) =>
    compareLane(plan, lanes[node]?.evidence, { ...input, node, job: lanes[node]?.job }),
  );
  // Selected execution can be verified without claiming evidence about omitted tests.
  const baseline = compared.filter((lane) => lane.status === "compared").map((lane) => lane.node);
  return {
    artifact: "orca-ci-shadow-comparison",
    schemaVersion: 1,
    shadowOnly: true,
    authority: "existing-full-checks",
    identities: plan.identities,
    planDigest: digest(plan),
    trusted: input.trusted,
    wouldRun: {
      tier: plan.wouldRun.tier,
      selected: plan.wouldRun.vitestFiles.length,
      discovered: plan.graphs[1].discoveredVitestFiles.length,
    },
    lanes: compared,
    fullBaseline: {
      status: baseline.length ? "available" : "not_run",
      nodes: baseline,
      reason: baseline.length
        ? "genuine_same_candidate_full_evidence"
        : "selected_or_docs_execution_does_not_prove_omitted_tests",
    },
    // CI never runs these browser/native lanes. Do not infer their verdicts from Vitest.
    separateRunners: plan.wouldRun.runners.map((runner) => ({
      id: runner.id,
      status: "unknown",
      reason: "outside_CI_workflow",
    })),
  };
}
