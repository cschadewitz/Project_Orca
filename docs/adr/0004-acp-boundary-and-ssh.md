# ADR 0004 — ACP is the agent boundary; SSH is a transport, not a daemon

**Status:** accepted

## Context
Claude Code, Codex, Gemini CLI, OpenCode, Kepler and Zed all speak the Agent Client
Protocol (JSON‑RPC over stdio). Remote machines should host agents without extra services.

## Decision
`@orca/agents` talks only ACP (`@agentclientprotocol/sdk`). Hosts are `local` (spawn) or
`ssh` (spawn `ssh -T … -- bash -lc 'cd <cwd> && exec <agent>'`); the ssh child's stdio is
the ACP stream. File access and workspace provisioning on remote hosts use short ssh
commands (`cat`, `test -e`, `mkdir -p`, `git worktree add`). Other transports implement
`AgentSession` and are injected via `Orchestrator.sessionFactory`.

## Consequences
+ Zero remote install beyond the agent itself; key‑based ssh is the only requirement.
+ Permission requests, fs requests and cancellation behave identically local/remote.
− Per‑file ssh round trips; an SFTP `HostFileSystem` is a drop‑in optimisation.
− Terminal capability is not served yet (agents fall back to their own shells).
