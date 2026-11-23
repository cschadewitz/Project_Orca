/**
 * One git worktree and branch per work item, created on the agent's host via
 * `git worktree add`. Works for remote hosts too because it only uses
 * AgentHost.exec.
 */
import { type AgentHost, shellQuote } from "@orca/agents";
import { OrcaError, type Workspace } from "@orca/core";
import { gitRefRefusal, type ProvisionInput, WORK_ITEM_BRANCH_PREFIX, type WorkspaceProvider } from "./provider.js";
import { OwnedRootWorktree } from "./owned-root-worktree.js";

export interface GitWorktreeProviderOptions {
  host: AgentHost;
  /** Path of the main checkout on the host. */
  repo: string;
  /** Directory under which worktrees are created. Defaults to `<repo>/../<repo-name>-worktrees`. */
  worktreeRoot?: string;
  baseBranch?: string;
  branchPrefix?: string;
  isolateRoots?: boolean;
  /** The git remote a run's named ref is fetched from (#883). Default `origin`. */
  fetchRemote?: string;
  /**
   * The refs a delegated run may name (#883): fully qualified refs, or prefixes ending in `/*`.
   * Empty or absent, every ref is refused.
   */
  allowedRefs?: readonly string[];
  /** Deadline for each remote Git operation a ref needs. Default 30s to list, 120s to fetch. */
  remoteTimeoutMs?: number;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly name = "git-worktree";
  constructor(private readonly o: GitWorktreeProviderOptions) {}

  /** Only an owned root (`isolateRoots`) takes a named ref: each such run gets its own checkout. */
  async checkRef(ref: string): Promise<string> {
    if (!this.o.isolateRoots)
      throw gitRefRefusal(ref, "the remote's workspace gives runs their own checkout only with isolateRoots");
    return new OwnedRootWorktree(this.o).checkRef(ref);
  }

  async provision(input: ProvisionInput): Promise<Workspace> {
    const host = this.o.host;
    if (input.gitRef && (input.workItem || input.parent || !this.o.isolateRoots))
      throw gitRefRefusal(input.gitRef, "only a root run of an isolateRoots workspace takes a ref");
    if (!input.workItem && !input.parent && this.o.isolateRoots) return new OwnedRootWorktree(this.o).provision(input);
    // Runs without a work item (e.g. the program run itself) work in the main checkout.
    if (!input.workItem)
      return input.parent ?? { hostId: host.id, cwd: this.o.repo, repo: this.o.repo, provider: this.name };
    const slug = input.workItem.slug;
    const branch = `${this.o.branchPrefix ?? WORK_ITEM_BRANCH_PREFIX}${slug}`;
    const root =
      this.o.worktreeRoot ??
      host.joinPath(this.o.repo, "..", `${this.o.repo.split(/[\\/]/).filter(Boolean).pop() ?? "repo"}-worktrees`);
    const dir = host.joinPath(root, slug);
    if (await host.fs.exists(dir)) return { hostId: host.id, cwd: dir, repo: this.o.repo, branch, provider: this.name };
    await host.fs.mkdirp(root);
    const base = this.o.baseBranch ?? "main";
    const exists = await host.exec(`git rev-parse --verify --quiet refs/heads/${shellQuote(branch)}`, {
      cwd: this.o.repo,
    });
    const cmd =
      exists.code === 0
        ? `git worktree add ${shellQuote(dir)} ${shellQuote(branch)}`
        : `git worktree add -b ${shellQuote(branch)} ${shellQuote(dir)} ${shellQuote(base)}`;
    const r = await host.exec(cmd, { cwd: this.o.repo });
    if (r.code !== 0) throw new OrcaError("INTERNAL", `git worktree add failed: ${r.stderr.trim()}`, { cmd, dir });
    return { hostId: host.id, cwd: dir, repo: this.o.repo, branch, provider: this.name };
  }

  async validate(ws: Workspace): Promise<void> {
    if (ws.rootProvisioning) await new OwnedRootWorktree(this.o).validate(ws);
  }

  async release(ws: Workspace): Promise<void> {
    if (ws.rootProvisioning)
      throw new OrcaError(
        "RUN_STATE",
        "Owned root worktrees require explicit reconciliation; automatic removal is refused",
      );
    if (ws.provider !== this.name || !ws.repo) return;
    await this.o.host.exec(`git worktree remove --force ${shellQuote(ws.cwd)}`, { cwd: ws.repo });
  }
}
