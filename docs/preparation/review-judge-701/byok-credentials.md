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

This makes no sender trusted. The HTTPS sender below has its own rules and review, and nothing activates it.

## The HTTPS sender

`packages/agents/src/review-judge/https-sender.ts` (`createHttpsJudgeSender`) is the network sender for a
hosted judge on the user's key. It is constructed for one destination URL, which must be the same URL
the secret is pinned to (`destination`), written in canonical form: `https`, no credentials, query or
fragment, no `.`/`..` or encoded path segments. Construction refuses any other shape before a key is
touched.

| Rule | How |
| --- | --- |
| One POST to the pinned URL, TLS checks always on (TLS 1.2+), on a fresh connection | `agent: false`, `rejectUnauthorized: true`, `minVersion` |
| No redirects, no retries | any status but 200 is `http-status`; a 3xx is never followed; one request per send |
| Bounded reply | declared or streamed body past `maxResponseBytes` is cut off (`response-too-large`); non-JSON (`content-type`), compressed (`content-encoding`) and invalid UTF-8 (`malformed-utf8`) are refused |
| Cancellation | abort destroys the request and settles the send at once, so a slot is never held by a socket nobody waits on |
| The key | read from the lease inside the call, only for a `judge-secret/v1` credential pinned to this URL; must be printable ASCII with no spaces or line breaks (no header splitting); placed only in `Authorization: Bearer` or `x-api-key`, never in the version, an error or a log |
| Extra headers | fixed, non-secret, lower-case; auth, cookie, host, framing and encoding headers are refused |
| Failures | fixed codes (`JudgeSenderFailed`), never a provider message, header or body |

Its tests (`review-judge-https-sender-701.test.ts`) run the sender's real request and response
handling against a loopback fake through an injected request function, plus one end-to-end run through
`secretJudgeCredentials`, the connection and the endpoint adapter. No real key, model or paid endpoint.

The sender is **inactive**: nothing constructs one or passes it to `prepareJudgeConnection`. Wiring it
to a provider (request and reply format for a specific hosted model), registering it, and the plain-rule
evaluation slot each need their own review before anything is switched on.

## Still open for #701

- A provider adapter for the first hosted model (its request and reply format), behind the same sender.
- #363 disclosure grants: the grant service is still the proposed contract with fakes.
- The profile-level judge floor decision and production registration/activation.
