- **engine:** a run is pinned to the workflow version it started on. Publishing a new version
  affects runs started afterwards; a run already under way resumes and finishes on the
  definition it began with, kept in the store's workflow-version store. `orca resume` on a run
  whose version is neither stored nor on disk fails with `WORKFLOW_VERSION_NOT_FOUND`, naming
  the versions that exist.
- **daemon:** `workflows.get({ id, version })` answers a stored older version instead of
  refusing it, and `WorkflowView` carries `pinned` (the view is not the version on disk);
  `runs.get` adds `run.workflowPinned`, and its traversal edges come from the run's pinned
  definition.
