# GitHub Copilot CLI

ORCA runs [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
through its own ACP server, `copilot --acp`, like any other ACP agent (#709). This page is how
to set it up. What is and is not covered is in the [support matrix](../agent-support.md#github-copilot-cli).

**Supported:** Copilot CLI **1.0.114** as npm installs it for **Linux x64** or **macOS arm64**,
started by ORCA on the same computer as the ORCA daemon, from a Copilot profile ORCA has
inspected. `copilot-cli-acceptance.yml` runs exactly those builds. ORCA checks the SHA-256 of the
executable before every session and refuses any other build, version or platform, Windows
included for now. Copilot's ACP server is a public preview, so its behaviour can change between
versions.

## 1. Install the pinned version

Install only the executable for your platform, into a directory named after the version, so a
later global install or update cannot replace it:

```sh
PREFIX="$HOME/.local/share/orca-agents/copilot-cli/1.0.114"
mkdir -p "$PREFIX" && cd "$PREFIX" && npm init -y >/dev/null
npm install --ignore-scripts @github/copilot-linux-x64@1.0.114      # macOS: @github/copilot-darwin-arm64@1.0.114
"$PREFIX/node_modules/@github/copilot-linux-x64/copilot" --no-auto-update --version   # GitHub Copilot CLI 1.0.114.
```

Install it this way, from npm: Homebrew, WinGet and the install script ship other files, which
ORCA refuses. Windows is refused until it has been through the acceptance run.

## 2. Give it its own Copilot profile and sign in yourself

Copilot keeps saved approvals ("don't ask again in this repo"), hooks, MCP servers and settings in
its home directory. ORCA needs one that only ORCA's Copilot uses, so nothing saved for your
everyday use answers ORCA's tool calls:

```sh
mkdir -m 700 -p "$HOME/.local/share/orca-agents/copilot-cli/profile"
COPILOT_HOME="$HOME/.local/share/orca-agents/copilot-cli/profile" "$PREFIX/node_modules/@github/copilot-linux-x64/copilot" login
```

That is Copilot's own sign-in; ORCA never sees the token. It needs a Copilot plan (an
organization seat needs the Copilot CLI policy enabled). Usage counts against that plan and ORCA
cannot show it.

To use your own model provider instead of a Copilot plan, set `COPILOT_PROVIDER_BASE_URL` and
`COPILOT_MODEL` in the agent's `env`, and give the key as a [secret reference](../WORKFLOWS.md#secret-references)
(`COPILOT_PROVIDER_API_KEY: { secret: copilot-provider-key }`), never as text.

## 3. Add the agent

```yaml
agents:
  - id: copilot
    name: GitHub Copilot CLI
    command: /home/you/.local/share/orca-agents/copilot-cli/1.0.114/node_modules/@github/copilot-linux-x64/copilot
    args: [--acp, --stdio, --no-auto-update, --disable-builtin-mcps, --no-ask-user]
    env:
      COPILOT_HOME: /home/you/.local/share/orca-agents/copilot-cli/profile
      COPILOT_AUTO_UPDATE: "false"
      COPILOT_ALLOW_ALL: "false"
    hostId: local
```

`--disable-builtin-mcps` keeps Copilot's built-in GitHub MCP server out, so ORCA's own MCP
servers are the only ones the session has. `--no-ask-user` removes Copilot's question tool,
which has no ACP form.

## What ORCA refuses, and why

ORCA checks the agent before starting it. A refusal names every problem at once.

| Refused | Why |
| --- | --- |
| An executable that is not the pinned 1.0.114 build for this platform (by SHA-256), or a platform other than Linux x64 and macOS arm64 | ORCA's guarantees are what was observed on that build |
| A `COPILOT_HOME` that is a link, belongs to someone else or can be written by others, or holds anything ORCA does not recognise: saved approvals, `trustedFolders`, `allowedUrls` or any non-cosmetic setting, hooks, MCP, LSP or provider files, agents, skills, plugins | Saved and trusted state would answer tool calls before ORCA is asked. Use a directory only ORCA's Copilot uses; the error names each entry |
| A relative `command`, or `npx @github/copilot` | PATH order or a launch-time download could swap the version |
| `--allow-all`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--yolo`, `--allow-tool`, `--allow-url`, `--autopilot`, `--assisted-approval`, `--add-dir`, `--trust-folder`, `--no-sandbox`, `--mode` other than `interactive` | They approve tools before ORCA is asked |
| `--port`, `--resume`, `--continue`, `-p` | ORCA speaks ACP over stdio and starts its own sessions |
| `COPILOT_ALLOW_ALL`, `COPILOT_PLAN_THEN_AUTOPILOT` or `COPILOT_ASSISTED_APPROVAL` set to anything true, in the config or in the daemon's environment | Same |
| No `--acp` or `--no-auto-update`, or `COPILOT_AUTO_UPDATE` not `"false"` | An update would run a version ORCA has not checked |
| No absolute `COPILOT_HOME` | Copilot would use your everyday `~/.copilot` |
| `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_PROVIDER_API_KEY` written into the config | Credentials go in secret references, never in config |
| One of those tokens in the daemon's environment | Copilot would use it instead of your sign-in. Start ORCA without it, or define it as a [secret](../WORKFLOWS.md#secret-references), which withholds it from agents |
| A host other than `local` | ORCA cannot check the environment Copilot would get there |

While a session runs:

- A prompt that starts with `/` is not sent. Copilot treats it as one of its own commands, over
  ACP too, and `/allow-all on`, `/yolo`, `/permissions allow-all` and `/autopilot on` turn its
  permission asks off for the rest of the session. Reword a prompt that starts with a path.
- ORCA does not set Copilot's `allow_all` option or switch it to autopilot mode, refuses a
  session that opens with either, and ends a session that reports either turned on.
- When you answer an ask with "always", ORCA records its own rule as for any agent but answers
  Copilot with "Allow once". Copilot's "Always allow" would approve the command name (`touch`,
  with any arguments) for the rest of the session without asking ORCA again.
