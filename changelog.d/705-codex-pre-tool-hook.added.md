- **agents:** the same experimental, not guard-qualified hook for local Codex agents
  (`@agentclientprotocol/codex-acp` 2.9.0 running Codex 0.171.0 on Linux x64), under the
  opt-in `nativeToolHook: experimental`. In acceptance runs with a scripted model, the shell commands,
  patches, MCP tool calls and image reads Codex hooks are checked against ORCA's rules; typed
  stdin to a running command is not. An ORCA deny blocks the call, and so does an ORCA ask, because Codex
  can't pause for a person from a hook. Codex's hosted web search is switched off, since no
  hook can see it. Codex lets a call through when its hook fails, so ORCA refuses to open the
  session unless Codex lists ORCA's hook as trusted and the hook blocks a test call the way
  Codex runs it. That check is made once, when the session opens: Codex lets a call through
  if its hook runner fails later, and nothing re-checks it. ORCA admits the session only once it has found the Codex process the adapter
  started among the agent's own processes and hashed the image it runs against the digest
  pinned for that adapter. Gemini and pi agents with `nativeToolHook: experimental` are refused. See
  `docs/agent-hook-coverage.md` (#705).
