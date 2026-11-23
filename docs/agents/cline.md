# Cline CLI (#711)

Cline CLI 3.0.75's own ACP server (`cline --acp`), started by ORCA through its generic ACP
session with a Cline provider guard in front (`packages/agents/src/providers/cline.ts`). What
is supported, and how each part is known, is in [agent-support.md](../agent-support.md#cline-cli).
The launch profile ORCA accepts is [cline.example.yaml](cline.example.yaml).

Everything below is done once, by you, on the computer that runs ORCA. ORCA never signs in for
you and never sees a Cline credential except an API key you hand it as a secret reference.

## 1. Install the pinned version

```sh
prefix=/opt/orca-providers/cline/3.0.75       # any absolute directory of your choosing
npm install --prefix "$prefix" --ignore-scripts @cline/cli-linux-x64@3.0.75   # or -darwin-arm64, -windows-x64
"$prefix/node_modules/@cline/cli-linux-x64/bin/cline" --version              # 3.0.75
```

`--ignore-scripts` is enough: ORCA starts the platform binary itself, not the `cline` npm
wrapper. On Linux x64 the binary's SHA-256 is
`f63e3073dcd3b5d045cca6a78a65250b9baecf7d599a1206276255a5fc4f58fe`. ORCA hashes the
executable before every start and opens only the published 3.0.75 build for your platform
(`CLINE_CLI_VERIFIED_IMAGES` in `packages/agents/src/providers/cline.ts`). Do not use
`npx cline` or a global install as the agent's command: ORCA refuses both.

## 2. Give Cline a directory of its own

Pick an absolute directory, for example `/opt/orca-providers/cline/profile`, and pass it as
`--config` both when you sign in and in the agent profile. Cline keeps its sign-in there, in
plain files, so ORCA refuses any agent access to it. Keep nothing else in it: ORCA accepts
only Cline's `data` directory there, and in `data/settings` only `providers.json`,
`global-settings.json` and `cline_mcp_settings.json`.

Do not use Cline's default `~/.cline`, which Cline run outside ORCA shares, or a directory
inside the workspace (anywhere under its repository root), even through a link: ORCA refuses both. The directory and its settings
must belong to you and be writable by you alone (`chmod -R go-w <dir>`). Give `--config`, and
`HOME` if you set it, as real paths: ORCA refuses a path with a link on it or written
another way (`..`, a trailing `/`). ORCA checks what the
directory holds before every start; it cannot tell whether something other than ORCA also
uses it, so keep it for ORCA.

## 3. Sign in

Choose one:

- **A Cline account (or ClinePass, or a ChatGPT subscription):** run
  `cline auth --config <dir>` and follow the browser sign-in. Nothing goes in ORCA's config.
- **An API key for another provider:** run
  `cline auth -p <provider> -k <key> -m <model> [-b <base URL>] --config <dir>`, then set
  `CLINE_PROVIDER` and `CLINE_MODEL` in the profile, and `CLINE_API_KEY` as a secret
  reference (the example uses a key file). ORCA refuses the key written into its config, and
  refuses a `CLINE_API_KEY` it would inherit from its own environment.

Without a sign-in, Cline answers ORCA's `session/new` with "authentication required" and
ORCA stops the agent. ORCA does not call ACP's `authenticate`, which would start a browser
sign-in from inside a run.

## 4. What ORCA checks before every start

ORCA refuses to start Cline, with the reason, when:

- the command is not an absolute path to a `cline` executable, or the agent is on an SSH host;
- the executable's SHA-256 is not the published 3.0.75 build for this platform;
- the config directory is missing, holds anything but Cline's `data` directory, or its
  `global-settings.json` turns `toolAutoApprove` on;
- the arguments are anything but `--acp`, `--config <absolute dir>`, `--thinking` and
  `--reasoning-effort <level>` (`--yolo` and `--auto-approve` are named in the refusal);
- `CLINE_SESSION_BACKEND_MODE` is not `local` or `CLINE_NO_AUTO_UPDATE` is not `1`;
- any other `CLINE_*` variable is set, in the profile or in ORCA's own environment;
- the agent has MCP servers (Cline ignores servers handed to it over ACP);
- Cline hooks or plugins exist in the workspace (`.cline/hooks`, `.clinerules/hooks`,
  `.cline/plugins`, up to the repository root), the config directory (`hooks`, `plugins`),
  or your home (`Documents/Cline/Hooks`, `Documents/Cline/Plugins`, `.agents/plugins`);
- Cline's own MCP settings in the config directory list any server;
- at `initialize`, Cline reports anything but `cline` 3.0.75.

During a session, ORCA itself rejects any tool outside Cline's own (`read_files`,
`search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`,
`ask_question`, `submit_and_exit`), whatever your rules say. That includes `spawn_agent`:
Cline 3.0.75 runs a sub-agent's tools without asking anyone, so ORCA does not let one start.

The desktop app's first-run check recognises a `cline` command as a Cline candidate. It does
not start it; these checks run when a session starts.

## Provenance

| Item | Pin |
| --- | --- |
| npm `cline` | 3.0.75, published 2026-11-21T05:31:57Z, `sha512-pPS9viwLrFN+gsepAqPo8lVv5wrjp8CzVB9UbRHwV0RbpvsrRSHxtoHoxMN2tvONuOLvTIWiEYPE3h3KWHqV0g==` |
| npm `@cline/cli-linux-x64` | 3.0.75, `sha512-I9uEOAmfphHjr6Bwvq+hzCx9bHAtjH8r7M0KyF4iS6SdzDAIcZxlaLWduAOu8vZ6ws3xkd4vqDU0StpznNmrHw==`; `bin/cline` SHA-256 `f63e3073dcd3b5d045cca6a78a65250b9baecf7d599a1206276255a5fc4f58fe` (a Bun-compiled single executable) |
| Source read | `cline/cline` at `8075d2e35cf5cad67c24f180c80a05d311b74a3e` (`apps/cli` 3.0.75, `sdk/packages/*` 0.2.1, the versions the npm package depends on): `apps/cli/src/acp/`, `apps/cli/src/main.ts`, `sdk/packages/agents/src/agent-runtime.ts`, `sdk/packages/core/src/{hooks,extensions,runtime/host}`, `sdk/packages/shared/src/storage/paths.ts` |
| ACP | Cline reports `protocolVersion` 1 and uses `@agentclientprotocol/sdk`; ORCA's client is the workspace's `@agentclientprotocol/sdk` |
| Runtime | The platform binary embeds its runtime; Node is needed only for `npm install` |
| Tested | Linux x64 (GitHub-hosted `ubuntu-24.04`), in CI, with a scripted OpenAI-compatible stand-in model. macOS arm64 and Windows are source-reviewed only |

## Differences from the VS Code extension

This is the CLI's ACP mode, not the extension. The extension's settings, auto-approve menu,
checkpoints and MCP marketplace are not involved; the CLI reads its own `--config` directory.
Within ACP mode the CLI has no remembered approvals ("Allow always" approves one call), runs
every tool in its own process (never ACP `fs/*` or `terminal/*`), and ignores MCP servers in
`session/new`.

## Not yet

Tier C (execution-guard certification) waits for #706's acceptance suite; until then the
matrix says what a shell command Cline was allowed to run can still do. `nativeToolHook: experimental` is
not offered for Cline: ORCA has no Cline hook adapter, so the asks above are the only point of control.
