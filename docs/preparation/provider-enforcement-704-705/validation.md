# Offline validation record — 26 October 2026

Baseline `32f92cc16b9faf1748059e930c3f77b3934151ae`; Node 24.19.0,
existing Vitest 5.0.2. No dependency installation or lockfile edits.

```sh
node node_modules/vitest/vitest.mjs run \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/command-evidence-v1-594.test.ts --maxWorkers=1
```

Result: **3 files, 84 tests passed, zero skipped**. Ten new pure-source/vector
checks; five existing shell-presentation loss witnesses; 69 existing draft #594
contract cases. Synthetic function probes do not execute the provider, shell,
MCP, config hooks, native callback, or policy engine. Command/cwd strings stay
data. Upstream Rust/Gemini test suites were not run. No installed artifact or
native repeated-cached-approval/revocation/effect claim follows.

Scoped ESLint and Prettier passed for the new JS test; JSON formatting checked.
Changed prose checked for UTF-8, LF, final newline, trailing whitespace, balanced
code fences and local file links. `git diff --check` passed. All 12 source
excerpt lengths/digests match the manifest. GitHub sources were read at full pins;
Claude publication metadata was read from npm without downloading any tarball.
The candidate Claude changelog tag returned empty content and an initially guessed
adapter permissions path returned 404; neither is used as supporting evidence.

Self-review checked the native/adapter range mismatch, source vs installed proof,
Claude callback coverage, explicit failure continuation, final-action mutations,
offered-effect lifetime, cancellation, alternate paths, protected config and
privacy gates. This is not independent security review. Full suite/build/global
typecheck/lint/coverage and platform/live checks were not run for this isolated
docs/data/pure-test change. Remote CI and final commit are reported in the draft
PR independently of these source qualification claims.

The [decision record](README.md) is GO only for offline preparation, UNKNOWN for
the bounded Claude installed experiment, and NO-GO for the current strict Codex,
Pi generic-UI and Gemini projected approval routes. Reviewed changes are proposed,
not implemented. All installed/live rows remain unsupported pending their stated
proof and separate authorization.

## Canonical reconciliation slice — 26 October 2026

Base `040fe081731ae636198a283ea70d421428dc328c` (combined full main CI still
pending; no green-main claim). Node 24.19.0, pinned pnpm 12.4.2, Vitest 5.0.5,
TypeScript 7.0.2 and Prettier 3.9.10. Frozen setup used the saved pnpm binary:
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --no-trust-lockfile`.
All 534 lock entries passed existing supply-chain policies. Lockfile, lifecycle
allow/deny list, sandbox protections and dependency manifests are unchanged.
An initial setup command referenced nonexistent `bin/pnpm.cjs` and failed before
installation; the installed pinned `bin/pnpm.mjs` entry point then succeeded.
No tool upgrade was performed.

The canonical fixtures import accepted core `ActionEvidenceV1`, `PolicyVerdictV1`
and `StrictPermissionState` plus the actual inactive admission/option functions.
They reuse the existing synthetic fixtures without editing #702-owned files.
All 32 historical vectors retain their dispositions and source pins; each now
names a negative canonical-admission test category. Additional controls cover
unknown final facts, source-only coverage, remembered/unknown option effects and
a changed post-check binding. They do not build a real provider capture or
calculate a production action binding. Cancellation/hook errors/final provenance
are represented as an unavailable trusted-owner `coverageAndState` precondition;
these tests do not independently validate the owner supplying that fact.

The entire digest-checked Claude callback excerpt now has synthetic positive and
post-await abort controls. Only the early abort-before-decode/fallback ordering is
source-function-tested; fallback implementations and effects are synthetic.
Codex and Gemini excerpts remain source-reviewed, not source-function-tested.
No native hook, runtime artifact or public native/SDK linkage is proved by these
fixtures. No source or installed evidence changed a feasibility classification.

Checks on final slice content:

```sh
pnpm exec vitest run \
  packages/agents/test/provider-qualification-704-705.test.ts \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/command-evidence-v1-594.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/permissions.test.ts \
  packages/agents/test/live-input-session.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/daemon/test/live-input-authority.test.ts --maxWorkers=2
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run format:check
pnpm exec tsc -p docs/preparation/tool-execution-guards/tsconfig.json
```

Result: **9 files, 324 tests passed, zero skipped**; root/renderer types,
repository ESLint/CSS lint, TypeScript/renderer build, repository format and
canonical positive/expected-rejection contract compilation passed. Build emits
the existing renderer chunk-size advisory. Final JS-only source-probe additions
received scoped ESLint/Prettier after the repository-wide checks. Changed Markdown
UTF-8/LF/final-newline/trailing-whitespace/fence/local-file-link checks and
`git diff --check` passed. No dependency or shared canonical contract edits.

Not run: full suite/coverage, upstream suites, installed/native/provider/actual-Cal
or platform/beta acceptance, network judge calls, app smoke or hooks. Future
Claude experiment remains an unexecuted PLAN. #704/#705 stay open; #594 ownership
and unsupported mode remain separate. No all-provider release gate is added.
Remote draft head/CI status are reported separately; local checks do not establish
combined main CI or independent review.
