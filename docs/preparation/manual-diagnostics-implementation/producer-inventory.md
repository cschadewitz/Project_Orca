# Typed producers and excluded sources

All main links below are pinned to `e8678ebaa06f4deb883143df288275300f762b3e`.
Read-only source inspection is not a privacy certification or runtime test.

## Main inventory

| Proposed fields / facts | Existing source and gap | Future owner / boundary |
| --- | --- | --- |
| App/protocol/OS/architecture | [Handshake constants](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/protocol/src/handshake.ts), sealed package identity and typed platform APIs. Public-release provenance must be verified; do not export this private source SHA merely because it is valid hex. | App main; exact numeric forms or unknown. No command/environment parsing. |
| Connection/authentication and current daemon version/protocol | [ConnectionMachine](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/app/src/main/connection-state.ts) owns link state and handshake generations. Its UI snapshot retains metadata and delays departure from live; it is not a freshness/authority attestation. | Add a dedicated typed observation at the owner; current generation and authority checked together. Never copy the whole snapshot or initiate diagnostic hello probes. |
| Startup spawn/exit/deadline categories | [daemon-process.ts](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/app/src/main/daemon-process.ts) has child callbacks and deadlines, but errors merge text/output. Existing probe returns a boolean and loses distinctions. | App lifecycle owner emits enum from the actual callback, never classifies an error string. Missing prior safe fact stays unknown. |
| Admission accepted/uncertain/recoverable failure | [Request contract](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/docs/request-submission.md) distinguishes admission states. Existing response/history is not an export object. | Current authorized operation owner emits the category. Lost transport is uncertain, never rejection or permission to resubmit. No receipt/Request/workflow payload. |
| Resume outcome, terminal run failure | [ReadModel](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/daemon/src/read-model.ts) serves rich views; those views are not safe diagnostic records. | Existing execution/control owner supplies only observed outcomes, after resource checks. Diagnostics must not resume or reread full history. |
| Protected-state availability / store format | [protected-file.ts](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/store/src/protected-file.ts) uses generic RUN_STATE across unreadable material; compatibility expectation is not actual store observation. | No diagnostic read/decrypt/key probe. A future typed owner observation from already authorized normal work, or unknown. #409 does not supply this automatically. |
| Presence flags, local aliases, omissions | No existing full safe producer. | Closed producer-owned booleans/unknown, bounded local map, fresh random IDs; count only eligible safe observations, never inventory private sources. |

## Current fields that are not export-safe

- [Logger](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/core/src/util/logger.ts):
  free `msg`, unrestricted `Record<string, unknown>` fields, inherited child/base fields,
  ISO wall time and JSON serialization of arbitrary values. Do not ingest its output even
  with a permissive secret scanner. A fixed log level is not approval of surrounding data.
- [Audit](https://github.com/cschadewitz/Project_Orca/blob/e8678ebaa06f4deb883143df288275300f762b3e/packages/daemon/src/auth/audit.ts):
  `at`, `actor.principal`, `actor.credential`, `remote`, `operation`, `target`,
  `reason`, arbitrary `code`. Target keys include run/workflow/request/work-item/artifact/
  plan/decision/agent/subscription identifiers, document, action and standing decisions.
  Truncation to 200 characters does not de-identify them. Security logging excludes many
  payloads for its own purpose; that does not make audit records safe for export.
  Even allowed outcome words must come from a reviewed typed producer, not audit ingestion.
- `DaemonStartError.message/output`, `DaemonExit.output`, stdout/stderr and `onLog`:
  free text, token-file path, endpoint, command/config paths and potentially huge newline-free
  output. No tail, truncation, stack/cause or regex fallback.
- `HelloResult`: `identity.workspaceId/instanceId`, `processId`, `storeDir`, method lists
  and arbitrary version strings are not a diagnostic bundle. Handshake is a source boundary,
  not a bulk serialization permission.
- Read-model RPC/event records, execution ciphertext, keys, configuration and MCP guards/
  cursors remain excluded. Hashing identifiers does not remove their sensitivity.

## Consistent observation and current authority

For the approved configurable five-minute default direction, producers emit only after
explicit tester rolling consent. This is ongoing safe-fact collection, never retroactive
log reading. Volatile retention and final budgets still require review; export intent
cannot authorize earlier or new background collection.

A future producer returns only the closed safe schema after checking the same private
authority and resource scope that authorized the underlying observation. Authentication
alone, advertised method availability, a caller-supplied run ID, or possession of an old
observation is insufficient. Do not widen read-only clients to control/admission access
just to collect a report. Locally known app facts may still be previewed offline.

Before publication, recheck the connection/resource generation and current authorization.
Revocation, a foreign target, replacement, mixed generations or uncertain consistency makes
the affected observation unknown/omitted (or rejects the attempt), never a stale positive.
No private authority identifiers or revision tokens enter the report. Describe these checks
as bounded observations; do not claim an atomic critical section or immunity to every
transient A-to-B-to-A change. Diagnostics holds no execution lock.

Without handshake evidence true: daemon version/protocol, store format and protected-state
snapshot are unknown; protected-state observation is not true; authentication is not
accepted. A handshake is necessary for these facts but never sufficient to establish them.
Current safe outcomes must also have their corresponding presence evidence. Unknown extra
fields are rejected, not stripped from a received candidate.

## Integration difference, not a new dependency

At inspection, open [#434](https://github.com/cschadewitz/Project_Orca/pull/434) head was
`951950dbf685bd3b9054a8399346eed15b403b4c`, diverged from this main baseline.
Its [operator read model](https://github.com/cschadewitz/Project_Orca/blob/951950dbf685bd3b9054a8399346eed15b403b4c/packages/daemon/src/operator-read-model.ts)
adds per-invocation current principal checks, exact-run projections and publication revisions;
its [production contract](https://github.com/cschadewitz/Project_Orca/blob/951950dbf685bd3b9054a8399346eed15b403b4c/docs/mcp-operator-production-contract.md)
reserves identity-bound mutations and boundary evidence. These are active, moving MCP work,
not a stable diagnostic API. Workspace/instance/principal/credential IDs, retry keys,
operation/continuation receipts, revision/config guards, live-owner identity and cursor
material stay private. Never serialize an operator row then delete fields.

Reinventory the final integrated baseline before assigning runtime files. Do not edit,
import or “fix” A/B/C/MCP files here. A later diagnostics producer can reuse verified
authority principles without depending on an unmerged API or claiming MCP acceptance.
