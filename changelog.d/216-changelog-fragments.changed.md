- **build:** release notes are written as fragments in `changelog.d/`, one file per entry
  named `<issue>-<slug>.<section>.md`, and `node tools/release.js prepare` renders them into
  the dated `CHANGELOG.md` section and deletes them (#216). Two pull requests in flight no
  longer edit the same region of the same file; `## Unreleased` holds a pointer instead of a
  list, and `node tools/release.js notes --unreleased` prints what is pending. `notes
  <version>` still reads the committed changelog, so the published release body is unchanged.
