# Verification record — 26 October 2026

Source base: main `32f92cc16b9faf1748059e930c3f77b3934151ae`, freshly fetched.
Changes are limited to this preparation directory, proposed ADR 0010 and a narrow lint
project override in tools/eslint-config/index.js. No runtime package source,
lockfile, dependency, production policy, capability, live provider or service changes.

| Check actually run | Result / scope |
| --- | --- |
| `node_modules/.bin/tsc -p docs/preparation/tool-execution-guards/tsconfig.json` | Pass; v1 types, one synthetic unqualified action, one review-phase consumer, thirteen expected compile-time errors |
| `node_modules/.bin/vitest run packages/agents/test/permissions.test.ts packages/agents/test/live-input-session.test.ts packages/engine/test/live-input.test.ts packages/daemon/test/live-input-authority.test.ts --maxWorkers=2` | 4 files / 105 tests pass; existing baseline permission/lifetime behavior, no new execution guard implementation |
| `node_modules/.bin/prettier --check tools/eslint-config/index.js docs/preparation/tool-execution-guards/contract.ts docs/preparation/tool-execution-guards/contract-fixtures.ts docs/preparation/tool-execution-guards/tsconfig.json` | Pass; Markdown is intentionally outside repository Prettier coverage |
| `node_modules/.bin/eslint .` | Pass after the final type/config edits; actual repository-wide type-aware ESLint invocation |
| `node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css` | Pass; remaining CSS half of the repository lint script |
| Effective `eslint --print-config` comparison: preparation contract versus existing agents source | Identical rule sets; only the preparation parser project differs |
| UTF-8/LF/final newline, trailing whitespace, balanced fenced blocks and local-file Markdown links | Pass; all changed Markdown files |
| `git diff --cached --check` | Pass before commit |

Runtime: Node 24.19.0. Existing installed binaries report TypeScript 7.0.2, Vitest 5.0.2
and Prettier 3.9.9. The manifest requests newer Vitest/Prettier patch versions; this was
not a fresh frozen dependency installation or a full CI reproduction. Initial `pnpm exec`
attempt triggered its dependency refresh and failed creating `/home/agent/.local/share/pnpm`
(ENOENT); direct existing binaries then passed without installation or lockfile edits.
No dependency repair was attempted; that is assigned to a separate owner.

No full suite, app smoke, provider command, external effect, hosted/BYOK request or live
hook test was run. The acceptance corpus is a set of implementation expectations, not
105 newly executed enforcement cases. One-use atomicity, exact codec/policy composition,
installed coverage, physical resource confinement and privacy acceptance remain unproved.

## Pre-handoff clarification and lint integration

Original PR CI run 40258204967 / job 121364602790 failed repository-wide ESLint because
the two preparation TypeScript files were outside parserOptions.project. The follow-up
uses a path-scoped project override pointing at their existing no-emit tsconfig; all
repository type-aware rules remain enabled and unrelated files retain their original
project/rules. The actual full ESLint command and CSS checker are rerun directly with
existing installed binaries, matching the checks in the lint script without pnpm's
unavailable dependency refresh. This is not merely a standalone compile check.

The revised type/docs checks cover explicit final/needs-review evaluation, policy-owned
pending and exact-request registrations, post-review current-state validation, bounded
approved payload materialization, selected judge configuration identity and separate
unavailable/evaluated results. Six additional acceptance expectations bring the corpus
to 30; they remain unexecuted implementation cases. The original 105 baseline regression
tests were not repeated for these type/docs and lint-project changes.
