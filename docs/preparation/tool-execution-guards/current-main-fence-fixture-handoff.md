# PR 809 first-run fence fixture repair

Implementation commit: `c15356749e458abbef4ae3c626d44c09f73f0611`, based on
`6e44a80513bbaf611c233bb6fef5def666f1c88e`. The only changed executable file is
`packages/cli/test/update-bootstrap.test.ts`, SHA-256
`3f34963e40f9aef23cb10fd74997e886a3acd8a785191bc4bda0d798785dc709`.

## Trigger and bounded fix

[CI run 41272749199](https://github.com/cschadewitz/Project_Orca/actions/runs/41272749199)
on head `6e44a80513bbaf611c233bb6fef5def666f1c88e` and merge candidate
`c4070f7e1f45893ca4d5424e58579e87c8637fff` ran on `tyler-2`. Its sole test failure
was `update-bootstrap.test.ts > refuses a surviving first-run writer on the same
boot`: `listen EADDRINUSE: address already in use 127.0.0.1:42910`. The log does
not identify the competing socket. It recorded 10,047 passing tests, one failure,
36 skipped and one todo; this was not a reported coverage-threshold failure.
Format, lint, typecheck, build and retry-admission acceptance passed. Coverage
reporting and compiled smoke were skipped after the test failure.

The fixture now follows the repository's existing 16-fresh-workspace allocation
bound. Only an `EADDRINUSE` from initial fence acquisition selects another
disposable fixture, before first-run ownership evidence is established. The
colliding fixture's update-window owner is detached and its directory removed.
Other setup errors propagate. The successful exact socket remains held through
ownership setup and the original refusal assertion, then closes in `finally`.
The actual assertion is never retried; its command, timeout and environment are
unchanged. Production fence mapping, collision refusal, execution budgets,
observer launch refusal and workflows are unchanged.

Three added regression tests cover injected initial collision and discarded
identity cleanup, real refusal of a second acquisition of the retained socket,
exhaustion at exactly 16 fresh identities, and immediate noncollision failure.
They do not turn a production collision into an accepted alternate port.

## Reproduction and evidence

The first local selection in `/tmp/orca-current-v2-validation` failed all four
selected tests before fence acquisition: the existing volume check refuses tmpfs
(`0x1021994`). This failed attempt remains recorded. No volume check was mocked,
removed or relaxed. Validation moved to an isolated checkout at
`/workspace/orca-fence-validation`, on explicitly supported overlayfs
(`0x794c7630`), with unchanged frozen dependencies and supply-chain checks. The
normal frozen install completed in 9.5 seconds using Node 24.21.0 / pnpm 12.4.2.
That checkout starts from the base commit above and contains the exact candidate
test bytes; all other executable inputs match the implementation commit.

From that checkout, with Node 24.21.0 on PATH:

```sh
timeout --kill-after=5s 60s node node_modules/vitest/vitest.mjs run packages/cli/test/update-bootstrap.test.ts --maxWorkers=1 --reporter=verbose -t 'first-run fence fixture|refuses a surviving first-run writer'
timeout --kill-after=5s 180s node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
timeout --kill-after=5s 60s node node_modules/eslint/bin/eslint.js packages/cli/test/update-bootstrap.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/cli/test/update-bootstrap.test.ts
```

Results: **four selected tests passed**, four unselected, 10.57 seconds. This
includes the original CLI refusal test. Root typecheck, changed-file lint,
Prettier and diff whitespace checks passed. The full file and full suite were
not rerun locally; the positive daemon-start test was not selected.

Independent reviewer `/root/independent_review` examined the complete test delta,
cleanup, acquisition boundary, unchanged original assertion and socket lifetime.
It found an exact-two-attempt assumption in the new regression, corrected to
allow additional real setup collisions within the existing bound while verifying
all discarded identities and the retained socket. It independently ran only the
three helper tests: **three passed**, five unselected, 3.96 seconds. No remaining
findings; this is bounded review, not formal security approval.

Local evidence files below are in `/tmp/orca-current-main-evidence/`:

| File | SHA-256 |
| --- | --- |
| `fence-fixture-tests.log` (initial tmpfs refusal) | `e04e7154a08e41542fb7e4b845932a06bcddec6b13392133283092a909fd0bad` |
| `fence-fixture-final-tests.log` | `cb1e09697c12b86d4eb2746f3cb770dd0c49dc93ed16fa6cf2229070254e3b42` |
| `fence-fixture-final-typecheck.log` (successful, empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fence-fixture-final-lint.log` (successful, empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `fence-fixture-install.log` | `6c8e7203e004e33933b474df85e8a2d887b2b5fa9aae2031ecc417c766e64e99` |
| `fence-fixture-independent-review.json` | `6e4588d57b9095fed3acd1069d50ec9ca52fdb15d1797d59eba5002704a07a90` |

The changed test is not a declared test-image build input. No image was rebuilt;
the three physical output hashes were rechecked and equal the
[v2 image identities](current-main-v2-nonlive-handoff.md). The four Python
designation failures remain unresolved and were not rerun or relabeled. No live
observer/tracer, production activation, formal approval, merge, budget increase
or denied hostname lookup occurred. Publication updates the existing draft PR;
its new exact-head CI status must be reported separately from the historical run.
