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

## The area prefix is the second grouping

Rendering groups a section twice: by change type, which is the `<section>` above, and inside
that by **change target**, which is the area prefix. The bullet above renders as

```markdown
### Added

#### cli

- `orca leases [list | break <runId> [--force] [--keep]]`.
```

— the prefix is removed from the bullet, because the heading it now sits under says it. So
the prefix is not decoration: spell it the way the commits do (`app`, `cli`, `core`,
`design`, `protocol`, `engine`, `store`, …), because a typo becomes a heading of its own
next to the one it meant. A combined prefix like `cli/daemon` is its own target and that is
fine — it says the change is both. Targets render alphabetically; entries inside one keep
their issue order.

One fragment's bullets need not share a target — a pull request that moved the protocol and
the CLI writes both bullets in one file and they are grouped separately. A bullet with no
prefix at all still renders, ungrouped, above the target headings; that is how `store` prose
comes out unchanged.

`store` is the section to think about rather than skip: ORCA is event-sourced, so a change
to the event log, plan journal, artifact index or config schema can invalidate a store
someone already has. A release with no `store` fragment renders "No change.", which is a
claim — write the fragment when it would be false, and see `docs/RELEASING.md`.

## The check

`.github/workflows/changelog.yml` fails a pull request that changes anything under
`packages/` and adds no file here. It asks only that — the section suffix is checked when a
release renders the fragment, and the prose is nobody's business.

Some `packages/` changes genuinely read as nothing to someone upgrading: a refactor, a test,
a comment, a rename with no surface. **Label the pull request `no-changelog`** and the check
passes. Labelling re-runs it, so there is nothing else to click.

## Reading and releasing them

```bash
node tools/release.js notes --unreleased   # what is pending, rendered
node tools/release.js prepare 0.4.0        # render into CHANGELOG.md and delete the fragments
```

`prepare` renders the sections in the order above, each omitted when empty and each grouped
by target inside, and the fragment deletions land in the `release: vX.Y.Z` pull request
alongside the section they became — which is also where the rendered notes are read first,
since that pull request's body is the section verbatim.
