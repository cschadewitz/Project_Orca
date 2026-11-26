# Workstreams

A **workstream** is a large feature with no target release: it must not wait for the release
before it, and must not disrupt that release either. Each one has a tracking issue, one
`ship-group:` label, one owner thread, and one way of landing, chosen when the tracking issue
is opened. The plan this follows is #1239.

Releases themselves never hold `main`: every release of `X.Y`, its candidates included, is cut
from `release/X.Y` (docs/RELEASING.md, "Release lines"), so `main` keeps taking workstream
merges throughout an RC.

## Feature branches (`feature/<name>`)

A long-lived branch is the exception, for work that cannot ship dark: an outside sign-off gates
even dark code, or the change breaks the store format or protocol and cannot be hidden.

- **Pull requests only.** Work reaches `feature/<name>` through reviewed pull requests, as on
  `main`. The `feature/*` ruleset requires a pull request and the `check (node 24)` check, and
  blocks force pushes and deletion.
- **CI.** `ci.yml` runs on pushes to `feature/**` and on pull requests into it. Its runner
  choice is the same as for `main`: same-repository branches and pull requests may use the
  self-hosted runners, since only collaborators with write access can push a `feature/*` or
  `feature-sync/*` branch, and a pull request from a fork gets GitHub-hosted runners whatever
  its base (docs/ci-runners.md).
- **Kept current, unattended.** **Feature sync** (`feature-sync.yml`, `tools/feature-sync.sh`)
  runs nightly and after every push to `main`. For each `feature/*` branch that does not
  already contain `main`, it merges `main` into `feature-sync/<name>`, keeps one pull request
  open into the feature branch, and merges it with a merge commit only when its head is exactly
  the bot's clean merge of the current feature head and `main` (same repository, opened by the
  bot, parents and tree checked) and the `check (node 24)` job of a `ci.yml` run for that pull
  request at that exact head succeeded. Unrelated green checks, a missing, queued, skipped or
  neutral `check (node 24)`, or any failed check do not count. A current head that is not that
  merge gets a comment and the `sync-conflict` label and is never merged.
- **Unattended merging is off until the ruleset exists.** The workflow merges only when the
  repository variable `FEATURE_SYNC_AUTO_MERGE` is `true`. Set it only after the `feature/*`
  ruleset below is in place, so the merge gate and the ruleset are two layers, not one. A conflict opens no pull request: one issue per branch, `Sync conflict:
  feature/<name>` with the `sync-conflict` label, lists the files for the workstream's owner,
  and the next clean sync closes it.
- **Landing.** One pull request from `feature/<name>` into `main` when the gate opens. Its
  changelog fragments live in `changelog.d/` on the branch and arrive with it; the landing pull
  request takes the target release's milestone.

Current feature branches: `feature/claude-agent-sdk` (gate #1132, tracking #1153) and
`feature/codex-app-server` (gate #1168, tracking #1189).
