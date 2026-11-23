# Bring-your-own-key judge credentials on #336 secret references (#701)

Status: **implemented, not activated.** `packages/agents/src/review-judge/secret-credentials.ts`
implements the connection's `JudgeCredentialService` (see [connection preparation](connection-preparation.md))
on the merged #336 secret references and use authority (#920, #933). Nothing registers a judge yet.

## Configuration

```yaml
secrets:
  judge-key:
    host: local              # the daemon's own machine
    provider: env            # env only for now: a file-backed judge key is refused
    name: JUDGE_API_KEY
    destination: https://judge.example/v0   # the one endpoint this value may be sent to
```

A judge connection descriptor carries `judgeSecretRef("judge-key")`, an opaque
`{ kind: "credential-ref/v0", id: "secret:judge-key" }`. It holds no value.

## Rules

| Rule | Where it is enforced |
| --- | --- |
| Only a secret pinned to the judge's destination is a judge key. An unpinned one, or one pinned elsewhere, is `credential-destination-mismatch` at preparation and `wrong-destination`/`not-pinned` at use. | `describe`, `withCredential` |
| A pinned secret never reaches an agent or MCP server process. | `validateSecretReferences` (config load), `planSessionSecrets` (session open) |
| The value is read on the host the connection runs on, which must be a local host. A reference bound to another host is unavailable; nothing falls back to a value found elsewhere. | `withCredential` |
| Every local host id is one realm, the daemon's own environment. A pinned secret must be bound to a local host. Its value cannot also be declared unpinned or with another pin under any id or any local host id: two definitions reading the same variable in the same realm (compared case-insensitively) must carry the same pin. Where host types are unknown (session open, the judge service) every host counts as one realm, so more is refused, never less. On every local host id, a pinned variable is withheld from what an agent inherits. | `validateSecretReferences`, `sharesPinnedSource` at describe, use and session open |
| Every use asks the run-bound #336 use check with purpose `review-judge`, the pinned destination and the source binding (a digest of provider and variable). Only a grant entry naming that purpose and destination covers it (or `*`); an agent grant never does, and a judge grant never covers agent delivery. `orca auth issue --secret <id>@<host>` writes a judge grant for a pinned secret, taking the destination and source from the config. Rotating the value at the granted variable needs no new grant; pointing the secret id at another variable, re-pinning it or moving it to another host is not covered. | `withCredential`, daemon `grantCovers`, CLI `auth issue` |
| File-backed keys are refused (`file-unsupported`, and a config error). A path names a file only lexically; until delivery can be bound to the file a read actually opens, `provider: env` is the only judge key source. | `validateSecretReferences`, `describe`, `withCredential` |
| Ordering. Every awaited step comes first: the full use check (run root, durable owner, current grant; an unauthorized use reads nothing), the read, then the caller's last awaited check (`beforeHandoff`: the connection reads the disclosure grant there). Then, synchronously and in the turn that calls the sender: cancellation, the catalog unchanged since the read (host, source, pin), the grant re-decided from the owner's current credentials (`authorizedNow`, the daemon's `bindSecretUse`), and the connection's own disclosure revision and expiry check. A change to any of them while anything was awaited refuses before the sender runs. | `withCredential`, connection `deliver` |
| Nothing is cached: the catalog is re-read at every describe and use, the value at every use. Rotation needs no restart; re-pinning or re-binding stops the next use. | `withCredential` |
| The sender gets a handle, not a string. `reveal()` works only during the one `consume` call and stops at once if the use is cancelled, even while the sender holds it; `JSON.stringify`, `String` and `util.inspect` never show the value. | `leasedCredential` |
| Every refusal is a fixed code (`JudgeSecretRefused.code`), never a value, path contents or provider text. The connection reports all of them to the adapter as `transport-failed`. | `withCredential` |

## Tests

`packages/agents/test/review-judge-secret-credentials-701.test.ts` drives the unchanged connection and
endpoint adapter with this service and a deterministic fake endpoint: end-to-end `fit`, rotation and
revocation between uses, file and env providers, every refusal above, cancellation before and after the
read, and the agent/MCP refusals. The value is generated per run; no network, real key or paid call.

This makes no sender trusted. A real network sender is separate work with its own review, and nothing here activates one.

## Still open for #701

- A real sender for an HTTPS endpoint (bounded read, no redirects, no retries, key only in a header).
- #363 disclosure grants: the grant service is still the proposed contract with fakes.
- The profile-level judge floor decision and production registration/activation.
