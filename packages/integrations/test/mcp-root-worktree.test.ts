/** Disposable compiled MCP acceptance; no live configuration or credentials. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProductionFixture, accepted, refused } from "./mcp-operator-production-fixture.js";
import { ReplayDiagnostics } from "./mcp-replay-diagnostics.js";

let fixture: ProductionFixture | undefined;
afterEach(async () => {
  await fixture?.close();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

it("a six-grant owned-only MCP client admits isolated direct roots without plan associations", async () => {
  const f = (fixture = await ProductionFixture.create());
  await f.stop();
  const repo = join(f.dir, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
  const configPath = join(f.dir, "orca.config.yaml");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.workspace = { provider: "git-worktree", repo: "repo", worktreeRoot: "trees", isolateRoots: true };
  await writeFile(configPath, JSON.stringify(config));
  await f.boot();
  const issued = await f.issue({
    principal: "isolated-root-client",
    permissions: ["runs.read", "artifacts.read", "workflows.read", "runs.start", "runs.control", "inputs.answer"],
    scope: { workflows: ["gate"], runs: "owned" },
  });
  const peer = await f.connect("stdio", issued.token);
  const first = await f.start(peer, "gate", "first-root");
  const second = await f.start(peer, "gate", "second-root");
  expect(first.runId).not.toBe(second.runId);
  const receiptDir = join(repo, ".git", "orca-root-workspaces");
  expect((await readdir(receiptDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  const paths = new Set<string>();
  for (const runId of [first.runId, second.runId]) {
    const receipt = JSON.parse(await readFile(join(receiptDir, `${runId}.json`), "utf8")) as {
      path: string;
      branch: string;
      baseCommit: string;
    };
    paths.add(receipt.path);
    expect(receipt.path).toBe(join(f.dir, "trees", runId));
    expect(git(receipt.path, "rev-parse", "HEAD")).toBe(receipt.baseCommit);
    expect(git(receipt.path, "branch", "--show-current")).toBe(receipt.branch);
    await f.pending(peer, runId);
    expect((await f.events(runId)).filter((event) => event.type === "run.created")).toHaveLength(1);
  }
  expect(paths.size).toBe(2);
  expect(accepted(await f.mutation(peer, "operator.admitRun", first.params))).toEqual({
    ...first.receipt,
    replayed: true,
  });
  await refused(
    peer,
    "start_workflow",
    {
      ...first.params,
      command: { ...first.params.command, requestId: "unassociated" },
      retry: { idempotencyKey: "association" },
    },
    "AUTH_FORBIDDEN",
  );
  const diagnostics = new ReplayDiagnostics();
  const previousDaemon = f.daemon;
  try {
    await diagnostics.measure("stop", () => f.stop());
    await diagnostics.measure("boot", () => f.boot());
    const restarted = await diagnostics.measure("connect", () =>
      f.connect("stdio", issued.token, f.endpoint, diagnostics.capture),
    );
    const replay = accepted(
      await diagnostics.measure("replay", () =>
        f.mutation(restarted, "operator.admitRun", { ...first.params, target: restarted.target }),
      ),
    );
    expect(replay).toEqual({ ...first.receipt, replayed: true });
    expect((await readdir(receiptDir)).filter((name) => name.endsWith(".json"))).toHaveLength(2);
  } catch (error) {
    console.error(
      "MCP admission restart failure",
      JSON.stringify(
        await diagnostics
          .evidence(f, previousDaemon, first.receipt.operationId, first.runId)
          .then((evidence) => ({ ...evidence, fixtureWaits: f.progress.snapshot() }))
          .catch(() => ({ unavailable: true })),
      ),
    );
    throw error;
  }
});
