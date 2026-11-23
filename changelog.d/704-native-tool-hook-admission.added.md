- **agents:** with `nativeToolHook: experimental`, a hooked session is held until ORCA has checked the Claude Code or Codex
  it runs: until then ORCA reads and writes no file for it and asks nobody on its behalf, and a
  session that fails the check is refused all of it. A hooked Claude agent's MCP servers are
  run by ORCA and served to Claude Code over the ACP connection, so Claude Code sees each
  server's name but never its command or environment (secrets included). A server starts only
  after the check, and every request to it is checked again when it is sent: a tool call only
  in the session's live turn and only if ORCA's rules allow it then (and again after a server
  had to start), each request within a deadline. A server never sees the variables ORCA
  withholds from the agent, and its errors reach the agent short and redacted. Secrets in the agent's own `env` still reach it as environment variables, through
  one delivery strategy that a key store can later replace (#704).
