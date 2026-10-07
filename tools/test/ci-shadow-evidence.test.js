/** Exercise genuine-report normalization, SHA binding, skip policy and safe artifact intake. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  atomicJSON,
  compareFullEvidence,
  INTENTIONAL_SKIPS,
  normalizeVitest,
  readJSON,
  RETRY_FILES,
  validateEvidence,
} from "../ci-shadow/evidence.js";
import { resolveSource, summary } from "../ci-shadow/consume.js";
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
const evidence = (node = 22) => ({
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
const job = (node) => ({
  conclusion: "success",
  steps: [
    "Build",
    "Retry admission acceptance (CLI and ACP)",
    node === 24 ? "Test with coverage" : "Test",
    "Smoke test the compiled build",
    ...(node === 24 ? ["Typecheck", "Design tokens are current", "Format", "Lint"] : []),
  ].map((name) => ({ name, conclusion: "success" })),
});
const compare = (e = evidence(), j = job(22), p = plan(), options = {}) =>
  compareFullEvidence(
    p,
    { 22: { evidence: e, job: j }, 24: { evidence: evidence(24), job: job(24) } },
    { repo, trusted: candidate, source, ...options },
  );
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

it("compares both full lanes and records exact intentional skips separately from passes", () => {
  const result = compare();
  expect(result.lanes.map((lane) => lane.status)).toEqual(["compared", "compared"]);
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
    compare(evidence(), job(22), { ...plan(), graphs: [{}, { discoveredVitestFiles: [] }] }).lanes[0].reasons,
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
  expect(compare(evidence(), job(22), plan(), { trusted: "0".repeat(40) }).lanes[0].reasons).toContain(
    "unexpected_skip_failure_or_empty_file",
  );
});

it("retains a seeded failure in an omitted file", () => {
  const e = evidence();
  e.suite.success = false;
  e.suite.files[0] = { ...file(ordinary), status: "failed", passed: 0, failed: 1 };
  const result = compare(
    e,
    { ...job(22), conclusion: "failure" },
    plan(discovered.filter((path) => path !== ordinary)),
  );
  expect(result.lanes[0].omittedFailures).toEqual([ordinary]);
  expect(result.lanes[0].reasons).toContain("failure_in_omitted_file");
  expect(result.lanes[0].status).not.toBe("compared");
});

it.each(["cancelled", "skipped", "failure", null])(
  "records full job outcome %s without claiming a comparison",
  (conclusion) => {
    const result = compare(evidence(), { ...job(22), conclusion });
    expect(result.lanes[0].status).toBe(conclusion === "cancelled" ? "cancelled" : "unknown");
  },
);

it("missing artifact, job or required step remains explicit unknown", () => {
  expect(compare(null).lanes[0].reasons).toContain("missing_evidence");
  expect(compare(evidence(), null).lanes[0].reasons).toContain("missing_job");
  const j = job(22);
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

it("publishes complete JSON atomically and refuses symlink/oversized inputs", () => {
  const dir = temp();
  const path = join(dir, "report.json");
  atomicJSON(path, { real: true });
  expect(readJSON(path)).toEqual({ real: true });
  expect(() => readJSON(path, 2)).toThrow("unsafe_or_oversized_json");
  execFileSync("ln", ["-s", path, join(dir, "link.json")]);
  expect(() => readJSON(join(dir, "link.json"))).toThrow("unsafe_or_oversized_json");
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

it("keeps existing full checks and limits while isolating workflow_run from candidate execution", () => {
  const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  const consumer = readFileSync(join(repo, ".github/workflows/ci-shadow.yml"), "utf8");
  for (const invariant of [
    "node: [22, 24]",
    "max-parallel: 1",
    "fail-fast: false",
    "timeout-minutes: 3",
    'ORCA_MCP_REQUIRE_PRODUCTION: "1"',
    'ORCA_RETRY_INTEGRATION: "1"',
    "pnpm install --frozen-lockfile",
    "node packages/cli/dist/main.js demo",
    "needs.changes.outputs.code == 'true'",
  ])
    expect(ci).toContain(invariant);
  expect(ci.match(/--reporter=default --reporter=json/g)).toHaveLength(3);
  expect(ci).not.toContain("actions: write");
  expect(consumer).toContain("ref: ${{ github.sha }}");
  expect(consumer).toContain("persist-credentials: false");
  expect(consumer).not.toContain("pull_request_target");
  expect(consumer).not.toContain("head_sha }}");
});
