/** Exercise genuine-report normalization, SHA binding, skip policy and safe artifact intake. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  atomicJSON,
  compareFullEvidence,
  INTENTIONAL_SKIPS,
  normalizeVitest,
  readJSON,
  RETRY_FILES,
  RUNNER_SKIPS,
  validateEvidence,
} from "../ci-shadow/evidence.js";
import { consume, resolveSource, summary } from "../ci-shadow/consume.js";
import { createPlan } from "../ci-shadow/selector.js";
import { git, hash } from "../ci-shadow/git.js";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const candidate = git(repo, ["rev-parse", "HEAD"]).toString().trim();
const source = { repository: "cschadewitz/Project_Orca", runId: 123, attempt: 1, event: "pull_request" };
const identities = { base: candidate, head: candidate, mergeBase: candidate, candidate };
const root = "/synthetic/checkout";
const ordinary = "tools/test/ci-classification.test.js";
const discovered = [ordinary, ...INTENTIONAL_SKIPS.map((skip) => skip.path)].sort();
const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-shadow-evidence-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = (path) => ({ path, status: "passed", passed: 1, failed: 0, skips: [], todo: 0 });
const plan = (selected = discovered) => ({
  identities,
  graphs: [{}, { discoveredVitestFiles: discovered }],
  wouldRun: { tier: "targeted", vitestFiles: selected, runners: [{ id: "resources-browser" }] },
});
const evidence = (node = 24) => ({
  artifact: "orca-ci-full-evidence",
  schemaVersion: 1,
  identity: { ...source, base: candidate, head: candidate, candidate, node },
  suite: {
    success: true,
    files: [
      file(ordinary),
      ...INTENTIONAL_SKIPS.map((skip) => ({ ...file(skip.path), passed: 0, skips: [hash(skip.name)] })),
    ],
  },
  retry: { success: true, files: RETRY_FILES.map(file) },
});
const job = () => ({
  conclusion: "success",
  steps: [
    "Build",
    "Retry admission acceptance (CLI and ACP)",
    "Test with coverage",
    "Smoke test the compiled build",
    "Typecheck",
    "Design tokens are current",
    "Format",
    "Lint",
  ].map((name) => ({ name, conclusion: "success" })),
});
const compare = (e = evidence(), j = job(), p = plan(), options = {}) =>
  compareFullEvidence(p, { 24: { evidence: e, job: j } }, { repo, trusted: candidate, source, ...options });
const raw = () => ({
  success: true,
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 1,
  numTodoTests: 0,
  testResults: [
    {
      name: join(root, ordinary),
      status: "passed",
      message: "secret failure text",
      assertionResults: [
        {
          status: "passed",
          fullName: "secret passed title",
          failureMessages: ["secret"],
          meta: { credential: "secret" },
        },
        { status: "skipped", fullName: "expected skip" },
      ],
    },
  ],
});

const selectedJob = () => ({
  ...job(),
  steps: [
    ...job().steps.map((step) => (step.name === "Test with coverage" ? { ...step, conclusion: "skipped" } : step)),
    { name: "Plan test execution", conclusion: "success" },
    { name: "Test selected files", conclusion: "success" },
  ],
});
const selectedPlan = () => ({
  ...plan([ordinary]),
  graphs: [{ complete: true }, { complete: true, discoveredVitestFiles: discovered }],
});
const selectedEvidence = (node = 24) => ({ ...evidence(node), suite: { success: true, files: [file(ordinary)] } });

it("authenticates selected Node 24 without claiming full/global coverage or omitted-test equivalence", () => {
  const result = compare(selectedEvidence(), selectedJob(), selectedPlan());
  expect(result.lanes.map((lane) => lane.status)).toEqual(["selected_verified"]);
  expect(result.lanes.map((lane) => lane.execution)).toEqual(["selected"]);
  expect(result.lanes[0].reasons).toEqual([]);
  expect(result.lanes[0].intentionalSkips).toEqual([]);
  expect(result.fullBaseline).toMatchObject({ status: "not_run", nodes: [] });
});

it.each([
  "push",
  "full_plan",
  "incomplete_graph",
  "both_steps",
  "missing_plan_step",
  "duplicate_selected_step",
  "extra_file",
  "skip",
])("rejects unproven reduced execution: %s", (kind) => {
  const e = selectedEvidence();
  const j = selectedJob();
  const p = selectedPlan();
  let input = {};
  if (kind === "push") input = { source: { ...source, event: "push" } };
  if (kind === "full_plan") p.wouldRun.tier = "full";
  if (kind === "incomplete_graph") p.graphs[0].complete = false;
  if (kind === "both_steps") j.steps.find((step) => step.name === "Test with coverage").conclusion = "success";
  if (kind === "missing_plan_step") j.steps = j.steps.filter((step) => step.name !== "Plan test execution");
  if (kind === "duplicate_selected_step") j.steps.push({ name: "Test selected files", conclusion: "success" });
  if (kind === "extra_file") e.suite.files.push(file("extra.test.ts"));
  if (kind === "skip") e.suite.files[0] = { ...file(ordinary), passed: 0, skips: [hash("new skip")] };
  expect(compare(e, j, p, input).lanes[0].status).toBe("unknown");
});

it.each(["missing", "failed", "stale", "cancelled"])(
  "does not claim an unavailable full Node 24 baseline: %s",
  (kind) => {
    const baseline = evidence(24);
    const baselineJob = job();
    if (kind === "failed") baseline.suite.success = false;
    if (kind === "stale") baseline.identity.candidate = "0".repeat(40);
    if (kind === "cancelled") baselineJob.conclusion = "cancelled";
    const result = compareFullEvidence(
      selectedPlan(),
      {
        24: { evidence: kind === "missing" ? null : baseline, job: baselineJob },
      },
      { repo, trusted: candidate, source },
    );
    expect(result.lanes[0].status).toBe(kind === "cancelled" ? "cancelled" : "unknown");
    expect(result.fullBaseline).toMatchObject({ status: "not_run", nodes: [] });
  },
);

it.each([
  "Build",
  "Retry admission acceptance (CLI and ACP)",
  "Test with coverage",
  "Smoke test the compiled build",
  "Typecheck",
  "Design tokens are current",
  "Format",
  "Lint",
])("full fallback still requires successful %s evidence", (name) => {
  const p = plan();
  p.wouldRun.tier = "full";
  const j = job();
  j.steps.push({ name: "Test selected files", conclusion: "skipped" });
  expect(compare(evidence(), j, p).lanes[0].status).toBe("compared");
  for (const conclusion of ["failure", "skipped", "cancelled"]) {
    j.steps.find((step) => step.name === name).conclusion = conclusion;
    expect(compare(evidence(), j, p).lanes[0].status).toBe("unknown");
    expect(compare(evidence(), j, p).lanes[0].reasons).toContain("missing_or_unsuccessful_required_step");
  }
  j.steps = j.steps.filter((step) => step.name !== name);
  expect(compare(evidence(), j, p).lanes[0].status).toBe("unknown");
});

it("rejects retired Node 22 evidence and does not consume it as a CI lane", () => {
  const wrongRuntime = selectedEvidence(22);
  expect(() => validateEvidence(wrongRuntime, wrongRuntime.identity)).toThrow("invalid_evidence_identity");
  const stale = compareFullEvidence(
    selectedPlan(),
    {
      22: { evidence: evidence(22), job: job() },
      24: { evidence: wrongRuntime, job: selectedJob() },
    },
    { repo, trusted: candidate, source },
  );
  expect(stale.lanes.map((lane) => lane.node)).toEqual([24]);
  expect(stale.lanes[0].reasons).toContain("stale_or_malformed_evidence");
  expect(stale.fullBaseline).toMatchObject({ status: "not_run", nodes: [] });
});

it.each([24])("requires explicit successful documentation execution on Node %s", (node) => {
  const p = { ...plan([]), wouldRun: { ...plan([]).wouldRun, tier: "docs" } };
  const e = { ...evidence(node), suite: null, retry: null };
  const j = {
    conclusion: "success",
    steps: [
      { name: "Check ordinary documentation", conclusion: "success" },
      ...[
        "Build",
        "Test selected files",
        "Test with coverage",
        "Retry admission acceptance (CLI and ACP)",
        "Smoke test the compiled build",
      ].map((name) => ({ name, conclusion: "skipped" })),
    ],
  };
  const check = () =>
    compareFullEvidence(p, { [node]: { evidence: e, job: j } }, { repo, trusted: candidate, source }).lanes[0];
  expect(check()).toMatchObject({ status: "docs_verified", execution: "docs" });
  j.steps[0].conclusion = "failure";
  expect(check().status).toBe("unknown");
  j.steps[0].conclusion = "skipped";
  expect(check().status).toBe("unknown");
  j.steps[0].conclusion = "success";
  e.suite = evidence(node).suite;
  expect(check().status).toBe("unknown");
});

it("normalizes actual Vitest fields and strips messages, titles, metadata and absolute checkout paths", () => {
  const normalized = normalizeVitest(raw(), root);
  expect(normalized.files[0]).toEqual({ ...file(ordinary), skips: [hash("expected skip")] });
  expect(JSON.stringify(normalized)).not.toContain("secret");
  expect(JSON.stringify(normalized)).not.toContain(root);
});

it.each(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"])(
  "rejects inconsistent real assertion totals: %s",
  (key) => {
    const report = raw();
    report[key]++;
    expect(() => normalizeVitest(report, root)).toThrow("inconsistent_vitest_counts");
  },
);

it.each(["/outside/test.js", `${root}/../escape.js`, "relative.js", `${root}/unsafe\nname.js`])(
  "rejects unsafe runner path %s",
  (name) => {
    const report = raw();
    report.testResults[0].name = name;
    expect(() => normalizeVitest(report, root)).toThrow();
  },
);

it("rejects duplicate files and unknown statuses", () => {
  const report = raw();
  report.testResults.push(report.testResults[0]);
  expect(() => normalizeVitest(report, root)).toThrow("duplicate_vitest_file");
  report.testResults.pop();
  report.testResults[0].assertionResults[0].status = "cancelled";
  expect(() => normalizeVitest(report, root)).toThrow("unknown_assertion_status");
});

it.runIf(process.platform === "win32")("refuses report paths on another Windows drive", () => {
  const report = raw();
  const otherDrive = resolve(root)[0].toUpperCase() === "Z" ? "Y" : "Z";
  report.testResults[0].name = `${otherDrive}:\\outside\\test.js`;
  expect(() => normalizeVitest(report, root)).toThrow("invalid_vitest_path");
});

it("compares full Node 24 and records exact intentional skips separately from passes", () => {
  const result = compare();
  expect(result.lanes.map((lane) => lane.status)).toEqual(["compared"]);
  expect(result.fullBaseline).toMatchObject({ status: "available", nodes: [24] });
  expect(result.lanes[0].intentionalSkips).toHaveLength(3);
  expect(result.lanes[0].intentionalSkips.every((skip) => skip.status === "skipped")).toBe(true);
  expect(result.separateRunners[0].status).toBe("unknown");
  expect(result.shadowOnly).toBe(true);
  expect(result.authority).toBe("existing-full-checks");
});

it.each(["base", "head", "candidate", "attempt", "runId", "event", "repository", "node"])(
  "rejects changed independent identity %s",
  (key) => {
    const e = evidence();
    e.identity[key] = typeof e.identity[key] === "number" ? e.identity[key] + 1 : "0".repeat(40);
    expect(compare(e).lanes[0].reasons).toContain("stale_or_malformed_evidence");
  },
);

it("rejects unknown fields, duplicate files and empty claimed discovery", () => {
  const e = evidence();
  e.suite.files.push(e.suite.files[0]);
  expect(() => validateEvidence(e, evidence().identity)).toThrow("duplicate_normalized_file");
  const extra = evidence();
  extra.admission = "passed";
  expect(() => validateEvidence(extra, extra.identity)).toThrow("invalid_evidence_schema");
  expect(
    compare(evidence(), job(), { ...plan(), graphs: [{}, { discoveredVitestFiles: [] }] }).lanes[0].reasons,
  ).toContain("full_discovery_mismatch");
});

it.each(["skips", "todo", "failed", "passed"])(
  "does not accept unexplained skipped/todo/failed/empty assertions: %s",
  (key) => {
    const e = evidence();
    e.suite.files[0][key] = key === "skips" ? [hash("unreviewed")] : key === "passed" ? 0 : 1;
    expect(compare(e).lanes[0].reasons).toContain("unexpected_skip_failure_or_empty_file");
  },
);

it("requires the independently passing retry lane and frozen skipped test source", () => {
  const e = evidence();
  e.retry.files[0].skips = [hash(INTENTIONAL_SKIPS[0].name)];
  expect(compare(e).lanes[0].reasons).toContain("retry_acceptance_not_proven");
  expect(compare(evidence(), job(), plan(), { trusted: "0".repeat(40) }).lanes[0].reasons).toContain(
    "unexpected_skip_failure_or_empty_file",
  );
});

it("records exact reviewed runner skips in full and selected lanes while the trusted source is unchanged", () => {
  const runner = RUNNER_SKIPS[0];
  const listed = { ...file(runner.path), skips: runner.names.map((name) => hash(name)).sort() };
  const full = evidence();
  full.suite.files.push(listed);
  const fullPlan = { ...plan(), graphs: [{}, { discoveredVitestFiles: [...discovered, runner.path].sort() }] };
  const compared = compare(full, job(), fullPlan).lanes[0];
  expect(compared.status).toBe("compared");
  expect(compared.intentionalSkips).toContainEqual({ path: runner.path, reason: runner.reason, status: "skipped" });

  const selected = { ...selectedEvidence(), suite: { success: true, files: [file(ordinary), listed] } };
  const withRunner = {
    ...selectedPlan(),
    wouldRun: { ...selectedPlan().wouldRun, vitestFiles: [ordinary, runner.path] },
  };
  expect(compare(selected, selectedJob(), withRunner).lanes[0].status).toBe("selected_verified");
  const extra = structuredClone(selected);
  extra.suite.files[1].skips = [...listed.skips, hash("an unreviewed skip")].sort();
  expect(compare(extra, selectedJob(), withRunner).lanes[0].reasons).toContain("unexpected_skip_failure_or_empty_file");
  expect(compare(selected, selectedJob(), withRunner, { trusted: "0".repeat(40) }).lanes[0].reasons).toContain(
    "unexpected_skip_failure_or_empty_file",
  );
});

it("retains a seeded failure in an omitted file", () => {
  const e = evidence();
  e.suite.success = false;
  e.suite.files[0] = { ...file(ordinary), status: "failed", passed: 0, failed: 1 };
  const result = compare(e, { ...job(), conclusion: "failure" }, plan(discovered.filter((path) => path !== ordinary)));
  expect(result.lanes[0].omittedFailures).toEqual([ordinary]);
  expect(result.lanes[0].reasons).toContain("failure_in_omitted_file");
  expect(result.lanes[0].status).not.toBe("compared");
});

it.each(["cancelled", "skipped", "failure", null])(
  "records full job outcome %s without claiming a comparison",
  (conclusion) => {
    const result = compare(evidence(), { ...job(), conclusion });
    expect(result.lanes[0].status).toBe(conclusion === "cancelled" ? "cancelled" : "unknown");
  },
);

it("missing artifact, job or required step remains explicit unknown", () => {
  expect(compare(null).lanes[0].reasons).toContain("missing_evidence");
  expect(compare(evidence(), null).lanes[0].reasons).toContain("missing_job");
  const j = job();
  j.steps.pop();
  expect(compare(evidence(), j).lanes[0].reasons).toContain("missing_or_unsuccessful_required_step");
  const e = evidence();
  e.suite = null;
  expect(compare(e).lanes[0].reasons).toContain("missing_suite_report");
});

const run = () => ({
  id: 123,
  run_attempt: 1,
  head_sha: candidate,
  event: "pull_request",
  status: "completed",
  repository: { full_name: source.repository },
  path: ".github/workflows/ci.yml",
  pull_requests: [{ number: 1, base: { sha: candidate }, head: { sha: candidate } }],
});
const event = () => ({ repository: { full_name: source.repository }, workflow_run: run() });
const pr = () => ({
  state: "open",
  base: { sha: candidate, ref: "main", repo: { full_name: source.repository } },
  head: { sha: candidate },
  merge_commit_sha: candidate,
});
it("resolves independent exact PR identities from server metadata", async () => {
  expect(await resolveSource(run(), event(), async () => pr(), repo)).toEqual({
    base: candidate,
    head: candidate,
    candidate,
  });
});
it("resolves a unique immutable commit association when GitHub omits the run PR list", async () => {
  const r = { ...run(), pull_requests: [] };
  const apiRead = async (path) => (path.startsWith("/commits/") ? [{ ...pr(), number: 1 }] : pr());
  expect(await resolveSource(r, { ...event(), workflow_run: r }, apiRead, repo)).toEqual({
    base: candidate,
    head: candidate,
    candidate,
  });
});
it.each([0, 2])("rejects %s matching commit PR associations instead of guessing", async (n) => {
  const r = { ...run(), pull_requests: [] };
  await expect(
    resolveSource(
      r,
      { ...event(), workflow_run: r },
      async () => Array.from({ length: n }, () => ({ ...pr(), number: 1 })),
      repo,
    ),
  ).rejects.toThrow("missing_or_ambiguous_pull_request");
});
it.each(["closed", "moved_head", "moved_base", "missing_candidate"])("rejects stale PR %s", async (mode) => {
  const p = pr();
  if (mode === "closed") p.state = "closed";
  if (mode === "moved_head") p.head.sha = "0".repeat(40);
  if (mode === "moved_base") p.base.sha = "0".repeat(40);
  if (mode === "missing_candidate") p.merge_commit_sha = null;
  await expect(resolveSource(run(), event(), async () => p, repo)).rejects.toThrow("stale_pull_request_identities");
});
it("rejects rerun attempts and unsupported source workflows", async () => {
  await expect(resolveSource({ ...run(), run_attempt: 2 }, event(), async () => pr(), repo)).rejects.toThrow();
  await expect(resolveSource({ ...run(), path: "untrusted.yml" }, event(), async () => pr(), repo)).rejects.toThrow();
});
it("resolves a main push to its exact first parent without guessing workflow_run before", async () => {
  const r = { ...run(), event: "push", head_branch: "main" };
  const result = await resolveSource(
    r,
    { ...event(), workflow_run: r },
    async () => {
      throw new Error("unexpected API");
    },
    repo,
  );
  expect(result).toEqual({
    base: git(repo, ["rev-parse", `${candidate}^1`])
      .toString()
      .trim(),
    head: candidate,
    candidate,
  });
});

function pipelineHistory() {
  // A small data-only history exercises the full adapter and recomputation path.
  // It neither copies the production inventory nor executes any candidate code.
  const dir = temp();
  git(dir, ["init", "--initial-branch=main"]);
  for (const path of [
    ".github/workflows/ci.yml",
    "vitest.config.ts",
    "tools/ci-shadow/record.js",
    "tools/ci-shadow/evidence.js",
    "tools/ci-shadow/execute.js",
    ordinary,
    ...INTENTIONAL_SKIPS.map((skip) => skip.path),
  ]) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(repo, path)));
  }
  const config = ["-c", "user.name=Shadow test", "-c", "user.email=shadow@example.invalid"];
  git(dir, ["add", "."]);
  git(dir, [...config, "commit", "-m", "Synthetic base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  git(dir, [...config, "commit", "--allow-empty", "-m", "Synthetic head"]);
  const trusted = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).toString().trim();
  const merge = git(dir, [...config, "commit-tree", tree, "-p", base, "-p", trusted], "Synthetic advisory candidate\n")
    .toString()
    .trim();
  return { dir, base, trusted, merge };
}

it("rejects prior runner workflow bytes even with exact source identities", async () => {
  const { dir, base, trusted } = pipelineHistory();
  const path = join(dir, ".github/workflows/ci.yml");
  const workflow = readFileSync(path, "utf8");
  expect(workflow).toContain("runs-on: ubuntu-24.04");
  writeFileSync(path, workflow.replaceAll("runs-on: ubuntu-24.04", "runs-on: [self-hosted, linux, x64, homelab]"));
  git(dir, ["add", ".github/workflows/ci.yml"]);
  const tree = git(dir, ["write-tree"]).toString().trim();
  const merge = git(
    dir,
    [
      "-c",
      "user.name=Shadow test",
      "-c",
      "user.email=shadow@example.invalid",
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      trusted,
    ],
    "Synthetic prior runner candidate\n",
  )
    .toString()
    .trim();
  git(dir, ["reset", "--hard", trusted]);
  const r = {
    ...run(),
    head_sha: trusted,
    pull_requests: [{ number: 1, base: { sha: base }, head: { sha: trusted } }],
  };
  const p = { ...pr(), head: { sha: trusted }, base: { ...pr().base, sha: base }, merge_commit_sha: merge };
  const output = temp();
  await expect(
    consume({
      repo: dir,
      out: output,
      event: { ...event(), workflow_run: r },
      trusted,
      apiRead: async (path) => {
        if (path === "/actions/runs/123") return r;
        if (path === "/pulls/1") return p;
        throw new Error("Evidence must not be read for a mismatched runner baseline");
      },
      artifactRead: async () => {
        throw new Error("Artifact must not be read for a mismatched runner baseline");
      },
    }),
  ).rejects.toThrow("unreviewed_evidence_producer_or_runner");
  expect(() => readJSON(join(output, "plan.json"))).toThrow();
  expect(() => readJSON(join(output, "comparison.json"))).toThrow();
});

it.each(["complete", "stale_after_read", "malformed_artifact"])(
  "complete consumer pipeline preserves %s evidence",
  async (mode) => {
    const { dir, base, trusted, merge } = pipelineHistory();
    const r = {
      ...run(),
      head_sha: trusted,
      conclusion: "success",
      pull_requests: [{ number: 1, base: { sha: base }, head: { sha: trusted } }],
    };
    const p = { ...pr(), head: { sha: trusted }, base: { ...pr().base, sha: base }, merge_commit_sha: merge };
    const full = createPlan({ repo: dir, base, head: trusted, candidate: merge });
    const output = temp();
    let reads = 0;
    const apiRead = async (path) => {
      if (path === "/actions/runs/123") {
        reads++;
        return mode === "stale_after_read" && reads === 2 ? { ...r, run_attempt: 2 } : r;
      }
      if (path === "/pulls/1") return p;
      if (path.endsWith("/jobs"))
        return {
          total_count: 1,
          jobs: [24].map((node) => ({ ...job(), name: `check (node ${node})`, run_id: 123, run_attempt: 1 })),
        };
      if (path.endsWith("/artifacts"))
        return {
          total_count: 1,
          artifacts: [24].map((node) => ({ id: node, name: `ci-full-evidence-123-1-node-${node}` })),
        };
      throw new Error("unexpected_api_path");
    };
    const artifactRead = async (_artifact, identity) => {
      const e = evidence(identity.node);
      e.identity = identity;
      e.suite.files = full.graphs[1].discoveredVitestFiles.map((path) => {
        const skip = INTENTIONAL_SKIPS.find((policy) => policy.path === path);
        return skip ? { ...file(path), passed: 0, skips: [hash(skip.name)] } : file(path);
      });
      if (mode === "malformed_artifact") e.identity = { ...identity, candidate: "0".repeat(40) };
      return e;
    };
    const promise = consume({
      repo: dir,
      out: output,
      event: { ...event(), workflow_run: r },
      trusted,
      apiRead,
      artifactRead,
    });
    if (mode === "stale_after_read") {
      await expect(promise).rejects.toThrow("stale_or_invalid_source_run");
      expect(() => readJSON(join(output, "plan.json"))).toThrow();
      expect(() => readJSON(join(output, "comparison.json"))).toThrow();
    } else {
      const comparison = await promise;
      expect(comparison.identities.candidate).toBe(merge);
      expect(comparison.lanes.map((lane) => lane.status)).toEqual(mode === "complete" ? ["compared"] : ["unknown"]);
      expect(comparison.artifacts).toEqual([
        { node: 24, state: mode === "complete" ? "validated" : "unknown_or_stale" },
      ]);
      expect(readJSON(join(output, "plan.json"))).toEqual(full);
      expect(readJSON(join(output, "comparison.json"))).toEqual(comparison);
    }
  },
);

it("publishes complete JSON atomically and refuses linked/oversized inputs", () => {
  const dir = temp();
  const path = join(dir, "report.json");
  atomicJSON(path, { real: true });
  expect(readJSON(path)).toEqual({ real: true });
  expect(() => readJSON(path, 2)).toThrow("unsafe_or_oversized_json");
  const link = join(dir, "link");
  if (process.platform === "win32") symlinkSync(temp(), link, "junction");
  else symlinkSync(path, link, "file");
  expect(() => readJSON(link)).toThrow("unsafe_or_oversized_json");
});

it.each(["valid", "traversal", "extra", "symlink", "oversized", "invalid_json"])("bounded ZIP intake: %s", (mode) => {
  const dir = temp();
  const archive = join(dir, "report.zip");
  execFileSync("python3", [
    "-c",
    `import sys, zipfile\nmode=sys.argv[2]\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n name='../escape.json' if mode=='traversal' else 'evidence.json'\n info=zipfile.ZipInfo(name)\n if mode=='symlink': info.external_attr=0o120777 << 16\n z.writestr(info, 'x'*(4194305) if mode=='oversized' else 'broken' if mode=='invalid_json' else '{"real":true}')\n if mode=='extra': z.writestr('extra.js', 'untrusted')`,
    archive,
    mode,
  ]);
  const read = () =>
    execFileSync("python3", [fileURLToPath(new URL("../ci-shadow/read-artifact.py", import.meta.url)), archive], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (mode === "valid") expect(JSON.parse(read())).toEqual({ real: true });
  else expect(read).toThrow();
});

it("summary emits bounded trusted fields without artifact text or admission claims", () => {
  expect(summary(compare())).toContain("existing CI checks remain authoritative");
  expect(summary({ status: "unknown", reason: "secret" })).not.toContain("secret");
});

it("forwards workflow reporter options through pinned pnpm's explicit run command", () => {
  const dir = temp();
  const output = join(dir, "arguments.json");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "shadow-forwarding-test",
      type: "module",
      packageManager: "pnpm@12.4.2",
      scripts: { test: "node capture.js", "test:coverage": "node capture.js --coverage" },
    }),
  );
  writeFileSync(
    join(dir, "capture.js"),
    `import fs from 'node:fs'; fs.writeFileSync(process.env.SHADOW_ARGS,JSON.stringify(process.argv.slice(2)));`,
  );
  const args = ["--reporter=default", "--reporter=json", "--outputFile.json=/synthetic/report.json"];
  // The global Windows pnpm shim is a .cmd, which execFile cannot launch.
  // Use its installed native executable directly, without a shell or downloads.
  const pnpm =
    process.platform === "win32"
      ? ((process.env.PATH ?? "")
          .split(delimiter)
          .map((entry) => join(entry, "node_modules", "pnpm", "pnpm.exe"))
          .find((entry) => existsSync(entry)) ?? "pnpm.exe")
      : "pnpm";
  for (const script of ["test", "test:coverage"]) {
    execFileSync(pnpm, ["run", script, ...args], {
      cwd: dir,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SHADOW_ARGS: output },
    });
    expect(readJSON(output)).toEqual(script === "test" ? args : ["--coverage", ...args]);
  }
});

it("keeps existing full checks and limits while isolating workflow_run from candidate execution", () => {
  const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  const consumer = readFileSync(join(repo, ".github/workflows/ci-shadow.yml"), "utf8");
  for (const invariant of [
    "node: [24]",
    "max-parallel: 1",
    "fail-fast: false",
    "timeout-minutes: 3",
    'ORCA_MCP_REQUIRE_PRODUCTION: "1"',
    'ORCA_RETRY_INTEGRATION: "1"',
    "pnpm install --frozen-lockfile",
    "node packages/cli/dist/main.js demo",
    "needs.changes.outputs.code != 'false'",
  ])
    expect(ci).toContain(invariant);
  expect(ci.match(/--reporter=default --reporter=json/g)).toHaveLength(2);
  expect(ci).toContain("run: pnpm run test:coverage --reporter=default --reporter=json");
  const coverageStep = ci.split("- name: Test with coverage\n")[1].split("\n      # Both still run")[0];
  expect(coverageStep).toContain(
    "if: needs.changes.outputs.code != 'false' && steps.selection.outputs.mode != 'targeted'",
  );
  expect(coverageStep).not.toContain("continue-on-error");
  expect(coverageStep).toContain('ORCA_MCP_REQUIRE_PRODUCTION: "1"');
  expect(ci).not.toContain("matrix.node != 24");
  expect(ci).not.toContain("name: Test\n");
  for (const name of ["Typecheck", "Design tokens are current", "Format", "Lint", "Build", "Test with coverage"])
    expect(ci).toContain(`name: ${name}`);
  expect(ci).not.toContain("actions: write");
  expect(consumer).toContain("ref: ${{ github.sha }}");
  expect(consumer).toContain("persist-credentials: false");
  expect(consumer).not.toContain("pull_request_target");
  expect(consumer).not.toContain("head_sha }}");
});
