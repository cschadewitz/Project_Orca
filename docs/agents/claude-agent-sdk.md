# Claude through the Claude Agent SDK

> **In progress, on `feature/claude-agent-sdk` only.** Nothing here is in a release, and it does
> not reach `main` until the release gate (#1132) opens. Tracking: #1153.

ORCA runs Claude over ACP today, through the `claude-agent-acp` adapter. `driver:
claude-agent-sdk` is a second, opt-in way: ORCA drives the Claude Agent SDK itself, which lets it
see and decide more of what Claude does (#1153 lists what each slice adds). ORCA checks the launch,
then runs the session through the SDK (#1120), and decides every tool call Claude makes with the
agent's permission rules (#1122): see [What a session may do](#what-a-session-may-do). It runs
on the daemon's own computer or, with only `claude` on the other machine, an SSH host (see
[On an SSH host](#on-an-ssh-host)). It does not run on Windows, which is refused before
anything starts, so use the ACP route there.

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

### How it counts against your limits

Work run through the Claude Agent SDK draws from your Claude plan's usage limits like Claude
Code does ([Anthropic: use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
People have measured SDK and `claude -p` traffic using up the 5-hour limit faster than
interactive Claude Code, so expect a run to use more of it than the same work typed by hand.
ORCA does not try to change that: Claude Code reports the SDK's own entrypoint (`sdk-ts`), and
ORCA never claims to be another product. An entrypoint of ORCA's own waits on Anthropic's
answer. With an API key the work is billed to that key's account instead (#1127).

What ORCA shows, all from what Claude Code itself sends (ORCA calls no usage service and reads
no credentials):

- **Each turn's usage** in the run: the context the turn's last call used against that call's
  model's window, the session's token totals, and Claude Code's estimated cost so far, priced at
  API rates. A turn with no call of its own, or whose model reports no window, shows none. The
  cost is an estimate, not a bill; on a subscription you pay by plan, not by it.
- **A limit that is close** (a claude.ai sign-in only) as a warning in the run, with how much of
  it is used and when it resets.
- **A limit that stopped a turn** (a call in that turn failed on a rate limit, or Claude Code
  reported the limit reached during it) ends the step with what happened and when the limit resets,
  for example "Claude reached the weekly limit of its subscription, so the step ended. It
  resets at 2026-11-28T09:00:00.000Z; run the step again after that." An API key's rate limit
  (HTTP 429), once Claude Code stops retrying, ends the step with its own message. ORCA does not
  retry either itself, and never switches to another account.

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

**From first-run setup.** The app's setup review asks which Claude agent the new configuration
gets: Claude through ACP (`claude-agent-acp`, selected first), Claude through the Claude Agent
SDK (experimental), or none yet. It offers the SDK driver only when it finds `claude` on `PATH`,
on a computer the driver runs on (not Windows). Finding it runs nothing: no version, handshake or
sign-in check happens during setup, and setup offers no sign-in. A `claude` that is not signed in
is refused when a session opens, with "run `claude auth login`" (#1131). The pick writes the
agent `claude`, with `command: claude-agent-acp` or with `driver: claude-agent-sdk` and no
command; change it or add others in Config.

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

The agent runs on ORCA's own machine or on an SSH host (see "On an SSH host" below). It takes
no `args` (the SDK builds Claude's arguments) and no `codexExecGate`. ORCA's tool hook always runs on this route,
in process (see "ORCA's tool hook" below). `nativeToolHook: experimental` additionally
requires the Claude Code that runs to be one ORCA verified (see "Which Claude Code runs");
`off` changes nothing, and `on` is refused when the session opens, as on the ACP route, until a
hook is guard-qualified.

### On an SSH host

With `hostId` naming an `ssh` host (#1130), the SDK and ORCA's permission bridge stay on ORCA's
machine, and only `claude` runs on the host. ORCA starts it over the host's own SSH
configuration (identity file, port, `remoteShell`), the way the ACP route starts an agent
there, with the SDK's stream-json on the connection's stdin and stdout. It runs as your own
login on that machine, with the Claude Code found on its login-shell `PATH` (or `command`) and
the sign-in kept there; ORCA reads no credentials there and offers no login. Sign in on the
host itself with `claude auth login`. The two checks above (`claude --version`, then
`claude auth status --json`) are asked on the host, each over its own SSH connection under the
same deadline, and a `claude` that is not signed in is refused with "run `claude auth login` on
<host>".

What `claude` is given there is only what the session sets: the agent's own literal `env`, what
ORCA adds, and the SDK's own variables, on top of the remote login shell's environment. None of
the daemon's environment crosses, and Claude credential variables ORCA would otherwise carry
are left out, as on ORCA's own machine. **No value is put on a command line.** The remote
command holds only variable names, the directory, the command and its arguments. ORCA writes
each value to the connection's stdin first, and the remote shell reads and exports it with
builtins before `claude` starts and is handed the rest of stdin. So a value appears in no
process's argument list on either machine, and in no error or log ORCA writes. A real-sshd
test scans every process's arguments while a session starts and runs.

**The host owns the launch.** The host must be Linux with bash as the remote shell (the
default `bash -lc`) and `flock` (util-linux); anything else is refused before `claude` starts.

- **A marker, not a number.** Every process of a launch carries
  `ORCA_CLAUDE_SDK_LAUNCH=<token>` in its environment, with a token unique to the launch. A stop
  signals a process only after reading that marker in `/proc/<pid>/environ` right before the
  signal, so a reused pid or group id, or another launch's process, is never signalled. A
  process that clears its own environment is not followed.
- **One supervisor, explicit states.** Each launch has a state on the host, written only while
  holding the launch's lock (`flock`): `starting`, `admitted` (the one process allowed to become
  `claude`, named by pid and start time), `running`, `stopping` (a stop asked for, not
  confirmed), `stopped` and `done` (both confirmed). The process that becomes `claude` waits
  until the state names it, and the remote shell holds the lock from before it starts until it
  carries the marker. So a stop never runs while a launch is started but not yet visible, and a
  launch a stop overtook never starts. A stop reaches `stopped` only on evidence: before
  admission nothing may start `claude`; after it, the admitted process must be gone or carry
  the marker, and no process may carry the marker any more. Otherwise the launch stays
  `stopping`, the stop reports it unconfirmed, and the host's watchdog keeps trying every
  second. The record is replaced whole (written, then renamed) and checked when read: one that
  cannot be read or written, or that is not a state, keeps any launch from starting and leaves
  the stop unconfirmed, though what carries the marker is still killed. "Confirmed" covers the
  supervised processes, those that carry the marker; a descendant that drops the marker from
  its environment is not one of them, and an empty scan says nothing about it. Tests hold a
  launch inside admission and stop it there, kill the remote shell after admission and stop
  what it admitted, check that a stop it cannot confirm is reported so and signals nothing, and
check records that are cut short, invalid, unreadable or cannot be written.
- **The host stops it by itself.** `claude`'s input comes through a relay in the remote shell,
  which drops a heartbeat line ORCA sends every 5 seconds and records a beat for every line it
  reads. A separate watchdog, which forwards nothing, stops every process of the launch when no
  beat comes for 30 seconds: ORCA frozen or unreachable, the link silently gone, or a `claude`
  that stopped reading so the relay is stuck writing to it. It also stops them 10 seconds after
  the input ended (ORCA closed it, or the connection did), taking the lock as any stop does.
  These deadlines are elapsed time (`/proc/uptime`), not the wall clock. When `claude` exits,
  the remote shell stops what it left. None of this needs a connection back, and only marked
  processes are ever signalled: the relay and the watchdog end by themselves.
- **ORCA confirms it.** Whenever a session ends (closed, cancelled while it opened, or its
  connection lost), ORCA also runs the stop over a new SSH connection and checks that no marked
  process of the launch runs. A stop that cannot be confirmed (the host unreachable, the lock not
  free in time, or its state record unreadable) is not
  reported as closure: `close()` throws and the session's termination is rejected with reason
  `remote-cleanup-unconfirmed`, so ORCA keeps the agent slot until it knows. The host's own
  stop is what remains.

Not covered: a host that crashes or a process that clears its own environment is not
followed. A stop that cannot show the launch is gone says so rather than claiming closure.

The real-sshd tests check each of these. After a close, a killed connection, a frozen ORCA
(its ssh stopped, no stop sent), a cleanup connection that cannot be made, a `claude` that
stopped reading with no cleanup connection to be had, and a cancelled open, a `claude` that ignores the end of its input, and a process it started, are gone, and
the unconfirmed case is reported as such.

What does not hold on that machine yet, and so is refused or left out:

- **No rule allows a call there.** The bridge cannot check a directory on another machine, so
  no call is taken to run inside the workspace: each call the policy allows is still a
  person's to allow. Deny rules, asks and protected paths apply as everywhere.
- **No attestation.** The Claude Code that runs there is not ORCA's child, so it is not attested
  (the result is logged as unverified), and `nativeToolHook: experimental` is refused on an SSH
  host, as on the ACP route.
- **No secret references.** Secrets are read only on ORCA's own machine, so an agent whose `env`
  (or one of its MCP servers') refers to one is refused on an SSH host.

The workspace must already be on the host (ORCA does not sync code), as for any SSH agent.

### Which Claude Code runs

ORCA starts `claude` itself, so it checks the program it starts (#1124), twice when the agent
has `nativeToolHook: experimental`:

1. **Before it runs at all**, even for `claude --version`: the file at the resolved real path
   must be a regular file (checked before it is opened, so a FIFO or device never blocks the
   check) whose image is pinned for this SDK. ORCA then does not run that path: it runs its own
   copy of exactly the bytes it hashed, kept read-only under `$XDG_CACHE_HOME/orca/claude-code`
   (`~/.cache/orca/claude-code` by default) in a directory only your user can use, written once
   per image and hashed again against the pin before every reuse (a copy that no longer matches
   is replaced). The version probe, the auth probe and the session all run that copy, which must
   report the pair's version. An update or replacement of your install between the check and a
   launch therefore changes nothing that runs, and a file that is not a pinned image never runs
   with the session's environment. The check has its own deadline (120 s, a first copy
   included) and the session open's cancellation, and once either ends it, no probe is started.

   This is a trusted cache, not isolation by the operating system: what it cannot stop is a
   process running as your own user rewriting ORCA's copy between that hash and the launch. Such a
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

- **No settings files** unless you list some: your user settings and a checkout's
  `.claude/settings.json` and `settings.local.json` are not loaded, so their hooks do not run and
  their permission rules and `env` do not apply. Your login is still used. To load some, list
  them in the agent's `claudeCode.settingSources` (`user`, `project`, `local`; `project` also
  brings CLAUDE.md), as on the ACP route. Unlike the ACP route, leaving it out loads none.
  What a loaded file adds still cannot run a call ORCA would not: ORCA's hook sees every call
  first, denies what its policy denies and asks about what its policy asks about, whatever
  the file's allow rules, hooks or `defaultMode` say, and its MCP servers stay out. Its deny
  rules and hooks can still refuse a call ORCA would allow, and its hooks run as your own
  commands.
- **Claude Code's command sandbox** with `claudeCode.sandbox: on` (#1134): Bash runs in Claude
  Code's OS sandbox (bubblewrap and socat on Linux, Seatbelt on macOS) with the same settings as
  on the ACP route, and the session fails to start without it. Every command is still decided
  by ORCA. It needs `settingSources: []`, written out.

```yaml
  - id: claude
    driver: claude-agent-sdk
    claudeCode:
      settingSources: []
      sandbox: on
```
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
