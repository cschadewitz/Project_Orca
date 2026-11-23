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
| Cline CLI 3.0.75, the npm build for Linux x64 (pinned by SHA-256 per platform), on the daemon's own computer, with a config directory ORCA has inspected | **Yes** (installed) | **Yes, for the routes marked installed below** | No, after #706 | None: no Cline hook adapter |

## GitHub Copilot CLI

Setup: [agents/copilot-cli.md](agents/copilot-cli.md). Acceptance:
`packages/agents/test/copilot-cli-acceptance-709.test.ts`, run by `copilot-cli-acceptance.yml`.
Code: `packages/agents/src/providers/copilot-cli.ts`.

| What | Behaviour | Known by |
| --- | --- | --- |
| Launch | Profile checked before start (flags, variables, `COPILOT_HOME`, tokens, host), then the executable's identity, then Copilot's own profile directory; anything else is refused before the agent starts | unit-tested; identity and profile installed |
| Executable identity | SHA-256 of the file the command resolves to must be a pinned build for this platform (`COPILOT_CLI_VERIFIED_BUILDS`). **Limits:** it identifies the bytes at that path when ORCA checks. A file replaced between the check and the spawn, an executable that starts another one, and a verified build launched through a wrapper script are not caught; the macOS code signature is not checked. Windows, Linux arm64, musl, macOS x64 and any other version are refused | installed (Linux x64; macOS arm64 by the CI job) |
| Copilot's profile (`COPILOT_HOME`) | Deny by default, checked before every session on the `COPILOT_HOME` the process will actually get (the agent's env with the session's overrides laid over it). The path to it is checked whether the profile exists or not: it must be canonical, with no link anywhere on it, and every directory from the root down must belong to the user or root and be closed to other writers (a root-owned sticky directory such as `/tmp` counts as closed). Only a confirmed absence counts as empty (a dangling link is refused, not taken as absent), and only when the directory it would be created in (links resolved) is the user's own and closed to other writers; a path that cannot be inspected or listed is refused. **Limits:** the checks run before the session and again at the start, and narrow the window but do not close it: a change made by the user's own account or root between the start check and Copilot opening its files, or while the session runs, is not caught The directory and every entry in it must be of the expected type, not a link, owned by the user running ORCA and not writable by others. It may hold only `config.json` (first launch and sign-in keys), `settings.json` (cosmetic keys only), an empty `permissions-config.json`, logs, session state and the session database, and an empty `installed-plugins`; JSON files must be objects. Saved approvals, `trustedFolders`, `allowedUrls`, permission modes, hooks, MCP, LSP or provider files, agents, skills, plugins and anything unrecognised are refused by name. The contents of `logs` and `session-state` are not inspected | installed: fresh profile, the same profile reused by two sessions, and a profile Copilot itself gave a URL approval (`copilot config allowedUrls`), refused; unit-tested: each type, link, owner, permission, unreadable-path, override and path custody case, for existing and missing profiles |
| Environment | The launch checks read what the host will pass: the daemon's environment less what ORCA withholds for secrets (the same plan the spawn uses), the agent's env, the session's overrides, then the secrets, which the host sets last. `COPILOT_HOME`, `COPILOT_AUTO_UPDATE` and the allow-all variables filled by a secret are refused, whatever a session override says, because ORCA cannot read them to check. The same check runs again on the start itself, with the arguments the host is given, and refuses a start whose environment, `COPILOT_HOME` or executable differs from what was checked | unit-tested |
| Signed-in profile | The keys `copilot login` writes (`loggedInUsers`, `lastLoggedInUser`, a plaintext token without a keychain) are accepted from Copilot's documentation, not observed: the acceptance run uses no account. If sign-in writes another key, ORCA refuses and names it | source |
| Handshake | ACP protocol 1; advertises `loadSession`, session `list` and `close`, one auth method (`copilot login` in a terminal). ORCA never calls `authenticate` | installed |
| Sign-in | Copilot's own `copilot login`, or a model provider with its key as a secret reference. A token in the config or the daemon's environment is refused | source; refusal unit-tested |
| Streaming | Message chunks, tool calls and their updates, usage, plan and command lists arrive on the session's own id | installed |
| Model errors | Reported as message text; the turn ends with `end_turn` and the session takes the next prompt | installed |
| Cancel | `session/cancel` ends the turn with `cancelled` and stops a running shell command before its effect | installed |
| Options offered on an ask | `allow_once`, `allow_always`, `reject_once` (no `reject_always`) | installed |
| ORCA deny (rule or person) | `reject_once`: the command does not run | installed |
| ORCA allow | `allow_once`: the command runs | installed |
| Answers | Only one-time answers reach Cline: "always" becomes "once"; with no one-time option offered, or an answer that is not one of the offered options, the ask is cancelled | offline |
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

## Cline CLI

`cline --acp` 3.0.75. Tiers **A** and **B**. "Installed" below means one route only: the
`@cline/cli-linux-x64` 3.0.75 binary (SHA-256 checked), a fresh config directory signed in to
the `openai-compatible` provider, a scripted stand-in model, on GitHub's Ubuntu 24.04 runner
(`cline-acp-acceptance.yml`). macOS, Windows, arm64, Cline-account sign-in, other providers
and a config directory reused across many sessions are by source only. Setup: [agents/cline.md](agents/cline.md).
Acceptance: `packages/agents/test/cline-acp-711.acceptance.test.ts`, run by
`cline-acp-acceptance.yml`. Code: `packages/agents/src/providers/cline.ts`.

Cline runs every tool itself, after asking ORCA with `session/request_permission`. It never
uses ACP's `fs/*` or `terminal/*`, so the ask is ORCA's only point of control, and everything
below is about that ask being made, being decided on the right facts, and holding.

| What | Behaviour | Known by |
| --- | --- | --- |
| Version | `initialize` must report `cline` 3.0.75; anything else fails the handshake | installed (3.0.75 accepted); offline (others refused) |
| Executable | ORCA hashes the command before every start and opens only the published 3.0.75 build for this platform (SHA-256 per platform). The hash names the published build; it does not cover a file swapped between the hash and the start, or code the build fetches later (auto-update is off) | installed (Linux x64); offline (others refused); other platforms' pins from the npm artifacts, not run |
| Launch flags | Only `--acp`, `--config <absolute dir>`, `--thinking`, `--reasoning-effort`. `--yolo` and `--auto-approve` (which approve every tool) are refused by name | source; offline |
| Cline's state | Must be in its own `--config` directory: not Cline's default `~/.cline` (shared with Cline run outside ORCA) and not inside the workspace, up to its repository root, compared by real path. ORCA refuses agent reads and writes there (Cline keeps sign-ins in plain files). Deny by default: only `data`, and in `data/settings` only Cline's three settings files; `toolAutoApprove` on is refused | source; installed (edit refusal shown for hooks) |
| Background hub | Cline runs sessions in a detached hub process by default, which outlives the agent ORCA stops. `CLINE_SESSION_BACKEND_MODE=local` is required; no Cline process remains after ORCA closes its sessions | source; installed |
| Auto-update | `CLINE_NO_AUTO_UPDATE=1` is required | source |
| Other `CLINE_*` variables | Refused from the profile, the session's overlay and ORCA's environment (they move state, settings or MCP servers) | source; offline |
| Launch environment | Checked as the host builds it: ORCA's environment less withheld secrets, the profile's `env`, the session overlay, then secret-filled names. Checked again at the moment of start; a start whose `HOME`, `--config` or directory differ from the ones checked is refused | offline |
| File checks | Fail closed: only a missing entry counts as absent; anything ORCA cannot read is refused. `--config`, `HOME` and the session directory must each be given as its real path (no link on it, no other spelling), so ORCA inspects exactly the paths Cline uses; anything else is refused before inspection. On Linux and macOS the config directory, `data`, `data/settings` and its files must belong to the user ORCA runs as and be writable by no one else | offline |
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
| Sub-agents and delegation | Cline runs a sub-agent's tools without asking anyone (3.0.75 gives the sub-agent no approval callback). ORCA answers every ask about a tool outside Cline's own nine (`spawn_agent`, team tools, configured agents, `ux_verifier`) with Cline's reject option itself, before any rule or person sees it | source; installed (the unasked sub-agent command shown without the guard, refused with it) |
| File changes | Cline 3.0.75 offers OpenAI-compatible models `apply_patch` for edits; ORCA reads its paths from the patch | installed |
| A call ORCA cannot read the target of | Reported as `other`, which no default rule allows | offline |
| `auto_approve` session option | ORCA never sets it on, refuses a session that opens with it on, and ends one that reports it turned on | installed (refused); offline (open and mid-session) |
| Plan mode | Cline's `mode: plan` is its own read-only preset; it changes nothing ORCA relies on | source |
| Outside ORCA's ask | What an allowed shell command does beyond its own text. Cline has no shell sandbox in ACP mode | source |
| Execution guard (C) | Not claimed; after #706 | unknown |
| `nativeToolHook: on` | Not offered: no Cline hook adapter | by design |
