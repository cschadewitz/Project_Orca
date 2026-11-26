# Claude through the Claude Agent SDK

> **In progress, on `feature/claude-agent-sdk` only.** Nothing here is in a release, and it does
> not reach `main` until the release gate (#1132) opens. Tracking: #1153.

ORCA runs Claude over ACP today, through the `claude-agent-acp` adapter. `driver:
claude-agent-sdk` is a second, opt-in way: ORCA drives the Claude Agent SDK itself, which lets it
see and decide more of what Claude does (#1153 lists what each slice adds). ORCA checks the launch,
then runs the session through the SDK (#1120). Until ORCA answers Claude's permission asks
(#1122), a session can read single files but not search or change anything: see [What a session may do](#what-a-session-may-do-for-now).

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
group. When the session closes, or a turn has to be stopped, ORCA ends Claude's input, waits
briefly, then kills that whole group, and kills it again once Claude has exited, so what Claude
started in its group goes with it. A process that leaves the group on purpose (for example with
`setsid`) is not covered.

**Linux and macOS only for now.** On Windows the session is refused before anything starts:
ORCA does not yet own the whole process tree there. Leave `driver` out to run Claude over ACP.

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

### Model and effort

The session offers the models your Claude Code lists itself (its own aliases such as
`default`, `sonnet` and `opus`, and full ids) as its `model` option, so a run's model choice
and the agent's `defaultModel` work as they do for any agent; a model Claude Code does not
list is refused with the list. A model that takes effort levels also has an `effort` option
(`default`, `low` … `max`); `default` leaves Claude Code's own choice, and switching to a model
that does not take the chosen level goes back to `default`. A session starts on Claude Code's
`default` model. Resuming a session is not there yet.

## What a session may do, for now

ORCA does not answer Claude's permission asks yet (#1122), so:

- **Read** runs, for a file ORCA does not keep from agents (its credential and key folders).
- **Glob and Grep are denied**: a search can reach a protected folder below where it starts.
- **TodoWrite** runs.
- **Everything else is denied before it runs**: edits, writes, Bash, web fetches, subagents and
  any other tool, also where Claude's own rules would have allowed it.
- **Every permission ask is answered no**, for example a read outside the working directory.

