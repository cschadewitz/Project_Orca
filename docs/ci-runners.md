# CI runner selection

The `check` job in [`ci.yml`](../.github/workflows/ci.yml) runs on a homelab
self-hosted runner when one is idle and on a GitHub-hosted `ubuntu-24.04` runner
otherwise. This page covers how that choice is made, how to override it, and what
the self-hosted runners can and cannot reach. It does not change what CI verifies;
see [CI shadow selection](ci-shadow-selection.md) for that.

## How the runner is picked

The `pick runner` job (`runs-on: ubuntu-slim`) fetches
`https://runners.theroses.dev/health`, which returns `{"Project_Orca": <idle runners>}`.

| Picker result | `check` runs on | Vitest workers | pnpm cache |
| --- | --- | --- | --- |
| a host has an idle runner (see Sharding) | `[self-hosted, linux, x64, tyler]` | 20 | none (see below) |
| no host does, or any failure | `ubuntu-24.04` | 2 | `setup-node` `cache: pnpm` |

Every failure to ask counts as zero: DNS, a curl timeout, a non-200 response,
non-JSON, or a non-numeric count. The step runs under `bash` with `pipefail`
and checks curl's own exit status, so a response that was partly written before
curl failed is also discarded.

On the self-hosted runners the pnpm cache is left empty because `setup-node`
restores through GitHub's Actions cache service, which the runners' proxy only
tunnels. `pnpm install` fetches from the npm registry instead, and the proxy caches
those tarballs. The worker count is 20, where a sweep of the full suite with coverage
stopped getting faster (8 workers 134 s, 16: 82 s, 20: 75 s, 24: 73 s, 31: 75 s); more
workers only add CPU contention.

Memory, measured in a throwaway container with the runners' settings (12 GiB RAM plus
12 GiB swap, 30 CPUs, `/tmp` as tmpfs, the proxy network, the Vitest order cache
restored), running `pnpm run test:coverage` after install and build, sampled once per
second. Peak working set and swap in use during the test step:

| Workers | RAM limit | Test step | Peak working set | Peak swap |
| --- | --- | --- | --- | --- |
| 16 | 12 GiB | 86 s | 6.6 GiB | none |
| 20 | 12 GiB | 82 s | 7.4 GiB | none |

Every run passed all tests. The runners keep their 12 GiB limit. It is a ceiling, not an
allocation, and the peak leaves about 4.6 GiB of room. An 8 GiB limit also held 20 workers
(7.5 GiB peak, no swap), so the limit has margin. Before the test helper change below, the same runs reached
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

The runners' own history (Prometheus, cAdvisor) shows peaks of 8.3 to 10.9 GiB and at
most 98 MiB of swap at 16 workers. That history is from before the large scenario files
were split, when only one such file ran at a time. The same code in a throwaway
container peaked at 10.9 GiB with no swap.

Only `check` moves. `changes` and `pick runner` always run on GitHub-hosted runners.

## Sharding

The full suite runs as shards in the `test` job (`vitest --shard=N/M` at the worker count
above). Each shard builds, runs its part with coverage, and uploads a Vitest blob.
`check (node 24)` is still the one job the evidence consumer and branch protection know:
it `needs` the shards, and its `Test with coverage` step downloads the blobs and runs
`vitest --merge-reports --coverage`, so the coverage thresholds and the full-suite report
cover every file.

Each shard is pinned to one host by a machine label (`m1`, `m2`), set in that host's
`RUNNER_LABELS` next to `tyler`. GitHub still decides when a runner is ready, but a shard
can only start on its own host, so two 20-worker shards never share one machine however
many runners each host has. The picker builds the shard list from `health`'s per-host
idle counts:

| Idle runners | Shards | Labels |
| --- | --- | --- |
| both hosts | 2 | shard 1 on `m1`, shard 2 on `m2` |
| one host | 1 | the whole suite, on that host |
| none, a failed request, or `CI_FORCE_HOSTED` | 1 | `ubuntu-24.04`, 2 workers |
| `health` without machine counts | 1 | unpinned `tyler` |

`health` gets the counts from GitHub's runner list, which spans every host registered to
the repo, so the hosts do not need to reach each other. See the runner stack's README for
`HEALTH_LABELS` and `HEALTH_MACHINES`.

A shard sees only part of the files, so it cannot meet the thresholds; shards set
`VITEST_SKIP_THRESHOLDS` and only the merge enforces them. The blobs hold absolute paths,
so `test` and `check` must run on the same image, with the workspace at the same
location. Targeted PR runs and docs-only changes are not sharded: `test` skips its test
steps for them.

`check` waits for the shards, so typecheck, lint and the build run after them rather than
beside them. The picker counts idle runners once, so a host that fills up between the
pick and the job queues its shard until a runner frees.

## Vitest file-order cache

Vitest starts the longest test files first, from the per-file durations it cached on
earlier runs (`node_modules/.vite/vitest/<hash>/results.json`). An ephemeral runner has
no earlier run. Without the cache the full suite with coverage at 20 workers took about
98 s, against about 79 s with it (three runs each; the machine was not idle).

The runners keep one copy in the `vitest-order` volume, mounted read-only for jobs at
`/var/cache/vitest-order`; the `check` job copies it into place before the tests run.
Jobs never write it. `start.sh` (root) updates it after a job exits, only when GitHub
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
automatic selection. Use it when a job is stuck queued on the homelab runners or the
homelab is down for maintenance.

## What the self-hosted runners can reach

The runner stack lives outside this repository; this section records what the
repository's workflows can rely on. The repository is private, but PR code
(install, build and test steps) executes on these machines, so treat them as
running untrusted-by-default code.

- **Per-job lifecycle:** each runner is registered `--ephemeral`, so it takes one job
  and is deregistered by GitHub. Its container then restarts and resets the job
  user's home directory and scratch directories before registering again. This is a
  filesystem reset on a reused container, not a fresh container or VM per job.
- **Host access:** containers are unprivileged, run the job as a non-root user and
  have no host bind mounts and no Docker socket. CPU and memory are capped.
- **Network:** runners attach only to an internal container network. Their one route
  out is a caching proxy that refuses loopback, private, link-local and CGNAT
  destinations, checked against the resolved address, so jobs cannot reach the home
  LAN.
- **Credentials:** the token used to register runners is removed from the job
  environment before the job starts. The only credential a job holds is the per-job
  `GITHUB_TOKEN`; this workflow keeps `permissions: contents: read` and
  `persist-credentials: false`. The health endpoint's own token lives in a
  separate container that jobs cannot reach.
- **Not guaranteed:** the container sandbox uses Docker's default seccomp profile
  plus the user-namespace calls Electron's Chromium sandbox needs. It is a container
  boundary, not a VM boundary.

In this repository only `check` selects the `tyler` label. Other workflows (for
example `app-smoke.yml`, `codeql.yml` and the release workflows) target the separate
`homelab` label; the isolation notes above describe the `tyler` runners and say
nothing about that pool. A new workflow that targets `tyler` takes on the same
assumptions.
