- **daemon:** Workflow drafts: `workflowDrafts.get`, `open`, `apply`, `undo`, `redo`, `review`,
  `publish` and `discard`. A draft is kept beside the workflow in `.drafts/`, edited through
  revision-checked semantic operations on the comment-preserving YAML, validated against the
  active generation, and published by reviewed bytes, a version bump and a generation Apply.
  Dragged positions are layout metadata in `.layout/`, never in the workflow file.
