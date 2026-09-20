# Releasing

A release of ORCA is a git tag, a GitHub release, and the `CHANGELOG.md` section they
both quote. Nothing is published to a registry: every package under `packages/` is
`private: true` and they move in lockstep, so there is exactly one version for the whole
repository, held in the root `package.json`.

Releases start at `0.2.0`. `0.1.0` was the untagged groundwork commit.

## The unit of release is a milestone

A milestone is the story: a set of issues that together make a coherent thing to announce.
Closing it proposes the release.

1. Every issue in the milestone carries one **bump label** — `release:major`,
   `release:minor`, `release:patch`, or `release:none` for internal churn nobody upgrading
   needs to know about. An issue with no bump label counts as `release:none`, and the
   release pull request lists those issues so an under-bump is visible rather than silent.
2. Each pull request drops its entry into `changelog.d/` as a **fragment** — one file per
   entry, named `<issue>-<slug>.<section>.md`, holding the bullet(s) verbatim. This is the
   part that matters: the notes are written when the change is fresh, by whoever made it,
   and releasing never has to reconstruct them from commit subjects. `changelog.d/README.md`
   has the naming and the four sections; `node tools/release.js notes --unreleased` renders
   what is pending.
3. When the work is done, **close the milestone**. `release-prepare.yml` checks that no
   issue in it is still open, takes the highest bump label, computes the next version, and
   opens a `release: vX.Y.Z` pull request that bumps `package.json`, renders the fragments
   into a dated changelog section and deletes them.
4. Review that pull request. Its body is the release body verbatim — to change the notes,
   edit `CHANGELOG.md` on the release branch.
5. **Merge it.** `release-publish.yml` re-runs typecheck, lint, format, tests, build and
   the compiled-CLI smoke test against the merge commit, then tags `vX.Y.Z` and publishes
   the release with the changelog section as its body and GitHub's generated list of
   merged pull requests appended underneath.

Closing a milestone stops at a pull request on purpose. A milestone can be closed by
accident and reopened; a published tag cannot be unpublished cleanly. One merge click is
the whole cost of that safety.

**The release pull request shows no CI checks.** GitHub does not start a workflow run from
an event created with `GITHUB_TOKEN`, so the PR that `release-prepare.yml` opens never
triggers `ci.yml`. That is why `release-publish.yml` re-runs the full check set against
the merge commit before it tags: the verification happens, just after the merge rather
than before it. If `release-publish.yml` fails, the version bump is on `main` with no tag
against it — fix forward and re-run the workflow. Giving `release-prepare.yml` a personal
access token instead of `GITHUB_TOKEN` would move the checks back onto the PR, at the cost
of a token to store and rotate; that trade is only worth making if `main` ever gains
required status checks.

## Changelog fragments

`CHANGELOG.md` is rendered, not edited. Its `## Unreleased` section holds a pointer, and
the entries waiting for the next release are files in `changelog.d/`:

```
changelog.d/152-runs-surface.added.md
changelog.d/198-preload-cjs.changed.md
changelog.d/101-leases.store.md
```

`<section>` is `store`, `added`, `changed` or `fixed`, and is the heading the file renders
under; `<issue>` is what the entries are ordered by. The body is the entry verbatim —
bullets with their area prefix, or prose for `store`. Two entries mean two files.

The point is that a pull request creates a file instead of editing a shared list, so two
pull requests in flight cannot conflict over the changelog — and a dropped fragment is a
missing file rather than a lost merge. `changelog.d/README.md` is the reference.

`prepare` renders the fragments into the dated section and deletes them, so the deletions
land in the `release: vX.Y.Z` pull request beside the section they became. Nothing else
reads `changelog.d/`: `notes <version>` quotes the committed `CHANGELOG.md`, which is what
`release-publish.yml` publishes.

## Versioning

Semantic versioning, with one pre-1.0 rule: while the major version is `0`, a
`release:major` label bumps the **minor** version (`0.1.0` to `0.2.0`), the same as
`release:minor`. Under semver `0.x` promises nothing anyway, and reaching `1.0.0` should
be a decision rather than the side effect of a label.

To release a version the labels would not produce — `1.0.0`, or a release candidate — put
a line in the **milestone description**:

```
Release: v0.3.0-rc.1
```

That overrides the labels. A version with a prerelease suffix is published with
`--prerelease`, so it never becomes the repository's "latest".

### What counts as breaking

Not the TypeScript API — nothing outside this repository imports it. ORCA's compatibility
surface is what lives on disk and what operators write by hand:

| Surface | Where |
| --- | --- |
| Event log and plan journal schema | `packages/store`, `packages/core/src/events` |
| Artifact index and artifact front matter | `packages/store`, `templates/` |
| Workflow and program YAML schema | `workflows/`, `packages/core/src/schema` |
| `orca.config.yaml` schema | `packages/core/src/config` |
| CLI command and flag names | `packages/cli` |
| Supported Node versions | `engines` in `package.json` |

ORCA is event-sourced, so a change to the first two can invalidate an existing `.orca`
store — the failure mode most likely to bite someone who upgrades, and the one least
likely to be noticed in review. Every release therefore carries a **Store format** section
in the changelog — rendered from the `store` fragments, and saying "No change." when there
are none — and a store-format change is at least a minor bump pre-1.0. "No change." is a
claim the release makes on your behalf: write the fragment when it would be false.

Documentation under `docs/` describes `main`, not the last release. Link docs at the tag
(`/blob/vX.Y.Z/docs/...`) when a release note needs to point at them.

## Doing it by hand

The workflow is a wrapper around `tools/release.js`, which is offline and has no
dependencies:

```bash
node tools/release.js version --bump minor    # print the next version
node tools/release.js notes --unreleased      # print what changelog.d/ holds
node tools/release.js prepare 0.2.0           # bump package.json, render the fragments
node tools/release.js notes 0.2.0             # print that release's notes
```

`prepare` refuses to run when `changelog.d/` is empty — a release whose notes nobody wrote
is worse than no release — and when `## Unreleased` has picked up entries written by hand,
which its rewrite would otherwise throw away.

To release without closing a milestone, run **Release (prepare)** from the Actions tab
with a milestone number. To skip the automation entirely, do the three commands above,
merge the result, and `gh release create vX.Y.Z --notes-file <(node tools/release.js notes X.Y.Z) --generate-notes`.

## Repository settings this depends on

- **Settings → Actions → General → Workflow permissions**: "Allow GitHub Actions to create
  and approve pull requests" must be on, or `release-prepare.yml` cannot open its PR.
- **Labels**: `release`, `release:major`, `release:minor`, `release:patch`, `release:none`.
- The repository is private, so releases are visible to collaborators only. Making them a
  distribution channel means making the repository public first.
- Nothing is attached to a release beyond the source tag. When built artifacts are
  wanted, add them to `release-publish.yml` after the build step. Two are planned, both
  from the same commit so their protocol versions agree by construction: a **daemon**
  artifact (the CLI with `orca serve`, no Electron) and a **desktop** artifact (the
  Electron app with that same daemon build bundled inside it, spawned on launch unless
  `ORCA_DAEMON_URL` points elsewhere). The `hello` handshake still carries the protocol
  version, because a desktop build will eventually attach to an older daemon on another
  machine. Desktop packaging needs platform runners and its own workflow; it must not be
  bolted onto `ci.yml`, which never launches the app.
