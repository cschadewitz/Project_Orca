# Live missing/invalid-credential rejection: preparation

This packet prepares the one #392 acceptance row that is still evidenced only by source tests:
**a request with no credential, and one with an invalid credential, are refused by the live
agent-01 daemon.** It is preparation. Nothing here has been run against agent-01, and nothing
here authorizes running it; [Permission](#permission-required-before-live-execution) says what
does.

Examined source: main `4d5176c8d57c37f974517900935e6e28ea234082`. The installed daemon recorded
in the [13 October host record](https://github.com/cschadewitz/Project_Orca/issues/392#issuecomment-6138313527)
is main `0c75d01eb0cab389ad1cbff5d1fb9a60bfe64362`. Between the two, `auth/transport.ts`,
`auth/credentials.ts`, `auth/errors.ts`, `auth/audit.ts` and the `/rpc` refusal path in
`server.ts` are byte-identical; `auth/guard.ts` and `auth/operations.ts` only gained additions
that are not on the authentication path. So the refusals below are what the installed build
should produce, but that is a source reading, not an observation of the host.

## What this does not reopen

These are complete for their recorded scope and are not repeated or described as missing here:

- [#393's actual-Cal results](https://github.com/cschadewitz/Project_Orca/issues/393#issuecomment-6149584344)
  and [C8](https://github.com/cschadewitz/Project_Orca/issues/393#issuecomment-6149831116):
  build/identity, privacy projection, Revision, cancellation, durable answers,
  daemon-unavailable and target-change handling, bad reads, tool selection.
- [#391's ledger](https://github.com/cschadewitz/Project_Orca/issues/391#issuecomment-6149960966):
  the Casey-only connector audience and service-principal attribution.
- Revoked and restricted credentials (#598), key/credential lifecycle and network/reboot
  rehearsals (#600), continuation-response loss (#601). These stay deferred, not passed.

## Authentication layers, from Cal to a run

| # | Layer | Where it runs | What refuses a request without the right credential |
| --- | --- | --- | --- |
| 1 | ChatGPT connector and its audience | OpenAI | A conversation outside the connector's audience never gets the tools. Verified by #391; not this test. |
| 2 | Platform tunnel and runtime key | OpenAI control plane ↔ `tunnel-client` on agent-01 (outbound only) | A tunnel-client without a valid runtime key cannot register, so nothing is delivered to agent-01. No inbound listener exists to send an unauthenticated request to. |
| 3 | MCP launcher | agent-01, started by `tunnel-client` over stdio | The live host runs the retained private launcher named in the tunnel profile. The repository's reviewed launcher (`tools/deploy/private-mcp-service/launch-mcp.js`) refuses a missing or wrongly shaped token file before stdio opens. |
| 4 | `orca mcp` adapter → daemon `/rpc` | agent-01 loopback, `127.0.0.1:33871` | The adapter sends `Authorization: Bearer <ORCA_MCP_TOKEN>`; the daemon decides. |
| 4a | Daemon transport gate | `TransportGate.admit` | Peer/proxy, `Host` (loopback name), `Origin`, credential-in-URL. Refusal: **403 `AUTH_FORBIDDEN`**, before any credential is looked at. |
| 4b | Daemon credential check | `TransportGate.admit` → `CredentialStore.authenticate` | No credential: **401 `AUTH_REQUIRED`**. Malformed, unknown, wrong, expired or revoked: **401 `AUTH_INVALID`**, identical on the wire. The body is never read. |
| 4c | Operation and resource authorization | `guard.ts` | Only after 4b succeeds. Never reached by this test. |

**Where each request of this test must be refused: layer 4b, the daemon's credential check.**
The test sends from the host's own loopback, so it does not pass through layers 1–3 at all.
That is deliberate:

- Layer 1 is #391's audience result, which is complete.
- Layer 2 cannot be tested with a missing or invalid key without starting a second
  `tunnel-client` or replacing the key. The [stdio deployment limit](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#stdio-deployment-limits)
  allows one active client per tunnel ID, so a second client would disrupt the active session,
  and changing the key is a credential action. Key expiry/rotation/revocation stays with #600.
- Layer 3 on the live host is the private retained launcher, which this repository does not
  review. Pointing it at a fixture token would mean changing its configuration or starting a
  second MCP child. Neither is in scope.

So a pass here establishes that **the live daemon refuses missing and invalid ORCA credentials
at its credential check**. It does not establish anything about the tunnel key, the launcher,
revocation or in-flight fencing.

## Telling the boundaries apart without exposing a credential

Each request leaves two independent traces: the HTTP response the helper keeps, and one line the
daemon appends to its own audit log (`<auth dir>/audit.jsonl`, owner-only). The audit line holds
the reason the caller is never told.

| Boundary that refused | HTTP response | Daemon audit record in the window |
| --- | --- | --- |
| **4b credential check (expected)** | 401, `WWW-Authenticate: Bearer realm="orca"`, `Connection: close`, body exactly `{"kind":"response","id":0,"ok":false,"error":{"code":…,"message":…}}`. `id: 0` rather than the request's own id shows the body was never read. | `authn.denied`, `transport: http`, no `actor`, `remote: 127.0.0.1`, reason `missing` / `malformed` / `unknown`. The `unknown` record carries the fixture's public credential id as its target. |
| 4a transport gate | 403 `AUTH_FORBIDDEN`, `id: 0` | `authn.denied` with reason `host-not-loopback`, `origin-not-allowed`, `credential-in-url`, `direct-backend-bypass` or `proxy-not-https`. |
| Something other than the daemon (a proxy, a different listener) | Anything else: another status, a different `WWW-Authenticate`, another body shape | No matching record. |
| Layer 1–3 (not exercised) | Nothing reaches the daemon | No daemon record; any trace is in OpenAI's logs or the tunnel-client journal. |

The helper's correlator (`correlate`) pairs each request with exactly one such record by time
window, code, reason, loopback peer and, for the third request, the fixture credential id. It
outputs only those fields for the matched records and a count by event type of every other
record in the window. Principal names, credential ids of real credentials, run ids and other
records' contents never enter its output.

## The three requests

`tools/auth-negative-test/probe.js` sends these, in order, once each, as `POST /rpc` with body
`{"kind":"request","id":"an392-…","method":"hello","params":{}}`. `hello` is read-only and a
refusal never reads the body anyway.

| # | Authorization header | Expected | Audit reason |
| --- | --- | --- | --- |
| 1 | none | 401 `AUTH_REQUIRED` "authentication required" | `missing` |
| 2 | `Bearer orca-negative-fixture-392-not-a-credential` | 401 `AUTH_INVALID` "invalid credentials" | `malformed` |
| 3 | `Bearer orca1.negfix392zzz.negative_fixture_392_not_a_credential______` | 401 `AUTH_INVALID` "invalid credentials" | `unknown`, target `negfix392zzz` |

Why these are not credentials and not a brute-force attempt:

- Fixture 2 does not match ORCA's token shape (`orca1.<12>.<43>`), so it is refused before the
  credential store is consulted.
- Fixture 3 has the token's shape so that the store lookup runs, but its id and secret are
  constants published in this repository. Issued ids are nine random bytes and issued secrets
  32 random bytes; neither can equal a published constant unless someone deliberately creates
  such a record. If it were somehow accepted, the helper classifies that as unexpected access
  and stops.
- Two fixed values, one attempt each. No value is generated, varied or derived from anything
  on the host. There is no flag, file or environment variable through which the helper could
  send any other bearer value, and it never reads the token file, the credentials file or
  `ORCA_MCP_TOKEN`.

## The helper's safeguards

- **One explicit target.** `--endpoint` must be `http://127.0.0.1:<port>/rpc` or
  `http://[::1]:<port>/rpc`: IP literal, explicit port, exact path, no query, fragment or
  userinfo. There is no default. `--confirm` must repeat it: `auth-negative-392@127.0.0.1:<port>`.
- **Fixed count, no retry.** Three requests at most, sequentially, each on a fresh connection
  with no keep-alive pool and no proxy, and a 5-second absolute deadline per request (wall
  clock, not inactivity, so a slow-drip listener cannot extend it). No loop sends anything twice.
- **Stop on the first surprise.** Any 2xx or `ok: true` is `unexpected-access` (exit 3). A
  403 is `rejected-at-transport-gate` (exit 2). Any other non-matching response is
  `unexpected-response` (exit 2). A refused or silent connection is `unreachable` (exit 4).
  After a stop, no further request is sent.
- **Sanitized evidence.** An unexpected body is kept only as its length and SHA-256. A body
  over 4,096 bytes is not read to the end: the connection is closed at the cap and the record
  says `bodyTruncated: true`, `bodyBytesAtLeast`, `bodySha256: null`. The
  fixture values themselves are not written to the evidence; it records probe names.
- **One run, one directory.** `--evidence-dir` must not exist; it is created `0700`, and
  `evidence.json` is written `0600` with the helper's own SHA-256. `--approval-ref` must link
  the GitHub comment recording the permission.
- **No dependencies.** Only Node built-ins, so the file can be copied alone to the host and its
  hash checked against the reviewed commit.

## Ownership and scheduling

The daemon also serves Cal's active session through the tunnel. A refused request changes no
credential, ownership or run state (refusals are header-only and the credential store is only
read), and the daemon has no lockout, so the test cannot lock out the service credential. The
risks left are scheduling ones: an observer confusing the denials with an attack, or a
concurrent session's records crowding the correlation window.

- **Operator:** Casey, on agent-01, as the `casey` user that owns the daemon. No one else runs
  it, and no agent runs it from a session.
- **Coordinator:** calciferschadewitz (Cal) prepares the window and reads back the results.
  Cal's own connector session must be **idle for the whole window**: no conversation turn in
  progress, no pending mutation or uncertain admission. Cal states this on the permission
  thread before the window opens.
- **Window:** one stated UTC window of at most 15 minutes, with no planned restart, upgrade,
  credential change or other test on agent-01 overlapping it. Do not start one if the daemon or
  tunnel has restarted since the window was agreed: a restart rotates the bootstrap credential
  and changes the boot identity, and that needs its own review.
- **Do not restart anything.** The procedure stops nothing, starts nothing, and never touches
  the tunnel, the launcher, the daemon configuration, the audience or any credential.

## Permission required before live execution

A comment on #392 from Casey that states all of:

> Approve one run of the #392 auth-negative probe: `tools/auth-negative-test/probe.js` at commit
> `<reviewed sha>` (SHA-256 `<hash>`), on agent-01 as `casey`, against
> `http://127.0.0.1:33871/rpc` only, three requests and no retries, in the window
> `<start>`–`<end>` UTC. Includes read-only `systemctl --user show` and `stat`/`wc -l` of the
> daemon's auth directory files and audit log before and after, and running the correlator on
> the audit log. No restart, configuration, tunnel, audience or credential change.

That comment's URL is the `--approval-ref`. Anything outside it - another endpoint, another
host, a second run, a variation of the fixtures - needs a new comment.

## Procedure

`<auth dir>` is the daemon's private auth directory and `<node>` the reviewed Node binary from
the installed unit; neither path is published. Run everything through the same clean entry
the runbook uses: `/usr/bin/env -i HOME=… PATH=… LANG=C`.

**1. Preconditions.** Copy only `tools/auth-negative-test/probe.js` from the approved commit
to a private directory and check `sha256sum` matches the approved hash. Confirm Cal has
declared the session idle. Then:

```sh
<node> probe.js plan --endpoint http://127.0.0.1:33871/rpc
```

`plan` sends nothing. Check it lists exactly three requests and `retries: 0`.

**2. Baseline.** Record, privately:

```sh
systemctl --user show orca-daemon.service orca-tunnel.service \
  -p Id,ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp
stat -c '%n %s %Y %i' <auth dir>/credentials.json <auth dir>/ownership.json <auth dir>/audit.jsonl
wc -l < <auth dir>/audit.jsonl
```

If either unit is not `active/running`, stop: there is nothing to test against safely.

**3. Run, once.**

```sh
<node> probe.js run --endpoint http://127.0.0.1:33871/rpc \
  --confirm auth-negative-392@127.0.0.1:33871 \
  --approval-ref <permission comment url> --evidence-dir <new private dir>
```

Exit 0 and `"outcome": "all-rejected"` is the only result that continues. Anything else: go
to [Stop](#stop).

**4. After.** Repeat step 2. Expected: same `MainPID`, `NRestarts` and start time for both
units; `credentials.json` and `ownership.json` unchanged in size, mtime and inode;
`audit.jsonl` grew by exactly 3 lines if the session stayed idle. More lines than that is not a
failure by itself; the correlator says whose they were by event type.

**5. Correlate.**

```sh
<node> probe.js correlate --evidence <dir>/evidence.json \
  --audit-log <auth dir>/audit.jsonl --out <dir>/correlation.json
```

Exit 0 and `"verdict": "daemon-credential-boundary-confirmed"` means each request was matched
to its own `authn.denied` record with the expected reason, from loopback.

**6. Report.** Post on #392: the approved commit and helper hash, the window, `evidence.json`
and `correlation.json` (both are already sanitized), and the before/after comparison as
"unchanged / grew by N", not the raw `stat` output. Leave #392 and #327 open for independent
verification of that record.

### Stop

On any non-zero exit, any changed unit PID or restart count, any change to `credentials.json`
or `ownership.json`, or a correlation verdict other than confirmed:

1. Send nothing more. Do not re-run, vary the fixtures or try another endpoint.
2. If the outcome was `unexpected-access`, treat it as a security finding: tell Casey at once,
   keep the evidence directory, and do not post the details publicly until Casey decides.
3. Otherwise record the outcome and exit code on #392, keep the evidence privately, and
   leave the row unverified. A `rejected-at-transport-gate` or `unexpected-response` result
   means the request did not reach the boundary under test, which is a finding about the
   setup, not a pass.

## Owner-coordination items (not actions here)

These are dependencies to keep in view when picking the window. This packet does not act on
any of them.

- The deployed ORCA service credential expires **2026-11-04** (13 October host record). A
  window after that date tests a daemon whose service credential has lapsed, and Cal's
  session would already be failing. Run before then, or after a separately approved renewal.
- The tunnel runtime key has its own expiry in the Platform API keys list. Its lifecycle is
  #600's.
- A daemon restart rotates the bootstrap owner credential and changes the boot identity
  (13 October record). The window must not straddle one.
- Revocation of a live credential, and restricted readers, are #598's. A pass here is not
  evidence for either.

## Source-tested versus live-unverified

| Claim | Status |
| --- | --- |
| Daemon refuses a missing credential with 401 `AUTH_REQUIRED` before reading the body | Source-tested: `packages/daemon/test/security-http.test.ts`, and here against the real daemon `/rpc` |
| Malformed/unknown/mismatched/expired/revoked credentials get the identical 401 `AUTH_INVALID`, reasons only in audit | Source-tested: same file |
| The helper sends exactly three fixed requests, never retries, stops on access/other refusal/unreachable, keeps no unexpected body | Source-tested: `tools/test/auth-negative-probe.test.js` |
| The correlator confirms only on the daemon's own matching records and leaks no other record | Source-tested: same file |
| A non-loopback `Host` is refused at the transport gate (403), and is reported as not reaching the credential check | Source-tested: same file |
| **The live agent-01 daemon refuses missing and invalid credentials at its credential check** | **Live-unverified.** Awaiting the permission and run above |
| Tunnel runtime-key, launcher-level and revocation refusals | Out of scope here; #600, #598 |
