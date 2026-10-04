/** Local Linux root isolation. A pending receipt is evidence, never permission to retry Git. */
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalHost } from "@orca/agents";
import { OrcaError, type Workspace } from "@orca/core";
import { z } from "zod";
import type { GitWorktreeProviderOptions } from "./git-worktree.js";
import type { ProvisionInput } from "./provider.js";

const exec = promisify(execFile);
const Receipt = z.strictObject({
  version: z.literal(1),
  runId: z.string(),
  repo: z.string(),
  commonDir: z.string(),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string(),
  path: z.string(),
});
type Receipt = z.infer<typeof Receipt>;
const refuse = () =>
  new OrcaError("RUN_STATE", "Owned root workspace is unavailable; inspect its original provisioning receipt");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Check each existing component, including dangling symlinks, before mkdir or Git. */
async function noSymlinks(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await noSymlinks(parent);
  if (await exists(path)) {
    if ((await lstat(path)).isSymbolicLink()) throw refuse();
    if ((await realpath(path)) !== path) throw refuse();
  }
}

/** Exclusive, durable reservation. A torn write also blocks reuse, retaining evidence. */
async function publish(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class OwnedRootWorktree {
  constructor(private readonly o: GitWorktreeProviderOptions) {}

  private async identity(runId: string) {
    if (
      !this.o.isolateRoots ||
      !(this.o.host instanceof LocalHost) ||
      process.platform !== "linux" ||
      !/^run_(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[0-9A-HJKMNP-TV-Z]{26})$/.test(runId)
    )
      throw refuse();
    const repo = resolve(this.o.repo);
    const root = resolve(this.o.worktreeRoot ?? join(dirname(repo), `${basename(repo)}-worktrees`));
    const path = join(root, runId);
    const branch = `${this.o.branchPrefix ?? "orca/"}roots/${runId}`;
    await noSymlinks(repo);
    await noSymlinks(root);
    if ((await git(repo, "rev-parse", "--show-toplevel")) !== repo) throw refuse();
    await git(repo, "check-ref-format", `refs/heads/${branch}`);
    const commonDir = await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    await noSymlinks(commonDir);
    const receipts = join(commonDir, "orca-root-workspaces");
    await noSymlinks(receipts);
    return { repo, root, path, branch, commonDir, receipts, receiptPath: join(receipts, `${runId}.json`) };
  }

  async provision(input: ProvisionInput): Promise<Workspace> {
    const identity = await this.identity(input.runId);
    const { repo, root, path, branch, commonDir, receipts, receiptPath } = identity;
    // Freeze before any external Git mutation; the receipt is the only source on retry.
    if (await exists(receiptPath)) {
      const receipt = await this.readReceipt(input.runId);
      const workspace = this.workspace(receipt);
      await this.validate(workspace);
      return workspace;
    }
    const baseCommit = await git(
      repo,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${this.o.baseBranch ?? "main"}^{commit}`,
    );
    const receipt = Receipt.parse({ version: 1, runId: input.runId, repo, commonDir, baseCommit, branch, path });
    if (await exists(path)) throw refuse();
    if ((await git(repo, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)).length) throw refuse();
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await publish(receiptPath, receipt);
    // The reservation is not durable until its directory entry in the Git common
    // directory is durable too. Failure retains evidence and must precede Git effects.
    const parent = await open(commonDir, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    // From here every failure retains the reservation. Never add again without a ready marker.
    await mkdir(root, { recursive: true });
    await noSymlinks(path);
    if (await exists(path)) throw refuse();
    await git(repo, "worktree", "add", "-b", branch, "--", path, baseCommit);
    const gitDir = await this.registration(receipt, true);
    await publish(`${receiptPath}.ready`, { gitDir });
    return this.workspace(receipt);
  }

  private workspace(receipt: Receipt): Workspace {
    return {
      hostId: this.o.host.id,
      cwd: receipt.path,
      repo: receipt.repo,
      branch: receipt.branch,
      provider: "git-worktree",
      rootProvisioning: { runId: receipt.runId, baseCommit: receipt.baseCommit },
    };
  }

  private async readReceipt(runId: string): Promise<Receipt> {
    const identity = await this.identity(runId);
    await noSymlinks(identity.receiptPath);
    const receipt = Receipt.parse(JSON.parse(await readFile(identity.receiptPath, "utf8")));
    if (
      receipt.runId !== runId ||
      receipt.repo !== identity.repo ||
      receipt.commonDir !== identity.commonDir ||
      receipt.branch !== identity.branch ||
      receipt.path !== identity.path
    )
      throw refuse();
    return receipt;
  }

  async validate(workspace: Workspace): Promise<void> {
    if (!workspace.rootProvisioning) throw refuse();
    const receipt = await this.readReceipt(workspace.rootProvisioning.runId);
    if (
      workspace.cwd !== receipt.path ||
      workspace.repo !== receipt.repo ||
      workspace.branch !== receipt.branch ||
      workspace.hostId !== this.o.host.id ||
      workspace.provider !== "git-worktree" ||
      workspace.rootProvisioning.baseCommit !== receipt.baseCommit
    )
      throw refuse();
    const { receiptPath } = await this.identity(receipt.runId);
    await noSymlinks(`${receiptPath}.ready`);
    const ready = z
      .strictObject({ gitDir: z.string() })
      .parse(JSON.parse(await readFile(`${receiptPath}.ready`, "utf8")));
    if ((await this.registration(receipt, false)) !== ready.gitDir) throw refuse();
  }

  private async registration(receipt: Receipt, pristine: boolean): Promise<string> {
    await noSymlinks(receipt.path);
    const dotGit = join(receipt.path, ".git");
    await noSymlinks(dotGit);
    if (!(await lstat(dotGit)).isFile()) throw refuse();
    if (
      (await git(receipt.path, "rev-parse", "--show-toplevel")) !== receipt.path ||
      (await git(receipt.path, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== receipt.commonDir ||
      (await git(receipt.path, "symbolic-ref", "HEAD")) !== `refs/heads/${receipt.branch}`
    )
      throw refuse();
    const head = await git(receipt.path, "rev-parse", "HEAD");
    const entries = (await git(receipt.repo, "worktree", "list", "--porcelain", "-z")).split("\0\0");
    const registered = entries.filter((entry) => entry.split("\0").includes(`worktree ${receipt.path}`));
    if (
      registered.length !== 1 ||
      !registered[0]!.split("\0").includes(`branch refs/heads/${receipt.branch}`) ||
      !registered[0]!.split("\0").includes(`HEAD ${head}`)
    )
      throw refuse();
    if (pristine && head !== receipt.baseCommit) throw refuse();
    // Owned edits and descendant commits survive cancellation/resume. Rewritten ancestry does not.
    await git(receipt.path, "merge-base", "--is-ancestor", receipt.baseCommit, head);
    const gitDir = await git(receipt.path, "rev-parse", "--absolute-git-dir");
    await noSymlinks(gitDir);
    return gitDir;
  }
}
