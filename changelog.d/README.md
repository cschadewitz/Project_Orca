# Changelog fragments

Release notes are written here, one file per entry, and rendered into `CHANGELOG.md` when a
release is prepared. A pull request adds a *new* file rather than editing a shared list, so
two pull requests in flight no longer conflict on the same region of the same file.

## Writing one

Name it `<issue>-<slug>.<section>.md`:

```
changelog.d/152-runs-surface.added.md
changelog.d/198-preload-cjs.changed.md
```

`<issue>` is the issue number the work closes (`0` if there is none), and it is what the
entries are ordered by. `<section>` is one of:

| Section | Heading it renders under | Shape |
| --- | --- | --- |
| `store` | `### Store format` | prose — what a change means for an existing `.orca` store |
| `added` | `### Added` | bullets |
| `changed` | `### Changed` | bullets |
| `fixed` | `### Fixed` | bullets |

The file holds the entry verbatim, keeping the area prefix the commits use:

```markdown
- **cli:** `orca leases [list | break <runId> [--force] [--keep]]`.
```

A pull request with two unrelated entries writes two files. Wrap at the same width as
`CHANGELOG.md`; the text is copied through untouched.

`store` is the section to think about rather than skip: ORCA is event-sourced, so a change
to the event log, plan journal, artifact index or config schema can invalidate a store
someone already has. A release with no `store` fragment renders "No change.", which is a
claim — write the fragment when it would be false, and see `docs/RELEASING.md`.

## Reading and releasing them

```bash
node tools/release.js notes --unreleased   # what is pending, rendered
node tools/release.js prepare 0.4.0        # render into CHANGELOG.md and delete the fragments
```

`prepare` renders the sections in the order above, each omitted when empty, and the
fragment deletions land in the `release: vX.Y.Z` pull request alongside the section they
became.
