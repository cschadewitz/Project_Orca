/** Enforce the reviewed PR selection on Node 22; Node 24 retains full coverage. */
import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicJSON, normalizeVitest, readJSON } from "./evidence.js";
import { git } from "./git.js";
import { createPlan, validateExecution, validatePlan } from "./selector.js";

export function executionPlan(input, event, node, manifest) {
  const plan = createPlan({ ...input, forceFull: event !== "pull_request" || node !== 22 }, manifest);
  validatePlan(plan, { ...input, forceFull: event !== "pull_request" || node !== 22 }, manifest);
  if (event === "pull_request") {
    const parents = git(input.repo, ["show", "-s", "--format=%P", input.candidate]).toString().trim().split(" ");
    if (!isDeepStrictEqual(parents, [input.base, input.head])) throw new Error("candidate_parents_mismatch");
  }
  if (git(input.repo, ["rev-parse", "HEAD"]).toString().trim() !== input.candidate)
    throw new Error("checkout_candidate_mismatch");
  // Even an advisory docs plan cannot skip a test job admitted by the existing classifier.
  const mode = event === "pull_request" && node === 22 && plan.wouldRun.tier === "targeted" ? "targeted" : "full";
  return { plan, mode };
}

export function selectedResult(plan, raw, root, node = 22) {
  const report = normalizeVitest(raw, root);
  if (report.files.some((file) => file.todo !== 0)) throw new Error("selected_todo");
  return validateExecution(plan, {
    candidate: plan.identities.candidate,
    node,
    lane: "suite",
    success: report.success,
    files: report.files.map((file) => ({ ...file, skipped: file.skips.length })),
  });
}

function candidateCheckout(repo, candidate) {
  if (git(repo, ["rev-parse", "HEAD"]).toString().trim() !== candidate) throw new Error("checkout_candidate_mismatch");
  git(repo, ["diff", "--exit-code", candidate, "--"]);
}

export function runSelected(input, artifact, reportPath, workers, run = spawnSync, manifest) {
  if (!/^[12]$/.test(String(workers))) throw new Error("invalid_worker_bound");
  const { plan, mode } = executionPlan(input, "pull_request", 22, manifest);
  if (mode !== "targeted") throw new Error("selection_no_longer_eligible");
  validatePlan(readJSON(artifact), input, manifest);
  const candidate = plan.identities.candidate;
  // Install/build/retry must not substitute tracked candidate source before execution.
  candidateCheckout(input.repo, candidate);
  rmSync(reportPath, { force: true });
  const result = run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      ...plan.wouldRun.vitestFiles,
      `--maxWorkers=${workers}`,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    { cwd: input.repo, stdio: "inherit", env: process.env },
  );
  if (result.error || result.status !== 0) throw new Error("selected_process_failed");
  // Clean HEAD movement is still an identity change, including a same-tree commit.
  candidateCheckout(input.repo, candidate);
  const accepted = selectedResult(plan, readJSON(reportPath, 32 * 1024 * 1024), input.repo);
  candidateCheckout(input.repo, candidate);
  return accepted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const temp = process.env.RUNNER_TEMP;
  const artifact = join(temp, "ci-selection-plan.json");
  const mode = process.argv[2];
  const input = {
    repo: process.cwd(),
    base: process.env.SHADOW_BASE,
    head: process.env.SHADOW_HEAD,
    candidate: process.env.GITHUB_SHA,
  };
  if (mode === "plan") {
    // No error or partial artifact can emit reduced execution permission.
    let selection = "full";
    try {
      if (process.env.GITHUB_EVENT_NAME === "push")
        input.base = git(input.repo, ["rev-parse", `${input.candidate}^1`])
          .toString()
          .trim();
      const result = executionPlan(input, process.env.GITHUB_EVENT_NAME, Number(process.env.SHADOW_NODE));
      atomicJSON(artifact, result.plan);
      selection = result.mode;
      console.log(
        `Node ${process.env.SHADOW_NODE} test mode: ${selection}; ${result.plan.wouldRun.reasonCodes.join(", ")}`,
      );
    } catch {
      console.log("Selection unavailable or unproven; retaining full tests.");
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${selection}\n`);
  } else if (mode === "run") {
    if (process.versions.node.split(".")[0] !== "22" || process.env.ORCA_MCP_REQUIRE_PRODUCTION !== "1")
      throw new Error("selected_runtime_or_production_requirement_mismatch");
    runSelected(input, artifact, join(temp, "full-suite.json"), process.env.VITEST_MAX_WORKERS);
  } else throw new Error("invalid_execution_command");
}
