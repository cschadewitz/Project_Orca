/**
 * One git worktree and branch per work item, created on the agent's host via
 * `git worktree add`. Works for remote hosts too because it only uses
 * AgentHost.exec.
 */
import type { AgentHost } from "@orca/agents";
import { OrcaError, type Workspace } from "@orca/core";
import type { ProvisionInput, WorkspaceProvider } from "./provider.js";

export interface GitWorktreeProviderOptions {
  host: AgentHost;
  /** Path of the main checkout on the host. */
  repo: string;
  /** Directory under which worktrees are created. Defaults to `<repo>/../<repo-name>-worktrees`. */
  worktreeRoot?: string;
  baseBranch?: string;
  branchPrefix?: string;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly name = "git-worktree";
  constructor(private readonly o: GitWorktreeProviderOptions) {}

  async provision(input: ProvisionInput): Promise<Workspace> {
    const host = this.o.host;
    // Runs without a work item (e.g. the program run itself) work in the main checkout.
    if (!input.workItem) return input.parent ?? { hostId: host.id, cwd: this.o.repo, repo: this.o.repo, provider: this.name };
    const slug = input.workItem.slug;
    const branch = `${this.o.branchPrefix ?? "orca/"}${slug}`;
    const root = this.o.worktreeRoot ?? host.joinPath(this.o.repo, "..", `${this.o.repo.split(/[\\/]/).filter(Boolean).pop() ?? "repo"}-worktrees`);
    const dir = host.joinPath(root, slug);
    if (await host.fs.exists(dir)) return { hostId: host.id, cwd: dir, repo: this.o.repo, branch, provider: this.name };
    await host.fs.mkdirp(root);
    const base = this.o.baseBranch ?? "main";
    const exists = await host.exec(`git rev-parse --verify --quiet refs/heads/${branch}`, { cwd: this.o.repo });
    const cmd = exists.code === 0 ? `git worktree add ${q(dir)} ${q(branch)}` : `git worktree add -b ${q(branch)} ${q(dir)} ${q(base)}`;
    const r = await host.exec(cmd, { cwd: this.o.repo });
    if (r.code !== 0) throw new OrcaError("INTERNAL", `git worktree add failed: ${r.stderr.trim()}`, { cmd, dir });
    return { hostId: host.id, cwd: dir, repo: this.o.repo, branch, provider: this.name };
  }

  async release(ws: Workspace): Promise<void> {
    if (ws.provider !== this.name || !ws.repo) return;
    await this.o.host.exec(`git worktree remove --force ${q(ws.cwd)}`, { cwd: ws.repo });
  }
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
