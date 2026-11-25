# CI runner selection

The `check` job in [`ci.yml`](../.github/workflows/ci.yml) runs on one of Tyler's
self-hosted runners (label `tyler`) when one is idle and on a GitHub-hosted `ubuntu-24.04` runner
otherwise. This page covers how that choice is made, how to override it, and what
the self-hosted runners can and cannot reach. It does not change what CI verifies;
see [CI shadow selection](ci-shadow-selection.md) for that.

## How the runner is picked

The `pick runner` job (`runs-on: ubuntu-slim`) fetches the runner host's health
endpoint, whose URL is the repository secret `CI_RUNNER_HEALTH_URL` (a secret so that
logs mask it; fork and Dependabot runs get no secrets and so use hosted runners), and reads the
idle runner count (`{"Project_Orca": <idle runners>}`) from it. With the secret unset, the picker
selects GitHub-hosted runners.

| Picker result | `check` runs on | Vitest workers | pnpm cache |
| --- | --- | --- | --- |
| at least one runner is idle | `[self-hosted, linux, x64, tyler]` | 20 | none (see below) |
| none is, or any failure | `ubuntu-24.04` | 2 | `setup-node` `cache: pnpm` |

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
runner after that, `check` queues on the self-hosted label until a runner frees.
It does not fall back to hosted by itself.

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

In this repository `ci.yml`'s `check` job selects the `tyler` label on its own. The Linux jobs of `app-smoke.yml` and `desktop.yml` (manual runs and release calls),
and `release-publish.yml`'s `verify` job ("verify the merge commit", the release's test work, with a read-only token and `ci.yml`'s worker cap and pnpm cache choice for the runner it gets),
use it too when the health endpoint reports at least one idle runner, and GitHub-hosted
`ubuntu-24.04` otherwise; [`tools/linux-runner.js`](../tools/linux-runner.js) makes that
choice once per run, and `CI_FORCE_HOSTED` applies to it as well. On the hosted fallback a step installs xvfb if it is missing and loads an
AppArmor profile that lets the one Electron executable the job launches (the development
Electron, or the packaged `linux-unpacked/orca-desktop`, resolved through symlinks) create the
user namespaces Chromium's sandbox needs. Ubuntu 24.04's restriction stays on for
everything else, and the step checks that an unrelated program is still refused. The
profile is otherwise unconfined, so it is a scoped exception, not a sandbox for the app.
It is also no boundary against the job's own code: the executable sits in the
runner-writable workspace and the job user has passwordless sudo on these VMs. The step
runs only on GitHub-hosted runners, never on a self-hosted one. Every other job runs on GitHub-hosted runners, including
`release-prepare.yml`, `release-publish.yml`'s other jobs, `changelog.yml` and
`codeql.yml`, which hold write tokens or deploy keys. In `release-publish.yml` the release's
identity and authorization (the exact commit, its lane and review, and the version) come only
from the GitHub-hosted `check` job, and every job that writes or dispatches takes them from
there; `verify` only passes or fails the commit `check` pinned. Its runner picker gets the
health endpoint only for a real release dispatched from the default branch or a merged release
pull request, so a rehearsal (`dry_run`), whose ref may be any branch, stays GitHub-hosted. A rehearsal also restores and saves no Actions caches (pnpm store, Electron downloads) in
`verify`, `desktop.yml` or `app-smoke.yml` (their `caches` input), because it runs its ref's
install scripts in the default branch's cache scope, where trusted runs would restore them. `tyler` is the only self-hosted
label; a new workflow that targets it takes on the same assumptions.
