# Acceptance and evidence matrix

Use the exact published preparation commit for checks and independent review.
The PR carries its immutable head because a document cannot contain the hash of
its own commit. An amended head requires rechecking and re-reviewing that head.

| Evidence class | Status and scope | What it establishes |
| --- | --- | --- |
| v1 synthetic contract/state suite | Passed locally on Node 22.23.2 and 24.21.0; 219 cases, zero failures/skips | Deterministic pins, strict objects/identity joins, drift, guard refusals, result/profile binding and retained synthetic uncertainty |
| Vitest bridge | Passed locally: same 219 cases through Vitest 5.0.2 with a temporary tooling-only config | Normal discovery registration; no production runtime tests |
| Historical owner-profile copy | Passed as reported in #502's linked exact b6f4345 receipt; not rerun here | That one approved owner invocation and independent destination checks |
| Historical independent copier tests | 63/77 passed in the linked cloud review; 13 failures and one error at existing ambiguous/missing cgroup mount refusal | Reviewed guard semantics; unsupported cloud profile remains refused; not a local 77-pass claim |
| Real controller ownership/effect/receipt integration | Not run; future controller work | No current evidence of acquired full ownership, atomic attempt persistence, real copy supervision or recovery |
| Actual worker readiness and #449 enforcement | Not run; separate enforcement acceptance | No worker write-sandbox, loopback, network, native-worker load or peak-capacity proof |

Historical owner evidence records 14 copied output trees, 192 recognized shims and
1,340 exact prefix edits; 22,985 verified entries and 18,155 independent destination
regular files. It reports successful version/native-load checks at their actual
owner profiles and expressly leaves future worker sandbox, loopback and capacity
unverified. Those counts and passes are attributed history, not measurements from
this task. See the [copy receipt](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6009737432).

## Local and repository checks

The environment has installed Node 22.23.2, Node 24.21.0 and pnpm 12.4.2, outside
the default PATH. The task checkout has **no node_modules**. The issue prohibits
installing packages and live source/dependency copying. Accordingly, dependent
checks requiring checkout dependencies stay blocked. Existing static Prettier
3.9.9, ESLint 10.11.0 and Vitest 5.0.2 entries were subsequently found in a prior
tool installation. Direct invocation reused them without installing or copying
dependencies. Scoped ESLint used the exact baseline config with temporary absolute
dependency imports; Vitest used a temporary config selecting only this bridge and
aliasing its installed library. Real tool paths and temporary configs stay local.

An attempted batch of pnpm check-script invocations unexpectedly triggered pnpm's
automatic dependency installation. The processes were interrupted (exit 130),
registry requests failed, no node_modules appeared, and package/workspace/lock
files remained unchanged. Those interrupted attempts are not successful checks.
All subsequent checks used direct executable entries. An initial subprocess-based
bridge also failed with host EPERM; the final bridge registers the exact same
assertions in process, which passed. Copier guards were unchanged.

| Command/check | Reported category |
| --- | --- |
| `node --test-reporter=tap docs/preparation/trusted-prepared-roots/contract.test.mjs` | Passed on Node 22/24; rerun on published head with result in PR |
| `node --check` on both packet modules and discovery bridge | Passed; repeated on published head |
| `git diff --check`, exact permitted-file inventory, frozen fixture hashes | Passed; repeated on published head |
| `node packages/design/build-tokens.js --check` and `node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css` | Passed, direct dependency-free equivalents of repository scripts |
| Direct installed Prettier `--check .` | Passed repository format check |
| Direct installed ESLint, baseline config, three owned executable files | Passed scoped lint |
| Direct installed Vitest, temporary tooling-only config | Passed final 219-case discovery bridge |
| Full repository lint, typecheck, build, tests/coverage and compiled demo | Blocked by absent checkout dependencies; no install/copy permitted |
| Opt-in retry integration, Electron/browser smoke | Not run; broader integration/live subprocess work outside this synthetic packet |
| Copier/wrapper suites and any real copier | Not run; guard behavior modeled from frozen code, historical results attributed separately |
| Independent review | Two P2 findings fixed with regressions; working-tree re-review clear; published exact-head review and disposition in PR |

Passed, failed, blocked, skipped and not-run are separate categories. No skipped
case counts as a pass. No unsupported-host capacity refusal becomes a successful
copy. No failed production check is hidden behind a fixture pass. CI still
classifies executable documentation and the tools bridge as code and runs its
normal Node 22/24 matrix with dependencies on the published PR.

## Fixture coverage

The suite checks every example object for unknown fields, frozen contract/result
digests and canonical encoding; receipt/run/root/branch/base/Git-ready joins;
source, lock, manifest, tool, generation and all inventories; pre-copy drift;
full virtual link chains and unique files; filter/index refusals in both roots,
including empty-named filter keys; partial output, shim and memory/disk bounds;
missing/altered/stale preparation results; agent-written markers; nonce-bound
checkpoints and exactly one invocation; independent output/source/metadata proof;
required check statuses and actual profile; two-root receipt/file isolation;
fresh/preparing/prepared/blocked/uncertain transitions, competing owners, crash,
lease loss and inspection-only recovery.

The synthetic tests evaluate descriptors, not the real copier or an installed
worker. Protected backend raw evidence and independently enforced controller
ownership are prerequisites for later real results. Neither a hash nor a passed
boolean creates authority. This packet does not complete #453 or #449.
