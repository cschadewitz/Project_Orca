- **agents:** ORCA's `PreToolUse` hook for local Claude agents, **experimental and not
  guard-qualified**: opt-in per agent with the explicit `nativeToolHook: experimental`, off by
  default (`nativeToolHook: on` is kept for a qualified hook and is still refused, so a config
  that set it earlier stays inactive), and no agent
  qualified by the #706 support matrix. In acceptance runs with a scripted model it puts every
  tool call Claude hooks, including calls Claude
  remembers as "always allowed", through ORCA's rules, so a revoked grant applies to the very
  next call; a hook that fails blocks the call; and ORCA admits a session only with the
  adapter and Claude Code build it was verified with (`@agentclientprotocol/claude-agent-acp`
  0.109.1 with Claude Code 2.1.330 on Linux x64), checked by hashing the image the session's
  runtime process actually runs, once, when the session opens. Not covered: what a shell
  command touches beyond its own text, and sessions on SSH hosts (refused). See
  `docs/agent-hook-coverage.md` (#704).
