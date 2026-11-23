- **agents:** ORCA's `PreToolUse` hook for local Claude agents (`nativeToolHook: on`) is built
  and tested against the real Claude Code, but not available yet: this build refuses every
  session that asks for it. Once on, it puts every tool call, including calls Claude
  remembers as "always allowed", through ORCA's rules, so a revoked grant applies to the very
  next call; a hook that fails blocks the call; and ORCA admits a session only with the
  adapter and Claude Code build it was verified with (`@agentclientprotocol/claude-agent-acp`
  0.109.1 with Claude Code 2.1.330 on Linux x64), checked by hashing the image the session's
  runtime process actually runs (#704).
