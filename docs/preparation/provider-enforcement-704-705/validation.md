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
