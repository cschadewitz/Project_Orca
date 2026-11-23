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
| OpenCode 1.19.4 (`opencode acp`), Linux x64 and macOS arm64 | **Yes** (installed) | **Yes, with the limits listed** (installed) | No, after #706 | None: no supported hook, refused |

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
- The reviewed `OPENCODE_CONFIG` file: nothing natively `allow`, `task`, `webfetch`,
  `websearch` and `external_directory` denied, `"*"` written first (OpenCode's last matching
  key wins), no plugins, no MCP, no formatters, no language servers, no custom commands, the
  `build` agent, sharing and auto-update off.
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
| A prompt starting with `/` | Refused before it is sent: OpenCode would run it as one of its own commands | installed |
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
- **No native tool hook.** OpenCode has no supported hook, so `nativeToolHook: on` is refused
  for it, and ORCA sees only the calls OpenCode asks about.
- **Model backends.** The acceptance suite runs against a scripted stand-in, and the reviewed
  operator profile names one real backend (Anthropic, with the operator's own key, entered
  outside ORCA). Every other backend, local models included, is unverified. With no credentials
  at all OpenCode would enable its own hosted free tier, which is why the profile pins
  `enabled_providers`.
