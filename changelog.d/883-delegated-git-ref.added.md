- **daemon:** A delegated step can name a git ref. An `orca-daemon` agent's `gitRef` (a
  fully qualified branch or tag, `refs/heads/…` or `refs/tags/…`) is sent with each admission
  (protocol 2.7, listed in `hello.admitFields`, optional `gitRef` on `runs.admit`). The remote
  daemon admits only refs its administrator lists in `workspace.allowedRefs` (none by
  default), checks the ref on its `fetchRemote` (default `origin`) with no prompts and a
  deadline, fetches exactly the object it checked (refusing a ref that moved meanwhile) without
  touching remote-tracking refs, and gives the run its own checkout of that commit (`git-worktree` with
  `isolateRoots`), running no hook, fsmonitor command or filter driver. A remote that cannot
  fails the step with `DELEGATION_REFUSED` and reason `git-ref`.
