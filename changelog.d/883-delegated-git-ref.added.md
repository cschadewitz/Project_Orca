- **daemon:** A delegated step can name a git ref. An `orca-daemon` agent's `gitRef` (a
  branch, tag or commit) is sent with each admission (protocol 2.7, listed in `hello.admitFields`, optional `gitRef` on
  `runs.admit`). The remote daemon checks it before admitting, fetches it from its
  workspace's `fetchRemote` (default `origin`) and gives the run its own checkout of that
  commit (`git-worktree` with `isolateRoots`). A remote that cannot fails the step with
  `DELEGATION_REFUSED` and reason `git-ref`.
