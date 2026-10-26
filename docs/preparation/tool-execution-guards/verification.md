# Verification record — 26 October 2026

Source base: main `32f92cc16b9faf1748059e930c3f77b3934151ae`, freshly fetched.
Changes are limited to this preparation directory and proposed ADR 0010. No package,
lockfile, dependency, production policy, capability, live provider or service changes.

| Check actually run | Result / scope |
| --- | --- |
| `node_modules/.bin/tsc -p docs/preparation/tool-execution-guards/tsconfig.json` | Pass; v1 types, one synthetic unqualified action, six expected compile-time errors |
| `node_modules/.bin/vitest run packages/agents/test/permissions.test.ts packages/agents/test/live-input-session.test.ts packages/engine/test/live-input.test.ts packages/daemon/test/live-input-authority.test.ts --maxWorkers=2` | 4 files / 105 tests pass; existing baseline permission/lifetime behavior, no new execution guard implementation |
| `node_modules/.bin/prettier --check docs/preparation/tool-execution-guards/contract.ts docs/preparation/tool-execution-guards/contract-fixtures.ts docs/preparation/tool-execution-guards/tsconfig.json` | Pass; Markdown is intentionally outside repository Prettier coverage |
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
