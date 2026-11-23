# Bring-your-own-key judge credentials on #336 secret references (#701)

Status: **implemented, not activated.** `packages/agents/src/review-judge/secret-credentials.ts`
implements the connection's `JudgeCredentialService` (see [connection preparation](connection-preparation.md))
on the merged #336 secret references and use authority (#920, #933). Nothing registers a judge yet.

## Configuration

```yaml
secrets:
  judge-key:
    host: local              # the daemon's own machine
    provider: env            # or file
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
| Every use asks the run-bound #336 use check first, with the same `SecretUse` a session open sends (secret, provider, host, endpoint binding, agent). A revoked or expired grant stops the next use; a refused use reads nothing. | `withCredential` |
| Nothing is cached: the catalog is re-read at every describe and use, the value at every use. Rotation needs no restart; re-pinning or re-binding stops the next use. | `withCredential` |
| The sender gets a handle, not a string. `reveal()` works only during the one `consume` call; `JSON.stringify`, `String` and `util.inspect` never show the value. | `leasedCredential` |
| Every refusal is a fixed code (`JudgeSecretRefused.code`), never a value, path contents or provider text. The connection reports all of them to the adapter as `transport-failed`. | `withCredential` |

## Tests

`packages/agents/test/review-judge-secret-credentials-701.test.ts` drives the unchanged connection and
endpoint adapter with this service and a deterministic fake endpoint: end-to-end `fit`, rotation and
revocation between uses, file and env providers, every refusal above, cancellation before and after the
read, and the agent/MCP refusals. The value is generated per run; no network, real key or paid call.

## Still open for #701

- A real sender for an HTTPS endpoint (bounded read, no redirects, no retries, key only in a header).
- #363 disclosure grants: the grant service is still the proposed contract with fakes.
- The profile-level judge floor decision and production registration/activation.
