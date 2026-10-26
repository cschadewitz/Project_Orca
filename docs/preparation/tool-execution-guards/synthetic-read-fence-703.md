# Inactive synthetic read fence — #703 bounded slice

This is source and disposable synthetic evidence, not installed-provider qualification or
production activation. It follows the reviewed #708 vocabulary and consumes canonical
types from #716 at `9688aa259a37216642ca36a5be144d234306700a`, unchanged core blob
`f767f47a485ab08320d5dcef2ade1641fc947cdd`. The dependency is retained in branch ancestry;
there is no competing type definition or import of #702's unpublished evaluator.
Capture-only predecessor #715 was independently checked as merged at
`95e9efca73299e77e1de89e59b8e9398a001747f`. Parent owns review, integration and merges.

## Boundary and retained authority

`packages/agents/src/synthetic-read-boundary.ts` supplies only a disposable injected
`AgentHost.fs.readFile` capability and mirrors the existing ACP callback's whole-file
read followed by line/limit slicing. Its fixture codec is
`orca-synthetic-acp-read-v1`: exact path, tagged omitted/null/undefined/numeric read
parameters, no path normalization, a 4096-character path bound, safe integers and no
extra fields. Engine admission also bounds encoded bytes to 32 KiB and original lifetime
to a finite maximum of 60 seconds. Explicit undefined is an internal JavaScript case,
not a claim that ACP JSON carries it. Raw duplicate-key validation stays unknown.

`packages/engine/src/synthetic-read-fence.ts` is unexported by the package barrel and
never registered with production ACP. One coordinator retains one original verified
invocation, owner snapshot, capture and exact original/final representation. Capture
and copying finish before the first await. The registered read, policy, recording and
ownership capabilities and original lifetime are retained; later injection-object
replacement cannot substitute an executor. Same-instance identical calls observe the
existing evaluation/permit/receipt. Different arguments or owner state refuse reuse.
Another coordinator cannot register the same verified invocation on the same original
lifetime. New attempts require a fresh owner/invocation binding.

Only a verdict obtained through the injected `PolicyPortV1` for that retained action can
reach authorization. Object-shaped actions, verdicts, serialized handles and public IDs
cannot mint permits. The port is reread at evaluation, authorization and dispatch;
current revision/binding and allow attribution must still match. This is port consumption,
not another policy evaluator. The test double is explicitly programmable synthetic
outcomes and implements no rule predicates, migration, storage or real approval behavior.
Require-human and needs-review stop this slice; it does not schedule humans or judges.
Opaque pending-review handles are retained without cloning or serializing their identity.

Capture persistence verifies current original authority under existing run ownership.
Authorization/dispatch acquire the
existing lease mutation fence; injected current original authority, snapshot/codec,
policy, cancellation, expiry and state checks run again. Required protected authorization
recording completes before consumption. A synchronous last check precedes the one-use
claim and registered I/O start, with no intervening await. The I/O promise settles outside
the mutex. Revocation/current-state providers must share that fence in future production
integration; this slice provides only synthetic bindings to the existing lease store.

## Recording, delivery, dispatch and effect

The engine's evidence seam is an injected adapter to existing protected execution records.
The dedicated fixture uses `InMemoryExecutionStore`'s existing private `agent.update`
payload envelope for retained capture, authorization and independent observations. This
test-only encoding is not a production persisted schema, RPC or second recovery ledger.
No permit can be reconstructed from those records.

| Observation | Evidence in this slice | Limit |
| --- | --- | --- |
| Recording | Required authorization write before consumption; independent record inspection | A rejected append may already have persisted. No repeat append or automatic reopening |
| Delivery | Separately supplied observation, otherwise unknown | No production ACP reply callback is wired; delivery alone proves no effect |
| Dispatch | Separate synthetic executor-entry record | Not inferred from a returned response or receipt state |
| Effect | Injected filesystem's independent read counter and observation record | Synthetic memory reads only; no physical filesystem or native-provider evidence |

`inspect` snapshots correlation fields, requires current authority for the exact retained
run before and after protected reads, and copies/freezes the projection. Missing observations
remain unknown, with no invented source/time attribution. Inspection cannot authorize,
dispatch or replay. It is owner-local inspection, including after that owner's lifetime
ends; cross-process durable receipt lookup/reconciliation remains #338/#357/#474 work.
Current exact-run read authorization is injected, not supplied by receipt fields.

`completed` means only that the injected executor promise resolved. Independent effect
and delivery observations may still be unknown. Failure/cancellation after consumption,
including a lost ownership acknowledgement after starting I/O, returns `execution-unknown`.
Late executor completion cannot turn it into permission to retry. Reusing a consumed permit
returns its existing receipt without I/O. Failure before starting I/O is `not-dispatched`;
this does not fabricate an independent negative observation. Tests separately assert zero
read count for deny, revoke, outage, stale state, lifetime loss and recording failure.

## Coverage and remaining work

Coverage stays `observation`, installed evidence is empty and physical resources stay
unknown. A programmable synthetic allow exists to exercise the fence; it does not prove
that #702's real policy admits an action with unknown required evidence.

String paths are not physical confinement. Relevant-state references here are synthetic
memory revisions, not stable handles or a conditional real filesystem operation. No
physical-path/symlink/rename race guarantee is claimed. That needs a separately designed
and tested stable-handle/conditional boundary in a disposable offline fixture. Existing
session root/protected-path checks and production callbacks are unchanged. No native
shell, descendants, independent MCP, installed provider or #594 support is established.

Remaining integration includes daemon-verified authority and revision bindings, actual
#702 policy behavior, budgets/shared-use semantics, production protected-record codecs,
exact-run durable receipt/recovery reconciliation, privacy-safe public projection,
physical resource enforcement and independent installed/provider acceptance. Restart tests
here instantiate a new coordinator and refuse old handles; they are not process-crash or
durable exactly-once tests. Cancellation after dispatch is best effort, not physical undo.
The owner-local check is not a transaction spanning an external effect.

No package advertisement, production callback wiring, sidecar/config/UI edits, policy
defaults, credentials, hook installation, live providers, private evidence egress, JEV
activation, paid service, deployment, release, merge or upstream contact is added. Existing
sandbox/privacy and unsupported #594 boundaries remain. This slice does not close #703.

## Verification

Node 24.19.0; TypeScript 7.0.2, Vitest 5.0.5, ESLint 10.13.0 and Prettier 3.9.10.
The declared frozen dependency baseline was restored under unchanged supply-chain and
lifecycle policy; the inherited upstream updater change is not a #703 dependency edit.
Any generated bootstrap-only lock metadata is restored to its pre-install bytes after
checking that the dependency lock document is unchanged.

Commands run on final implementation/test content (at most two Vitest workers):

```sh
node_modules/.bin/vitest run \
  packages/engine/test/synthetic-read-fence.test.ts \
  packages/agents/test/synthetic-read-boundary.test.ts \
  packages/agents/test/permissions.test.ts \
  packages/agents/test/live-input-session.test.ts \
  packages/agents/test/acp-session.test.ts \
  packages/agents/test/protected-paths-session.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/store/test/lease-store.test.ts --maxWorkers=2
node_modules/.bin/tsc -b packages/engine/tsconfig.json --pretty false
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
node_modules/.bin/eslint .
node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css
git diff --check
```

The focused run passed **8 files / 211 tests**, including **58 engine fence** and
**10 capture/codec** cases. Root/renderer typechecks, engine/reference package build,
full repository ESLint and CSS token checks passed. Changed TypeScript formatting and
diff whitespace checks pass. Full suite/coverage, full renderer build, Electron/native
smoke, installed providers, physical filesystem races and actual process-crash recovery
were not run for this slice. PR CI is a separate exact-head result, not implied by these
checks. No changelog is needed for an inactive unadvertised module with no user-visible
runtime behavior.
