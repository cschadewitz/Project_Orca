# Owner-bound command bridge checkpoint — Refs #702 / #706

This is an incomplete, unregistered integration checkpoint. It consumes reviewed
persistence #731 at `c6157bddec40b438e3425baf52cf65d12355c216`, based on main
`bc0c57d82925cefa001513b8431355b912e4d462`. Managed design #730 was inspected at
`9316577892659ee7f758801442adb97913f392d0`; it is not merged into this branch.
No activation, native provider calls or existing workspace edits occurred.

## Minimum managed-owner handoff

The integration needs the existing `InactiveTypedSidecarOwner` capability, bound
to a real enrolled managed lifetime and full physical root relationship. Its
compatibility checks must fail closed when enrollment, roots, exclusive ownership
or lifetime are lost. A JSON receipt, client flag or environment value is insufficient.
The bridge constructor validates that capability through the existing store factory.
No production composition calls this constructor.

The approval owner must independently retain an exact `RetainedScopedReview`:
command, action, approved scope evidence, original input identity, expiry and exact
once/deny option IDs. `prepare` receives authenticated actor and actual current
sidecar snapshot. `assertCurrent` must synchronously verify the independently
retained approval, exact action/scope/revision and actor; it cannot accept a public
reference as proof. Current authority revision needs asynchronous read and
synchronous commit assertion. The bridge supplies original-principal grant checks
through the reviewed Authorizer seam and compares every persistence command and
actor against its retained snapshot. These owner callbacks remain injection
requirements, not implemented managed/approval services.

## Implemented local seam

`packages/daemon/src/scoped-permission-bridge.ts` retains random UUID handles in
memory. Requests contain only workspace/instance target, live input identity or
handle plus a closed choice. It snapshots owner records and binds actor and input.
Save invokes the existing typed store and never answers. Explicit once/deny invokes
the existing LiveHumanInput service without a standing writer. Double submissions
are claimed synchronously; failed or uncertain attempts consume the handle.
Inspection reads the actual store and never retries or reconstructs callbacks.
Only the existing safe decision projector produces decision output; raw errors and
private persistence receipts are withheld.

## Remaining work and evidence limits

This checkpoint is not the requested complete integration. Protocol result schemas,
auth operation inventory, managed availability/registration, app IPC/client adapter,
permission-card connection and bridge-specific acceptance tests remain unfinished.
The methods are deliberately unregistered; the existing guard would refuse them
until the operation inventory is reviewed and wired. No UI path is claimed.
The existing persistence/live-input tests exercise actual disposable stores and
answer leases, but do not validate this new bridge. A future owner must add the
requested stale-review/identity/cancellation/expiry/write-fault/acknowledgement
matrix through authenticated HTTP and the real UI adapter before acceptance.
Revoke is still provided only by the reviewed typed store, not by this bridge.

Local verification: existing typed authority/live-input suites passed (21 tests).
The new bridge passed targeted ESLint and Prettier. Root typecheck initially found
one bridge error, corrected to use the existing authRequired error factory; the
remaining error is missing app `yaml` resolution in the supplied installation.
No dependency policy, lockfile or persistence parser/lock changes were made.
GitHub REST and GraphQL reads returned Forbidden; the connected GitHub PR tool
returned Unknown tool. No PR or branch was published by this checkpoint.
