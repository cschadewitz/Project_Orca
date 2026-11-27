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
builds Claude's arguments) and no `codexExecGate`. ORCA's tool hook always runs on this route,
in process (see "ORCA's tool hook" below). `nativeToolHook: experimental` additionally
requires the Claude Code that runs to be one ORCA verified (see "Which Claude Code runs");
`off` changes nothing, and `on` is refused when the session opens, as on the ACP route, until a
hook is guard-qualified.

### Which Claude Code runs

ORCA starts `claude` itself, so it checks the program it starts (#1124), twice when the agent
has `nativeToolHook: experimental`:

1. **Before it runs at all**, even for `claude --version`: the file at the resolved real path
   must be a regular file (checked before it is opened, so a FIFO or device never blocks the
   check) whose image is pinned for this SDK. ORCA then does not run that path: it runs its own
   copy of exactly the bytes it hashed, kept read-only under `$XDG_CACHE_HOME/orca/claude-code`
   (`~/.cache/orca/claude-code` by default) in a directory only your user can use, written once
   per image. The version probe, the auth probe and the session all run that copy, which must
   report the pair's version. An update or replacement of your install between the check and a
   launch therefore changes nothing that runs, and a file that is not a pinned image never runs
   with the session's environment. The check has its own deadline (120 s, a first copy
   included) and the session open's cancellation, and once either ends it, no probe is started.

   What this cannot stop is a process running as your own user rewriting ORCA's copy. Such a
   process can already read the session's environment and the daemon's memory, so no check
   ORCA makes from that user could; the second check measures what runs again.
2. **Once it runs**, after it has answered the SDK's `initialize` and before the session is
   given work or its MCP servers start: ORCA hashes the image the kernel runs for that process
   (`/proc/<pid>/exe`), checks that it is still the same process and still ORCA's own child, and
   compares it with the same pin. This check has the open's own deadline and cancellation.

Nothing Claude Code says about itself (a path, its process title) is read or run. The second
check is a measurement of what runs, not a boundary before execution: the first is that.
Verified pairs, Linux x64 only for now:

| Claude Agent SDK | Claude Code | Image (`@anthropic-ai/claude-code-linux-x64`, `claude`) |
| --- | --- | --- |
| 0.3.332 | 2.1.332 | `sha256:a2df1f41bb00250992926420d0063f89b127cb81abdd284dbefb80c50ff1d026` |

- **With `nativeToolHook: experimental`** an unverified Claude Code (another version, another
  build of the same version, a wrapper, another platform) is refused before the session is
  given any work.
- **Otherwise** the session runs your own Claude Code whatever its version, and ORCA only logs
  that it is not one it verified (the second check, not waited for). Such a session carries no
  attestation claim.

A pin moves only by a reviewed change with an acceptance run on the new pair.

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

### ORCA's tool hook

On this route ORCA's native tool hook (#1123) is a `PreToolUse` callback inside the daemon,
not a separate program per tool call. It sees every call Claude makes, MCP tools and a
subagent's calls included, ahead of Claude's own rules, and decides it the way the ACP route's
hook does:

- a call touching ORCA's own files is denied; then the permission rules decide;
- a call the rules allow but that runs outside the workspace (and outside
  `additionalDirectories`) is asked about, and only a person can allow it, whatever the rules
  say by the time Claude asks. So is a call that does not say where it runs, and any ask ORCA
  cannot tie, as the first ask for it, to a call the hook saw inside the workspace in the same
  turn, for the same tool, with the same input;
- the hook never answers `allow`, so Claude's own check still runs;
- every failure while deciding is an explicit deny, and the hook is installed with
  `onFailure: "block"`, which Claude Code versions without it refuse before the session opens.

With `diagnostics.toolCalls: keep`, the hook records one line per decided call in the ACP
route's hook format (#1000), which ORCA stores as it does a hook program's lines. Recording
can never change an answer, and never holds a session open: lines not stored within two
seconds of the session closing are dropped.

### MCP servers

The agent's `mcpServers` work as on the ACP route (#1125), with the same checks. ORCA runs each
server itself and gives Claude only its name, as an in-process server: Claude never sees the
server's command, arguments or environment, and its secrets stay on ORCA's side.

- A server starts only when Claude first lists its tools or calls one, once the session is open.
  Nothing starts for a session that failed to open, or once it has begun to close.
- **A tool call** is decided by the agent's permission rules when Claude asks for it, as above
  (titles read `<server>: <tool>`). It reaches the server only inside the live turn, and only as
  the call that was decided, with the same arguments. A rule that denies the call since, or an
  automatic allow the rules no longer give, refuses it. Nobody is asked a second time.
- Every request has the relay's deadline, and Claude is told only a short reason when one fails.
- A server's answers pass the session's secret redaction before they reach Claude, so a value
  ORCA read (the server's own credential too) never reaches Claude's context or its transcript,
  even when the server echoes it.
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
