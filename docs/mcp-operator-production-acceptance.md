# Production MCP acceptance (#327)

**Current main, 4 October 2026:** `94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`
includes the production handlers and the 60-case compiled matrix below. Its
[CI run](https://github.com/cschadewitz/Project_Orca/actions/runs/37163133592)
passed on Node 22 and 24, with `ORCA_MCP_REQUIRE_PRODUCTION=1` in both jobs;
missing aliases therefore fail rather than skip. This is reference-client and
compiled-daemon evidence, not proof of the full actual-Cal or deployed-host
acceptance. The first actual-Cal authenticated `discover_orca` observation recorded
in [#327](https://github.com/cschadewitz/Project_Orca/issues/327) used older
agent-01 runtime `3702da5b38dc449280c2837366615de741e9c45c`; it does not
validate this current-main binary on that host.

The C-branch setup and #434 overlay described in the later historical sections
are dated preparation evidence. They no longer describe the installation state of
current main. The [evidence map](runtime-operator-integration.md#current-main-evidence-map)
separates code, compiled tests and deployed observations.

## Execution

Use Node >=22 and the repository's pinned pnpm. Install the frozen lockfile, then
build in this checkout. The fixture intentionally launches the compiled CLI in
separate Node processes, bypassing Vitest's source aliases for the runtime under test.
It fails if compiled entry points are absent. Rebuild after integrating runtime changes;
do not point these tests at another checkout's `dist` directory.

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.build.json
pnpm exec tsc --noEmit
pnpm exec eslint packages/integrations/test/mcp-operator-production-*.ts
pnpm exec prettier --check packages/integrations/test/mcp-operator-production-*.ts docs/mcp-operator-production-acceptance.md

# Current-main acceptance: missing production mounts are failures, never skips.
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-{lifecycle,recovery,authority}.test.ts --maxWorkers=1

# Machine-readable evidence, without adding generated reports to the branch.
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-{lifecycle,recovery,authority}.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/orca-mcp-production-results.json

# Select one row by its stable ID, e.g. response loss or exact live identity.
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-recovery.test.ts -t R01 --maxWorkers=1
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-authority.test.ts -t A04 --maxWorkers=1
```

Loopback listeners and child processes must be permitted by the runner. A sandbox
`listen EPERM`, build failure, malformed discovery, crashed child, refused preflight,
or failed fixture is a **failure**, not a production dependency skip. Only successful,
authenticated discovery plus `tools/list` proving a required alias is absent can
trigger a dependency skip. Once all aliases are mounted, boundary/state/assertion
failures stay red; the harness does not skip them.

## Runtime and isolation

`mcp-operator-production-fixture.ts` creates a new temporary config, disk store,
auth directory and workflows for every test. It runs compiled `orca serve` with
token authentication and port zero. A separate compiled credential-store process
issues/revokes only synthetic fixture credentials. The persistent test principal
is separate from the daemon's bootstrap credential so restarting or opening a
second daemon cannot accidentally rotate the test caller. No host/workspace
credentials or access policy are read or changed.

The stdio client launches compiled `orca mcp`. The HTTP client sends real
Streamable HTTP requests over a loopback private bridge into the compiled
`createOperatorHttpHandler`, with its fixed HTTPS origin and the caller's bearer
credential. The bridge adapts Node HTTP requests to Fetch requests; it neither
manufactures responses nor supplies privileged credentials. This tests the
supported private-bridge handler path, not public TLS termination or deployment.
HTTP/WS backing RPCs use the same authenticated compiled daemon.

The workloads are gates, a declared corrective-input gate, a parent with a parked
child, and an ACP agent that asks permission. The existing compiled scripted agent
is a synthetic workload, not a mutation handler. Production bootstrap constructs
the actual admission, retry, continuation, revision, execution-authority, ownership,
lease, journal, audit and credential services. There are no `vi.mock` replacements,
in-memory MCP transports, discovery fixtures or injected mutation callbacks.

Fault injection is outside those services: a forwarding proxy consumes a genuine
daemon response and drops the acknowledgement; another holds a genuine response
while a credential is revoked; a process is killed/restarted; two daemon processes
write one store; or one protected payload file is temporarily moved. Response-loss
tests retain the original real receipt for correlation and count forwarded writes
to detect automatic adapter retries. Test cleanup closes clients/listeners/processes
and removes synthetic state. The process environment excludes ambient ORCA settings,
agent credentials and `NODE_OPTIONS`.

Settled assertions first use bounded `runs.events` reads with the same peer token
and endpoint (500 events per page, following `hasMore`/`nextCursor`, at most ten
pages per observation). Durable inputs require their exact unanswered
`human.requested`, matching `step.waiting`, then `run.paused`. Live inputs require
the current-instance permission publication and an exact-run `inputs.list` proving
the pending owner and all seven identity fields; they do not require a durable
pause. Boundary/status checks wait for the corresponding run event milestone.
Terminal checks also inspect each observed continuation through authorized
`continuations.get` until its receipt is settled: `run.completed` precedes the final
fenced service write. L02 and backing-parity A11 inspect first, wait read-only for settlement, then
reconcile once. R03 observes admission settlement with `operator.admission`, never
by polling the admission mutation. Deliberate retained-key replay cases remain
explicit tests, separate from readiness.
On terminal receipt failure, the fixture emits bounded, failure-only diagnostics:
the last 32 public run/continuation milestones (sequence, type and receipt state),
receipt state and blocked reason, lease-file presence, and an allowlisted error code.
Lease-file presence is a snapshot, not proof of live ownership. These reads use the
same authorized peer for events and receipts; the lease probe only checks file
existence. Diagnostics never open protected payloads or print credentials, rationale,
raw errors or subprocess output, and never trigger reconciliation. A failed event
reread falls back to the already observed event sequence.
Readiness propagates errors, does not retry mutations, uses the existing timeout,
and never falls back to an owner's credential. The raw `page()` remains unchanged
for cursor and fault tests; A12 deliberately reads without readiness and accepts
only a schema-valid snapshot, the explicit empty `restartRequired` response
(no cursor and no truncation), or bounded `RUN_STATE` refusal, then requires the
settled revision view. A restart signal is not treated as a settled empty result. A12 does not guarantee that timing exercises both outcomes.

## Executable matrix

The current matrix contains 60 cases. Each row runs over **both stdio and authenticated HTTP MCP**. Counts include both
transports. Row IDs are executable `-t` selectors. Backing HTTP/WS coverage in F01,
R02, A09 and A11 is additional to the MCP transport parameterization.

| ID | Count | Executable acceptance |
| --- | ---: | --- |
| F01 | 2 | Actual authenticated discovery and tool inventory agree with daemon hello and HTTP/WS discovery. No advertised substitute capabilities. |
| F02 | 2 | Real preflight and existing direct admission park a gate; bounded event pages preserve distinct IDs and one persisted run. |
| F03 | 6 | Existing production services create revision, live permission and parent/child workloads; protected boundary and live callback readiness are real. |
| F04 | 4 | Existing production answer/revision and continuation services actually execute the scripted agent and produce an artifact; rationale is excluded and corrective text reaches the prompt. |
| L01 | 2 | All ten aliases mounted; Request identity retained, direct admission invents no Request; actual lookup/reconcile receipts and one run correlate. |
| L02 | 2 | Exact durable answer records without resuming; duplicate refused; continuation/lookup/reconcile; rationale excluded from agent prompt; exact artifact read and byte omission. |
| L03 | 2 | Atomic answer plus root continuation replays once; one continuation/operation, accepted/accepted/settled journal transitions and exactly one correlated decision; mismatched child boundary and a fresh terminal continuation refused. |
| L04 | 2 | Pinned revision target/action; every target component and undeclared action ID checked; ordinary answer cannot bypass revision; declaration payload validation; replay/conflict; private text excluded from public history and delivered once. |
| L05 | 2 | Cancellation receipt reflects a real cancellation of exact parent and descendants. |
| R01 | 4 | Request and direct admission each lose an acknowledgement after commit; no automatic retry; explicit retained-key replay/lookup/reconcile matches actual receipt; changed payload conflicts. |
| R02 | 2 | Kill/restart preserves admission correlation; old instance target refused; fresh-target replay creates no run; HTTP/WS lookup/reconcile agree. |
| R03 | 2 | Two compiled daemons concurrently replay one already accepted retained key; one operation/run, read-only settlement, changed payload refused. |
| R04 | 2 | Combined answer/continuation response loss, restart, stable receipt, replay and changed-decision conflict; one decision-bearing journal marker. |
| R05 | 2 | Revision response loss and restart preserve protected pending receipt without executing or publicly exposing its payload. |
| A01 | 2 | Revoked connected caller refused before dispatch for all ten tool names; typed HTTP 401 or bounded MCP AUTH_INVALID; open WS cannot retain authority. Executable before mounting, without proving alias-handler execution. |
| A02 | 2 | Current grant combinations and owner/workflow scope; weak readers receive restriction-only action ID and no revision view; continuation disclosure matches authorized `runs.get`. |
| A03 | 2 | Workspace/boot/run/step/input identity, caller authority injection, implicit resume and standing grants refused; cross-run artifact ID refused. |
| A04 | 2 | All seven live identity fields; actual second daemon reports owner-unavailable; original callback accepts once and duplicate cannot deliver again. |
| A05 | 2 | Owner death/restart expires live approval; old callback never receives an answer. |
| A06 | 2 | Unscoped runs omit strong enrichment and unscoped inputs are refused with PROTOCOL_MESSAGE; bounded reads, forged cursor restart and snapshot invalidation after revision; protected text excluded. |
| A07 | 2 | Revocation while a real protected read response is held prevents late MCP publication. This is an edge publication check, not a claim about every internal daemon await. |
| A08 | 2 | Audit binds authenticated actor and actual operation/run correlations; excludes key, rationale, credential, paths; errors exclude payload/stack/details. |
| A09 | 2 | Backing HTTP/WS strict schemas, retry UTF-8 byte limits, target checks and receipt equality; unsupported pending-replacement surface stays absent. |
| A10 | 2 | Ordinary boundary is unsupported; missing durable protected evidence propagates RUN_STATE as a whole-read failure without a boundary/success payload; current authentication remains required and restoring evidence restores the authorized revision view. |
| A11 | 2 | All ten aliases succeed through both backing HTTP and WS with actual execution, Request/direct identity, continuation receipts, cancellation and revision effects. |
| A12 | 2 | Cold revision/run reads without readiness expose a schema-valid snapshot, an explicit empty restart signal without cursor/truncation, or a bounded whole-read RUN_STATE refusal without a usable boundary; the subsequent settled revision read must succeed. |

Coverage limits: L03's child refusal uses a boundary from another run, so it does
not independently establish root-only enforcement. L04 prepares action-ID mismatch,
five target-component mismatches and empty/oversize UTF-8/wrong-kind refusals; valid
structured-values and depth-limit workloads remain unrun/unimplemented here. A10
covers revision evidence failure and restoration, not continuation uncertainty or
a typed transient-unavailability classification. A07 checks the publication edge,
not every awaited daemon authorization boundary. These limits remain integration
follow-up within #327; this matrix is not a claim of complete production acceptance.

Current-main verification does not yet establish TLS termination or private-tunnel
lifecycle on agent-01, the current binary's host activation, or Cal's tool selection
and confirmation behavior. The observed Cal discovery on the older runtime proves
one authenticated read for that principal and scope only. #327's remaining
pre-existing-run, Request/direct-run, cancel/recovery, exact gate-negative,
denial/truncation/secret-fixture and follow-up cases require actual-client evidence
under [#393](https://github.com/cschadewitz/Project_Orca/issues/393).

The ten aliases are exercised positively by A11 and these MCP cases:

| RPC | MCP tool | Principal cases |
| --- | --- | --- |
| `operator.submitRequest` | `submit_request` | L01, R01 |
| `operator.admitRun` | `start_workflow` | L01–L05, R01–R03 |
| `operator.admission` | `get_admission` | L01, R01, R02 |
| `operator.reconcileAdmission` | `reconcile_admission` | L01, R01, R02 |
| `operator.cancel` | `cancel_run` | L05, A03 |
| `operator.answer` | `respond_to_approval` | L02, A04 |
| `operator.continueRun` | `continue_run` | L02–L04, R04 |
| `operator.continuation` | `get_continuation` | L02, R04 |
| `operator.reconcileContinuation` | `reconcile_continuation` | L02, R04 |
| `operator.revise` | `revise_input` | L04, R05 |

## Historical initial preparation evidence (C branch)

Initial commit `9720e7d736bcacdd04ae3609c3ab175d91169290` was executed on 2026-10-03 with Node `24.21.0` and pnpm `12.4.2`, using a build made
from the frozen base in this isolated checkout:

| Check | Passed | Failed | Skipped / unrun | Result |
| --- | ---: | ---: | --- | --- |
| Complete preparation matrix, 58 tests | 14 | 0 | 44 dependency skips; their production bodies are unrun | All F rows pass; all L/R/A rows blocked on the real mount. |
| Strict gate diagnostic, lifecycle `-t L01` | 0 | 2 expected dependency failures | 22 excluded by the name selector | Nonzero exit; stdio and HTTP both report all ten aliases missing. |
| Compiled build (`tsc -b tsconfig.build.json`) | — | — | — | Passed. |
| Root TypeScript including tests (`tsc --noEmit`) | — | — | — | Passed. |
| ESLint on the four new test files | — | — | — | Passed. |
| Prettier on the five owned files | — | — | — | Passed. |

The full matrix took 185.45 seconds; the strict diagnostic took 6.80 seconds.
Local machine-readable reports are `/tmp/orca-327-production-results.json` and
`/tmp/orca-327-strict-results.json` (generated evidence, not committed fixtures).
The diagnostic used:

```sh
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-lifecycle.test.ts -t L01 --maxWorkers=1
```

In that initial run, F rows establish fixture readiness only. L/R/A bodies remained unexecuted because
production discovery exposes none of the ten mutation/receipt aliases. There are
no unexpected failures in the final preparation run. The full strict matrix,
production-body results after Cal's integration, the unrelated full repository
suite, renderer/Electron checks and actual-Cal #393 proof are **unrun**. The strict
command is the required acceptance command after Cal integrates; a preparation-mode
green exit is insufficient. The two expected strict-gate failures do not establish
that the blocked production bodies pass or fail.

No main merge, deployment, release, credential migration, host security change or
actual-Cal connectivity is part of this branch. No percentage, ETA or cost is
estimated. Complete production success, CI and #393 proof remain outstanding.

## Historical first review corrections

Refusal responses now enforce `OPERATOR_MAX_RESULT_BYTES` and reject success
`structuredContent`, retaining credential-leak checks. A01 accepts only the SDK's
`SdkHttpError` with HTTP status 401 (or an ordinary MCP `AUTH_INVALID` refusal), not
message matching or arbitrary thrown errors. The SDK error message/data are also
bounded and checked for credential leakage. A01 can run before production mounting
because authentication must precede tool lookup. Passing it proves that edge for
all ten requested names, not execution of the absent mutation handlers.

A10 now requires a whole-read `RUN_STATE` refusal for missing durable protected
payloads, forbids a usable boundary/success payload, checks revocation during and
after the fault, and verifies that restoring the file restores the authorized
revision view. It does not turn generic store errors into successful `unavailable`
rows. A10, the new L04 action mismatch and A12 remain blocked on real integration.
The readiness helpers are exercised through F02–F04 with real services on the
preparation branch; their use by production aliases still requires the integrated
strict run.

Final review validation on 2026-10-03, Node `24.21.0` / pnpm `12.4.2`:

| Check | Passed | Failed | Skipped / unrun |
| --- | ---: | ---: | --- |
| Complete preparation matrix, 60 tests | 16 | 0 | 44 dependency skips; production bodies unrun |
| Strict A01, both transports | 2 | 0 | 22 excluded by the name selector |
| Strict L03/L04/R03/A10/A12 diagnostic | 0 | 10 expected missing-mount failures | 50 excluded by the name selector; selected production bodies unrun |
| Compiled build, root TypeScript, scoped ESLint, five-file Prettier and diff whitespace | All passed | 0 | — |

The full preparation matrix took 230.38 seconds. F01–F04 contribute 14 passes;
A01 contributes two authentication-edge passes. A02–A12, all L rows and all R rows
remain blocked. An intermediate readiness-development run had 12 passes, four
fixture failures and 44 dependency skips: it incorrectly expected preparation MCP
live-owner hooks and a single child event rather than spawn/finish rows. Those
assumptions were corrected before the final run; production ownership assertions
remain in A04. Reports are `/tmp/orca-327-review-production-results.json`,
`/tmp/orca-327-review-a01-results.json` and `/tmp/orca-327-review-strict-results.json`.
The earlier development report is `/tmp/orca-327-review-development-results.json`.
These are generated local evidence, not committed fixtures. Targeted strict commands:

```sh
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-authority.test.ts -t A01 --maxWorkers=1
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-{lifecycle,recovery,authority}.test.ts -t 'L03|L04|R03|A10|A12' --maxWorkers=1
```

GitHub CI currently has no run for this preparation-target PR: `ci.yml` only
triggers for `main`. Enabling that CI path is outside C's ownership. The integrator
must also build the compiled runtime before these tests execute. No-checks is not
green CI, and the required full strict integration run remains outstanding.

## Combined validation of remaining review corrections

The updated review on #431 identified A06's incorrect unscoped-input success
expectation, L02 reconciliation during an active execution lease, L03 counting
journal transitions as separate continuations, and terminal reads preceding the
continuation service's final receipt. The tests now preserve the run-scope guard,
separate receipt inspection from reconciliation, count one logical continuation
with three ordered public transitions and one exact decision, and wait through
authorized read-only receipt inspection before settled MCP reads. Public event
records intentionally omit the protected dispatch field; the expected accepted /
accepted / settled sequence corresponds to needed / attached / settled, with the
lookup and replay proving the same operation identity. Production code is unchanged.

The combined run also exposed the same active-lease ordering in backing-parity
A11, now corrected. A12 had assumed that a cold successful read could never require
restart. The existing read model explicitly returns `restartRequired: true` on
concurrent publication; A12 now asserts that exact safe response has zero items,
no cursor and no truncation, preserving the mandatory later settled assertion and
all error checks.

R03's original fresh race was scheduling-dependent because the two daemon boots
have different active configuration generations. A command pinned by the first
can legitimately fail `CONFIG_STALE` on the second if it wins the fresh claim.
R03 now first accepts with the issuer, then races explicit same-key replays in
both daemons and checks identical operation/result, replay flags, a single run,
and changed-payload refusal. Settlement uses read-only admission lookup. This
establishes concurrent replay of durable intent, not simultaneous fresh admission
under a shared generation; that latter scenario is not established by this fixture.

The earlier preparation and review sections above describe their original heads,
not the current composed validation result. No full repository, renderer/Electron,
CI or actual-Cal acceptance is implied by this matrix.

### Reproduced product defect

L03 intermittently reaches `run.completed` but its continuation never reaches the
expected settled receipt. The first combined run timed out after the existing
15-second read-only bound on HTTP. A subsequent fresh-fixture diagnostic on the
final test sources reproduced a **blocked** receipt after completion on stdio
(1 passed, 1 failed, 22 name-filter exclusions). The harness now fails immediately
on that blocked receipt; it neither reconciles it away nor retries the mutation.
The original successful retained-key replay and single-decision assertions remain.

Source inspection suggests a race in `ContinuationAdmissionModel.admit`: an
accepted replay schedules reconciliation again, and its failure path can call
`blockUnavailable` while the original attachment is settling. This is a suspected
cause, not a traced proof of the exact interleaving or blocked reason. The observed
post-completion blocked receipt is reproduced; production remediation belongs to
the runtime owner. No product code was changed here, and a later passing matrix
does not establish that this intermittent defect is fixed.

### Exact composed execution evidence (2026-10-03)

Runtime baseline: `951950dbf685bd3b9054a8399346eed15b403b4c` (#434), built in
`/tmp/orca-431-validation`. Only the four C test files from the C commit containing
this document were overlaid. Node `24.21.0`, pnpm `12.4.2`. No composed runtime
source was imported into the C branch. The PR records the full C commit SHA.

| Execution | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Final full strict matrix, 374.56 seconds | 60 | 0 | 0 |
| Final-source L03 diagnostic | 2 | 0 | 22 name-filter exclusions |
| Final-source L03 reproduction (first fresh repeat; stopped on failure) | 1 | 1 | 22 name-filter exclusions |
| Intermediate full strict matrix before A11/A12/R03 corrections | 56 | 4 | 0 |
| Intermediate A12 diagnostic | 2 | 0 | 22 name-filter exclusions |

The final matrix includes authority 24/24, lifecycle 24/24 and recovery 12/12;
all ten aliases and both MCP transports executed. The intermediate failures were
A11 HTTP `RUN_LEASED`, A12 stdio explicit snapshot restart, R03 stdio `CONFIG_STALE`,
and L03 HTTP receipt-settlement timeout. The first three fixture expectations were
corrected as described above; the fourth remains a reproduced product defect.
The full matrix pass is not a claim of stable product acceptance or CI clearance.

Commands (from the composed validation worktree, except C lint/format checks):

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.build.json
pnpm exec tsc --noEmit
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-{lifecycle,recovery,authority}.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=/tmp/orca-431-final-results.json
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-lifecycle.test.ts -t L03 --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=/tmp/orca-431-continuation-results.json
# Reproduction uses the same L03 command with a fresh fixture and output filename:
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-lifecycle.test.ts -t L03 --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=/tmp/orca-431-continuation-repeat-1.json
pnpm exec eslint packages/integrations/test/mcp-operator-production-*.ts
pnpm exec prettier --check packages/integrations/test/mcp-operator-production-*.ts docs/mcp-operator-production-acceptance.md
git diff --check
```

Compiled build, root TypeScript in both C and composed checkouts, scoped ESLint,
five-file Prettier and whitespace checks pass. An offline install lacked a cached
tarball; the authorized frozen install succeeded. An attempted Vitest `--repeat=3`
command was rejected before executing tests; the bounded shell-loop reproduction
stopped after its first run failed. Neither setup failure contributes test counts.
Reports and logs live under `/tmp/orca-431-*`; generated evidence is not committed.

### Continuation settlement correction (#443)

The fix starts from accepted main `3702da5b38dc449280c2837366615de741e9c45c`.
The observed #442 merge `9639c5a4bc8cb8de192c3ecc6952358b4c2249a8` has the
same continuation runtime blob (`008a7419826729f07849ffbec6818abe9eb6f796`).
Deterministic barriers reproduce blocked receipts on that runtime when a replay
reads dispatch-needed before the winner attaches, then enters inner recovery
after completion but before settlement. Both same-model and separate-model cases
fail. Refusing the final settlement fence or store append independently reproduces
the same receipt corruption. These establish concrete defects, not the exact
interleaving of the original CI failure.

Recovery now checks terminal history under the existing writer fence, and
post-execution settlement publication failures preserve a recoverable receipt.
Tests also cover lost acknowledgement after a durable settlement append and an
execution-wrapper rejection after terminal publication. The existing strict L03
checks, authority classification, unsafe-boundary rejection, journal verification,
single decision and single execution remain in force. The #443 PR records bounded
Node 22/24 baseline samples and validation against its final commit; passing random
samples alone are not evidence that a race is fixed.

### Pre-lease continuation contention correction (#499)

The accepted base is `f799be0700044320d53a0dd606e4397b07a25053`.
Deterministic shared-runtime barriers hold the winner inside summary loading,
after its local running slot is reserved and before durable execution lease
acquisition. Both same-model and separate-model retained-key responses schedule
reconciliation. On the unchanged runtime, each loses with `RUN_LEASED` but
publishes a second `blocked` marker while the winner remains at the barrier.
Both strict regression cases fail there; cleanup releases the winner and drains
execution. This reproduces #499's mechanism, not the uncaptured extra Linux CI
event's exact state or interleaving.

Pre-attachment `RUN_LEASED` now refuses the competing attempt without publishing
a receipt transition. The original accepted intent remains inspectable while
the winner attaches; the public journal remains exactly
`accepted / accepted / settled` with one correlated decision, one attachment,
one execution and one completion. Fresh terminal intent is refused without a
new event. This rule also covers an actual file-lease refusal whose incumbent
releases before error handling: acquiring a publication fence afterward does
not make that refusal a failure of the shared intent. Separate interpreter/store
instances still refuse execution against a real active lease.

The regressions use real file stores, registered retry claims, protected journals,
generation restoration and the interpreter, with the existing injected scheduler
and labelled authority-wrapper fixture. They release every barrier and drain both
models during cleanup. Existing authority/revocation, exact-boundary, generation,
journal verification, and #448 post-completion/publication-refusal tests remain
in force. Production L03's strict checks and read-only observation are unchanged.
The PR records the final SHA and Node 22/24 build/check/test results. These tests
do not establish actual-Cal, deployed-host or Windows acceptance.
