# Tool-call telemetry from native pre-tool hooks

Issue #1000. An agent whose native pre-tool hook ORCA installs (`nativeToolHook: on`, #704
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
    nativeToolHook: on
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
   spool (`recordHookTelemetry`): a single synchronous append to a file that must already
   exist, never creating one, never following a link and never blocking, at most 8 KiB per
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
backup, carryover or SQLite conversion copies it with the rest of the store.

`diagnostics/` is in the store's agent-denied set, beside `private-execution`: no agent tool
may read or write it. Owner-only modes do not stop a process of the same user, so every open
is checked as well: directories must be real, owner-only directories of ORCA's user, and
files are opened without following links and without blocking (a FIFO or device in a file's
place cannot hold a reader or writer), and must be regular, owner-only files of ORCA's user
with one name. Anything else is refused, not read or written through. (Windows has no
POSIX modes; there the protected directory and the link refusal are the boundary.)

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

Deleting is final for what was deleted, from the moment its marker is durable. A deletion
first writes a small marker (a new file, flushed, renamed into place, its directory flushed)
and only then removes the records. From then on the marker decides: the run's (or session's)
records are never listed, exported or counted, and records that arrive later, from a session
still running, are refused and dropped. If the deletion stops after the marker, the records
left on disk stay hidden and the next `prune` removes them; if it stops before, nothing was
deleted, and deleting again is the remedy. Markers are kept for good: the store cannot know
that no session of the run will ever run again (a resumed run opens new ones), and a marker
is a few bytes.

## The hook's side

The hook programs emit lines in a follow-up to the hook adapters (#704 Claude, #705 Codex):
the session code opens the spool with `openHookTelemetrySpool` when the agent keeps tool
calls, puts its path in the hook context, exposes it as the session's `hookTelemetry`, and
calls its `finish()` when the session ends. Until then no session has a spool, and with the
option on, nothing is recorded.
