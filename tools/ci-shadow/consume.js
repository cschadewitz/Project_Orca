/** Read-only workflow_run consumer: trusted tools, immutable Git data, bounded JSON only. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { atomicJSON, CI_NODES, compareFullEvidence, readJSON, validateEvidence } from "./evidence.js";
import { createPlan, validatePlan } from "./selector.js";
import { git, hash } from "./git.js";

const REPO = "cschadewitz/Project_Orca";
const prefix = `https://api.github.com/repos/${REPO}`;
const SHA = /^[a-f0-9]{40}$/;
const archiveLimit = 5 * 1024 * 1024;
const jsonLimit = 4 * 1024 * 1024;

async function boundedResponse(response, limit) {
  if (!response.ok) throw new Error("api_or_artifact_unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("oversized_response");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function api(path) {
  const response = await fetch(prefix + path, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30000),
  });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedResponse(response, jsonLimit)));
}

async function list(path, key) {
  const entries = [];
  for (let page = 1; page <= 10; page++) {
    const data = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count)) throw new Error("invalid_api_inventory");
    entries.push(...data[key]);
    if (entries.length === data.total_count) return entries;
    if (entries.length > data.total_count || data[key].length < 100) throw new Error("truncated_api_inventory");
  }
  throw new Error("oversized_api_inventory");
}

export async function resolveSource(run, event, apiRead, repo) {
  if (
    run.repository?.full_name !== REPO ||
    run.path !== ".github/workflows/ci.yml" ||
    run.status !== "completed" ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !SHA.test(run.head_sha) ||
    !["pull_request", "push"].includes(run.event) ||
    event.workflow_run?.id !== run.id ||
    event.workflow_run?.run_attempt !== run.run_attempt ||
    event.workflow_run?.head_sha !== run.head_sha ||
    event.repository?.full_name !== REPO
  )
    throw new Error("stale_or_invalid_source_run");
  if (run.event === "push") {
    if (run.head_branch !== "main") throw new Error("unsupported_push_branch");
    const base = git(repo, ["rev-parse", `${run.head_sha}^1`])
      .toString()
      .trim();
    if (!SHA.test(base)) throw new Error("missing_push_parent");
    return { base, head: run.head_sha, candidate: run.head_sha };
  }
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length > 1)
    throw new Error("missing_or_ambiguous_pull_request");
  let association = run.pull_requests[0];
  if (!association) {
    // GitHub may omit PR associations on workflow runs (notably private repos).
    // Resolve the immutable commit's server-side associations, never a branch name
    // or artifact-provided PR number; require a complete, unique open matching head.
    const matches = [];
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const prs = await apiRead(`/commits/${run.head_sha}/pulls?per_page=100&page=${page}`);
      if (!Array.isArray(prs) || prs.length > 100) throw new Error("invalid_pull_request_inventory");
      matches.push(
        ...prs.filter(
          (pr) =>
            pr.state === "open" &&
            pr.head?.sha === run.head_sha &&
            pr.base?.ref === "main" &&
            pr.base?.repo?.full_name === REPO,
        ),
      );
      if (prs.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete || matches.length !== 1) throw new Error("missing_or_ambiguous_pull_request");
    association = matches[0];
  }
  const number = association.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid_pull_request_number");
  const pr = await apiRead(`/pulls/${number}`);
  // Moving or closed PRs cannot authenticate a superseded merge ref. Retain unknown.
  if (
    pr.state !== "open" ||
    pr.base?.repo?.full_name !== REPO ||
    pr.base?.ref !== "main" ||
    pr.head?.sha !== run.head_sha ||
    !SHA.test(pr.base.sha) ||
    !SHA.test(pr.merge_commit_sha) ||
    association.head?.sha !== pr.head.sha ||
    association.base?.sha !== pr.base.sha
  )
    throw new Error("stale_pull_request_identities");
  return { base: pr.base.sha, head: pr.head.sha, candidate: pr.merge_commit_sha };
}

async function readArtifact(artifact, identity) {
  if (
    artifact.expired ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > archiveLimit ||
    artifact.workflow_run?.id !== identity.runId ||
    artifact.workflow_run?.head_sha !== identity.head ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")
  )
    throw new Error("unsafe_or_stale_artifact");
  const response = await fetch(`${prefix}/actions/artifacts/${artifact.id}/zip`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  const archive = await boundedResponse(response, archiveLimit);
  if (`sha256:${hash(archive)}` !== artifact.digest) throw new Error("artifact_digest_mismatch");
  const dir = mkdtempSync(join(tmpdir(), "orca-shadow-artifact-"));
  try {
    const path = join(dir, "report.zip");
    writeFileSync(path, archive, { flag: "wx" });
    const raw = execFileSync("python3", [fileURLToPath(new URL("./read-artifact.py", import.meta.url)), path], {
      maxBuffer: jsonLimit,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return validateEvidence(JSON.parse(raw.toString("utf8")), identity);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function consume({ repo, out, event, trusted, apiRead = api, artifactRead = readArtifact }) {
  if (!SHA.test(trusted) || git(repo, ["rev-parse", "HEAD"]).toString().trim() !== trusted)
    throw new Error("untrusted_tool_checkout");
  const runId = event.workflow_run?.id;
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error("invalid_source_run_id");
  const run = await apiRead(`/actions/runs/${runId}`);
  const identities = await resolveSource(run, event, apiRead, repo);
  // Fetch only exact server-resolved object identities. Never check out candidate files.
  for (const sha of new Set(Object.values(identities))) {
    if (!SHA.test(sha)) throw new Error("invalid_commit_identity");
    try {
      if (git(repo, ["cat-file", "-t", sha]).toString().trim() !== "commit") throw new Error("missing_commit");
    } catch {
      // Private repository read: reuse this job's ephemeral read-only token without
      // persisting credentials or passing a secret through command arguments.
      execFileSync(
        "git",
        [
          "--no-replace-objects",
          "-c",
          "credential.helper=",
          "fetch",
          "--no-tags",
          `https://github.com/${REPO}.git`,
          sha,
        ],
        {
          cwd: repo,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`,
          },
        },
      );
    }
  }
  if (run.event === "pull_request") {
    const parents = git(repo, ["show", "-s", "--format=%P", identities.candidate]).toString().trim();
    if (parents !== `${identities.base} ${identities.head}`) throw new Error("mismatched_merge_candidate_parents");
  }
  // A changed producer, test invocation or discovery config needs its own reviewed
  // trusted baseline. A workflow_run artifact cannot authenticate changed runner code.
  for (const path of [
    ".github/workflows/ci.yml",
    "vitest.config.ts",
    "tools/ci-shadow/record.js",
    "tools/ci-shadow/evidence.js",
    "tools/ci-shadow/execute.js",
  ]) {
    if (
      !git(repo, ["rev-parse", `${trusted}:${path}`]).equals(
        git(repo, ["rev-parse", `${identities.candidate}:${path}`]),
      )
    )
      throw new Error("unreviewed_evidence_producer_or_runner");
  }
  const source = { repository: REPO, runId: run.id, attempt: run.run_attempt, event: run.event };
  const input = { repo, ...identities, forceFull: false };
  const plan = createPlan(input);
  validatePlan(plan, input); // Complete independent recomputation before any publication.
  const jobs = await listWith(apiRead, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs");
  const artifacts = await listWith(apiRead, `/actions/runs/${run.id}/artifacts`, "artifacts");
  const lanes = {};
  for (const node of CI_NODES) {
    const matchingJobs = jobs.filter(
      (job) => job.name === `check (node ${node})` && job.run_id === run.id && job.run_attempt === run.run_attempt,
    );
    const named = artifacts.filter(
      (artifact) => artifact.name === `ci-full-evidence-${run.id}-${run.run_attempt}-node-${node}`,
    );
    let evidence = null;
    let artifactState = "missing";
    if (named.length === 1) {
      try {
        const identity = { ...source, ...identities, node };
        evidence = validateEvidence(await artifactRead(named[0], identity), identity);
        artifactState = "validated";
      } catch {
        artifactState = "unknown_or_stale";
      }
    } else if (named.length > 1) artifactState = "ambiguous";
    lanes[node] = { evidence, job: matchingJobs.length === 1 ? matchingJobs[0] : null, artifactState };
  }
  // The source attempt and live PR identities must still match after reading artifacts.
  const after = await apiRead(`/actions/runs/${runId}`);
  const refreshed = await resolveSource(after, event, apiRead, repo);
  if (JSON.stringify(refreshed) !== JSON.stringify(identities)) throw new Error("stale_identities_after_read");
  const comparison = compareFullEvidence(plan, lanes, { repo, trusted, source });
  comparison.source = source;
  comparison.sourceConclusion = [
    "success",
    "failure",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "neutral",
  ].includes(run.conclusion)
    ? run.conclusion
    : "unknown";
  comparison.artifacts = CI_NODES.map((node) => ({ node, state: lanes[node].artifactState }));
  atomicJSON(join(out, "plan.json"), plan);
  atomicJSON(join(out, "comparison.json"), comparison);
  return comparison;
}

async function listWith(apiRead, path, key) {
  if (apiRead === api) return list(path, key);
  const data = await apiRead(path);
  if (!Array.isArray(data[key]) || data[key].length !== data.total_count) throw new Error("truncated_api_inventory");
  return data[key];
}

export function summary(comparison) {
  if (comparison.status === "unknown")
    return "Shadow comparison: **unknown**. No authenticated same-candidate evidence was accepted. Existing CI checks remain authoritative.\n";
  return (
    [
      "Shadow comparison is advisory; existing CI checks remain authoritative.",
      `Candidate: \`${comparison.identities.candidate}\`; base: \`${comparison.identities.base}\`; head: \`${comparison.identities.head}\`.`,
      `Proposed tier: **${comparison.wouldRun.tier}**; ${comparison.wouldRun.selected}/${comparison.wouldRun.discovered} Vitest files.`,
      ...comparison.lanes.map(
        (lane) =>
          `Node ${lane.node}: **${lane.status}**; ${lane.intentionalSkips.length} explicitly recorded intentional skips; ${lane.omittedFailures.length} omitted failures.`,
      ),
      `Full same-candidate baseline: **${comparison.fullBaseline?.status ?? "unknown"}**.`,
      "Browser/native runners: unknown (outside the CI workflow). Selected execution is partial; a full baseline is reported only when actually run on this candidate.",
    ].join("\n\n") + "\n"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.env.SHADOW_OUTPUT;
  let comparison;
  try {
    comparison = await consume({
      repo: process.cwd(),
      out,
      event: readJSON(process.env.GITHUB_EVENT_PATH),
      trusted: process.env.GITHUB_SHA,
    });
  } catch (error) {
    // Deliberately exclude exception/API/artifact text from logs and summaries.
    const reasons = [
      "stale_or_invalid_source_run",
      "missing_push_parent",
      "missing_or_ambiguous_pull_request",
      "stale_pull_request_identities",
      "mismatched_merge_candidate_parents",
      "unreviewed_evidence_producer_or_runner",
      "stale_identities_after_read",
    ];
    comparison = {
      artifact: "orca-ci-shadow-comparison",
      schemaVersion: 1,
      shadowOnly: true,
      authority: "existing-full-checks",
      status: "unknown",
      reason: reasons.includes(error.message) ? error.message : "source_identity_plan_or_evidence_unavailable",
    };
    atomicJSON(join(out, "comparison.json"), comparison);
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(comparison));
}
