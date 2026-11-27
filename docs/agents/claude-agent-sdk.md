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
forwards a login. It takes no Anthropic or Claude variable (`ANTHROPIC_*`, `CLAUDE_*`, such as
`CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_ENV_FILE`) from the daemon's own environment: the only
credential or Claude override Claude gets beyond its own login is one set in the agent's `env`.
`CLAUDE_CONFIG_DIR` is kept, so a daemon started with it uses the login in that directory. ORCA
writes nothing there itself (Claude Code keeps its own session transcripts there).

To use an API key or a cloud provider instead, set its variables in the agent's `env`, as on the
ACP route, written out or as a secret reference (`{ secret: … }`). A secret reference works as it
does over ACP (#1126):

- The session's use check must allow it, or the session is refused before Claude starts.
- The value is read on ORCA's own machine just before Claude starts, and is put only in the
  variable the agent's `env` names.
- Every daemon variable a secret is read from is kept from Claude, whether this agent uses that
  secret or not.
- The value is taken out of the run's events and logs, and out of every error the session
  reports.

A secret reference in one of the agent's MCP servers' `env` is checked and read the same way,
and reaches only that server, in the variable its `env` names (see "MCP servers" below).

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

- **No settings files** (`settingSources: []`): your user settings and a checkout's
  `.claude/settings.json` and `settings.local.json` are not loaded, so their hooks do not run and
  their permission rules and `env` do not apply. Your login is still used. Loading them by choice
  is not offered yet.
- **Only ORCA's MCP servers** (`--strict-mcp-config`): the agent's own `mcpServers`, run by ORCA
  (see below). A checkout's `.mcp.json` and your own Claude MCP config are not loaded.
- Claude Code's own system prompt, and permission mode `default`.
- **Session transcripts are kept** where Claude Code always keeps them, in its own config
  directory, under a session id ORCA picks (the session's `acpSessionId`), so the session can be
  resumed. This is what Claude Code does over ACP too.

### Resume and context recovery

A session opened with `resumeSessionId` continues that earlier session's transcript (Claude
Code's `resume`), with the same guarantees as `session/load` on the ACP route:

- **Recovery required** (`requireContextRecovery`). With no id the open is refused with
  `CONFIG_INVALID` before anything starts. A resume Claude Code refuses (for example an unknown
  id) is refused with `AGENT_PROTOCOL`, and one that does not answer in time with
  `AGENT_TRANSPORT`. In both cases `details.contextRecoveryReason` gives the reason, the
  process is stopped, and no fresh session is opened.
- **Recovery optional.** A refused resume is followed by a fresh session, once the refused
  process is gone, and continuity is reported as `fresh` / `load-failed`.
- **What gets passed on.** Only a session id in UUID form is given to Claude Code. Claude Code
  would also resume a session by its title, which ORCA never asks for. Any other value counts
  as a failed load, and nothing is started for it.
- **What a resume restores.** The conversation only. A permission ask that was pending when
  the earlier session ended is not restored, and resuming authorizes nothing: every tool call
  is decided again.

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

## What a session may do

ORCA decides every tool call Claude makes with the agent's permission rules (#1122), the same
rules, people and answerer as for Claude over ACP:

- **Denied by a rule, or touching ORCA's own files:** denied before it runs. Claude is told
  why.
- **Asked by a rule:** the run's answerer is asked, a person in the app or the client that
  started the run, even when Claude would have run the call without asking, such as a read in
  its working directory. With nobody to answer, the call is denied.
- **Allowed by a rule:** Claude's own checks still apply. If Claude asks, ORCA answers yes for
  that one call. Claude is never told to remember a yes, so the next identical call is decided
  again, by the rules as they are then.
- **A person's answer** counts for that one call only. When they decline, Claude is told that
  the person declined.
- **Glob and Grep are denied:** a search can reach a protected folder below where it starts.
  `TodoWrite` always runs.
- **An ask outside a live turn, or after the turn was cancelled,** is denied, and the tool
  does not run. Cancelling while a person is being asked stops Claude's turn too.

An ask card shows the call as ORCA's rules read it, together with what Claude said about it:
why it asks, the path it was blocked on, and for a subagent's call, the tool call that started
the subagent. A note the person writes beside a decline does not reach Claude yet.

### MCP servers

The agent's `mcpServers` work as on the ACP route (#1125), with the same checks. ORCA runs each
server itself and gives Claude only its name, as an in-process server: Claude never sees the
server's command, arguments or environment, and its secrets stay on ORCA's side.

- A server starts only when Claude first lists its tools or calls one, in a live session.
- **A tool call** is decided by the agent's permission rules when Claude asks for it, as above
  (titles read `<server>: <tool>`). It reaches the server only inside the live turn, and only as
  the call that was decided, with the same arguments. A rule that denies the call since, or an
  automatic allow the rules no longer give, refuses it. Nobody is asked a second time.
- Every request has the relay's deadline, and Claude is told only a short reason when one fails.
- A server's name may hold only letters, digits, `-` and single `_`, at most 64 characters, so
  Claude's tool names (`mcp__<server>__<tool>`) stay unambiguous. Another name refuses the
  session before anything starts.

### How your permission rules read these calls

ORCA decides each call with the same permission rules it uses for Claude over ACP (#1119). A rule that matches by title (`titlePattern`) is matched
against the title Claude's ACP adapter would show for that call, so a title rule you wrote for
ACP sessions holds here too. ORCA reproduces that title for Bash and PowerShell, Read, Write,
Edit, WebFetch, WebSearch and MCP tools. For other tools (Glob, Grep, NotebookEdit, subagents and
the like) it cannot, so those calls are kept strict:

- no rule allows them, so they are asked, even under `default: allow`;
- every deny or ask title rule for their kind applies, even one written for a different call;
- an "always" answer is used for that call only, not saved as a standing allow.
