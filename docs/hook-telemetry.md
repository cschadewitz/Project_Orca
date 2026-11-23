# Tool-call telemetry from native pre-tool hooks

Issue #1000. An agent whose native pre-tool hook ORCA installs (`nativeToolHook: experimental`, #704
for Claude Code and #705 for the rest) runs that hook on every tool call the hook covers,
including calls the agent never asks ORCA about. With telemetry on, the hook also leaves a
record of each call it decided, and ORCA keeps those records in the store with the run.

Telemetry is diagnostic. It is never an audit record, it never decides anything, and a hook's
answer never waits for it.

## Turning it on

Off by default, per agent:

```yaml
agents:
  - id: claude
    command: claude-agent-acp
    nativeToolHook: experimental
    diagnostics:
      toolCalls: keep   # default off: nothing is recorded
      retainDays: 30    # 1 to 365, default 30
```

`toolCalls: keep` without an installed hook records nothing. An `orca-daemon` agent cannot
keep tool calls: its remote daemon's own agents do the work, so keep them there.

## What a record holds

One record per tool call the hook decided:

| Field | Where it comes from |
| --- | --- |
| `runId`, `sessionId`, `stepRunId`, `agentId` | ORCA: whose spool the line came from |
| `seq`, `receivedAt`, `expiresAt` | ORCA: ingestion order, ORCA's clock, `retainDays` after receipt |
| `source` | always `hook-reported` |
| `reportedAt`, `tool`, `toolUseId`, `kind`, `title`, `input`, `decision`, `rule`, `latencyMs`, `hookError` | the hook, as reported |

`decision` is `allow`, `ask`, `deny`, or `block` (the hook's own failure, which blocks the
call). Every text field is cut to a fixed bound (`TOOL_TELEMETRY_LIMITS`) with the length it
had before; `input` is JSON-encoded and cut to 2,000 characters, the same bound as a tool
call's args in the run log. Every field from the hook is redacted of the secret values the
run's sessions resolved and of its sensitive inputs (#336), the same redaction the run log
gets.

Coverage is the hook's coverage. A call the hook does not see (see
`docs/agent-hook-coverage.md`: for example Codex `write_stdin`, or a provider's hosted
search) has no record, and no record implies one.

## How records reach the store

The hook runs under the agent's runtime and has no access to ORCA's store.

1. Before the agent starts, ORCA creates an empty spool file, exclusively and owner-only, in
   the private directory that already holds the hook's context file, and remembers which file
   it made. That directory must be inside ORCA's agent-denied paths (the store's
   `private-execution`), and be a real, owner-only directory of ORCA's user; otherwise no
   spool is made. The path goes into the hook's context.
2. After the hook has decided a call and written its answer, it appends one JSON line to the
   spool (`recordHookTelemetryAsync` in the hook program, `recordHookTelemetry` where a
   synchronous call is wanted): a single append to a file that must already
   exist, never creating one and never following a link, at most 8 KiB per
   line and 4 MiB per spool. The hook's context carries the spool's path and the device and
   inode ORCA made it with; the hook writes only if the open file is that one, a regular,
   owner-only file of its user with one name. It never throws or prints, and the hook ignores whether it worked.
3. While the session runs, ORCA drains the spool every few seconds, and once more when the
   session ends, after which the spool is removed.

The hook runs in the agent's process tree, so the agent could write the spool as well. ORCA
treats every line as untrusted: a line that is too long, is not JSON, or is not exactly a v1
line (`HookTelemetryLineSchema`, which has no field for a run or session) is dropped and
counted; a spool that is no longer the file ORCA made, is a link, has a second name, is owned
by another user or is open to group or others is not read again; at most 20,000 lines are
taken from one session. A failed store write drops that batch and never fails the step.

After a crash, a spool left behind is discarded, never ingested: only the process that made
it knew which run and session it belonged to. `sweepHookTelemetrySpools` removes the spools
whose process (recorded in the file name) has exited; the session factory runs it where it
sets up the hook directory, before any session opens.

## Where they are kept

`<store>/diagnostics/tool-calls/<run>/<session>.jsonl`, on either metadata backend. It is a
new directory: the store's format epoch does not change, an earlier ORCA ignores it, and a
backup, carryover or SQLite conversion copies it with the rest of the store. The hook's
per-session files (`private-execution/tool-hooks`: each session's context and spool, whose
lines are not redacted yet) are not: every store copy leaves that directory out.

`diagnostics/` is in the store's agent-denied set, beside `private-execution`: no agent tool
may read or write it. Owner-only modes do not stop a process of the same user, so every open
is checked as well: directories must be real, owner-only directories of ORCA's user, and
files are opened without following links and with `O_NONBLOCK`, so that a FIFO or device
put in a file's place cannot hold the open; it then fails the check. (That flag only affects
the open: reading and writing a real file is ordinary file I/O.) Files must be regular,
owner-only files of ORCA's user with one name. Anything else is refused, not read or written through.

**Linux and macOS only.** These checks rest on `O_NOFOLLOW` and POSIX owners and modes, which
Windows does not have. On Windows ORCA keeps no tool-call diagnostics at all: no spool is
made, the store refuses every operation, and `orca diagnostics tool-calls` says it is not
supported there.

Every change to a run (appending, deleting, expiring) holds that run's lock, which is kept
outside the run's directory so removing the directory never removes a held lock.

## Export, deletion and retention

```sh
orca diagnostics tool-calls runs                         # runs that have records
orca diagnostics tool-calls export <runId> [sessionId]   # one JSON record per line
orca diagnostics tool-calls delete <runId> [sessionId]   # remove a run's or one session's
orca diagnostics tool-calls prune                        # remove every expired record
```

An expired record is never listed or exported, whether or not a sweep has removed it yet.
Expired records are also removed while ORCA ingests new ones, at most once an hour.

Deleting is final for what was deleted, from the moment its marker is written. A deletion
first writes a small marker (a new file, flushed, renamed into place, its directory flushed)
and only then removes the records. That holds across an ORCA crash. Across a power cut it
holds only as far as the flushes reach: the first write under a newly made directory does
not flush every ancestor made with it, so a power cut just after such a write can lose the
marker. From then on the marker decides: the run's (or session's)
records are never listed, exported or counted, and records that arrive later, from a session
still running, are refused and dropped. Listing runs checks markers before opening anything
they hide, so a leftover file cannot stop other runs being listed. If the deletion stops after the marker, the records
left on disk stay hidden and the next `prune` removes them; if it stops before, nothing was
deleted, and deleting again is the remedy. Markers are kept for good: the store cannot know
that no session of the run will ever run again (a resumed run opens new ones), and a marker
is a few bytes.

## The hook's side

ORCA's pre-tool hook records every call it answers, for Claude Code (#704) and Codex (#705)
alike, once
the hook itself is installed. It is still off in shipped builds (#704), so until it is turned
on nothing is recorded, whatever `diagnostics.toolCalls` says. When it is on:

- When the agent keeps tool calls, the session code opens the spool with
  `openHookTelemetrySpool` beside the hook's context file, in the store's
  `private-execution/tool-hooks`, and puts its path, device and inode in the context as
  `telemetry`. It hands the spool to the session as `hookTelemetry`, and `cleanup` calls its
  `finish()` (one last drain, then the spool is removed) before the context goes.
- The hook builds one line per answered call: the tool, its id, the kind and title it decided
  on, its input, the policy's answer (`allow`, `ask` or `deny`), the reason as `rule`, and how
  long it took. For Codex the answer recorded is the policy's, though the hook blocks an
  `ask` there. A call it could not decide is `block`, with `rule: "hook-error"` and the reason
  in `hookError`; a frame it could not read is recorded as tool `(unreadable)`.
- Recording is kept apart from the decision. The answer and exit code are settled first; a
  line that cannot be built is dropped, never the answer. The hook program does not write the
  line itself: once its answer is out, it hands the line over a pipe to a detached recorder
  (the same program, run as `--record-telemetry`, sharing none of the hook's streams) and
  exits without waiting for it. A slow or stuck spool holds only the recorder, which gives up
  after 2 seconds, never the hook or the agent waiting for it. Whether the line was written
  changes nothing. A context `telemetry` that is not an absolute path, decimal device and inode is an
  unreadable context, which blocks the call as any unreadable context does; a spool anywhere
  but the context's own directory records nothing.
- A line too long for the 8 KiB limit leaves things out whole, never cut, because a cut could
  end inside a secret ORCA would then not recognize to redact: first the input's long values,
  then the title, then the whole input, each replaced by a note of its length. A line whose
  bare fields still do not fit is not written.
- ORCA's own startup probe of the Codex hook records nothing.
- The session factory discards spools a stopped process left behind
  (`sweepHookTelemetrySpools`) once, before the first hooked session opens.
