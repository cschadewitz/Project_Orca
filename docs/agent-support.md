# Which agents ORCA supports, and how far

ORCA speaks ACP, so in principle any ACP agent connects. That is not the same as ORCA being
able to say what the agent will and will not do. This page is the honest version, one section
per agent product, at a pinned version.

A section here says what was observed, by what means, and what is outside. Nothing here is a
promise about a version, platform or backend it does not name: **an agent, version or platform
with no row is unsupported**, and the provider guard refuses it rather than opening a session
whose limits nobody has written down.

## Tiers

The tiers come from the first-wave agent stories (#705, #709–#711). They are cumulative and a
lower one never implies a higher one.

| Tier | Name | What it means |
| --- | --- | --- |
| **A** | Connectivity | The launch profile is pinned and reproducible; handshake, streaming, session and turn identity, errors and cancellation were exercised; the supported OS, runtime and authentication combinations are written down, and everything else fails closed. |
| **B** | Controlled approval | The agent's real offered options and their native effect were tested, and whether a denied action ran was observed independently of what the agent reported — on disk, or at a canary — rather than taken from the agent's own account. |
| **C** | Execution-guard certified | The #700 action contract and the #706 acceptance suite, for one exact provider, tool, version and host: final-action binding, policy and revocation checks, one-use consumption, outage behaviour and tamper limits. |

How a claim is known:

- **installed**: observed on the real agent by ORCA's acceptance tests, which run unattended in
  CI against a scripted stand-in for the model — no account, key or spend;
- **source**: read in the agent's source at the pinned revision, not exercised;
- **by design**: a property of ORCA's own code, covered by unit tests;
- **unknown**: not established, and therefore treated as not covered.

Tier B is a statement about the calls the agent asks about. It is **not** a sandbox and not
every-execution enforcement. The separate opt-in native tool hook (`nativeToolHook: on`,
#704/#705) is what puts ORCA's policy in front of calls the agent never asks about, and
[what ORCA's pre-tool hook covers](agent-hook-coverage.md) says for which agents that exists.

## Summary

| Agent (pinned) | Platforms | Tier | Notes |
| --- | --- | --- | --- |
| OpenCode 1.19.4 (`opencode acp`) | Linux x64, macOS arm64 | **A + B** | Build hashed per session, isolated profile required. No tier C; no native tool hook. |

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
| Switching the session's agent ("mode") | Refused, and a session that opens in another mode is closed: another agent brings its own native permissions | by design |
| Another build of the executable | Refused before anything starts | installed |
| Stale, duplicate and wrong-session asks; a failed human-input callback | Answered `cancelled`, which OpenCode maps to a rejection; a failed callback fails the turn | fixture (`opencode-acp-fixture-710.test.ts`) |

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
