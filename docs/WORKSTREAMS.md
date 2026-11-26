# Workstreams

A **workstream** is a large feature with no target release: it must not wait for the release
before it, and must not disrupt that release either. Each one has a tracking issue, one
`ship-group:` label, one owner thread, and one way of landing, chosen when the tracking issue
is opened. The plan this follows is #1239.

Releases themselves never hold `main`: every release of `X.Y`, its candidates included, is cut
from `release/X.Y` (docs/RELEASING.md, "Release lines"), so `main` keeps taking workstream
merges throughout an RC.

## Choosing how it lands

| | Incubating flag on `main` (default) | Feature branch (exception) |
| --- | --- | --- |
| When | Anything that can ship as dead code | An outside sign-off gates even dark code, or a store or protocol break that cannot be hidden |
| Where work merges | `main`, small pull requests | `feature/<name>`, small pull requests |
| Keeping current | Nothing to do | Feature sync, nightly |
| Changelog | `changelog.d/incubating/<flag>/` | `changelog.d/` on the branch |
| Milestone | Set on merge to the minor it rides in, `release:none` | The landing pull request takes its release's milestone |
| Turning it on | A promotion pull request | Landing the branch |

Pick the mode when the tracking issue is opened and say which in its body.

## Incubating flags (the default)

Unfinished work lands on `main` in small reviewed pull requests behind a flag in the registry,
`packages/core/src/features.ts`. It ships as dead code in whatever release comes next and
cannot disturb it; a short promotion pull request turns it on in the release that wants it.

- **Register the flag** with the workstream's first pull request: kebab-case `name`, `stage:
  "incubating"`, the tracking `issue`, and a one-line `summary`. Check it with
  `featureEnabled("<name>")`; an unknown name throws, so a typo fails loudly.
- **Stages.** `incubating` is off by default; only a developer or a test turns it on, with
  `ORCA_INCUBATING=<name>` (or `all`), never from app configuration. That is a default, not an
  access control: whoever sets a process's environment can reach it. `experimental` is off
  unless the owner opts in (a config switch the caller passes) or `ORCA_EXPERIMENTAL` names it
  (by name only; `all` there turns nothing on).
  `stable` is on, and the flag and its checks are removed in the next minor.
- **Both paths are tested.** CI's normal run covers the flag off. **Incubating**
  (`incubating.yml`) runs the tests again with `ORCA_INCUBATING=all` whenever the registry holds
  a flag, so the half-built path cannot rot.
- **Changelog.** Fragments go in `changelog.d/incubating/<flag>/`, named as usual. Release
  prepare reads only the top of `changelog.d/`, so they stay out of every release until the
  promotion pull request runs `node tools/release.js promote <flag>`, which moves them into
  `changelog.d/` to ship with it.
- **Milestone and labels.** Dark pull requests take `release:none`. **Milestone on merge**
  (`milestone-on-merge.yml`) gives any pull request merged into `main` without a milestone the
  release it actually rides in: the earliest open minor (`X.Y.0`) whose `release/X.Y` line is
  not cut yet, since a cut line no longer takes `main`'s merges. When that cannot be
  established it sets nothing, and a milestone someone set is never changed.
- **Promotion.** One pull request moves the flag to `experimental` or `stable`, runs `promote`,
  carries the release bump label, and takes the milestone of the release that turns it on.

## Nobody has to watch

**Workstream report** (`workstream-report.yml`) runs weekly and edits one issue labelled
`workstream-report`: feature branches with no commit for 14 days, incubating flags whose
tracking issue was quiet for 30 days, and open `sync-conflict` issues. Quiet work shows up
there instead of being remembered.

## Feature branches (`feature/<name>`)

A long-lived branch is the exception, for work that cannot ship dark: an outside sign-off gates
even dark code, or the change breaks the store format or protocol and cannot be hidden.

- **Pull requests only.** Work reaches `feature/<name>` through reviewed pull requests, as on
  `main`. The `feature/*` ruleset requires a pull request and the `check (node 24)` check from
  GitHub Actions with the strict policy (the head must be up to date with the feature branch),
  and blocks force pushes and deletion.
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
  A conflict opens no pull request: one issue per branch, `Sync conflict: feature/<name>` with
  the `sync-conflict` label, lists the files for the workstream's owner, and the next clean sync
  closes it.
- **Unattended merging needs the ruleset.** The workflow merges only when the repository
  variable `FEATURE_SYNC_AUTO_MERGE` is `true` and, read before every merge, one active ruleset
  on the feature branch requires a pull request and `check (node 24)` from GitHub Actions
  (app 15368) under the strict policy, with no bypass actors. The bypass list is visible only to
  a token that can administer rulesets; if the release App's token cannot read it, the ruleset
  counts as unverified and sync pull requests wait for a person. Right before merging it also
  reads the feature branch again and skips the merge if it moved since the check; between that
  read and the merge, the strict, unbypassable rule is what makes GitHub refuse a merge onto a
  moved branch. Set the variable only after that ruleset exists.
- **Landing.** One pull request from `feature/<name>` into `main` when the gate opens. Its
  changelog fragments live in `changelog.d/` on the branch and arrive with it; the landing pull
  request takes the target release's milestone.

Current feature branches: `feature/claude-agent-sdk` (gate #1132, tracking #1153) and
`feature/codex-app-server` (gate #1168, tracking #1189).
