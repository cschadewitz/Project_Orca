- **build:** CI fails a pull request that changes `packages/` and adds no fragment under
  `changelog.d/`, so a missing release note is caught while the change is fresh rather than
  at release time (#218). Label the pull request `no-changelog` when the change genuinely
  needs no note.
