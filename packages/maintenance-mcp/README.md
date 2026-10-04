# Independent maintenance MCP — inactive first increment

Preparation for [#483](https://github.com/cschadewitz/Project_Orca/issues/483).
This is a closed read-only contract, an SDK stdio entry function, a refusing production
adapter, and synthetic tests. **It is not deployable maintenance access.** Nothing installs,
starts, enables, connects to, or grants authority on agent-01. The issue remains open for
production observation, activation and access acceptance.

The package depends only on the repository's already selected MCP server SDK **2.2.0**
and Zod **4.6.5**, pinned exactly. It imports no ORCA daemon, store, engine, credentials,
configuration or launcher. Its separate build is `pnpm --filter @orca/maintenance-mcp build`.
There is deliberately no executable bin, start script, service unit, production config,
tunnel profile, key example or activation command. Importing the package has no transport
or observation side effects. The source API `serveMaintenanceStdio()` starts a local
stdio session only when explicitly called; it always uses the refusing adapter.

## Implemented API

All tool arguments are strict closed objects, with no coercion. `tools/list` advertises
exactly these four tools, all read-only, idempotent, non-destructive and closed-world.
No resources, prompts, subscriptions, raw-log export, restart, stop, enable, repair,
auto-restart or other control tools are implemented. Unknown tools fail generically.

| Tool | Arguments | Current shipped behavior |
| --- | --- | --- |
| `maintenance_discover` | `{}` | Local contract readiness, fixed policy/hash and limits, build metadata, fresh bridge instance UUID; host boot identity unavailable |
| `get_host_health` | `{"host":"agent-01"}` | `unavailable / not_configured`; proposed mount alias is `root` |
| `get_service_health` | `{"host":"agent-01","service":"…"}` | `orca-daemon`: `not_supervised / not_configured`; all other aliases unavailable |
| `get_service_logs` | Same service target, optional enum `category`, optional integer `limit` (1–50, default 20) | `unavailable / not_configured` |

`host` is an alias, never a DNS name to resolve. `root` is a fixed proposed mount alias;
there is no mount/path input or implemented filesystem probe. Services are exactly
`orca-daemon`, `orca-tunnel`, `maintenance-bridge`, `maintenance-tunnel`. Category is
exactly `lifecycle`, `readiness`, or `resource`. There are no caller-supplied paths,
URLs, commands, environment variables, process argv, arbitrary units, journal selectors,
bus destinations, UIDs, regexes, time ranges or cursor inputs. Additional fields fail.

Observation results carry `responseAt`, `observedAt` (null when no observation), host
alias, mount/service alias, bridge instance ID and policy ID. Successful synthetic
observations have `status: ok`; observations older than 30 seconds are `stale` and retain
their original timestamp. Stale never means current health. Future timestamps, invalid
shapes, invalid counts and inconsistent capacity values are unavailable. Failed reads
have a closed reason code: `not_configured`, `busy`, `timeout`, `source_failed`,
`oversized_source`, or `invalid_source`. Exceptions and validation errors are never echoed.
`ok` means a valid fresh observation; service `state: failed` can still be an `ok`
observation. Foreground ORCA is always `not_supervised`, with no PID lookup or inference.

Discovery's build identity is package/version plus the source base revision and
`unattested-preparation`; `deployedRevision` is null. It does **not** attest the running
commit or binary. The reviewed PR SHA must be recorded independently for a future build.
`policyId` is SHA-256 of the serialized fixed policy (including limits and proposed
identities). It is an identifier, not a signature. A bridge instance UUID is newly generated
per backend lifetime and is not a credential. Host boot identity explicitly remains
`unavailable`, including when injecting synthetic observations. A production adapter must
add a reviewed boot identity mechanism and consistency checks before activation.

There is no pagination or cursor issuance/acceptance; clients receive a bounded recent
snapshot and explicit `truncated`. Principal/boot/policy cursor binding is therefore not
claimed. If cursors are added, bind and authenticate them to current principal, host boot,
bridge instance, policy, target and filters, and test revocation/restart/expiry before use.

## Service manager identities are unresolved, not interchangeable

| Alias | Proposed manager | Proposed unit | Configured manager / UID / unit |
| --- | --- | --- | --- |
| `orca-daemon` | user | `orca-daemon.service` | all null; foreground ORCA is not supervised |
| `orca-tunnel` | user | `orca-tunnel.service` | all null; unavailable |
| `maintenance-bridge` | user | `maintenance-bridge.service` | all null; unavailable |
| `maintenance-tunnel` | user | `maintenance-tunnel.service` | all null; unavailable |

These are explicit **proposals**, not assertions about agent-01. In particular, a unit
basename never identifies a service globally. A production policy must pin the actual
manager kind, numeric owner UID for each user manager, exact unit and permitted source,
then change the policy ID. The independent maintenance service user has not been named
or created, and may differ from the ORCA user. A user-manager observation may not fall
back to the system manager, root's user bus, another UID, process search or a similarly
named unit. If the approved identity is unavailable, return unavailable. A system-manager
choice requires its own reviewed exact mapping; no system-manager authority exists here.

## Observation adapter and structured log policy

`ObservationAdapter.read` is a trusted, injected implementation boundary, not a dynamically
loaded plugin and not an MCP argument. Tests inject in-memory bytes. The shipped
`unavailableAdapter` performs zero I/O and returns null for every source. Neither the
ORCA-dependent MCP backend nor its guarded launcher is reused.

Before being connected to real sources, an adapter must enforce fixed routes and the
read budget **during acquisition**, before allocating or decoding the full source. The
backend independently checks byte size before UTF-8 decode/JSON parse, validates all
fields, caps records, and projects outputs. That defense cannot prevent a buggy injected
adapter from allocating memory, executing synchronous CPU work or acquiring excessive
authority. Untrusted code is not sandboxed by a TypeScript interface. Production adapter
review and supervisor resource limits remain required.

Health fixture fields are limited to host boot UUID, uptime seconds, total/available memory
bytes and total/available root bytes, or the service state enum `active/inactive/failed`.
No hostname, PID, path, environment, command line or error text is returned from sources.
The log source format is a bounded `{observedAt, records, truncated}` JSON batch:

| Approved category | Only returned record fields, besides `observedAt` and `category` |
| --- | --- |
| lifecycle | `state`: started, stopped, failed |
| readiness | `ready`: boolean |
| resource | `resource`: memory or root; `usedPercent`: finite number 0–100 |

Unknown record types or invalid typed fields are dropped and counted in `omittedRecords`.
Extra fields on otherwise valid records, including **all message bodies**, are stripped;
affected records are counted in `recordsWithOmittedFields`. Strings cannot be hidden in
approved number/boolean/enum fields. No regex redaction promise is made. Category/time
exclusions are counted in `filteredRecords`. Only records within the fixed 15-minute
window ending at the source observation timestamp survive; the newest `limit` entries
are returned in chronological order. A stale batch stays stale. Upstream or result-window
truncation sets `truncated`; omission counts describe only the bounded acquired batch,
never the unread remainder of a journal. No arbitrary journal text is exported.

## Resource bounds and audits

| Boundary | Limit |
| --- | --- |
| SDK stdio receive buffer | 8 KiB; oversized input closes transport |
| Tool arguments | 4 KiB serialized JSON |
| Source acquisition | 16 KiB and 64 records per read |
| Source concurrency | 2 per backend, no queue |
| Observation deadline | 1 second, cooperative abort |
| Tool result envelope | 32 KiB, including both text and structured content |
| Log entries | 20 by default, at most 50 |
| Audit retention | last 128 entries in memory |

A timed-out read retains its slot until the source settles, so an adapter ignoring abort
can make observations busy but cannot accumulate unbounded orphan reads. Discovery stays
ready independently of source slots. JavaScript deadlines are subject to event-loop
scheduling; they cannot preempt blocking native/synchronous adapters. The stdio SDK owns
framing and backpressure. These are per-session/read bounds, not an ingress rate limit or
process memory guarantee under a malicious flooding client. Future activation must bound
session count, ingress rate, process memory/CPU and slow-reader lifetime at the reviewed
tunnel/supervisor boundary; those protections are not implemented or accepted here.

Audit entries contain only fixed operation (or `unknown`), outcome and response timestamp.
They include no arguments, responses, log bodies, credentials, peer claims or exception
messages. A local `auditSnapshot()` API returns a detached bounded copy; no MCP audit
export exists. Transport parse errors are silently discarded by the reporting callback
instead of logging possibly sensitive SDK exceptions. Audits are best-effort volatile
diagnostics, not durable compliance evidence, and are **not tamper-proof against host root**.

## Threat model and permission expectations

The caller may send malformed requests, unit/path/URL injection, oversized messages,
repeated requests and adversarial log content. Observed applications may emit secrets or
prompt-injection text. Contract validation, fixed aliases, typed output projection and
bounded reads reduce exposure; returned data never grants instructions or write authority.
Host root, a compromised bridge dependency, or a malicious adapter can defeat this boundary.
Shared service-principal access is another trust boundary, not evidence of a human caller.

Initial permissions require **no** sudo, Docker socket, global `systemd-journal`/`adm`
membership, broad filesystem/home access, SSH, arbitrary systemd D-Bus authority, ORCA
token/store access or service control. Do not create any of them to make health turn green.
The proposed maintenance OS identity, runtime, state directory, credentials and tunnel
must be independent of ORCA. If a cross-user journal or system-manager source cannot be
observed narrowly, keep it unavailable. A later narrowly privileged observation helper
would need separate review: fixed alias-to-manager/UID/unit map, read-only narrow protocol,
typed projections at the privileged boundary, bounded reads, peer identity checks,
ownership/ACL review and no generic command/path/bus selector. No helper is included here.

Colocation on agent-01 can survive an ORCA daemon/store failure and SSH logout **once
independently supervised and accepted**. It cannot survive a dead agent-01, kernel,
network, power supply or hypervisor. A separate management VM and service controls are
future work. This inactive source package does not establish logout/reboot survival.

## Transport, identity and future activation contract

The smallest selected SDK route is **local stdio**, through `serveStdio` and
`StdioServerTransport` in the pinned SDK. Tests exercise that actual transport with local
streams. There is no public TCP/HTTP listener, invented framing, HTTP authentication,
Unix-socket listener or assumed runtime Unix-socket support in this increment.

Future topology: an independently supervised maintenance tunnel using the official
**tunnel-client0.0.15**, launching the independent bridge over its supported stdio route.
The logical bridge and tunnel aliases do not imply two systemd units already exist; if
the bridge is a tunnel-owned child, the actual supervisor/child observation model needs
explicit review. Verify the release artifact, launch syntax, process ownership and
stdio lifecycle with the official client before producing a launcher/profile. Do not
reuse the ORCA MCP guarded launcher, which requires a functioning ORCA daemon/store.
If a private Unix-socket bridge becomes necessary, use the SDK-supported stream route
only after validating runtime socket support, path ownership, peer access and lifecycle.
If HTTP is selected later, separately validate exact origin/host/authentication, request
limits and private socket support; do not replace this contract with a public listener.

Current discovery reports `local_stdio_unverified`, never a verified human principal.
The future restricted tunnel service principal identifies a service credential, **not a
verified human identity**. Everyone allowed to invoke that principal shares its approved
read scope unless a separately verified end-user identity design is added. Client-provided
MCP metadata is not identity. Stdio has no remote-user authentication mechanism by itself.

A dedicated maintenance tunnel runtime key and secure owner-controlled local credential
storage are later owner-approved actions. No key value, token, OAuth grant, service-account
grant or credential-generation instruction appears in this package or its examples.
Credentials must never be embedded in source, argv, unit Environment lines, logs or checked-in
profiles. Approval of this preparation does not authorize creating identities/keys,
installing services, touching live logs, changing permissions/network policy, or deploying.

Before activation, the owner must approve a concrete reviewed implementation and verify:

1. Exact build artifact/commit and independent service/tunnel identity; fixed host/mount,
   manager/UID/unit map; least-privilege observation sources. Unsupported sources fail closed.
2. Source-adapter tests for byte/record acquisition bounds, abort/timeout, journal rotation,
   missing permissions, structured projection and no fallback into other users/managers.
   Review any observation helper separately; no broad group grants.
3. Actual official tunnel-client0.0.15 behavior, secure key loading, private scope and
   restricted service-principal disclosure. No verified human identity claim or OAuth grant.
4. Harmless actual-client discovery and typed fixture reads; then separately authorized
   real health/structured-log acceptance. Pin host boot/bridge/policy/build identities.
5. Denied caller tests, existing-session and fresh-session revocation, tunnel/key rotation,
   disconnect/reconnect, stale boot/policy rejection, no cached authority past revocation.
   This package implements no tunnel revocation mechanism; evidence is still required.
6. ORCA down/store inaccessible while bridge discovery remains ready; ORCA foreground
   reports not supervised. Independent restart, SSH logout and reboot acceptance; no
   unapproved automatic service-control action or privilege escalation.
7. Session/rate/memory/CPU/slow-reader limits and safe audit retention. Record host failure
   limitations, stop/disable the maintenance tunnel for rollback, revoke only its dedicated
   key/association, and verify both new and existing calls fail. Preserve ORCA state and
   unrelated services. These are future acceptance requirements, not commands run here.

## Source validation and fixtures

`test/api-fixtures.json` supplies portable requests and expected safe result subsets for
the shipped refusing backend. `test/fixtures.ts` supplies synthetic host/log adapters;
tests use no real host observation or logs. Run from the repository root:

```text
pnpm exec vitest run packages/maintenance-mcp/test --maxWorkers=2
pnpm run typecheck
pnpm run lint
pnpm exec prettier --check packages/maintenance-mcp tsconfig.build.json
pnpm --filter @orca/maintenance-mcp build
```

Tests cover strict schema rejection, path/unit/bus/URL injection, fake secrets and
adversarial log bodies, bounded source bytes/records/responses, stale/future observations,
timeouts and stuck concurrency slots, ORCA-independent readiness, negative mutation/tool
discovery, stdio framing and the absence of ORCA runtime imports. Production Linux,
systemd/user-bus/journal permissions, official tunnel, actual client identity, revocation,
logout and reboot acceptance have **not run**. Follow-up production adapter/launcher work
and all activation gates remain tracked by #483; merging source alone must not close it.
