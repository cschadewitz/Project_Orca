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
  "secrets": [{ "secret": "github-token", "host": "build-box" }],
}
```

- An entry names a secret id **and** the host it is bound to. If `orca.config.yaml` later
  binds the same id to another host, the grant does not follow it: the next use is refused
  until a grant names the new binding. `"*"` grants every reference and is what the `owner`
  preset expands to.
- Absent means none. No other preset grants any.
- Two new permissions:
  - `secrets.use`: the principal's runs may receive values for its granted references.
  - `secrets.read`: `secrets.list` and `secrets.check` (below). This is a workspace
    permission, so a restricted principal cannot hold it.
- `orca auth issue --secret <id>@<host>` (repeatable) and `--secret '*'` write the field.
  `rotate` keeps it. `revoke` ends it with the credential.

## The use decision

`Orchestrator.secretUse({ runId, uses })` is asked at every session open, after the catalog
and host checks and before the host reads anything. The daemon answers it like this:

1. Find the run's root, and the principal that durably owns it (`OwnershipStore`, the same
   record run access uses). A run with no recorded owner is refused.
2. Load that principal's credentials **now**, not the ones it had at launch. A credential
   counts only if it is not revoked and not expired. Revocation or expiry therefore stops
   the next session open.
3. Each use must be covered by at least one current credential that holds `secrets.use`
   and whose `secrets` grant names that secret id with the host it is bound to now (or is
   `"*"`).
4. Anything else is refused with `CONFIG_INVALID`, `details { secret, reason:
   "unauthorized", hostId }`. The message does not say which credentials exist.

Principals that do not come from a credential:

- **Loopback compatibility mode** (`LOCAL_PRINCIPAL`). It already holds every owner
  permission, so it gets `"*"`, but only while the daemon is running in that mode.
- **Standalone OS-user mode** (no credentials file; `local-submission-authority.ts`). The
  verified OS user owns the config directory, and the secrets it declares, outright, so it
  gets `"*"`. The same check that refuses the mode once a credentials file exists also
  refuses the grant.

Every decision is audited with principal, run, secret ids and outcome, never a value.

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
