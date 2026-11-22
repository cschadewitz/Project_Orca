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
  "secrets": [{ "secret": "github-token", "provider": "file", "host": "build-box" }],
}
```

- An entry names a secret id, its provider **and** the host it is bound to. If
  `orca.config.yaml` later binds the same id to another host or another provider, the grant
  does not follow it: the next use is refused until a grant names the new binding. `"*"` grants every reference and is what the `owner`
  preset expands to.
- Absent means none. No other preset grants any.
- Two new permissions:
  - `secrets.use`: the principal's runs may receive values for its granted references.
  - `secrets.read`: `secrets.list` and `secrets.check` (below). This is a workspace
    permission, so a restricted principal cannot hold it.
- `orca auth issue --secret <id>@<host>` (repeatable) and `--secret '*'` write the field and
  add `secrets.use`. The id must be configured and bound to that host when the credential is
  issued; the provider is taken from that binding. `rotate` keeps the grant. `revoke` ends
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
   - has a `secrets` grant naming that secret id with its exact provider and the host it is
     bound to now (or is `"*"`).

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
- Redaction covers each value's base64, unpadded base64 and base64url forms as well as the
  value itself.

## Lifetime

- A value is read at each session open. A `per-run` session keeps the values it was opened
  with until it closes. The next open asks the decision again.
- A resumed run asks again at its first session open. Nothing from an earlier interpreter
  is replayed.

## Metadata methods

These land in the PR after the use decision (with the app's reference picker, part B2). The
permission and the grant they read are already in place.

| Method          | Permission                     | Returns                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets.list`  | `secrets.read`                 | Every configured reference's id, host, provider and description. A principal whose grant is not `"*"` sees only its granted ids. No variable names or paths unless it also holds `config.read`.                                                                                     |
| `secrets.check` | `secrets.read` (and the grant) | `{ id, available, reason? }` for one reference, checked on its own host **without** reading the value: a local env variable is set and non-empty, or a file exists and is readable; on SSH, one `test` in the remote shell. A reference outside the caller's grant is not found. |

Neither method ever returns a value, and neither falls back to another host.

## Ping

`agents.ping` keeps refusing to deliver (part A). Diagnostics do not need the credential.

## Out of scope

- Delegated sessions on a remote daemon (#883) resolve on that daemon under its own grants.
- The app's reference picker (part B2) builds on `secrets.list`.
