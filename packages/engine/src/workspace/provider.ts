/**
 * WorkspaceProvider - decides *where* a run's agents work.
 *
 * The provider is asked once per run (child runs inherit the parent's workspace
 * unless a work item asks for its own). Implementations: local directory,
 * git worktree per work item (below), Kepler task worktrees, T3 Code threads
 * (see @orca/integrations).
 */
import type { Request, WorkItem, Workspace } from "@orca/core";

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

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly name = "local";
  constructor(
    private readonly cwd: string,
    private readonly hostId = "local",
  ) {}
  async provision(input: ProvisionInput): Promise<Workspace> {
    if (input.parent) return input.parent;
    return { hostId: this.hostId, cwd: this.cwd, provider: this.name };
  }
}
