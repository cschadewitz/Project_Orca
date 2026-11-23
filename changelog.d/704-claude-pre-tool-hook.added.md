- **agents:** ORCA's permission policy now decides every tool call a local Claude agent makes,
  not only the ones Claude asks about. A `PreToolUse` hook installed in each session puts
  calls Claude remembers as "always allowed" through ORCA's rules, so a revoked grant
  applies to the very next call. ORCA's allow defers to Claude's own check, its ask comes
  back as a permission prompt, and a hook that fails blocks the call. ORCA's own files are
  refused to Claude's built-in tools. Needs `@agentclientprotocol/claude-agent-acp` 0.109.1
  or later; `nativeToolHook: off` on an agent turns it off (#704).
