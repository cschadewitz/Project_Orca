# Claude through the Claude Agent SDK

> **In progress, on `feature/claude-agent-sdk` only.** Nothing here is in a release, and it does
> not reach `main` until the release gate (#1132) opens. Tracking: #1153.

ORCA runs Claude over ACP today, through the `claude-agent-acp` adapter. `driver:
claude-agent-sdk` is a second, opt-in way: ORCA drives the Claude Agent SDK itself, which lets it
see and decide more of what Claude does (#1153 lists what each slice adds). Today ORCA checks the
launch and then refuses the session; the session driver is the next slice (#1120).

## 1. Install Claude Code and sign in yourself

ORCA runs **your own installed, unmodified `claude`**, never the CLI the SDK bundles, and uses
**the login you made yourself**:

```sh
claude --version            # Claude Code installed on the machine ORCA runs on
claude auth login           # your own sign-in; ORCA offers none
claude auth status          # ORCA asks the same before every session
```

ORCA never opens Claude's credentials file, keychain entries or token files, and never shows or
forwards a login. It takes no Anthropic or Claude Code variable (`ANTHROPIC_*`, `CLAUDE_CODE_*`)
from the daemon's own environment: the only credential Claude gets beyond its own login is one
written in the agent's `env`. `CLAUDE_CONFIG_DIR` is kept, so a daemon started with it uses the
login in that directory.

To use an API key or a cloud provider instead, set its variables in the agent's `env`, as on the
ACP route. Secret references (`{ secret: … }`) are refused on this driver until it delivers
secrets (#1126).

## 2. One subscription, one person

A Claude subscription belongs to one person. Run the SDK driver only on your own daemon, for your
own work. **A daemon that runs other people's work must not route it through one person's
login**: give that daemon its own API key in the agent's `env`, or use the ACP route with each
person's own setup.

## 3. Add the agent

```yaml
agents:
  - id: claude
    name: Claude (Agent SDK)
    driver: claude-agent-sdk
    # command: /home/you/.local/bin/claude   # optional; `claude` on PATH when left out
    hostId: local
```

Leave `driver` out and the agent runs over ACP exactly as before.

## What ORCA checks before a session

1. **The executable**, resolved to the file that would run by its real path. One inside an
   `@anthropic-ai/claude-agent-sdk*` package (the SDK's bundled CLI) is refused.
2. **`claude --version`**, under a deadline.
3. **`claude auth status --json`**, under a deadline. `loggedIn: false` fails the session open
   with "run `claude auth login`"; a timeout or an answer ORCA cannot read fails it too.

The agent must run on ORCA's own machine for now (SSH hosts: #1130). It takes no `args` (the SDK
builds Claude's arguments), and neither `nativeToolHook` nor `codexExecGate`.
