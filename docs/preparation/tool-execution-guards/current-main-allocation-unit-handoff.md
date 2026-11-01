# Allocation-bound unit fixture isolation

Base: `1121f45e7bb4b8f6f0b4920c0258e96688756070`, draft PR #809.
[CI run 41275157865](https://github.com/cschadewitz/Project_Orca/actions/runs/41275157865)
failed only the allocation-bound regression: expected synthetic exhaustion, but
received real `EADDRINUSE` on `127.0.0.1:42512`. Source inspection showed that each
synthetic attempt first provisioned a real update window, which acquires eight
socket slots before the injected acquisition callback. The competing socket
owner is unknown. The original surviving-writer refusal test passed in that run.

The existing allocation loop is now a test-local helper with a fixture factory.
The genuine integration fixture still provides its real update-window setup and
unchanged detach/removal cleanup. The exhaustion unit test instead supplies only
temporary directory identities and an injected acquisition failure. It verifies
16 distinct attempts, the exact exhaustion cause, ordered cleanup of every
attempt, and absence of every discarded directory. It performs no update-window
provisioning or socket acquisition.

The real socket collision and surviving-writer refusal tests remain intact. The
16-attempt limit, acquisition-only `EADDRINUSE` handling, successful socket
lifetime, original refusal assertion, timeout and environment are unchanged.
Other fixture-creation failures still propagate; this change does not broaden
the retry boundary or claim that all unrelated setup collisions are eliminated.

The only executable change is `packages/cli/test/update-bootstrap.test.ts`,
SHA-256 `d4ca8a8c59f6db86fc174cdbb8b27002ab59c3f71ca96b79298fca102a921bc4`.
Production sources, image inputs, historical/current Python test separation,
source pins, observer refusal, workflows and execution budgets are unchanged.

Validation used the supported overlay checkout `/workspace/orca-fence-validation`
with its existing frozen dependencies and Node 24.21.0:

```sh
timeout --kill-after=5s 60s node node_modules/vitest/vitest.mjs run packages/cli/test/update-bootstrap.test.ts --maxWorkers=1 --reporter=verbose -t 'first-run fence fixture|refuses a surviving first-run writer'
timeout --kill-after=5s 180s node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
timeout --kill-after=5s 60s node node_modules/eslint/bin/eslint.js packages/cli/test/update-bootstrap.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/cli/test/update-bootstrap.test.ts
```

Four selected tests passed in 10.17 seconds; four others, including the positive
daemon-start test, were unselected. Typecheck, changed-file lint, formatting and
whitespace checks passed. Independent reviewer `/root/independent_review` found
no issues and independently passed only the three helper tests in 1.62 seconds.
No full-file or full-suite local rerun was performed. Exact-head remote CI is
reported separately after non-force publication.

Evidence under `/tmp/orca-current-main-evidence/`:

| File | SHA-256 |
| --- | --- |
| `allocation-unit-tests.log` | `128b9dcf669213abc5d167cba4cdf41bbd26d159190d34215f10057f7b5fa119` |
| `allocation-unit-typecheck.log` (successful, empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `allocation-unit-lint.log` (successful, empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fence-allocation-independent-review.json` | `611bff4fb5ef871f1f9e46f489ce3b1e77d36931ad7915b10761f67ac0a67bf5` |

No image rebuild, current-image designation, live observer/tracer, activation,
formal approval, denied lookup retry or merge occurred. Historical-positive
regression coverage remains distinct from current-image and live proof.
