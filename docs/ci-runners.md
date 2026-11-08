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
| idle count above zero | `[self-hosted, linux, x64, tyler]` | 16 | none (see below) |
| zero, or any failure | `ubuntu-24.04` | 2 | `setup-node` `cache: pnpm` |

Every failure to ask counts as zero: DNS, a curl timeout, a non-200 response,
non-JSON, or a non-numeric count. The step runs under `bash` with `pipefail`
and checks curl's own exit status, so a response that was partly written before
curl failed is also discarded.

On the self-hosted runners the pnpm cache is left empty because `setup-node`
restores through GitHub's Actions cache service, which the runners' proxy only
tunnels. `pnpm install` fetches from the npm registry instead, and the proxy caches
those tarballs. The worker count is 20, where a sweep of the full suite with coverage
stopped getting faster (8 workers 134 s, 16: 82 s, 20: 75 s, 24: 73 s, 31: 75 s); more
workers only add CPU contention. Memory was about 8 GB peak at 16 workers with coverage
and has not been re-measured at 20.

Only `check` moves. `changes` and `pick runner` always run on GitHub-hosted runners.

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
