- **agents:** ORCA's pre-tool hook now also covers local Codex agents
  (`@agentclientprotocol/codex-acp` 2.9.0 running Codex 0.171.0 on Linux x64), under the same
  opt-in `nativeToolHook: on`. ORCA's hook checks every shell command, patch and MCP tool call Codex makes
  against ORCA's rules. An ORCA deny blocks the call, and so does an ORCA ask, because Codex
  can't pause for a person from a hook. Codex's hosted web search is switched off, since no
  hook can see it. Codex lets a call through when its hook fails, so ORCA refuses to open the
  session unless Codex lists ORCA's hook as trusted and the hook blocks a test call the way
  Codex runs it. ORCA admits the session only once it has found the Codex process the adapter
  started among the agent's own processes and hashed the image it runs against the digest
  pinned for that adapter. Gemini and pi agents with `nativeToolHook: on` are refused. See
  `docs/agent-hook-coverage.md` (#705).
