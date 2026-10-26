# Composed memory slice validation

Validated on 26 October 2026 with Node 24.19.0, pnpm 12.4.2, TypeScript 7.0.2,
Vitest 5.0.5, ESLint 10.13.0 and Prettier 3.9.10. Integrated dependency pins and
support limits are recorded in [composition-slice.md](composition-slice.md).
The final implementation commit and draft PR identify the exact tested source;
these commands run before committing that unchanged source/test content.

Normal setup after integrating main #720 dependency changes:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 /workspace/.orca-tools/node_modules/.bin/pnpm install --frozen-lockfile
```

Passed under unchanged supply-chain and allowlisted lifecycle policies. The lock
is byte-identical to main `1538d34b02eeb6ecbfeeea1464dd26f6fab85b9b`.
No install safeguard was disabled. The Electron binary is not needed for these
source tests, types or renderer build; no Electron/native smoke was run.

Affected regression command (two workers maximum):

```sh
node_modules/.bin/vitest run \
  packages/engine/test/composed-memory-guard.test.ts \
  packages/agents/test/strict-resource.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/review-judge.test.ts \
  packages/agents/test/synthetic-read-boundary.test.ts \
  packages/engine/test/synthetic-read-fence.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/store/test/lease-store.test.ts --maxWorkers=2
```

Result: **8 files / 355 tests passed, zero skips**. This includes 39 composed
Vitest cases (with the mutation loop additionally covering 13 changes at each
of three barriers), 19 canonical-resource cases, and the existing policy,
judge, capture, fence, live-input and lease regressions. The stable corpus
itself remains unchanged; these are only its documented executable subsets.

```sh
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
node_modules/.bin/eslint .
node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css
/workspace/.orca-tools/node_modules/.bin/pnpm run build
```

Changed TypeScript formatting, stable corpus IDs, local document links and
`git diff --check` are also checked. The entire repository test suite/coverage,
compiled smoke, physical/native/installed-provider paths, process-crash recovery
and live-model evaluation are outside this bounded local run. CI is a separate
exact-head result, never implied by these local checks.

All listed TypeScript, repository ESLint, CSS token and build checks passed on
the final source/test content. The renderer build retains its existing >500 kB
chunk warning. Changed TypeScript formatting, document IDs/local links and
whitespace checks passed. Lock SHA-256 equals main1538d34:
`352f24faa4a0b52765738749035e39a89e1d0f40c5312b61655be1040cdb6c8a`.

Separately, the parent reported that main1538d34's full
[CI40266246682](https://github.com/cschadewitz/Project_Orca/actions/runs/40266246682)
failed `packages/app/renderer/test/first-run.test.tsx:338` with 8,175 tests
passing: a failed rereview still exposed the saved-configuration bind button.
A separate owner is diagnosing that baseline UI/test failure. This slice does
not modify first-run code or weaken its assertion. The focused local result
above is not a full-suite or CI-green claim. Parent-owned exact-head CI and
independent review remain required before merge.
