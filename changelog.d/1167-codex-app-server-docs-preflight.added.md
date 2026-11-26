- **agents:** the experimental Codex app-server driver (`driver: codex-app-server`, still refused
  for sessions) now has its own setup page (`docs/agents/codex-app-server.md`). The page covers the
  pinned native build, your own `codex login`, and what the driver does not fix: calls Codex runs
  in its sandbox, the IPC caveat, the hook's fail-open runner, and unconfirmed cancels. The app's
  first-run review shows such an agent as experimental with those caveats. It also says whether
  the executable's bytes match a Codex build ORCA pinned for the machine. Nothing is executed for
  that check (#1167).
