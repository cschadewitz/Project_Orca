- **agents:** `nativeToolHook: on` now works: ORCA installs its pre-tool hook in local Claude
  and Codex sessions at the verified versions, instead of refusing them. A hooked session is
  held until ORCA has checked the Claude Code or Codex it runs: until then ORCA reads and
  writes no file for it and asks nobody on its behalf, and a session that fails the check is
  refused all of it. A hooked Claude agent's MCP servers are now run by ORCA and served to
  Claude Code over the ACP connection, so Claude Code sees each server's name but never its
  command or environment (secrets included), and a server starts only after the check. Secrets
  in the agent's own `env` still reach it as environment variables, through one delivery
  strategy that a key store can later replace. `orca ping` and `orca-daemon` delegation still
  refuse a `nativeToolHook: on` agent, since they cannot install the hook (#704).
