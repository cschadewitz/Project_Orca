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
| GitHub Copilot CLI 1.0.114, the npm builds for Linux x64 and macOS arm64 only (pinned by SHA-256), on the daemon's own computer, with a profile ORCA has inspected | **Yes** (installed) | **Yes, for the routes marked installed below** | No, after #706 | None yet: refused |

## GitHub Copilot CLI

Setup: [agents/copilot-cli.md](agents/copilot-cli.md). Acceptance:
`packages/agents/test/copilot-cli-acceptance-709.test.ts`, run by `copilot-cli-acceptance.yml`.
Code: `packages/agents/src/providers/copilot-cli.ts`.

| What | Behaviour | Known by |
| --- | --- | --- |
| Launch | Profile checked before start (flags, variables, `COPILOT_HOME`, tokens, host), then the executable's identity, then Copilot's own profile directory; anything else is refused before the agent starts | unit-tested; identity and profile installed |
| Executable identity | SHA-256 of the file the command resolves to must be a pinned build for this platform (`COPILOT_CLI_VERIFIED_BUILDS`). **Limits:** it identifies the bytes at that path when ORCA checks. A file replaced between the check and the spawn, an executable that starts another one, and a verified build launched through a wrapper script are not caught; the macOS code signature is not checked. Windows, Linux arm64, musl, macOS x64 and any other version are refused | installed (Linux x64; macOS arm64 by the CI job) |
| Copilot's profile (`COPILOT_HOME`) | Deny by default, checked before every session: a directory (not a link) of the user running ORCA, not writable by others, holding only `config.json` (first launch and sign-in keys), `settings.json` (cosmetic keys only), an empty `permissions-config.json`, logs, session state and the session database, and an empty `installed-plugins`. Saved approvals, `trustedFolders`, `allowedUrls`, permission modes, hooks, MCP, LSP or provider files, agents, skills, plugins and anything unrecognised are refused by name | installed: fresh profile, the same profile reused by two sessions, and a profile Copilot itself gave a URL approval (`copilot config allowedUrls`), refused |
| Signed-in profile | The keys `copilot login` writes (`loggedInUsers`, `lastLoggedInUser`, a plaintext token without a keychain) are accepted from Copilot's documentation, not observed: the acceptance run uses no account. If sign-in writes another key, ORCA refuses and names it | source |
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
| Windows | Refused (not a verified platform) | unit-tested |
| Checkout configuration (`.github/copilot/settings*.json`, `.github/hooks`, `.claude/settings*.json`) | Copilot loads a checkout's configuration only when the folder is trusted; ORCA refuses every trust source it can see (`--trust-folder`, a truthy `COPILOT_ALLOW_ALL`, `trustedFolders`). Not exercised | source |
