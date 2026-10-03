# Validation record and remaining execution

Measured on 2026-10-03, Linux x64, Git 2.47.3, against the owned new files on
`e94bf699d9f3000de8822ed3434c1dce92b6ce19`. See the PR head for the final implementation
commit. [Offline evidence](offline-evidence.json) retains actual stdout, exit codes,
baseline/file hashes and diffs from two independent attempts, with absolute temporary
paths replaced by `<attempt-1>` and `<attempt-2>`. Source script/patch hashes bind this
record to the implementation without a self-referential commit SHA.

| Check | Result | Evidence / limit |
| --- | --- | --- |
| `node examples/beta-first-job/fixture.js validate` (Node 24.21.0) | pass | Two clean local repositories, no remotes; exactly the threshold check fails before the patch (exit 1), all five pass afterward (exit 0); identical initial/final hashes, baseline commits and diffs; unchanged sentinel. |
| `node --test examples/beta-first-job/fixture.test.js` (Node 22.23.2 and 24.21.0) | pass | Rejects wrong root, changed tests, extra file, modified sentinel, symlink substitution, uncorrected source, unexpected remote and staged changes. Reset creates identical broken bytes in a new root and preserves the completed copy; destructive reset arguments refused. No network request uses the synthetic `.invalid` remote. |
| Owned JavaScript Prettier check | pass | Repository Prettier configuration; Markdown is intentionally excluded by repository policy. |
| Repository `pnpm run lint` | pass | Full ESLint and CSS token checks, using a temporary Corepack shim on PATH. |
| Runtime unit suite / build / Electron smoke | not run | No runtime/app/manifests changed; the new standalone Node checks are the fixture acceptance suite and are not automatically included in `pnpm test`. |
| Packaged install/connect/launch BF-02–06 | blocked | Requires approved #385/#386/#334 candidate and integration route; none executed here. |
| Real-agent execution | not run | No live provider, sign-in or paid call; explicit per-run authorization/preflight remains required. |
| Product cancel/retry and workspace selection BF-07/08 | not run | Local reset/refusal checks do not prove daemon cancellation or UI selection. |
| Physical Mac / Windows | not run | No platform or hardware certification inferred from Linux fixture checks. |

The first local validation attempt was refused by the workspace execution sandbox
(`spawnSync git EPERM`), before any fixture test result. The approved retry allowed
only local disposable fixture operations and passed. This was an execution-environment
constraint, not an observed product failure. Temporary roots/evidence are retained for
review; no automated recursive cleanup ran.

Development lint dependencies were linked from the locked repository dependencies;
no dependency/manifests changed and lifecycle scripts were disabled. Those tools are
for maintainers, not required by the sample or installed on a tester's machine.

#385/#386/#334/#388/#389/#390 already cover delivery, supported onboarding/launch,
packaged evidence, guide integration and consented beta walkthrough. No new out-of-scope
issue is necessary. Parent acceptance remains open. The next slice is to consume this
fixture through the accepted candidate flow, with its own authorization and evidence.
