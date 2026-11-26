/**
 * A repository pushed to a managed server, used as its workspace (#1235): the settings
 * `hostRepositories` builds for a pushed checkout provision a work item's worktree with the real
 * `GitWorktreeProvider`, after a first push and after a later push of another branch. The
 * "server" is a temporary home on this machine where each command runs as its words.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalHost } from "@orca/agents";
import type { WorkItem } from "@orca/core";
import { GitWorktreeProvider } from "@orca/engine";
import type { CourierTransport } from "@orca/protocol/server-courier";
import {
  bundleRepository,
  hostRepositories,
  localGit,
  pushRepository,
  refsToPush,
} from "@orca/protocol/server-repository";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-pushed-workspace-"));
  dirs.push(dir);
  return dir;
};
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function server() {
  const home = tmp();
  mkdirSync(join(home, ".local/share/orca-server"), { recursive: true });
  const transport: CourierTransport = {
    exec: (command) => {
      const result = spawnSync(command[0]!, command.slice(1), { cwd: home, env, encoding: "utf8" });
      return Promise.resolve({ code: result.status ?? 255, stdout: result.stdout ?? "" });
    },
    upload: (path, remotePath) => {
      copyFileSync(path, remotePath.startsWith("/") ? remotePath : join(home, remotePath));
      return Promise.resolve();
    },
  };
  return { home, transport };
}

async function push(local: string, transport: CourierTransport) {
  const refs = await refsToPush(localGit, local, []);
  const bundle = await bundleRepository(localGit, local, refs);
  try {
    return await pushRepository(transport, bundle, { name: "app", refs });
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
}

/** Provision a work item's worktree from the workspace the server's listing offers. */
async function provision(transport: CourierTransport, slug: string) {
  const [repository] = await hostRepositories(transport);
  const workspace = repository!.workspace!;
  const provider = new GitWorktreeProvider({
    host: new LocalHost({ id: "local", type: "local" }),
    repo: workspace.repo,
    baseBranch: workspace.baseBranch,
    fetchRemote: workspace.fetchRemote,
    allowedRefs: workspace.allowedRefs ?? [],
  });
  return provider.provision({ runId: `run_${slug}`, workflowId: "test", workItem: { slug } as WorkItem });
}

// Real git on a POSIX home standing in for the server, as in the protocol's push tests.
it.skipIf(process.platform === "win32")(
  "provisions a work item's worktree after a first push and after a later push of another branch",
  async () => {
    const local = tmp();
    git(local, "init", "-q", "-b", "main");
    writeFileSync(join(local, "README.md"), "one\n");
    git(local, "add", ".");
    git(local, "commit", "-q", "-m", "one");
    const { transport } = server();
    await push(local, transport);
    const first = await provision(transport, "first");
    expect(git(first.cwd, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "main"));

    // Only a new branch this time: the bare repository's HEAD names it, the checkout stays on main.
    git(local, "checkout", "-q", "-b", "feature");
    writeFileSync(join(local, "README.md"), "feature\n");
    git(local, "commit", "-q", "-am", "feature");
    const pushed = await push(local, transport);
    expect(pushed.checkoutState).toMatchObject({ kind: "kept", usable: true });
    const second = await provision(transport, "second");
    expect(git(second.cwd, "rev-parse", "HEAD")).toBe(git(local, "rev-parse", "main"));
  },
);
