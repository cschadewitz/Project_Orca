- **engine:** the `local` workspace provider, when its directory is a git checkout and the run
  is for a work item, checks out `orca/<slug>` (creating it from the current HEAD, or reusing
  it) and returns it as `workspace.branch`, recording the branch it replaced as
  `workspace.previousBranch`. The build agent no longer picks a branch of its own and leaves
  the shared checkout on it; the previous branch is recorded, not restored.
- **templates:** `sdlc/build` and `sdlc/deploy` name `{{ workspace.branch }}` when there is
  one, instead of "the current branch".
