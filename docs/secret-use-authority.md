# Secret use authority (#336, part B)

Part A (#920) shipped secret references with delivery switched off: `openAcpSession` refuses
a delivery without an `authorizeSecretUse` decision, and nothing in the daemon or CLI makes
one. This document defines that decision and the metadata methods it rests on. It is the
contract part B implements.

## What a grant is

A credential record gains an optional `secrets` field: the secret references its principal
may use.

```jsonc
{
  "principal": "ci-bot",
  "permissions": ["runs.read", "runs.start", "secrets.use"],
  "secrets": [
    { "secret": "github-token", "provider": "file", "host": "build-box", "binding": "h1:…" },
  ],
}
```

- An entry names a secret id, its provider, the host it is bound to **and** that host's
  endpoint binding: a digest of what decides which machine and account the host runs on
  (for SSH: `host`, `user`, `port`, `identityFile`, `sshArgs`, `sshBinary`, `remoteShell`;
  not tuning such as `workspaceRoot` or timeouts). If `orca.config.yaml` later binds the id
  to another host or provider, or points the same host id at another endpoint, the grant
  does not follow it: the next use is refused before the host reads anything, until a grant
  names the new binding. Rotating the value at the same binding needs no new grant. Which
  machine an SSH destination actually reaches is still ssh's to verify (its host keys). `"*"` grants every reference and is what the `owner`
  preset expands to.
- Absent means none. No other preset grants any.
- Two new permissions:
  - `secrets.use`: the principal's runs may receive values for its granted references.
  - `secrets.read`: `secrets.list` and `secrets.check` (below). This is a workspace
    permission, so a restricted principal cannot hold it.
- `orca auth issue --secret <id>@<host>` (repeatable) and `--secret '*'` write the field and
  add `secrets.use`. The id must be configured and bound to that host when the credential is
  issued; the provider and the endpoint binding are taken from the config at that moment. `rotate` keeps the grant. `revoke` ends
  it with the credential.

## The use decision

`Orchestrator.secretUse({ runId, uses })` is asked at every session open, after the catalog
and host checks and before the host reads anything. The daemon answers it like this:

1. Find the run's root and the root's workflow, and the principal recorded as owning the
   root (`OwnershipStore`, the same record run access uses). A run with no recorded owner is
   refused.
2. Verify that ownership is **durable**: it is read back from the ownership file, not from a
   pending attribution still in this process's memory. Admission flushes it before
   execution starts, so a run that got that far always has it.
3. Load that principal's credentials **now**, not the ones it had at launch. A credential
   counts only if it is not revoked and not expired. Revocation or expiry therefore stops
   the next session open.
4. Each use must be covered by **one** current credential that, on its own:
   - holds `secrets.use`,
   - has a workflow scope that includes the root's workflow, and
   - has a `secrets` grant naming that secret id with its exact provider, the host it is
     bound to now and that host's current endpoint binding (or is `"*"`).

   Two credentials of the same principal never combine: a credential scoped to another
   workflow does not lend its grant to one that lacks it.
5. Anything else is refused with `CONFIG_INVALID`, `details { secret, reason:
   "unauthorized", hostId }`. The message does not say which credentials exist.

Principals that do not come from a credential:

- **Loopback compatibility mode** (`LOCAL_PRINCIPAL`). It already holds every owner
  permission, so it gets `"*"`, but only while the daemon is running in that mode.
- **Standalone OS-user mode** (no credentials or token file). The verified OS user owns the
  config directory, and the secrets it declares, outright, so runs it durably owns get
  `"*"`. The grant is re-checked at each decision: it ends the moment a credentials file
  exists, or if the config or store directory is not owned by that user.

Where it is wired:

| Path                                                                 | Authority                                                   | Audit               |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------- |
| `orca serve` (token mode)                                             | the owner's credentials                                     | `auth/audit.jsonl`  |
| `orca serve --unauthenticated-loopback`                               | `"*"`; that mode records no owners                          | none                |
| Local CLI in a fresh process: `run`, `submit`, `resume`, `answer`, … | the owner's credentials, or standalone OS-user mode         | `auth/audit.jsonl`  |
| `orca agent ping` (ephemeral)                                          | none: ping never delivers                                   | none                |

A direct `orca run` with `--cwd` or selection overrides starts without admission and so
records no owner. It does not support secret references: a step that uses one fails with
`unauthorized` before anything is read.

Every audited decision records principal, run, secret ids and outcome, never a value.

## SSH launch boundary

On an SSH host the remote shell that reads the values also starts the agent (part A). That
shell is a controlled boundary that fails closed:

- Tracing is switched off (`set +xv`) and the shell's stderr goes to `/dev/null` while any
  value is in a variable, so an `xtrace` a login profile turned on, or a shell error, cannot
  print a value or its base64. Stderr is restored only for the agent.
- After each withheld variable is unset and each agent variable exported, the shell checks
  that it took. If not (a readonly variable, for example), it reports a failure and exits
  before the agent starts, and the open fails with `AGENT_TRANSPORT`.
- Each value is reported to the wrapper in base64 for redaction. An encoder that fails or
  prints nothing stops the shell; the wrapper accepts a report only if every expected
  secret has exactly one non-empty, canonical base64 report. The agent starts only after the
  wrapper has checked them and written a go line to the shell; on any reporting failure it
  writes nothing, kills the connection, and the agent never starts.
- A secret value is UTF-8 text. A report is accepted only if its bytes decode as UTF-8 with
  nothing replaced and encode back to exactly the same bytes, so the text redacted is the
  text the agent receives; anything else is refused before the agent starts. A local host
  refuses a file that is not UTF-8 text the same way (`reason: unsupported`).
- Redaction covers each value's base64, unpadded base64 and base64url forms as well as the
  value itself.

## Lifetime

- A value is read at each session open. A `per-run` session keeps the values it was opened
  with until it closes. The next open asks the decision again.
- A resumed run asks again at its first session open. Nothing from an earlier interpreter
  is replayed.

## Metadata methods

Protocol 2.6 (`packages/protocol/src/secrets.ts`, answered by `SecretsReadModel` in
`packages/daemon/src/secrets-model.ts`):

| Method          | Permission     | Returns |
| --------------- | -------------- | ------- |
| `secrets.list`  | `secrets.read` | `{ secrets: [{ id, host, provider, description? }] }`, sorted by id. A principal whose grant is not `"*"` sees only the ids its grant names with the provider, host and endpoint binding each has now. `name` (env) or `path` (file) only with `config.read`. |
| `secrets.check` | `secrets.read` | `{ id, host, available, reason? }` for one visible reference, checked on its own host **without** reading the value. `reason` is `missing`, `unreachable`, `unknown-host` or `busy`. A reference outside the caller's grant is refused as not found (`CONFIG_INVALID`, `reason: "not-found"`) and never checked. |

How a check works:

- **Local host.** An env variable is set and non-empty; a file is a regular file, readable
  and non-empty.
- **SSH host.** One command on that host, metadata only there too. It first turns tracing
  off and sends stderr to `/dev/null` (`{ set +xv && exec 2>/dev/null; } || exit 4`); if
  the shell cannot do that, the check stops and reports `unreachable`. An env variable is
  then tested with `sh -c '[ -n "${NAME:+x}" ]'`: a child shell sees exported variables
  only, as delivery does, and `${NAME:+x}` never expands the value, so it is not printed,
  piped to another program or compared. A file is tested with `test -f/-r/-s`. Exit 0 is
  available, 3 (the test failed) is `missing`, anything else (including a connection
  failure) is `unreachable`. No output is returned.
- **Bounded.** An SSH check is one `ssh` process run for its exit status alone: its
  output is discarded, never read or buffered, and it is killed after 15 seconds. At most
  four run at once across every caller; a check past that answers `busy` at once and starts
  nothing. A reference outside the caller's grant, or a caller without `secrets.read`, never
  gets that far. Local checks are not counted.

`available: true` means **present**, nothing more: the variable is set and non-empty, or the
file is readable and non-empty. It does not prove that the value is right, that it is UTF-8
text the session can take, or that a run will be allowed to use it: that is the use decision
at session open, made from the run owner's grant, and delivery can still refuse.

The caller's principal is read at each call: in token mode its credential is re-checked, so
a revoked or narrowed grant stops showing what it no longer covers. Neither method ever
returns a value, and neither falls back to another host.

## Catalog MCP servers (#337)

The same decision, made the same way, gives a session a catalog MCP server.
`Orchestrator.capabilityUse({ runId, uses })` is asked at every session open whose step
selects one, pooled `per-run` sessions included, before anything starts. Each use is
`{ kind: "mcpServer", id, hostId, hostBinding, definition, absoluteCommand }`, where `definition` is
`mcpServerDefinitionDigest` (`m1:` plus 32 hex digits of a sha256 over the server's
command, arguments and environment, with secret references as references).

- A credential's optional `capabilities` grant is `"*"` or a list of `{ kind: "mcpServer",
  id, host, binding, definition }`. The `owner` preset grants `"*"`; no other preset grants
  any. `orca auth issue --mcp-server <id>@<host>` (repeatable) or `--mcp-server '*'` writes
  it and adds the `capabilities.use` permission; the definition and binding are taken from
  the config at that moment.
- Steps 1 to 5 above apply, with `capabilities.use` in place of `secrets.use` and the grant
  naming that server id, defined exactly that way, on the agent's host and its current
  endpoint, with one difference: **one** current credential must cover the whole selected
  set together, not each server on its own. A session is given its servers as a set, so
  two credentials granting one server each do not combine into both.
- A named grant covers a server only when its `command` is an absolute path
  (`absoluteCommand`), so the definition pins the executable. A command found by `PATH`
  search or relative to the working directory is covered only by `"*"`, and `orca auth
  issue --mcp-server` refuses to write a named grant for one. A refusal is `CONFIG_INVALID`, `details { kind, id, hostId, reason:
  "unauthorized" }`, audited as `capability.use`.
- Loopback and standalone OS-user mode get `"*"` exactly as they do for secrets.
- After the decision, the server's command is resolved on the agent's host to an
  executable regular file, and the agent is handed that absolute path (see
  docs/WORKFLOWS.md for what a grant covers of the arguments and environment). Any secret reference in the server's `env` is then read like every
  other reference in that session: on the agent's host, under `secrets.use`, with no
  fallback to another host.
- `agents.ping` has no run and so no owner: it starts only the agent's own inline servers.

## Ping

`agents.ping` keeps refusing to deliver (part A). Diagnostics do not need the credential.

## Out of scope

- Delegated sessions on a remote daemon (#883) resolve on that daemon under its own grants.
- The app's reference picker builds on `secrets.list` and `secrets.check`. It lands with the
  #335 desktop authoring screens, where an agent's and an MCP server's `env` are edited.
