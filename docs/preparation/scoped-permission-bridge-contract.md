# Owner-bound command bridge checkpoint — Refs #702 / #706

This is an unregistered command/UI integration under injected owner fixtures. It consumes reviewed
persistence #731 at `c6157bddec40b438e3425baf52cf65d12355c216`, based on main
`bc0c57d82925cefa001513b8431355b912e4d462`. Managed design #730 was inspected at
`9316577892659ee7f758801442adb97913f392d0`. Both dependencies are now merged in
main; this branch non-force merged exact main
`a4ae53d1d5a8d7945f5c6782da46c833accdb29d` before final integration checks.
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

## Integrated path and evidence limits

The closed `SCOPED_PERMISSION_CONTRACTS` family validates request and safe result
schemas. The app main process validates its closed IPC family, preload exposes
only that family, and `scopedRulePort` creates callbacks bound to opaque handles.
PermissionCard uses the port only when the current handshake advertises the method.
It reuses ScopedRuleChoices and the existing safe decision view. Cancel/unmount
invalidates retained reviews; a pending write cannot be cancelled or replayed.
A successful save leaves the callback pending; answering requires a separate
explicit request. Once/deny never pass a standing writer to LiveHumanInput.
No combined save-and-answer command is exposed. Existing record-before-standing-
write-before-delivery behavior remains in the original registry, unchanged.

The auth operation inventory is explicit, but **no production daemon registers
these methods**. The test composition injects the owner and existing Authorizer
into the method factory. Default CLI/managed startup cannot enable it by flag,
query or environment. The managed Linux owner, actual protected approval lookup,
qualification/disclosure and exact-build acceptance remain integration dependencies.
`prepare` and `assertCurrent` in fixtures are synthetic retained approval owners;
they certify no installed provider or managed enrollment. Revoke remains available
only in the reviewed typed store; this family does not implement a revoke UI.

Bridge acceptance tests exercise real disposable sidecars, credential files, leases,
answer events, actual authenticated HTTP and guarded dispatch. They cover exact
actor/command binding, separate save/answer, once/deny, stale revision/review,
expiry, cancellation, workspace mismatch, duplicate requests, revocation across
awaits and uncertain rename acknowledgement with explicit read-only inspection.
Existing typed live-input tests separately cover record/write/delivery order,
uncertain append/publication and restart without callback reconstruction. They
remain distinct evidence: no native provider/hook or managed build claim is made.
No end-to-end Electron smoke has been run for this bridge. No automatic replay or
retry is implemented; all owner exceptions are converted to a fixed public error.

## Setup and access observations

Frozen install completed with unchanged lockfile and the existing supply-chain
policy check and lifecycle allowlist; Electron download was skipped. Temporary
PNPM_HOME/XDG paths stayed under /tmp. The supplied pnpm executable reported
11.19.0 although package.json pins 12.4.2; no package manager pin was changed.
Root and renderer typechecks and TypeScript/Vite build passed after installation.
Checks and exact final head are reported in the handoff rather than implying CI.

Only metadata READS failed: GitHub CLI attempted GraphQL at
`https://api.github.com/graphql` for PR/issue metadata, and REST GET
`https://api.github.com/repos/cschadewitz/Project_Orca/issues/702`.
The CLI printed `Forbidden`; it did not expose an HTTP response body/status
beyond that label, so a more specific 403 reason is unknown. Those routes were
not retried after the parent's instruction. The connected github.fetch_pr call
for #731 returned `Unknown tool`. No GitHub API WRITE was attempted or denied.
The existing configured origin is HTTPS GitHub cschadewitz/Project_Orca, fetch
and push. Fetch and read-only ls-remote succeeded; ls-remote confirmed the new
branch absent before publication. No alternative remote, proxy, credentials,
network settings or security settings were introduced.

## Confirmed-save continuation correction

Client review reproduced a connected-card blocker at published source
`5a7e3065de2723f05f39327916554ad4c5021694`: saving left the input pending while
the choices stayed permanently latched. Closing cancelled the saved handle, and
there was no separate-answer route. The new connected regression failed against
that exact renderer source; see [failing-before evidence](scoped-permission-bridge-evidence/saved-flow-before.txt).

Only a **confirmed save** now opens a saved phase. An explicit **Review separate
answer** loads a fresh owner review and handle; the old handle is cancelled. Save
stays unavailable for that input. A subsequent Allow once or Deny is a separate
request, rechecked by the adapter and the existing server/lease authority path.
Close after a confirmed save also permits reopening a fresh answer-only review.
A failed fresh review cannot reuse the cancelled saved handle. Uncertain or
mismatched acknowledgements remain latched, without automatic retry or answer.
The adapter accepts Saved only for Save, and Answered only for once/deny; a
connection generation change while awaiting acknowledgement is uncertain.

`packages/app/renderer/test/scoped-rule-port.test.tsx` mounts the actual
PermissionCard without an injected review port, so it exercises the card's real
adapter selection and scopedRulePort through a synthetic preload bridge. Its
closed-contract transport validates request shape and retains synthetic handles;
it does not authenticate a real transport, persist policy, enroll a managed
workspace or launch Electron. The approval/disclosure responses are synthetic.
It covers confirmed save followed by an explicit fresh review and answer,
close/cancel after save, refusal of a fresh review, lost acknowledgements, stale
fresh authority and connection binding, duplicate actions, and legal-but-mismatched
outcomes for all three choices. The separate daemon suites provide the real
credential/file/lease evidence. Together the affected suites passed 95 tests after
this correction; root/renderer types, build, affected ESLint, CSS token check and
changed-file formatting were also run. Production registration remains absent.
