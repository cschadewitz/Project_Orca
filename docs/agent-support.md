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
| Cline CLI 3.0.75, Linux x64 | **Yes** (installed) | **Yes, with the gaps listed** (installed) | No, after #706 | None: no Cline hook adapter |

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

## Cline CLI

`cline --acp` 3.0.75, Linux x64 installed-tested (`cline-acp-acceptance.yml`); macOS arm64 and
Windows x64 by source only. Tiers **A** and **B**. Setup: [agents/cline.md](agents/cline.md).
Acceptance: `packages/agents/test/cline-acp-711.acceptance.test.ts`, run by
`cline-acp-acceptance.yml`. Code: `packages/agents/src/providers/cline.ts`.

Cline runs every tool itself, after asking ORCA with `session/request_permission`. It never
uses ACP's `fs/*` or `terminal/*`, so the ask is ORCA's only point of control, and everything
below is about that ask being made, being decided on the right facts, and holding.

| What | Behaviour | Known by |
| --- | --- | --- |
| Version | `initialize` must report `cline` 3.0.75; anything else fails the handshake | installed (3.0.75 accepted); offline (others refused) |
| Executable | ORCA hashes the command before every start and opens only the published 3.0.75 build for this platform (SHA-256 per platform) | installed (Linux x64); offline (others refused) |
| Launch flags | Only `--acp`, `--config <absolute dir>`, `--thinking`, `--reasoning-effort`. `--yolo` and `--auto-approve` (which approve every tool) are refused by name | source; offline |
| Cline's state | Must be in its own `--config` directory. ORCA refuses agent reads and writes there (Cline keeps sign-ins in plain files). Deny by default: only `data`, and in `data/settings` only Cline's three settings files; `toolAutoApprove` on is refused | source; installed (edit refusal shown for hooks) |
| Background hub | Cline runs sessions in a detached hub process by default, which outlives the agent ORCA stops. `CLINE_SESSION_BACKEND_MODE=local` is required; no Cline process remains after ORCA closes its sessions | source; installed |
| Auto-update | `CLINE_NO_AUTO_UPDATE=1` is required | source |
| Other `CLINE_*` variables | Refused from the profile and from ORCA's environment (they move state, settings or MCP servers) | source; offline |
| Sign-in | A Cline account via `cline auth --config <dir>`, or a provider key as a secret reference in `CLINE_API_KEY`. No sign-in: `session/new` fails and ORCA stops the agent | installed |
| Streaming, turn identity | Text streams as `agent_message_chunk`; turns end `end_turn` | installed |
| Model error | The turn fails with `AGENT_PROTOCOL`; the session stays usable | installed |
| Cancel | A turn waiting on the model ends `cancelled` | installed |
| Hooks and plugins | Cline runs hook scripts and plugin modules without asking, and a plugin can approve tools. A launch where the workspace (up to the repository root), the config directory or the home (`Documents/Cline`, `.agents/plugins`) has any is refused; edits into `.cline`, `.clinerules`, `Documents/Cline` and `.agents` are refused by ORCA's protected paths | source; installed (refusal before start, planted hook refused) |
| MCP servers | Cline ignores MCP servers in `session/new`; an agent with any is refused. Cline's own MCP settings must list none | source; offline |
| Skills (#337) | Cline does not accept embedded context, so ORCA's existing check refuses a session that carries skills | source |
| Permission options | `allow_once`, `allow_always`, `reject_once` | installed |
| "Allow always" | Approves that one call in this version. ORCA answers "Allow once" anyway; the next identical call is asked again | installed |
| What an ask carries | Cline sends the tool's input and no `locations`. ORCA reads the paths an edit, read or patch touches, and a command's text, from the input, as Cline's tool will use them, before its policy decides | source; installed |
| Path rules, protected paths | Apply to Cline edits, reads and patches through those paths | installed |
| Command rules | A command's words are matched (`run_commands` input, joined with `;`) | installed (rule-matched deny, no ask, file untouched) |
| ORCA deny, person rejects | Cline does not run the call and tells the model it was rejected | installed |
| ORCA allow | Cline runs exactly the call asked about | installed |
| Cancel while asked | The ask is answered `cancelled`, the call does not run | installed |
| Sub-agents (`spawn_agent`) | Reported by Cline as `think`; ORCA treats it as `other`, so it is asked. The sub-agent's own tools are asked through the same session | installed |
| A call ORCA cannot read the target of | Reported as `other`, which no default rule allows | offline |
| `auto_approve` session option | ORCA never sets it on, refuses a session that opens with it on, and ends one that reports it turned on | installed (refused); offline (open and mid-session) |
| Plan mode | Cline's `mode: plan` is its own read-only preset; it changes nothing ORCA relies on | source |
| Outside ORCA's ask | What an allowed shell command does beyond its own text. Cline has no shell sandbox in ACP mode | source |
| Execution guard (C) | Not claimed; after #706 | unknown |
| `nativeToolHook: on` | Not offered: no Cline hook adapter | by design |
