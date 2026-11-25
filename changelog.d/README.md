# Changelog fragments

This page is for anyone whose pull request changes `packages/`. It shows how to write a release
note as its own file here. `node tools/release.js prepare` renders the files into `CHANGELOG.md`.
One file per entry means two open pull requests never conflict on the same lines.

## Write one

Name the file `<issue>-<slug>.<section>.md`:

```
changelog.d/152-runs-surface.added.md
changelog.d/198-preload-cjs.changed.md
```

- `<issue>` is the issue the work closes, or `0` if none. Entries are ordered by it.
- `<section>` is one of:

| Section | Renders under | Shape |
| --- | --- | --- |
| `store` | `### Store format` | Prose: what the change means for an existing `.orca` store. |
| `added` | `### Added` | Bullets. |
| `changed` | `### Changed` | Bullets. |
| `fixed` | `### Fixed` | Bullets. |

The file holds the entry as written, with the area prefix the commits use:

```markdown
- **cli:** `orca leases [list | break <runId> [--force] [--keep]]`.
```

Two unrelated entries go in two files. Wrap at the same width as `CHANGELOG.md`; the text is
copied unchanged.

## The area prefix groups entries

Inside each section, entries are grouped by area prefix. The bullet above renders as:

```markdown
### Added

#### cli

- `orca leases [list | break <runId> [--force] [--keep]]`.
```

- The prefix moves into the heading, so spell it as the commits do (`app`, `cli`, `core`,
  `design`, `protocol`, `engine`, `store`, …). A typo becomes a heading of its own.
- A combined prefix such as `cli/daemon` is its own group.
- Groups are alphabetical. Entries inside a group keep their issue order.
- One file's bullets may have different prefixes; each goes to its own group.
- A bullet with no prefix renders above the groups. `store` prose renders this way.

**Think about `store`; do not skip it.** ORCA is event-sourced. A change to the event log, plan
journal, artifact index or config schema can break a store someone already has. A release with
no `store` fragment says "No change.", which is a claim. Write the fragment when that claim would
be false. See [Releasing](../docs/RELEASING.md).

## The check

`.github/workflows/changelog.yml` runs only when dispatched by hand. Dispatch **Changelog** with
the pull request number. It fails when `packages/` changed and no new file was added here. It
checks nothing else; `tools/changelog.js` checks the section name when a release renders it.

If a `packages/` change means nothing to someone upgrading (a refactor, a test, a comment), label
the pull request `no-changelog`. Pull requests labelled `release` are also skipped. Dispatch
again after changing a label. A note, or a reason for none, is still required.

## Read and release

```bash
node tools/release.js notes --unreleased   # show what is pending, rendered
node tools/release.js prepare 0.4.0        # render into CHANGELOG.md and delete the fragments
```

`prepare` renders the sections in the table's order, leaves out empty ones (except `store`) and
groups each by prefix. The deleted fragments land in the `release: vX.Y.Z` pull request, whose
body is the rendered section.
