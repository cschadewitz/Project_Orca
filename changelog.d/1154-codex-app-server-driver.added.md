- **agents:** `driver: codex-app-server` on an agent (#1154), experimental: Codex through its
  own app-server on the user's own `codex login`, with no sign-in of ORCA's. Every session that
  asks for it is refused for now, at the session factory, the ACP launch and delegation; config
  rejects it on an `orca-daemon` agent and together with `nativeToolHook` or `codexExecGate`.
  Not a guard, and no support tier.
