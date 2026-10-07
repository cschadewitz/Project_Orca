# SHA-bound shadow selection (#509)

This is an independent advisory implementation of [#509](https://github.com/cschadewitz/Project_Orca/issues/509).
It computes **would-run** plans; the existing full CI checks remain authoritative.
No workflow, required check, test timeout, worker limit, production fixture, runtime,
release or deployment behavior changes. The separate [#510](https://github.com/cschadewitz/Project_Orca/issues/510)
fixture optimization owns its production fixture changes.

## Owned implementation and limits

The implementation lives in `tools/ci-shadow/`, its tests in
`tools/test/ci-shadow-selection.test.js` and `tools/test/ci-shadow/golden.v1.json`,
and this document is the only selector documentation path.

`ownership.v1.json` versions the exact initial island, full-risk rules, reviewed
Git inventory, explicit consumer edges and runner/check inventory. Its reviewed
source is main `d3491cc06b5abc1c5d82f2c685d6f628d9d4b04b`, tree
`db6e22b47cafb1504ebdab1c3ef9cac0b06cad90`. That tree has 339 statically discovered Vitest files.
Adding the selector test increases candidate discovery to 340; this implementation
PR therefore takes full, as do all selector/manifest changes.

The initial Tier 1 advisory island contains exactly the existing renderer
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
  scripted-agent processes. Reverse runtime dependencies preserve authority,
  lifecycle and recovery consumers even if the candidate removes an import.
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
**1.1.0**; manifest/graph version **1**. Proposed artifact filename:
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

The later consumer must independently resolve the **current** event identities,
run trusted `validatePlan`/the CLI validator with those identities, and reject on
any mismatch. Validation recomputes the complete proposal: schema/version, SHA,
selector/manifest/graph hashes, discovery, diff, reasons, selected files and checks.
It rejects unknown fields, edited selections, stale code/metadata and mutated
observations. Base/head/candidate movement invalidates prior plans. A push/merge
queue consumer needs its own correctly resolved candidate, not head-only reuse.
This version implements no event adapter and grants no merge/release authority.

Observed execution belongs in a separately versioned evidence sidecar linked to
the same candidate and plan digest. The exported `validateExecution` checks a strict
normalized file report: `{candidate,node,lane,success,files}` with lane `suite` or
`retry`, Node 22/24 and each file `{path,status,passed,failed,skipped}`. It rejects
missing/extra/duplicate files, zero assertions, failure/cancellation, skips and stale
identity. The retry lane requires both named CLI/ACP files to pass with no skips.
The later report adapter must derive counts/statuses from actual runner results;
passing claimed counts to this helper is not proof that a process ran. Ordinary
full-suite intentional opt-in skips need an explicit reviewed evidence model; this
strict helper cannot accept them as passed and does not replace current CI's
existing separate acceptance step. There is no raw Vitest/Playwright adapter or
aggregate gate in this slice. Compile/demo, coverage, browser and native verdicts
must be separately recorded against the same SHA; Vitest results cannot stand in
for those lanes or platform coverage.

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

1. Emit shadow plans alongside same-candidate existing full results, without a
   second concurrent full workload; add trusted exact-file discovery/result adapters.
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
