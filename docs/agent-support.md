# Agent support

What ORCA has checked about each agent product beyond the generic ACP session, by support
level (#709, #710, #711, alongside #705's hook coverage page, `agent-hook-coverage.md`, once it lands):

- **A, connectivity**: ORCA starts the agent from a pinned launch profile, opens a session,
  streams a turn, handles its errors and cancels it, and refuses launches it cannot vouch for.
- **B, controlled approval**: the agent's permission asks reach ORCA's policy, the options it
  offers are known, an ORCA refusal stops the action, and what the agent would remember or run
  without asking is listed.
- **C, certified execution guard**: every execution path is bound to ORCA's decision, proven by
  the #706 acceptance suite. Nothing is certified yet.

Every entry says how it is known, as in the hook coverage page:

- **installed**: observed on the real agent by ORCA's acceptance tests, which run unattended in
  CI against a scripted stand-in for the model;
- **source**: read in the agent's documentation or source at the pinned version, not exercised;
- **unknown**: not established, and treated as not covered.

## Support levels

| Agent (pinned) | A | B | C | Hook (`nativeToolHook: on`) |
| --- | --- | --- | --- | --- |
| GitHub Copilot CLI 1.0.114, Linux x64 and macOS arm64 | **Yes** (installed) | **Yes, with the gaps listed** (installed) | No, after #706 | None yet: refused |

## GitHub Copilot CLI

Setup: [agents/copilot-cli.md](agents/copilot-cli.md). Acceptance:
`packages/agents/test/copilot-cli-acceptance-709.test.ts`, run by `copilot-cli-acceptance.yml`.
Code: `packages/agents/src/providers/copilot-cli.ts`.

| What | Behaviour | Known by |
| --- | --- | --- |
| Launch | Profile checked before start (flags, variables, `COPILOT_HOME`, tokens, host); version read from the executable and only 1.0.114 opens | unit-tested; version installed |
| Handshake | ACP protocol 1; advertises `loadSession`, session `list` and `close`, one auth method (`copilot login` in a terminal). ORCA never calls `authenticate` | installed |
| Sign-in | Copilot's own `copilot login`, or a model provider with its key as a secret reference. A token in the config or the daemon's environment is refused | source; refusal unit-tested |
| Streaming | Message chunks, tool calls and their updates, usage, plan and command lists arrive on the session's own id | installed |
| Model errors | Reported as message text; the turn ends with `end_turn` and the session takes the next prompt | installed |
| Cancel | `session/cancel` ends the turn with `cancelled` and stops a running shell command before its effect | installed |
| Options offered on an ask | `allow_once`, `allow_always`, `reject_once` (no `reject_always`) | installed |
| ORCA deny (rule or person) | `reject_once`: the command does not run | installed |
| ORCA allow | `allow_once`: the command runs | installed |
| "Always" answers | Sent as `allow_once`; the next call with the same command name is asked again; Copilot saves nothing (`permissions-config.json` absent) | installed |
| File writes (`create`, `edit`) | Asked about as `edit`; denied, no file. Written by Copilot itself, not through ACP `fs/*`, so ORCA's protected-path check applies only through the policy | installed |
| Subagents (`task`) | Their commands are asked about on the parent session; denied, they do not run | installed |
| `/allow-all on`, `/yolo`, `/permissions allow-all`, `/autopilot on` in a prompt | Copilot runs them over ACP and stops asking, with no option update for allow-all. ORCA refuses any prompt that starts with `/` | installed (unguarded run pinned) |
| `allow_all` option, autopilot mode | ORCA never sets them; a session opening with or reporting either is ended | unit-tested |
| Commands Copilot calls read-only (`cat`, `ls`, …) | **Run without an ask.** Not seen by ORCA's policy | installed |
| File reads and searches inside the workspace | **Run without an ask** | installed (reads) |
| Reads outside the workspace | Asked about as `read` ("Access paths outside trusted directories") | installed (manually) |
| Text typed into a running shell (`write_bash`) | **Not asked about**: a command ORCA allowed can be fed further input | unknown, treated as not covered |
| MCP servers, URL fetches, memory writes, background shells after the turn | Not exercised | unknown |
| Hooks, plugins, skills in the workspace or `COPILOT_HOME` | Run commands of their own. ORCA's fresh `COPILOT_HOME` starts with none; the workspace's are the workspace's | source |
| Windows | Not run | unknown |
