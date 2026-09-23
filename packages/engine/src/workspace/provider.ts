/**
 * WorkspaceProvider - decides *where* a run's agents work.
 *
 * The provider is asked once per run (child runs inherit the parent's workspace
 * unless a work item asks for its own). Implementations: local directory,
 * git worktree per work item (below), Kepler task worktrees, T3 Code threads
 * (see @orca/integrations).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OrcaError, type Request, type WorkItem, type Workspace } from "@orca/core";

const execFileAsync = promisify(execFile);

export interface ProvisionInput {
  runId: string;
  workflowId: string;
  request?: Request | undefined;
  workItem?: WorkItem | undefined;
  parent?: Workspace | undefined;
}

export interface WorkspaceProvider {
  readonly name: string;
  provision(input: ProvisionInput): Promise<Workspace>;
  /** Optional cleanup hook (e.g. remove worktree) - never called automatically. */
  release?(workspace: Workspace): Promise<void>;
}

/** Branch prefix shared with GitWorktreeProvider, so a work item's branch has one name whichever provider made it. */
export const WORK_ITEM_BRANCH_PREFIX = "orca/";

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: (x.stdout ?? "").trim(), err: (x.stderr ?? x.message ?? "").trim() };
  }
}

/**
 * Runs work in one shared directory. When that directory is a git checkout and the run
 * is for a work item, the provider checks out `orca/<slug>` (creating it from the current
 * HEAD if needed) so the branch an agent commits to is ORCA's choice, not a side effect of
 * the previous run, and records the branch it replaced as `previousBranch` (#139). The
 * previous branch is not restored: `release()` is never called by the orchestrator.
 */
export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly name = "local";
  constructor(
    private readonly cwd: string,
    private readonly hostId = "local",
  ) {}
  async provision(input: ProvisionInput): Promise<Workspace> {
    const base: Workspace = input.parent ?? { hostId: this.hostId, cwd: this.cwd, provider: this.name };
    if (!input.workItem) return base;
    const cwd = base.cwd;
    if (!(await git(cwd, ["rev-parse", "--is-inside-work-tree"])).ok) return base;
    const branch = `${WORK_ITEM_BRANCH_PREFIX}${input.workItem.slug}`;
    const head = await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    // A detached HEAD is recorded as the commit it points at.
    const current = head.ok && head.out ? head.out : (await git(cwd, ["rev-parse", "HEAD"])).out;
    if (current === branch) return { ...base, branch };
    const exists = (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    const args = exists ? ["checkout", branch] : ["checkout", "-b", branch];
    const r = await git(cwd, args);
    if (!r.ok)
      throw new OrcaError("INTERNAL", `git checkout of ${branch} failed: ${r.err}`, {
        cwd,
        cmd: `git ${args.join(" ")}`,
      });
    return { ...base, branch, ...(current ? { previousBranch: current } : {}) };
  }
}
