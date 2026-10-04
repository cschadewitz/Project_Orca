# Owned root worktrees

Issue #460 adds an opt-in to the built-in `git-worktree` provider. Implementation
base: `7a3ff6a1db0ea119bbb41886128039d47f4b312e`, verified against remote `main`
before edits, including the merged #447/#444 startup-cleanup foundation.

An operator may configure `workspace.isolateRoots: true` alongside the existing
trusted `repo`, `worktreeRoot`, `baseBranch`, `branchPrefix` and `hostId` settings.
This document does not activate that configuration. Omission preserves the old
shared root behavior, including in previously captured generations. WorkItems
keep their existing branches and children inherit the parent's workspace.

For an isolated root, the server's reserved run ID selects the directory directly
under `worktreeRoot` and the branch `<branchPrefix>roots/<runId>`. Workflow input,
task text and variables cannot select the provider, repository, prefix or path.
This does not require Request/WorkItem records or plan grants. The ordinary scoped
direct client retains `runs.read`, `artifacts.read`, `workflows.read`, `runs.start`,
`runs.control`, `inputs.answer`, selected workflow IDs and owned runs.

Before `git worktree add`, the provider resolves `baseBranch` to an exact commit
and exclusively writes and syncs a versioned receipt at
`<git-common-dir>/orca-root-workspaces/<runId>.json`. It binds the run, canonical
repository/common directory, frozen commit, branch and path. Only a successful
Git registration check publishes the separate `.json.ready` marker, which records
the worktree's Git administration directory. A moving base branch is never used
as the argument to `worktree add` after that reservation.
The receipt file, receipts directory and its parent Git common directory are
synced before Git mutation. A publication or sync failure retains any evidence
already written and prevents the Git effect.

Reuse and execution attachment verify the receipt, marker, canonical paths,
absence of symlinks, actual Git worktree registration, common repository, branch,
administration directory and ancestry from the frozen base. Agent edits and
descendant commits are retained. Detached HEAD, a replacement repository, a
rewritten base or a changed branch is refused. An existing directory or branch
without this ownership evidence is never adopted. There is no force removal,
reset or shared-checkout fallback for opted-in roots. `release` refuses owned
root removal.
Execution preflight runs under the execution lease's mutation fence before
first-start attempt/witness persistence or continuation attachment CAS and
acknowledgement. A refused preflight leaves first-start evidence unconsumed; a
continuation remains blocked with dispatch still needed, not ambiguously attached.
After restoring the original valid registration, retry or reconcile the same
identity. This does not authorize retrying uncertain provisioning or an already
consumed first start.

## Recovery contract

This first version deliberately chooses **fail-closed recoverable failure with
retained evidence**, not automatic provisioning reconciliation. Direct admission's
private-input/uncertain-provisioning guard, reserved identity, authority checks,
retry fences and generation checks are unchanged. A crash before provisioning,
after Git creates the workspace, before the ready marker, or before `run.created`
can leave the admission incomplete. Reconciliation retains the same admission/run
and does not retry Git when private inputs already exist. A pending or torn
receipt also refuses provider reuse. Lost acknowledgements use existing durable
admission/policy evidence; this feature does not manufacture missing policy or
ownership records to make an incomplete admission appear accepted.

An operator must inspect the original admission, its protected inputs and captured
generation, the receipt/marker, `git worktree list --porcelain`, branch history and
retained edits. There is no new repair command or permission to delete receipts,
force-reset branches, create a replacement run or automatically complete an
uncertain admission. Keep the evidence until a separately reviewed reconciliation
can establish what happened. A failed registration check prevents execution;
cancellation can still record cancellation without deleting the workspace.
Missing generations refuse execution through the existing generation contract.
Startup failure and cancellation retain workspace evidence; direct-child cleanup
does not establish descendant or remote-process termination.

## Supported boundary

The new ownership implementation requires the built-in local host on Linux.
Remote/custom hosts and other platforms fail closed for opted-in roots. Existing
WorkItem provider behavior is unchanged. Captured configuration reconstructs the
built-in provider after restart, without behavior-bearing plugins.
The selected execution host must also be a built-in local host on Linux with the
workspace's recorded host ID. This is checked before creating or returning a
pooled session, including role overrides and children inheriting owned workspaces.
A local workspace paired with an SSH agent is refused; no remote support is added.

These are accidental collision and recovery safeguards within a trusted local
filesystem. Receipts are private-mode files outside the agent's worktree, but Git
worktrees share the repository/object database and the OS user can edit Git
metadata. This is not a security sandbox against a hostile same-user process,
nor a race-proof filesystem boundary against concurrent path substitution. It
does not exclude secrets, constrain CPU/memory/processes/network, or implement
the rest of #449 or #453. Tests use disposable local Git repositories; they do
not certify the live agent-01 Codex profile, remote hosts, macOS or Windows.
Deployment, configuration activation and staged capacity acceptance remain
separately reviewed owner actions.
