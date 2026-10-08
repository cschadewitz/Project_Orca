# SHA-bound shadow selection (#509)

This implements [#509](https://github.com/cschadewitz/Project_Orca/issues/509).
The reviewed selector now reduces eligible PR tests on Node 22; Node 24 still runs
the complete suite with unchanged coverage thresholds on the same candidate.
A separate read-only workflow compares the actual execution evidence.
Required check names, test timeouts, worker limits, production fixtures, runtime,
release and deployment behavior remain unchanged. The separate [#510](https://github.com/cschadewitz/Project_Orca/issues/510)
fixture optimization owns its production fixture changes.

## Enforced PR execution

Casey explicitly authorized activation after #520's first genuine live comparison
at main `983b824adba26b0d26cfca747e5c303d03a397c6`. The enablement branch starts at
verified main `65606fbce827cba914a67b999b1a47c0aab2797a`.

- Only `pull_request` Node 22 jobs with a completely recomputed **targeted** plan
  may run `Test selected files`. Eligibility remains the two exact time-formatting
  leaves below and the existing positive literal/structure/capability invariants.
  The selected set is the entire app Vitest domain plus union-graph consumers and
  directly modified tests. This is a real reduced invocation, not a full-mode flag.
- Node 24 always runs full coverage. Main pushes, critical/mixed/unknown changes,
  stale inventory/source, changed discovery, ambiguous identities and selector
  errors retain full testing. Every PR/main event admits the check matrix, including
  Markdown, consumed documentation, unknown inputs, renames and deletions. There is
  no docs-only bypass: classification cannot discard a rename's old path or assume
  Markdown has no consumer. Even an advisory docs plan executes full Node 22 tests.
- Exact event base/head/candidate SHAs are required. A PR candidate must have
  exactly the ordered parents `[base, head]`, and checkout HEAD must equal candidate.
  The checkout has full history and retains no Git credentials. No PR code runs in
  the privileged `workflow_run` consumer: candidate source is immutable Git data.
- Build, production-required environment, bounded workers, CLI/ACP retry acceptance
  with no skips, and compiled smoke stay mandatory on both Nodes. Whole-repository
  statics and every global/app coverage ratchet stay unchanged on Node 24.
- Immediately before selected execution, the plan is recomputed and fully validated,
  HEAD and tracked source must match the immutable candidate before execution,
  before accepting reports and after report validation; a clean commit move also
  fails. Any old result is removed. Vitest gets
  argument-array paths, without a shell. A green process is insufficient: fresh
  JSON must contain exactly all selected files, with passing nonempty assertions and
  no failure, skip or todo. Missing, duplicate or additional files fail the job.

The old frozen inventory no longer matched current main and made all real proposals
full. This PR explicitly refreshes the whole inventory certificate after its final
workflow/reporting changes; it does not declare an unknown graph complete. Its own
old-base implementation change takes full. Subsequent same-certificate literal-only
PRs can reduce. Future non-exempt inventory drift deliberately restores full until
a separately reviewed certificate refresh; broad runtime/test-only eligibility is
not enabled. The graph's completeness claim still covers only the named island.

The refreshed certificate audits implementation `fd336c55000a8554bd5741bd8518c27df2ed2649`
with inventory hash `47843eb5631d9f00944ce1446b5edb2b4312eb48aa022ecf634cf076e3782c54`.
Selector version **1.1.2** includes execution/evidence source in its identity.
The earlier certificate and acceptance records below are historical, not the current
activation certificate. The enablement PR's full run and first new live consumer
remain parent-controlled acceptance checks; local probes do not fabricate those results.

The advisory consumer reads the source job API to distinguish full `Test` from
`Test selected files`. A reduced Node 22 report is **selected_verified**, never a
full Node 22 baseline; acceptance also requires Node 24 **compared** against full
discovery for exactly the same run/attempt/base/head/candidate. The artifact's legacy
`ci-full-evidence-*` name/schema does not imply full execution: `execution` in the
comparison explicitly states `selected` or `full`. The three reviewed intentional
full-suite skips remain exact-name/hash and unchanged-blob checks. Selected execution
allows none. Browser/native lanes remain unknown, outside this CI workflow.

To adopt the new workflow on an existing PR, merge or rebase the merged enablement
main into its head, then push normally. That `synchronize` event creates a new run
with the new workflow and exact new merge candidate. Rerunning an old run reuses its
old workflow; base movement alone also leaves head-to-candidate workflow/selector
changes that force full. No synthetic PR or manual dispatch is needed. Unrelated
runtime PRs still take full. The parent owns cancellation, merge and controlled
resumption; this implementation does not dispatch or poll CI.

Rollback: change the Node 22 full `Test` condition back to `matrix.node != 24` and
remove/disable `Test selected files` through an ordinary reviewed workflow PR. Main
and Node 24 already remain full. No branch protection, host or credential change is
needed. No measured latency saving or broad activation evidence is claimed.

## Owned implementation and limits

The implementation lives in `tools/ci-shadow/`, its tests in
`tools/test/ci-shadow-selection.test.js` and `tools/test/ci-shadow/golden.v1.json`,
and this document is the only selector documentation path.

`ownership.v1.json` versions the exact initial island, full-risk rules, reviewed
Git inventory, explicit consumer edges and runner/check inventory. The merged
#511 foundation audited main `6a7316cba563e9c3f0c1cc1f6d7e0a5fb65e3c85`, including
#512's credential-admin regression and #519's bounded failure-only diagnostics;
its selector test brought discovery from 341 to 342 files. This reporting slice
starts at verified main `d7546ce6bcaf51f194aade26de2cd9a432cd7073`
(tree `9cc9f5fcf2f202dddeb8403ba2425e9d1abbf132`) and refreshes the frozen inventory
to implementation `820db15eaebfb5a3aee22107b0e7baf4dc771281`, hash
`56bdea6aee6ade13f38bfd64cb47b2b731f9654c9f3942da278aad20f3898c82`.
The new report-adapter regression brings discovery to 343. Eligibility, selector
algorithm/version, existing edges and test semantics are unchanged. This PR
necessarily takes full; its older base inventory is incomplete for the refreshed
audit. Subsequent same-baseline candidates can use the existing literal-only rules.
The original `d3491cc` review had 339 files and cannot replace this source inventory.

The historical CI 553 reporting integration included main
`c1eba301702fef0466b2d3481c36d62331ee7d48`, including the reviewed test compiler,
accepted-retry contention fix and standard `ubuntu-24.04` CI routing. The shadow
consumer uses that same runner route. The frozen inventory above is retained;
new integrated files conservatively force full selection until a separate audit.
This integration neither changes selector eligibility nor reuses prior evidence.
CI 538's Node 22 failure remains historical; its actual holder/cause is unproven.

The final ready-baseline refresh integrates main
`6abcdbaa72f26972adfc1ce6f9ef03e0232b47a9`, including the reviewed ACP SDK 1.7.0
update, preparation documentation/staging tests and daemon shutdown settlement.
Reporting source, strict trusted workflow/producer parity, intentional-skip policy
and frozen inventory are retained. New discovery remains full until separately
audited; this refresh does not expand selector eligibility. The parent-verified
CI 553 comparison selected full/all 345 on its original `c1eba301` base,
`6db566c` head and `1901becc` candidate, with both lanes compared and three skips
retained per lane. That historical evidence cannot authorize this newer tuple.
Fresh full CI and a later live default-branch consumer remain separate gates.

The initial Tier 1 island contains exactly the existing renderer
`src/ui/format-time.ts` and `test/format-time.test.tsx`. Eligibility requires a positive structural invariant: each base/candidate leaf
must match its reviewed normalized AST fingerprint. Only string, numeric and
(non-tagged) template text literal values are normalized, and text must remain
within the reviewed one-line ASCII wording alphabet (letters, digits, spaces and
` ,.'?!:;%()+-`). Changes outside those allowed literal values take full. An exact source frame
also freezes every byte outside those approved literal spans, including comments,
formatting, compiler directives and test-runner pragmas.
Node kinds, semantic flags/scalars, identifiers, child order and trailing-comma
structure remain fixed. New statements, declarations, calls, member reads,
control flow or binding/assignment forms take full, even when earlier capability
signatures happen to match. This is a literal/wording pilot, not general code-change
eligibility. Dependencies, imported bindings, call targets and member-access
signatures must also remain reviewed.

The virtual TypeScript binder permits only the reviewed
`Date`, `Math` and `undefined` ambient references; unresolved transport/persistence
references, ambient declarations and external-module import-equals force full.
New named/default/namespace imports, side-effect imports or foreign re-exports
force full even from an already reviewed module; an added Vitest helper can import
another module dynamically. New member reads/calls also force full: existing
`expect` can otherwise gain a filesystem snapshot matcher without a new import.
Computed member access, tagged-template invocation, object/array binding patterns
and destructuring assignments (including `for-of`, `for await` and `for-in`
assignment initializers) force full. Quoted destructuring keys can otherwise
hide a filesystem API behind already reviewed method names. The primary AST invariant rejects all unreviewed structure; the capability guards
are additional conservative checks. This does not prove arbitrary semantics. Binding loads
no candidate libraries or dependencies.
Additions, deletions, copies,
renames, modes, new test files and discovery changes take full. All renderer
**and app-side** Vitest tests are
selected together. All five browser/platform runners are conservatively retained.
There is no independent-package or broad renderer eligibility rule. In particular,
resource-model authority/lifecycle, bridge/preload, credentials, protected inputs,
protocol, shared design, persistence and maintenance MCP stay full.

Tier 0 has one exact, reviewed inert prose path: this document. Other Markdown,
JSON, YAML, logs, shell/Python scripts and docs assets are unknown/full until
reviewed. `docs/preparation/**` contracts and fixtures and `templates/**` runtime
inputs are full regardless of extension. A label or caller can force full;
`--force-full true` cannot lower a tier.

The graph is deliberately bounded. It combines static imports/re-exports, source
aliases, emitted-to-source imports, package exports/workspace dependencies,
TypeScript references, conservative domain supersets and reviewed explicit edges:

- The prepared-root JSON fixture feeds its filesystem-reading contract and the
  Vitest wrapper. Security-contract changes are full.
- The production MCP fixture consumes emitted CLI, daemon, MCP transport and
  scripted-agent processes. The credential-admin child maps emitted
  `daemon/dist/auth/bootstrap.js` to its source; #512's regression independently
  imports both emitted daemon entrypoints, verifies identity/fresh processes and
  tests persisted revocation. Reverse runtime dependencies preserve authority,
  lifecycle and recovery consumers even if the candidate removes an import.
- The reviewed restart diagnostic helper supplies the optional observer preload
  to the compiled MCP child. Its regression launches both the observer preload
  and a TypeScript helper import embedded inside generated child code. Explicit
  filesystem edges retain the retry catalog/operation, run event and lease
  mutation lock-metadata readers. The helper and diagnostic regression remain
  shared/full-risk paths; their review does not expand targeted eligibility.
- Shared resource fixtures, resource-model, preferences and Vite feed the standalone
  resources browser spec. Its `.spec.ts` is outside root Vitest discovery.
- Linux Electron smoke, three-platform type proof and macOS/Windows native encrypted
  intent/revision acceptance are separate runner edges, with their configurations,
  exact files, projects and platforms recorded.

The non-island inventory is hashed as sorted path/mode/blob identities. A change
outside the explicit prose/island/owned-selector paths invalidates the audited
inventory and forces full. Unresolved static imports, parser errors, missing explicit
edges/runners, unsafe paths or non-regular files also make the graph incomplete.
Static import analysis is a lower bound; the frozen inventory and domain supersets
cover the named island only. They do not prove every possible semantic dependency
or arbitrary code behavior. Refreshing coverage/eligibility needs full verification
and review. Most real PRs will initially take full; no measured speedup is claimed.

## Producer contract

Use the pinned package manager (`pnpm@12.4.2`) and the task's Node `24.21.0` for
local evidence, preserving frozen-lockfile installation and supply-chain policies.
The TypeScript parser is the existing ESLint tool package dependency; no new
dependency or lockfile modification is needed. Supported runtime verification
continues to include Node 22 and 24.

Run the selector from a trusted checkout, using full immutable 40-character commit
SHAs resolved by the eventual workflow from its event/candidate, never PR-supplied
branch names or labels that lower risk:

```sh
node tools/ci-shadow/cli.js plan \
  --repo /path/to/checkout \
  --base "$BASE_SHA" --head "$PR_HEAD_SHA" --candidate "$CANDIDATE_SHA" \
  --force-full false > "$PLAN_TEMP"

node tools/ci-shadow/cli.js validate \
  --repo /path/to/checkout \
  --base "$BASE_SHA" --head "$PR_HEAD_SHA" --candidate "$CANDIDATE_SHA" \
  --force-full false --artifact "$PLAN_TEMP"
```

Both commands must succeed before publishing an artifact. Use atomic publication
of the validated temporary file; never consume partial stdout. An exception emits
no JSON and exits nonzero. Missing/unavailable/abbreviated commits, unavailable or
multiple merge bases, invalid/truncated Git records and unrelated candidates fail
the producer. A later workflow must fail or independently recompute a verified
full plan; producer failure/cancellation/missing artifacts cannot become docs or
targeted success. Empty diffs and discovery select full, not an empty success.

Git reads use immutable objects with replacement objects, external diff and text
conversion disabled; candidate JavaScript and configuration are not executed.
NUL-delimited status parsing retains both sides of renames/copies and deleted paths.
The plan records merge-base → PR head changes **and** head → actual merge-candidate
changes. Thus independently advanced base code present in the tested candidate
cannot silently disappear from classification. Candidate must contain both base
and head. This conservative second diff may force more full runs than a later
reviewed model. Graph edges and consumer discovery use the union of base and
candidate; missing base-side consumers from candidate discovery force full.

## Artifact and consumer contract

Artifact kind: `orca-ci-shadow-plan`; schema version **1**; selector version
**1.1.1**; manifest/graph version **1**. Proposed artifact filename:
`ci-shadow-plan-v1-<candidate-sha>.json`. The shape is specified by
`tools/ci-shadow/plan.schema.v1.json` (`urn:orca:ci-shadow-plan:1`). A matching
filename or valid JSON Schema shape is insufficient for acceptance.

Each deterministic plan carries:

- Immutable base, PR head, computed merge-base and actual candidate SHAs, plus
  base/candidate Git trees.
- Selector source/schema hash, manifest version/hash, graph inventory and graph
  hashes, coverage scope/completeness and exact discovered Vitest inventories.
- Every changed status and old/new path, origin diff, per-path tier/reason and
  union consumer evidence; mixed risk uses the highest tier.
- Exact would-run Vitest files, separate runners/configuration/projects/platforms,
  expected check identifiers and full-fallback reasons.
- `shadowOnly: true`, `authority: "existing-full-checks"` and an empty
  `observedResults` array. A proposal records no fabricated execution verdict.

The consumer independently resolves the **current** event identities,
run trusted `validatePlan`/the CLI validator with those identities, and reject on
any mismatch. Validation recomputes the complete proposal: schema/version, SHA,
selector/manifest/graph hashes, discovery, diff, reasons, selected files and checks.
It rejects unknown fields, edited selections, stale code/metadata and mutated
observations. Base/head/candidate movement invalidates prior plans. A push/merge
queue consumer needs its own correctly resolved candidate, not head-only reuse.
The event adapter below grants no merge/release authority.

Observed execution belongs in a separately versioned evidence sidecar linked to
the same candidate and plan digest. The exported `validateExecution` checks a strict
normalized file report: `{candidate,node,lane,success,files}` with lane `suite` or
`retry`, Node 22/24 and each file `{path,status,passed,failed,skipped}`. It rejects
missing/extra/duplicate files, zero assertions, failure/cancellation, skips and stale
identity. The retry lane requires both named CLI/ACP files to pass with no skips.
The report adapter derives counts/statuses from actual runner results;
passing claimed counts to this helper is not proof that a process ran. Ordinary
full-suite intentional opt-in skips need an explicit reviewed evidence model; this
strict helper cannot accept them as passed and does not replace current CI's
existing separate acceptance step. This slice adds a Vitest JSON adapter; no
Playwright adapter or aggregate gate is introduced. Compile/demo, coverage,
browser and native verdicts are separately recorded against the same SHA; Vitest results cannot stand in
for those lanes or platform coverage.

## Advisory CI reporting and same-candidate comparison

`ci.yml` retains its original full matrix and adds Vitest JSON alongside the
default reporter. It captures checkout identity before tests and publishes one
`orca-ci-full-evidence` v1 sidecar per run/attempt/Node, using `record.js`. It never
launches another suite. Capture, normalization and upload are advisory; existing
failures remain blocking. Partial/malformed/missing reports remain null. Artifacts
contain paths, statuses, counts and skipped-name SHA-256 hashes, with no assertion
text, messages, console output, absolute paths or credentials.

`ci-shadow.yml` receives `workflow_run: CI/completed`. It checks out only the
immutable default-branch `github.sha`, with persisted credentials disabled, and
installs that trusted tree's frozen dependencies under existing supply-chain
policy. It reuses existing action versions, pinned Node 24.21.0 and pnpm 12.4.2.
Only this consumer adds `actions: read` beside `contents: read`; existing CI
permissions remain unchanged. Candidate files/configuration/dependencies are never
checked out, installed or executed. No `pull_request_target`, write token, comment,
dispatch or check-result write is used. Python 3's standard ZIP/JSON libraries
read a bounded fixed member; no dependency/lockfile changes are needed.

The consumer resolves source run, attempt and complete job/artifact inventories
from GitHub's API. An open PR's live server base/head/candidate must match the
source run association, with two exact candidate parents. When GitHub omits that
association, complete server-side commit-to-PR lookup must yield exactly one open
PR with the exact source head; no branch/artifact hint is used. Identities are rechecked
after reads. A moved/closed PR, rerun, stale candidate or missing association is
unknown. Main push head/candidate is the source run SHA; comparison base is its
exact first parent. This is a first-parent comparison for multi-commit pushes too;
it does not reconstruct an unauthenticated `workflow_run` push `before` range.
Existing full push classification/execution remains unchanged.

Candidate CI workflow, Vitest config and producer/adapter must equal trusted source.
Changes to reporting/execution need a reviewed default-branch baseline. Artifacts
from the prior runner route remain unknown when their workflow blob differs;
runner labels are never normalized or accepted by compatibility inference. Before
this reporting workflow reaches the trusted default branch, producer evidence
cannot establish a live consumer verdict.

Artifacts are selected by exact run/attempt/Node. Missing, duplicate, expired or stale data
is unknown. Metadata, compressed-byte SHA-256, archive size, exactly one regular
`evidence.json` member, JSON size, strict fields, identity and duplicates are checked.
ZIP members are never extracted to controlled paths. Artifact text is never
executed or interpolated into shell, logs, Markdown, environment or outputs.

Normalized reports are untrusted runner data. Independently read GitHub step
outcomes must prove build, mandatory no-skip retry acceptance, full suite/coverage,
compiled smoke and Node 24 statics. This is provenance from existing full CI, not
cryptographic attestation against malicious tests forging their own reporter.
Reported full file inventory must exactly equal candidate discovery. Complete
trusted plan recomputation precedes publication. The comparison links a canonical
plan digest and retains failed omitted files, per Node. Missing/failed/skipped/
cancelled steps cannot yield `compared`; original failures remain in original
checks. `compared` is available evidence, not rollout/admission approval or savings.

Three existing Linux opt-in skips have an explicit bounded policy:

- CLI `admission-retry-wiring.test.ts` and ACP `admission-retry-acp.test.ts`: one
  exact skipped assertion each in the suite; both must independently pass every
  assertion without skips in the mandatory retry lane.
- `jev-eval.live.test.ts`: its exact credential-dependent live-provider assertion
  stays skipped. No credential or live-provider acceptance is introduced.

Each also requires the candidate test blob to equal trusted policy source. Skips
remain `skipped`, never passed. Different names/counts, changed source, empty/todo
files or other skips make evidence unknown. Strict `validateExecution` is unchanged;
this full-suite sidecar does not relax targeted/retry validation. A bounded seeded
omitted-failure regression checks incident reporting, not live targeted execution.

Browser/native runners remain `unknown/outside_CI_workflow`. Coverage and compiled
verdicts are the actual same-run step outcomes; numbers stay in existing coverage
reports. Legacy docs-only matrix skips give missing-full-suite evidence. Required
check names, classification, serial matrix, concurrency, coverage ratchets and
acceptance limits are intact. No aggregate or protection migration is introduced.

The new `workflow_run` consumer runs only after its workflow/tools reach the
default branch. Pre-merge CI can validate producer reports for a bounded read-only
local replay; it cannot prove the new default-branch workflow executed. Live
consumer validation is a post-merge follow-up; merge is unauthorized in this slice.
Setup/timeout failure remains a failed advisory job, not accepted evidence.
Nightly, release parity, freshness, platform adapters and pilot are later #509 work.

## Existing authority and remaining integration gates

The current full contract remains build-before-tests on Node 22/24, explicit
CLI/ACP retry acceptance with no skips, `ORCA_MCP_REQUIRE_PRODUCTION=1`, emitted
CLI demo, Node 24 whole-repository typecheck/lint/format/design freshness and full
coverage with unchanged global/app ratchets. Worker bounds and serial matrix stay
unchanged. Partial coverage would not replace full coverage. Existing checks
`check (node 22)` and `check (node 24)` remain unchanged. Branch-protection/ruleset
reads returned `Forbidden` in this environment; actual required-check settings
are unverified. No migration is implied.

Later owned workflow work must:

1. Validate the default-branch advisory consumer on real full CI runs; add separate
   browser/native result adapters before claiming those runners have evidence.
2. Review required-check settings before any stable `CI required` aggregate migration;
   implement `always()`/`needs` failure/cancellation/missing/skip checks and merge-group
   candidate handling without weakening existing required names.
3. Extract/reuse the complete full-verification contract and close release parity:
   current release checks use Node 24 only, tests before build, no explicit retry
   acceptance, required-production flag or coverage. All existing desktop packaging
   and app/native platform gates remain mandatory on the exact release candidate.
4. Preserve full main pushes. Add full nightly-main/platform verification, separate
   non-cancelled full-run groups, off-hour capacity-reviewed scheduling, failure ownership
   and freshness monitoring. Issue 509's proposed 30-hour freshness threshold and pilot
   minimums require rollout review; a cron or file-count ratio is not acceptance.
5. Replay representative historical exact base/head/config candidates, labeling
   incomplete discovery unknown. Compare targeted invocation and full results on the
   same SHA, test seeded omissions, require no unexplained missed failures/files/skips,
   retain coverage/Node/platforms, and review every represented island before activation.

Rollback is immediate full mode: disable the affected island after any selector
incident, or force all full if impact is unknown; preserve failures and require
current-candidate full green verification before affected admission or release.
Do not silently retry to green. No targeted gate is activated by this PR, and it
does not finish issue 509's workflow/nightly/release or pilot acceptance.

## Verification

The golden fixture exercises isolated Git histories for prose, renderer test/domain,
filesystem JSON, runtime/security/schema, executable docs, templates, lock/config,
test additions/deletions/renames, shared design and unknown paths. Negative probes
cover missing/abbreviated commits, mismatched merge candidates, base movement,
NUL/truncated/malformed/invalid UTF-8 paths, graph gaps, dynamic imports/new execution
boundaries, empty discovery/diffs, stale metadata, modified plans and missing/failed/
skipped file results. Union-consumer tests preserve removed imports and old fixture
names. Browser/resource/platform edges are checked without claiming a browser ran.

```sh
VITEST_MAX_WORKERS=2 pnpm exec vitest run \
  tools/test/ci-shadow-selection.test.js tools/test/ci-classification.test.js \
  --maxWorkers=2
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run design:check
pnpm run build
```

Publish exact-head local/CI results with the draft PR. This tooling test neither
launches the production fixture nor optimizes it; production/platform/pilot and
historical replay evidence stay distinct from graph regression coverage.
