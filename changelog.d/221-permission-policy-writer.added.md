- **core:** a permission policy can be written, not only read. Answering an agent's
  permission prompt with "always" derives a rule from that one request and appends it to
  `orca.permissions.json`, a sidecar beside `orca.config.yaml`, layered *after* the agent's
  configured `permissions:` rules so configuration always wins. Rules carry the time they
  were added and the tool call they were granted for, because a standing permission grant
  should be readable in a diff. Paths are workspace-relative, so a grant still applies in the
  next run's git worktree; a `path:` match on a rule is new and exact, where `pathPrefix:`
  stays the hand-written broad form. The derivation refuses to widen — never a parent
  directory, never anything outside the workspace, and an `execute` grant is scoped to its
  command rather than to the directory it ran in — and refuses to write a rule around a run
  id or a temp path that could never match again, reporting the refusal so the caller can
  honour the answer just once. See ADR 0009.
