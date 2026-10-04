# Daemon security: authentication and authorization

The daemon's HTTP `/rpc` endpoint and WebSocket `/socket` endpoint authenticate every caller
and authorize every operation, every resource and every pushed notification (#328). This page
is the reference for operators deploying the daemon and authors of clients that call it.
Current `orca serve` wires the policy. The code is in
`packages/daemon/src/auth/`; each module's header explains its part.

Three checks are kept separate, and every call passes all three:

1. **Authentication** — which principal is calling. Decided by the transport from a bearer
   credential (or by the explicit loopback compatibility mode), before a body is read or a
   socket is accepted. HTTP authenticates again after body receipt, using current grants
   immediately before dispatch. A caller can never name its own principal.
2. **Operation authorization** — whether that principal holds the permission the method
   needs. Checked before the method's params are validated. Methods missing from the
   inventory are denied by default.
3. **Resource authorization** — which runs, workflows, artifacts and gates the call may see
   or touch. Checked before the method runs; lists are filtered and recounted.

## Modes

`startDaemon` refuses to start without an `auth` policy. No mode is the default.

| Mode                       | Who may call                                                   | Where allowed                                        |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `token`                    | A holder of a valid bearer credential, within its grants.      | Loopback; or any address behind a trusted TLS proxy. |
| `loopback-unauthenticated` | Any local process, as the owner. The pre-#328 behavior.        | Loopback binds only. Refused anywhere else.          |

The unauthenticated mode is for compatibility while local supervisors migrate. It still
applies the loopback peer, `Host` and `Origin` checks below, so a web page cannot reach the
daemon through it. Do not use it on a machine where other users run untrusted processes.

## Credentials

A credential is an opaque bearer token of the form `orca1.<id>.<secret>`:

- `<id>` is 12 URL-safe characters. It is public. It names the credential in audit records
  and in `revoke`.
- `<secret>` is 256 random bits. The daemon stores only its SHA-256, in `credentials.json`
  (mode `0600`), so reading that file does not let anyone call the daemon.

Each credential records a **principal** (a stable name such as `local-owner` or `ci-bot`), a
list of **permissions**, a **resource scope**, its creation time, and optionally an expiry
and a revocation time.

| Lifecycle step | How                                                    | Effect                                                     |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Provision      | `CredentialStore.issue({ principal, preset, ttlMs })`  | Returns the token once. It cannot be recovered later.      |
| Rotate         | `CredentialStore.rotate(id)`                           | New secret, same principal and grants. The old one is revoked. |
| Expire         | `expiresAt` / `ttlMs` at issue                         | Refused from that moment, just like a revoked credential.  |
| Revoke         | `CredentialStore.revoke(id)`                           | Refused on the next request, and open sockets close (below). |

Credential mutations (`issue`, `rotate`, `revoke`, `bootstrapLocalOwner`) return promises;
callers must await them. They use the store’s cross-process file lock across reload,
mutation and atomic persistence. Rotation publishes revocation and replacement together.
Bootstrap also publishes the matching token file before releasing the lock, so concurrent
starts cannot leave two live bootstrap credentials or a token from the wrong writer.
An interrupted bootstrap may leave an unusable token file; restart bootstrap to repair it.
The shared lock recovers a provably dead local holder; unknown holders fail closed.

The daemon re-reads `credentials.json` whenever the file changes. A credential issued or
revoked by another process, such as a CLI, takes effect without a restart. If the file is
damaged, every credential is refused until it is repaired, and a daemon will not start on a
damaged file.

### Local bootstrap

On startup the daemon issues a fresh `owner` credential for principal `local-owner`, revokes
the bootstrap credential from its previous start, and writes the token to
`<authDir>/local-client.token` with mode `0600`. A local client running as the same user
reads that file with `readLocalToken()` and sends the token. A process running as a
different user cannot read the file. That user boundary is what loopback alone never
enforced.

A client that gets `AUTH_INVALID` after the daemon restarts should re-read the token file
once before reporting an error. The rotation is working as intended.

`openAuthDirectory(dir)` creates the directory with mode `0700` and adds a `.gitignore`
containing `*`, so none of its contents is picked up by version control. The directory
holds:

| File                 | Contents                                                |
| -------------------- | ------------------------------------------------------- |
| `credentials.json`   | Credential records (secret hashes only).                |
| `ownership.json`     | Root run id to the principal that started it.           |
| `audit.jsonl`        | The security audit trail (below).                       |
| `local-client.token` | This start's local owner token. The only secret here.   |

## Principals, permissions and scopes

A credential holds a list of these permissions:

| Permission           | Grants                                                                     |
| -------------------- | -------------------------------------------------------------------------- |
| `runs.read`          | Read runs, their events, open inputs and claims; run notifications.        |
| `artifacts.read`     | Artifact references, metadata and bodies.                                  |
| `workflows.read`     | Workflow definitions; `workflows.changed`.                                 |
| `runs.start`         | Start runs and use installed operator launch preflight.                    |
| `runs.control`       | Resume and cancel runs.                                                    |
| `inputs.answer`      | Answer one open gate or permission ask, once.                              |
| `permissions.grant`  | Answer a permission ask with `always`, which writes a standing rule.       |
| `claims.release`     | Release a work-item claim.                                                 |
| `plan.read`          | The plan reads; `plan.changed`.                                            |
| `plan.write`         | Waive dependencies, decide and reopen decisions, update risks.             |
| `agents.read`        | Agent health; `agent.changed`.                                             |
| `agents.ping`        | Spawn an agent to perform a handshake.                                     |
| `config.read`        | `config.get`, which returns the configuration **unredacted**; `config.changed`. |
| `config.write`       | `config.set`, `config.apply`.                                                              |
| `daemon.maintenance` | The update coordinator's admission control.                                |

A **resource scope** limits which resources those permissions apply to:

- `workflows`: `"*"` or a list of root workflow ids. The principal may list, read and start
  only these workflows, and may see only runs whose root run belongs to one of them.
- `runs`: `"all"`, or `"owned"`, which limits the principal to runs it started itself and
  their descendants.

A scope that is anything other than `{ workflows: "*", runs: "all" }` is **restricted**. A
restricted principal can never hold the workspace-wide permissions (`permissions.grant`,
`plan.*`, `agents.*`, `config.*`, `daemon.maintenance`). Each of them would reveal or change
something the scope hides: the plan links runs across owners, agent health names claimed
work, and the configuration lists everything. `issue` rejects such a credential, and the
permission check rejects it again at call time.

Presets are expanded into the record at issue time:

| Preset     | Permissions                                                                 | Scope                    |
| ---------- | --------------------------------------------------------------------------- | ------------------------ |
| `owner`    | All of them.                                                                | Unrestricted.            |
| `operator` | Everything except `config.*`, `permissions.grant` and `daemon.maintenance`. | Unrestricted.            |
| `viewer`   | `runs.read`, `artifacts.read`, `workflows.read`, `plan.read`, `agents.read`. | Unrestricted.            |
| `client`   | `runs.read`, `artifacts.read`, `workflows.read`, `runs.start`, `runs.control`, `inputs.answer`. | `{ workflows: "*", runs: "owned" }`; narrow `workflows` at issue time. |

The `client` preset fits an adapter or a bot, including the MCP adapter (#327): it can
launch work, steer it and answer its gates, and it sees nothing else.

Starting with `requestId` additionally requires `plan.read`; `workItemId` requires both
`plan.read` and `plan.write`, because execution reads these documents and can settle a plan
item. Restricted callers therefore cannot attach either link. Existing and guessed IDs
receive the same `AUTH_FORBIDDEN` before admission or document access.

## Permission matrix

This table is `OPERATIONS` in `auth/operations.ts`, and `auth-operations.test.ts` checks
that the two match. A method that is missing from the table is refused with
`AUTH_FORBIDDEN`, even if a method table answers it.

| Method | Permission | Resource check | Audited |
| --- | --- | --- | --- |
| `operator.discover` | any authenticated principal | Credential-only safe target and implemented operation discovery. | — |
| `operator.page` | any authenticated principal | Closed collection selects its grant in OperatorReadModel before validation; resource filtering precedes pagination. | — |
| `operator.config` | `config.read` | Allowlisted generation status only. | — |
| `operator.preflight` | `runs.start` | Authorized workflow and captured generation; no side effects. | — |
| `operator.artifact` | `artifacts.read` | Exact run/artifact relation, plus runs.read; bounded sensitive-content projection. | — |
| `operator.submitRequest` | `runs.start` | Also requires `plan.write` before validation; current target, workspace Request admission and authorized workflow. | mutation |
| `operator.admitRun` | `runs.start` | Current target, authorized workflow and linked Request/work-item grants. | mutation |
| `operator.admission` | `runs.start` | Current target and own operation in this workspace; original grants/resources, including `plan.write` for Request receipts. | — |
| `operator.reconcileAdmission` | `runs.start` | Same receipt authority; attachment separately requires current execution authority. | mutation |
| `operator.cancel` | `runs.control` | Current target, then existing guarded `runs.cancel` checks the exact run. | mutation |
| `operator.answer` | `inputs.answer` | Current target, then existing guarded `inputs.answer` checks the exact durable or live decision. | decision |
| `operator.continueRun` | `runs.control` | Current target, sealed run and issued boundary; an included decision also requires `inputs.answer`. | mutation |
| `operator.continuation` | `runs.read` | Current target and the sealed receipt's run; locator IDs grant no authority. | — |
| `operator.reconcileContinuation` | `runs.control` | Current target, original principal and run; original decision also needs `inputs.answer`, with separate execution-authority checks. | mutation |
| `operator.revise` | `inputs.answer` | Also requires `runs.control` before validation; current target, exact durable run/input and declared destination. | decision |
| `hello` | any authenticated principal | `methods` and `capabilities` are filtered to what the principal may use; `storeDir` needs `config.read` | — |
| `runs.list` | `runs.read` | filtered to visible runs; `total` and paging recomputed | — |
| `runs.get` | `runs.read` | the run | — |
| `runs.events` | `runs.read` | the run | — |
| `inputs.revise` | `inputs.answer` | also requires `runs.control`; exact durable run, input and declared destination | decision |
| `inputs.replaceRevision` | `inputs.answer` | also requires `runs.control`; exact undelivered destination/attempt and CAS | mutation |
| `inputs.revisionPending` | `runs.read` | exact run; protected payload also requires `inputs.answer` and `runs.control` | — |
| `inputs.list` | `runs.read` | filtered to visible runs; `waiting` recomputed | — |
| `claims.list` | `runs.read` | filtered to claims held by visible runs | — |
| `artifacts.list` | `artifacts.read` | filtered to visible runs; `total` recomputed | — |
| `artifacts.get` | `artifacts.read` | the artifact's run | — |
| `workflows.list` | `workflows.read` | filtered to the workflow scope | — |
| `workflows.get` | `workflows.read` | the workflow (by root id) | — |
| `workflows.validateInputs` | `runs.start` | the selected workflow, before any schema or input diagnostic (reserved for #330) | — |
| `requests.submit` | `plan.write` | plus `runs.start`; workspace Request admission | mutation |
| `requests.reconcile` | `plan.write` | plus `runs.start`; own admission in this workspace | mutation |
| `requests.admission` | `plan.write` | plus `runs.start`; own admission in this workspace | — |
| `requests.admissions` | `plan.write` | plus `runs.start`; own admissions in this workspace | — |
| `runs.start` | `runs.start` | the workflow; the new run is attributed to the caller | mutation |
| `runs.admit` | `runs.start` | the workflow and authorized associations; prompt durable receipt | mutation |
| `admissions.get` | `runs.start` | own operation, original grants and resources; Request also needs `plan.write` | — |
| `admissions.reconcile` | `runs.start` | own operation, original grants/resources; attachment requires current execution authority | mutation |
| `runs.resume` | `runs.control` | the run | mutation |
| `runs.continue` | `runs.control` | exact sealed run and issued boundary; an included decision also requires `inputs.answer` | mutation |
| `continuations.get` | `runs.read` | the sealed receipt's run; a locator or CAS token is not authority | — |
| `continuations.reconcile` | `runs.control` | original principal and run; original decision also requires `inputs.answer`, execution authority is rechecked separately | mutation |
| `runs.cancel` | `runs.control` | the run | mutation |
| `inputs.answer` | `inputs.answer` | the exact open gate and its run; `always` also needs `permissions.grant` | decision |
| `claims.release` | `claims.release` | the claim's owning run | mutation |
| `config.get` | `config.read` | workspace-wide | — |
| `config.set` | `config.write` | workspace-wide | mutation |
| `config.apply` | `config.write` | workspace-wide | mutation |
| `plans.list` | `plan.read` | workspace-wide | — |
| `plan.get` | `plan.read` | workspace-wide | — |
| `items.list` | `plan.read` | workspace-wide | — |
| `schedule.get` | `plan.read` | workspace-wide | — |
| `schedule.explain` | `plan.read` | workspace-wide | — |
| `dependencies.list` | `plan.read` | workspace-wide | — |
| `risks.list` | `plan.read` | workspace-wide | — |
| `decisions.list` | `plan.read` | workspace-wide | — |
| `journal.list` | `plan.read` | workspace-wide | — |
| `dependencies.waive` | `plan.write` | workspace-wide | decision |
| `decisions.decide` | `plan.write` | workspace-wide | decision |
| `decisions.reopen` | `plan.write` | workspace-wide | decision |
| `risks.update` | `plan.write` | workspace-wide | decision |
| `agents.list` | `agents.read` | workspace-wide | — |
| `agents.ping` | `agents.ping` | workspace-wide | mutation |
| `subscribe` | any authenticated principal | a run-scoped stream needs `runs.read` and the run; each notification is checked separately | — |
| `unsubscribe` | any authenticated principal | only the caller's own connection's subscriptions | — |
| `maintenance` | `daemon.maintenance` | workspace-wide | mutation |

`hello` is not a substitute for per-resource authorization. It reports which methods a
principal may call, but each call is still checked against the specific resource it names.

Without `artifacts.read`, `runs.get.artifacts` and each `inputs.list` entry's `artifacts`
are empty, as are each step's `inputArtifactIds` and `outputArtifactIds`. Input visibility
and waiting counts still follow run scope. `runs.events` and raw
`event.appended` delivery omit `artifact.*`, `step.inputs`, and `plan.signals.rejected`
events, which carry artifact data, metadata or references. This applies even to an
unrestricted run scope, and covers live delivery and replay. Event pages retain their
scan cursors and `lastSeq`; clients must follow those cursors even when a filtered page
is empty. Sequence gaps do not contain artifact content.

Lifecycle events remain visible, with `step.started.inputArtifactIds` and
`step.completed.result.artifactIds` emptied. `journal.list` omits artifact IDs from
entry and entity origins, empties work-item `produced` maps (including updates and their
summaries), and withholds `signals.rejected` entries. Journal page cursors, `hasMore` and
`lastSeq` are retained too. Other plan views and folded notifications carry no
schema-defined artifact IDs. These projections cover explicit schema fields, not arbitrary
artifact-like strings in user-authored values. They copy outbound data only: authoritative
run/journal history and results for authorized artifact readers remain unchanged.

### Notifications

Every notification is checked against the receiving principal's grants, as they stand at
that moment, before it is written to the socket:

| Notification                                                                                   | Needs                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `run.changed`, `step.changed`, `agent.update`, `input.opened`, `input.answered`, `input.invalidated`, `event.appended` | `runs.read`, and the run visible                       |
| `agent.changed`                                                                                | `agents.read`                                          |
| `config.changed`                                                                               | `config.read`                                          |
| `plan.changed`                                                                                 | `plan.read`                                            |
| `workflows.changed`                                                                            | `workflows.read`, and the workflow in scope            |
| anything else                                                                                  | withheld                                               |

## Resource isolation

- **Runs inherit from their root.** A child run, along with its steps, events, artifacts,
  gates and claims, is visible exactly when its root run is visible. There is no other
  inheritance path, and a linked id grants nothing on its own.
- **Ownership** is recorded when `runs.start` creates a root run. That happens at the run's
  `run.created` event, not when the call returns, so a caller can watch its own run from the
  first step. Runs started before authentication existed, or started by a CLI, have no
  owner. Only principals whose `runs` scope is `"all"` can see them. Missing ownership always
  narrows access and never widens it.
- **A resource the caller cannot see gets the same response as one that does not exist.**
  The code, message and details are identical. Lists come back empty rather than refused. A
  subscription to an invisible run succeeds with `replayed: 0` and delivers nothing.
  `WORKFLOW_NOT_FOUND` omits the `known` list for a principal with a workflow allowlist.
- **Artifact path protections are unchanged.** The guard only decides whether
  `artifacts.get` runs at all. The read model still serves bodies from the store, never from
  a caller-supplied path.

## Gate decisions

Reading, listing, subscribing to or reconnecting to a run never answers a gate. The only way
to answer one is `inputs.answer`, and it requires all of the following:

- the `inputs.answer` permission, plus `permissions.grant` when the call includes `always`.
  That second check runs first, so a refused standing rule has no side effects;
- the exact open request, in a run the caller can see;
- if the caller passes `runId`, the request must belong to that run or one of its
  descendants. A mismatch gets the same response as an unknown request;
- the current state, which the control model checks under the run's lease. A gate that is
  already answered gets `INPUT_ANSWERED`, a run that has stopped waiting gets
  `RUN_NOT_WAITING`, and an unknown option gets `INPUT_OPTION_UNKNOWN`.

A restricted caller should pass `runId`. Without it, an already-answered request returns the
generic not-found instead of `INPUT_ANSWERED`, because the search would otherwise reach runs
the caller cannot see.

## Transports

### HTTP `/rpc`

Send `Authorization: Bearer <token>`. Authentication is decided from the headers alone; a
refused request's body is never read.

| Situation                                                     | Status | Envelope `error`                                           |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| No credential                                                 | 401    | `{ "code": "AUTH_REQUIRED", "message": "authentication required" }` |
| Malformed, unknown, wrong, expired or revoked credential      | 401    | `{ "code": "AUTH_INVALID", "message": "invalid credentials" }` |
| Credential in the URL (`?token=`, `?access_token=`, ...)      | 401    | `AUTH_INVALID`, as above                                   |
| Disallowed `Origin`, non-loopback `Host`, proxy bypass, non-https proxy | 403 | `{ "code": "AUTH_FORBIDDEN", "message": "not permitted" }` |
| Authenticated, but the operation is not granted               | 200    | `AUTH_FORBIDDEN`, with the request's `id`                  |
| Authenticated, but the resource is not visible                | 200    | The method's own not-found                                 |

Responses use the existing envelope, `{ "kind": "response", "id", "ok": false, "error" }`.
Transport-level refusals use `id: 0`, as other transport failures already do. 401 responses
carry `WWW-Authenticate: Bearer realm="orca"`. No auth error ever has `details`. All invalid
credentials get one identical response; the reason appears only in the audit log.

`GET /health` is unauthenticated and always answers exactly `{ "ok": true }`.

### WebSocket `/socket`

Authenticate the upgrade request in one of two ways:

- Send `Authorization: Bearer <token>`, for clients that can set headers.
- Offer the subprotocols `orca.v1` and `orca.bearer.<token>`, for clients that cannot set
  headers, such as `globalThis.WebSocket`. The daemon selects `orca.v1` and never echoes the
  bearer protocol. Always offer `orca.v1`, because some clients reject a handshake that
  selects none of the offered protocols.

A refused upgrade never becomes a connection. The daemon responds with the HTTP status and
envelope body from the table above.

After the upgrade, the credential is re-checked before every request on the connection,
before every notification, and every `revalidateMs` (default 5000 ms) while the connection
is idle. If the credential has been revoked or has expired, the daemon closes the socket
with code **4401** (reason `AUTH_INVALID`), stops its subscriptions, and records a
`connection.closed` audit entry. A changed grant takes effect on the next check.

Subscriptions belong to the connection they were created on. A subscription id means
nothing on any other connection: `unsubscribe` reports `stopped: false` there. Reconnecting
requires authenticating from scratch, and a resumed subscription (`since`) is authorized
against the principal's grants at the time of reconnection. Holding an old connection, a
subscription id or a run id grants nothing.

## Deployment

### Loopback (the default)

`127.0.0.1:6722`. Requests must come from a loopback peer, with a `Host` of `localhost`,
`127.x.x.x` or `[::1]`. The `Host` check blocks DNS rebinding. Requests that carry an
`Origin` header are refused unless the origin is listed in `allowedOrigins`. Browsers always
send `Origin`; the CLI and the app's main process do not.

To reach a loopback daemon from another machine, use an SSH tunnel
(`ssh -L 6722:127.0.0.1:6722 host`). Credentials are still required.

### Remote, behind a TLS-terminating reverse proxy

The daemon does not terminate TLS itself. A non-loopback bind is **refused at startup**
unless `trustedProxies` lists the address of the proxy in front of it. Once `trustedProxies`
is set:

- A request from any peer that is not a trusted proxy gets 403. This blocks direct access to
  the backend that would bypass the proxy.
- A request from a trusted proxy must carry `X-Forwarded-Proto: https`. The daemon reads the
  last value, which the nearest proxy wrote. Anything else gets 403.
- `X-Forwarded-For` is used only for the audit log's `remote` field, and only from a trusted
  proxy, taking the right-most entry. Forwarded headers from any other peer are ignored.
  Forwarded headers never identify the caller; only the bearer credential does.
- The proxy must pass through `Authorization` and, for `/socket`, the `Upgrade`,
  `Connection` and `Sec-WebSocket-*` headers. It must not log `Authorization` or
  `Sec-WebSocket-Protocol`.

An example nginx configuration:

```nginx
location / {
  proxy_pass http://10.0.0.20:6722;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Bind the daemon to an interface only the proxy can reach, and list the proxy's address,
for example `trustedProxies: ["10.0.0.10"]`.

## Audit

The audit trail is `audit.jsonl`, created with mode `0600` before the daemon listens. Each
line has this shape:

```json
{
  "at": "...",
  "event": "operation",
  "transport": "http",
  "actor": { "principal": "alice", "kind": "credential", "credential": "AbCdEfGhIjKl" },
  "operation": "inputs.answer",
  "target": { "requestId": "hi_…", "runId": "run_…" },
  "outcome": "succeeded",
  "remote": "127.0.0.1"
}
```

| `event`             | Written for                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `operation`         | Every mutation and decision (the "Audited" column), succeeded or failed.  |
| `authz.denied`      | An operation or resource refusal, with an internal `reason`.              |
| `authn.denied`      | A transport refusal: missing, malformed, unknown, mismatch, expired, revoked, origin, host, proxy. |
| `connection.closed` | A socket closed because its credential lapsed.                            |

Targets are identifiers only: run, workflow, request, work item, artifact, plan, document,
subscription, and which `always` decision was chosen. A record never contains vars, notes,
answer text, configuration text, params payloads, URLs, or any credential secret. The
credential id is public and is the only credential-related value recorded. If an append
fails, the error is reported on stderr and the next append is still attempted.

Operator mutation audit targets include allowlisted workspace/instance, command, exact decision
and service receipt correlation IDs, including IDs nested in `command.target`, `decision.live`
and resolved retry results. The actor always comes from the authenticated principal. Raw retry
keys, guard tokens, option/answer text, Request bodies, revision payloads, notes and supplied
actors are excluded. Admission/continuation lookup reads are not mutation-audited; refusals are.

## Client migration

| Client                                    | Change                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| CLI in client mode                        | Read `<authDir>/local-client.token`, or `ORCA_DAEMON_TOKEN`; send `Authorization: Bearer`.   |
| Desktop app main process                  | Read the token file of the daemon it spawned; send it on `/rpc` and as `orca.bearer.*` on `/socket`; re-read it once on `AUTH_INVALID`; treat close code 4401 as "re-authenticate", not as a network blip. |
| Update supervisor (`maintenance`)         | Same token file; `maintenance` needs `daemon.maintenance`, which only `owner` has.           |
| Embedders calling `startDaemon`           | Pass `auth`. Use `{ mode: "loopback-unauthenticated" }` only to keep the old behavior on loopback. |
| Custom method tables                      | Every method name must be in `OPERATIONS`. An un-inventoried method is `AUTH_FORBIDDEN`.     |

## Current integration and acceptance boundary

On main `94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`, `orca serve`
bootstraps token authentication, the CLI exposes `auth issue|list|rotate|revoke`,
and the desktop daemon client supplies its credential. The legacy
`--unauthenticated-loopback` mode is explicit and loopback-only. Authenticated
operator methods are conditionally mounted with their production sources and
audited through the same daemon boundary. The former #328 branch handoff and
`patches/328-control-integration.patch` are historical; do not apply them to
current main. The [current evidence map](runtime-operator-integration.md#current-main-evidence-map)
links the implementation and executable checks.

The CLI accepts named presets with workflow/run-scope options; it does not accept
an arbitrary permission list on `auth issue`. A proposed finer read-only grant
cannot be provisioned by inventing a CLI flag or borrowing the local owner token.
The `client` preset defaults to owned runs and includes write grants. Inspecting
pre-existing user-selected runs requires a reviewed `runs: all` envelope over the
approved root workflows; that envelope includes other and future runs of those
roots. `config.read` is workspace-wide and includes raw unredacted `config.get`;
the MCP `get_configuration_status` tool uses an allowlisted projection and does
not grant raw config access.

#328 remains open. Its existing HTTP/WebSocket credential, operation, resource,
notification, gate and audit tests establish the implemented core. They do not
establish the expanded workflow-editor draft ownership, secret-reference use,
full #336 raw-config migration alignment, or a complete deployment and client
migration proof. Current-main CI passed on Node 22/24 at
[run 37163133592](https://github.com/cschadewitz/Project_Orca/actions/runs/37163133592);
that does not prove an upgraded agent-01 runtime or actual-Cal behavior. Keep
these remaining [#328 criteria](https://github.com/cschadewitz/Project_Orca/issues/328)
open until their own evidence exists.
