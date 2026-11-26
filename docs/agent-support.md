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

| Agent (pinned) | A | B | C | Hook (`nativeToolHook: experimental`) |
| --- | --- | --- | --- | --- |
| GitHub Copilot CLI 1.0.114, the npm builds for Linux x64 and macOS arm64 only (pinned by SHA-256), on the daemon's own computer, with a profile ORCA has inspected | **Yes** (installed) | **Yes, for the routes marked installed below** | No, after #706 | None yet: refused |
| OpenCode 1.19.4 (`opencode acp`), the npm builds for Linux x64 and macOS arm64 only (pinned by SHA-256), on the daemon's own computer, with an isolated profile ORCA has inspected | **Yes** (installed) | **Yes, with the limits listed** (installed) | No, after #706 | None: no supported hook, refused |
| Cline CLI 3.0.75, the npm build for Linux x64 (pinned by SHA-256 per platform), on the daemon's own computer, with a config directory ORCA has inspected | **Yes** (installed) | **Yes, for the routes marked installed below** | No, after #706 | None: no Cline hook adapter |
| Codex 0.171.0 through `codex app-server` (`driver: codex-app-server`, experimental), the native Linux x64 build (pinned by SHA-256), on the daemon's own computer, on the user's own `codex login` | No: every session is refused until the route is qualified (#1165) | No | No | Keeps Codex's fail-open hook runner, refused with this driver for now. See [codex-app-server.md](agents/codex-app-server.md) |

## GitHub Copilot CLI

Setup: [agents/copilot-cli.md](agents/copilot-cli.md). Acceptance:
`packages/agents/test/copilot-cli-acceptance-709.test.ts`, run by `copilot-cli-acceptance.yml`.
Code: `packages/agents/src/providers/copilot-cli.ts`.

| What | Behaviour | Known by |
| --- | --- | --- |
| Launch | Profile checked before start (flags, variables, `COPILOT_HOME`, tokens, host), then the executable's identity, then Copilot's own profile directory; anything else is refused before the agent starts | unit-tested; identity and profile installed |
| Executable identity | SHA-256 of the file the command resolves to must be a pinned build for this platform (`COPILOT_CLI_VERIFIED_BUILDS`). **Limits:** it identifies the bytes at that path when ORCA checks. A file replaced between the check and the spawn, an executable that starts another one, and a verified build launched through a wrapper script are not caught; the macOS code signature is not checked. Windows, Linux arm64, musl, macOS x64 and any other version are refused | installed (Linux x64; macOS arm64 by the CI job) |
| Copilot's profile (`COPILOT_HOME`) | Deny by default, checked before every session on the `COPILOT_HOME` the process will actually get (the agent's env with the session's overrides laid over it). The path to it is checked whether the profile exists or not: it must be written canonically (no `.`, `..`, doubled or trailing separators), so the spelling ORCA inspects is the one Copilot receives, with no link anywhere on it, and every directory from the root down must belong to the user or root and be closed to other writers (a root-owned sticky directory such as `/tmp` counts as closed). Only a confirmed absence counts as empty (a dangling link is refused, not taken as absent), and only when the directory it would be created in (links resolved) is the user's own and closed to other writers; a path that cannot be inspected or listed is refused. **Limits:** the checks run before the session and again at the start, and narrow the window but do not close it: a change made by the user's own account or root between the start check and Copilot opening its files, or while the session runs, is not caught The directory and every entry in it must be of the expected type, not a link, owned by the user running ORCA and not writable by others. It may hold only `config.json` (first launch and sign-in keys), `settings.json` (cosmetic keys only), an empty `permissions-config.json`, logs, session state and the session database, and an empty `installed-plugins`; JSON files must be objects. Saved approvals, `trustedFolders`, `allowedUrls`, permission modes, hooks, MCP, LSP or provider files, agents, skills, plugins and anything unrecognised are refused by name. The contents of `logs` and `session-state` are not inspected | installed: fresh profile, the same profile reused by two sessions, and a profile Copilot itself gave a URL approval (`copilot config allowedUrls`), refused; unit-tested: each type, link, owner, permission, unreadable-path, override and path custody case, for existing and missing profiles |
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

## OpenCode 1.19.4

The source review this is built on, with OpenCode's configuration layers, permission defaults
and remembered grants in full, is
[docs/preparation/opencode-acp-710/](preparation/opencode-acp-710/README.md). The provider
module is `packages/agents/src/providers/opencode.ts`; the installed evidence comes from
`.github/workflows/opencode-acceptance.yml`.

### What is pinned

| Item | Pin |
| --- | --- |
| Release | OpenCode **1.19.4**, `anomalyco/opencode@148842ef…`, npm `opencode-<platform>@1.19.4` |
| Build | SHA-256 of the executable, per platform, in `OPENCODE_IMAGES`. ORCA hashes the configured executable (through its real path, by file identity) before every session and refuses anything else. |
| Platforms | `linux-x64` and `darwin-arm64`, the two the acceptance suite runs. `linux-arm64` and `darwin-x64` images are recorded but **refused**: nothing has run there. Windows is not supported (upstream recommends WSL). |
| ACP | Protocol 1 (OpenCode's SDK 0.21.0). No `terminal`; ORCA advertises none. |
| Host | This computer only. An OpenCode agent on an SSH host is refused, because its profile and build cannot be checked there. |
| OpenCode 2 | `@opencode/cli` is a different product with a rewritten ACP agent. It is unreviewed and refused. Never run `opencode upgrade --major` against a pinned install. |

### What the launch must look like

OpenCode merges up to ten configuration layers, and several of them can grant tools or run code
with no ask at all: the person's own `~/.opencode`, a project `opencode.json`, JS plugins,
formatters, language servers. ORCA therefore refuses to start OpenCode unless the launch is an
isolated profile, and says exactly what is missing (`CONFIG_INVALID`, `problems`):

- `opencode acp --hostname 127.0.0.1 --port 0 --pure`, as an absolute path to the verified
  executable. The internal HTTP server OpenCode runs for itself is unauthenticated, so it is
  held to loopback on a random port. No other flag is accepted.
- `HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` set to the profile's own absolute paths;
  `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_PURE` and `OPENCODE_DISABLE_AUTOUPDATE` on;
  `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` empty.
- Nothing in the profile's own configuration directories (`$XDG_CONFIG_HOME/opencode` and
  `~/.opencode`) except the schema-only file OpenCode seeds and the plugin dependency it
  installs there itself. Agents, modes, commands and tools in those directories load with no
  ask, and `--pure` keeps out only plugins, so anything else refuses the launch.
- The reviewed `OPENCODE_CONFIG` file: only reviewed settings (an unknown key, such as the
  legacy `tools` map, refuses the launch), nothing natively `allow`, `"*"` written first, no
  plugins, no MCP, no formatters, no language servers, no custom commands, the `build` agent,
  sharing and auto-update off. `task`, `webfetch`, `websearch` and `external_directory` must
  stay denied in the effective ruleset, not just be written as `deny`: OpenCode decides by
  the last rule whose permission and pattern match, over the top-level `permission` and then
  `agent.build.permission`, so ORCA rebuilds that ordered list and refuses a later rule that
  reopens a denial (a wildcard key such as `"t*"`, a pattern entry, or an agent-level `"*"`).
- The checks read the environment the process will actually get: the daemon's own, less exactly
  what the host withholds for secrets, then the agent's env, then the session's, then the
  variables a secret delivery fills. They run when the session is prepared and again at the
  actual start, on the start's own environment, withheld names and secret deliveries; a start
  whose directory, `HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG` or `OPENCODE_PERMISSION`
  differs from the checked ones, or whose image changed, is refused. A control variable that a
  secret fills is refused, since its value is only known at launch. Refusals name variables,
  never values.
- `HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` must be canonical: written without `.`,
  `..`, `//` or a trailing `/` (so the path ORCA reads is the exact spelling OpenCode gets,
  which the start then passes through unchanged), no link anywhere on the path, and every directory on it the user's or root's and closed to other writers (a
  root-owned sticky directory such as `/tmp` counts as closed).
  The config file and every entry of the profile directories must be the expected type, not a
  link, the user's own and not writable by others; a profile directory counts as empty only
  when it does not exist.
- `OPENCODE_PERMISSION` equal to that file's `permission`. It is the last layer OpenCode
  applies, after a machine-wide or MDM configuration, which is why ORCA also refuses to start
  when `/etc/opencode` or the macOS managed equivalent exists: a per-agent rule delivered there
  is not overridden by it.
- An ORCA policy that denies OpenCode's subagent launch. OpenCode reports it as kind `think`
  with the title `task`, which ORCA's #140 defaults would otherwise allow.
- No `mcpServers`: OpenCode registers a client's servers for every session in the process.

A ready profile to copy is
[`orca.opencode.example.yaml`](preparation/opencode-acp-710/orca.opencode.example.yaml), with
[`opencode.isolated.json`](preparation/opencode-acp-710/opencode.isolated.json) beside it;
[setup and preflight](preparation/opencode-acp-710/setup-preflight.md) has the operator steps,
including verifying the binary against the pinned npm integrity rather than trusting the npm
wrapper's postinstall.

### What was observed

| What | Behaviour | Known by |
| --- | --- | --- |
| Handshake, `session/new`, streaming, turn identity | Protocol 1, OpenCode's session id kept, `agent_message_chunk` updates, turn ends `end_turn` | installed |
| `authenticate` | A no-op in 1.19.4 (it only advertises `opencode auth login`); ORCA never calls it | source, installed |
| Explicit denial | A rejected shell command does not run: nothing on disk | installed |
| A rule-matched allow | Answered `once`, every time. A repeat of the same command is decided again; a changed command reaches a person | installed |
| A person's "Always allow" | Narrowed to "Allow once" by ORCA, so OpenCode asks again next call. **Control case, with the guard off:** OpenCode's own "always" skips the second ask entirely, directory-wide for the life of the process, and outranks a configured deny — which is why ORCA never selects it | installed (both) |
| File edits | Asked as `edit` with the path. A rejected write leaves no file; an allowed one writes once | installed |
| Subagents (`task`) | Denied natively: no ask, and no child's effects. Its own asks would never be forwarded over ACP in 1.19.4 anyway (upstream #48232) | installed |
| Web fetch and search | Denied natively; a canary URL in the test's own server is never hit | installed |
| Cancellation | A cancel while an ask is pending ends the turn `cancelled`, and a late answer runs nothing | installed |
| A command with a `workdir` outside the workspace | Nothing lands outside: OpenCode's `external_directory` is denied natively. ORCA could not have decided it — an `execute` ask carries the command text only, with no location and no cwd, so an ORCA title rule matches the same command in any directory | installed |
| A file path given through a link to the workspace (macOS `/var` → `/private/var`) | Treated by OpenCode as outside the project and denied natively, with no ask. Configure the workspace by its real path | installed (macOS) |
| A prompt starting with `/` | Refused before it is sent: OpenCode would run it as one of its own commands | installed |
| A person's "Always reject", or an answer with no one-time equivalent on offer | Sent as `reject_once`; when OpenCode offers no one-time option for the answer, the ask is cancelled instead of answered with a persistent response | unit-tested |
| Switching the session's agent ("mode") | Refused, and a session that opens in another mode is closed: another agent brings its own native permissions | unit-tested |
| Another build of the executable | Refused before anything starts | installed |
| Stale, duplicate and wrong-session asks; a failed human-input callback | Answered `cancelled`, which OpenCode maps to a rejection; a failed callback fails the turn | unit-tested (`opencode-acp-fixture-710.test.ts`) |

### What is outside, and stays outside

These are the honest limits of tier B for OpenCode. None of them is closed by anything in this
release, and tier C is not claimed.

- **Shell children.** One ask covers the parsed command; what it spawns, writes or fetches is
  unmediated. Children run with no sandbox.
- **The command's directory.** An `execute` ask has no cwd and no location, so ORCA decides it
  by title alone (`workdir` is in the raw input only). The native `external_directory` deny is
  what keeps a command's paths inside the workspace, not an ORCA rule.
- **Native file writes.** Every OpenCode tool reads and writes in its own process. ORCA's
  `fs/*` handlers and protected paths see only what OpenCode chooses to send: asks with
  locations, and the `fs/write_text_file` mirror of an edit it already made itself.
- **The truncation directory**, which OpenCode appends as allowed after every layer.
- **The daemon's environment.** ORCA's host can add or replace variables but cannot remove one,
  so anything the daemon was started with reaches OpenCode and every command it runs. Start the
  daemon for an OpenCode agent from a shell that holds no credentials.
- **The internal HTTP server**, unauthenticated on loopback: any local process that finds the
  port can drive OpenCode, replies to its permission asks included. ORCA cannot generate a
  per-launch secret for it today (`OPENCODE_SERVER_PASSWORD`).
- **No native tool hook.** OpenCode has no supported hook, so `nativeToolHook: experimental` is refused
  for it, and ORCA sees only the calls OpenCode asks about.
- **Model backends.** The acceptance suite runs against a scripted stand-in, and the reviewed
  operator profile names one real backend (Anthropic, with the operator's own key, entered
  outside ORCA). Every other backend, local models included, is unverified. With no credentials
  at all OpenCode would enable its own hosted free tier, which is why the profile pins
  `enabled_providers`.
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
| Answers | Only one-time answers reach Cline: "always" becomes "once"; with no one-time option offered, or an answer that is not one of the offered options, the ask is cancelled | offline |
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
| `nativeToolHook: experimental` | Not offered: no Cline hook adapter | by design |
