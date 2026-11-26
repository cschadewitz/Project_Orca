# Claude through the Claude Agent SDK

> **In progress, on `feature/claude-agent-sdk` only.** Nothing here is in a release, and it does
> not reach `main` until the release gate (#1132) opens. Tracking: #1153.

ORCA runs Claude over ACP today, through the `claude-agent-acp` adapter. `driver:
claude-agent-sdk` is a second, opt-in way: ORCA drives the Claude Agent SDK itself, which lets it
see and decide more of what Claude does (#1153 lists what each slice adds). ORCA checks the launch,
then runs the session through the SDK (#1120). Until ORCA answers Claude's permission asks
(#1122), a session can read but not change anything: see [What a session may do](#what-a-session-may-do-for-now).

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

These checks start two short-lived local processes, `claude --version` and `claude auth status
--json`, with the environment described above. Neither starts an SDK session or a model turn.
ORCA keeps none of their output beyond the version number and the auth method and provider
names: no error or log carries text the CLI printed.

1. **The executable**, resolved to the file that would run by its real path. One inside an
   `@anthropic-ai/claude-agent-sdk*` package (the SDK's bundled CLI) is refused.
2. **`claude --version`**, under a deadline.
3. **`claude auth status --json`**, under a deadline. `loggedIn: false` fails the session open
   with "run `claude auth login`". Signed in counts only from a probe that ran to its own exit
   with code 0; a timeout, cancellation, signal, output over the cap, nonzero exit or an answer
   ORCA cannot read fails it.

The agent must run on ORCA's own machine for now (SSH hosts: #1130). It takes no `args` (the SDK
builds Claude's arguments), and neither `nativeToolHook` nor `codexExecGate`.

## The session

One session is one Claude Code process, started by the SDK from the executable checked above,
with your login and the environment described in section 1. ORCA starts it in its own process
group and ends that group when the session closes, so nothing Claude started outlives it.

ORCA starts Claude with a fixed setup:

- **No settings files** (`settingSources: []`): your user, project and local Claude settings,
  hooks and permission rules are not loaded. Your login is still used.
- **No MCP servers** (`--strict-mcp-config` with none) and **no session files**
  (`persistSession: false`).
- Claude Code's own system prompt, and permission mode `default`.

Each ORCA turn is one message to Claude; the turn ends with Claude's result. Cancelling a step,
or a turn timeout, interrupts Claude; a turn that has not ended within the agent's
`cancelGraceMs` after that is failed and the process stopped. Claude's text, thinking, tool calls
and results, and its to-do list (as a plan) show in the run like any other agent's. Errors name
what happened, never text Claude printed.

Model and effort choices, and resuming a session, are not there yet (#1120 follow-ups).

## What a session may do, for now

ORCA does not answer Claude's permission asks yet (#1122), so:

- **Read, Glob and Grep** run, on paths ORCA does not keep from agents (its credential and key
  folders). A Glob pattern must stay below its search path.
- **TodoWrite** runs.
- **Everything else is denied before it runs**: edits, writes, Bash, web fetches, subagents and
  any other tool, also where Claude's own rules would have allowed it.
- **Every permission ask is answered no**, for example a read outside the working directory.

