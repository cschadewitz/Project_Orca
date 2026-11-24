- **agents:** `codexExecGate: experimental`, a separate opt-in route for Codex through ORCA's
  gate in its executor path. It is **refused for every session for now**, before the agent
  starts, with each reason numbered: ORCA's config directory, store or loaded config file inside
  a directory the agent may write (the default layout included), a host that is not Linux x64
  with the system's bubblewrap and `unshare` and no `/etc/codex`, what the closed executor still
  cannot close, and that the route is not wired yet. It cannot be combined with
  `nativeToolHook`, and nothing falls back to running Codex without the gate. No support tier is
  claimed.
