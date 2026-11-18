# CI runner selection

The `check` job in [`ci.yml`](../.github/workflows/ci.yml) runs on one of Tyler's
self-hosted runners (label `tyler`) when enough are idle and on a GitHub-hosted `ubuntu-24.04` runner
otherwise. This page covers how that choice is made, how to override it, and what
the self-hosted runners can and cannot reach. It does not change what CI verifies;
see [CI shadow selection](ci-shadow-selection.md) for that.

## How the runner is picked

The `pick runner` job (`runs-on: ubuntu-slim`) fetches the runner host's health
endpoint, whose URL is the repository secret `CI_RUNNER_HEALTH_URL` (a secret so that
logs mask it; fork and Dependabot runs get no secrets and so use hosted runners), and reads the
idle runners per host from it (see Sharding). With the secret unset, the picker
selects GitHub-hosted runners.

| Picker result | `check` runs on | Vitest workers | pnpm cache |
| --- | --- | --- | --- |
| a host has an idle runner (see Sharding) | `[self-hosted, linux, x64, tyler]` | 20 | none (see below) |
| no host does, or any failure | `ubuntu-24.04` | 2 | `setup-node` `cache: pnpm` |

Every failure to ask counts as zero: no `CI_RUNNER_HEALTH_URL`, DNS, a curl timeout, a non-200 response,
non-JSON, or a non-numeric count. The step runs under `bash` with `pipefail`
and checks curl's own exit status, so a response that was partly written before
curl failed is also discarded.

On the self-hosted runners the pnpm cache is left empty because `setup-node`
restores through GitHub's Actions cache service, which the runners' proxy only
tunnels. `pnpm install` fetches from the npm registry instead, and the proxy caches
those tarballs. The worker count is 20, where a sweep of the full suite with coverage
stopped getting faster (8 workers 134 s, 16: 82 s, 20: 75 s, 24: 73 s, 31: 75 s); more
workers only add CPU contention.

Memory, measured in a throwaway container with the runners' settings (a 12 GiB memory
limit, the Vitest order cache restored), running `pnpm run test:coverage` after install and build, sampled once per
second. Peak working set and swap in use during the test step:

| Workers | RAM limit | Test step | Peak working set | Peak swap |
| --- | --- | --- | --- | --- |
| 16 | 12 GiB | 86 s | 6.6 GiB | none |
| 20 | 12 GiB | 82 s | 7.4 GiB | none |

Every run passed all tests, and the peak leaves about 4.6 GiB of room under the limit. An
8 GiB limit also held 20 workers (7.5 GiB peak, no swap). Before the test helper change below, the same runs reached
the 12 GiB limit and used 1.4 to 5.3 GiB of swap. The cause was the test fixtures. They
replaced `fs.readSync` with `vi.spyOn`, which keeps the arguments of every call, buffers
included, until the spy is restored. The code under test calls `readSync` in a tight
loop, so each of the 15 scenario test files in `controlled-owned-read`,
`controlled-standing-workflow` and `initial-approval-owned-read` held 0.4 to 1.8 GiB of
ArrayBuffers while its JS heap was under 250 MB. `packages/cli/test/intercept-read-sync.ts`
now replaces `readSync` without recording calls.

If memory grows again, find the cause before raising the limit or lowering the worker
count. Capping Node's heap (`--max-old-space-size`), the young generation
(`--max-semi-space-size`) or the malloc arenas (`MALLOC_ARENA_MAX`) did not help, and
neither did switching coverage off. Those settings do not reach ArrayBuffer memory.
`--logHeapUsage` shows live heap per test file, but it does not show ArrayBuffers.
Sampling `process.memoryUsage().arrayBuffers` in each test process does.

Only `check` moves. `changes` and `pick runner` always run on GitHub-hosted runners.

## Sharding

The full suite runs as shards in the `test` job (`vitest --shard=N/M` at the worker count
above). Each shard builds, runs its part with coverage, and uploads a Vitest blob.
`check (node 24)` is still the one job the evidence consumer and branch protection know:
it `needs` the shards, and its `Test with coverage` step downloads the blobs and runs
`vitest --merge-reports --coverage`, so the coverage thresholds and the full-suite report
cover every file.

`check` and the shards start together. `check` runs its typecheck, lint and build beside
the tests, then its `Wait for test shards` step polls this run's jobs through the API
until every shard is done (it needs `actions: read`) before it merges the blobs.

`check` and each shard are pinned to a host by a machine label (`m1`, `m2`), set in that
host's `RUNNER_LABELS` next to `tyler`. GitHub still decides when a runner is ready, but a
job can only start on its own host, so two 20-worker shards never share a machine however
many runners it has. Because `check` holds a runner while it waits, a host needs an idle
runner for every job pinned to it, or `check` could take the only one and wait forever for
a shard queued behind it. The picker therefore subtracts `check`'s runner first: `check`
goes to `m1` when it has an idle runner (otherwise `m2`), and a shard goes to each host
that still has one. It reads the per-host idle counts from `health`:

| Idle runners (m1, m2) | `check` | Shards |
| --- | --- | --- |
| 2+, 1+ | `m1` | 2: shard 1 on `m1`, shard 2 on `m2` |
| 1, 1+ | `m1` | 1, on `m2` |
| 2+, 0 | `m1` | 1, on `m1` |
| 0, 2+ | `m2` | 1, on `m2` |
| no host can hold `check` and a shard, a failed request, or `CI_FORCE_HOSTED` | `ubuntu-24.04`, 2 workers | 1, on `ubuntu-24.04` |

When `health` sends only the repository's total (`{"Project_Orca": <idle runners>}`,
its current response) there is nothing to pin a host with, so the picker uses the plain
`tyler` label: with 2 or more idle runners, `check` and one shard run there; with fewer,
everything runs on `ubuntu-24.04`. Only one shard, so two 20-worker shards never land on
the same host. The picker logs only the validated counts (never the response body) to
show which case applied.

The idle counts are a snapshot, not a reservation. Another CI run on a different ref, or
an `app-smoke` or `desktop` job on the same pool, can take those runners after the picker
looks. `check` then holds its runner in `Wait for test shards` while the shard queues,
until the shard starts or the wait step's timeout ends the run. The rules above make that
less likely; they do not rule it out.

`m1` therefore needs two runners (one for `check`, one for shard 1) for the suite to
split in two; `m2` needs one.

`health` gets the counts from GitHub's runner list, which spans every host registered to
the repo, so the hosts do not need to reach each other. The runner stack's own
documentation covers how the counts are configured.

A shard sees only part of the files, so it cannot meet the thresholds; shards set
`VITEST_SKIP_THRESHOLDS` and only the merge enforces them. The blobs hold absolute paths,
so `test` and `check` must run on the same image, with the workspace at the same
location. Targeted PR runs and docs-only changes are not sharded: `test` skips its test
steps for them.

The picker counts idle runners once, so a host that fills up between the pick and the
job queues its job until a runner frees. `check` and shard 1 both run on `m1`, so its
typecheck, lint and build compete with shard 1's workers for that host's CPU.

## Vitest file-order cache

Vitest starts the longest test files first, from the per-file durations it cached on
earlier runs (`node_modules/.vite/vitest/<hash>/results.json`). An ephemeral runner has
no earlier run. Without the cache the full suite with coverage at 20 workers took about
98 s, against about 79 s with it (three runs each; the machine was not idle).

The runners keep one copy in the `vitest-order` volume, mounted read-only for jobs at
`/var/cache/vitest-order`; the `check` job copies it into place before the tests run.
Jobs never write it. The runner stack updates it after a job exits, only when GitHub
reports that this runner just completed a successful `push` to `main` and the workspace
is at that commit, and only from entries it rebuilds itself (passing files, numeric
durations, at most 5000, none older than 30 days). The file only orders test files: a
missing, stale or wrong one costs speed, never correctness.

## Known limit: the idle count is a snapshot

The choice is made once, when `pick runner` runs. If another job takes the last idle
runner after that, `check` queues on the self-hosted label and waits. It does not fall
back to hosted by itself.

## Forcing GitHub-hosted runners

Set the repository variable `CI_FORCE_HOSTED` to `true` (Settings, Secrets and
variables, Actions, Variables). The picker then skips the health request and selects
`ubuntu-24.04`. Re-run the workflow for it to apply: a run that already picked a runner
keeps its choice. Delete the variable or set it to anything else to return to
automatic selection. Use it when a job is stuck queued on the self-hosted runners or they are down for
maintenance.

## Pull requests from forks

The picker always selects `ubuntu-24.04` when the pull request's head repository is
not this repository, so the stock workflow never sends fork code to the self-hosted
runners. That check lives in `ci.yml`, and a fork's pull request runs the `ci.yml`
from its own branch, so a fork can remove it or set `runs-on` to a self-hosted label
directly. The real gate is the repository setting that requires approval before
workflows from outside collaborators' forks run (Settings, Actions, General; it
appears once the repository is public). Before approving a fork's run, check whether
it changes anything under `.github/`.

## What the self-hosted runners can reach

The runner stack lives outside this repository, and its isolation details are kept
with it, not here. What this repository's workflows can rely on: each runner takes
one job and is reset before the next; jobs run as a non-root user with no host mounts
and no Docker socket; their only route out is a proxy that refuses private and
loopback destinations; and the only credential a job holds is its `GITHUB_TOKEN`
(`ci.yml` keeps `permissions: contents: read` and `persist-credentials: false`). PR code
(install, build and test steps) runs on these machines, so treat them as running
untrusted-by-default code.

In this repository `ci.yml`'s `check` and `test` jobs select the `tyler` label on their
own. The Linux jobs of `app-smoke.yml` and `desktop.yml` (manual runs and release calls)
use it too when the health endpoint reports at least one idle runner, and GitHub-hosted
`ubuntu-24.04` otherwise; [`tools/linux-runner.js`](../tools/linux-runner.js) makes that
choice once per run, and `CI_FORCE_HOSTED` applies to it as well. Those jobs need no
second idle runner, because none of them waits on another the way `check` waits on its
shards. On the hosted fallback a step installs xvfb if it is missing and lifts Ubuntu
24.04's AppArmor block on unprivileged user namespaces, which Chromium's sandbox needs;
that step runs only on GitHub-hosted runners, never on a self-hosted one. Every other job runs on GitHub-hosted runners, including
`release-prepare.yml`, `release-publish.yml`'s own jobs, `changelog.yml` and
`codeql.yml`, which hold write tokens or deploy keys. `tyler` is the only self-hosted
label; a new workflow that targets it takes on the same assumptions.
