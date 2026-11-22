Stores now record their format and the ORCA version that last wrote them in
`store-format.json`. A 0.7.0 store (same format, no marker yet) is stamped on first open with
nothing else changed. Ordinary startup never converts a store: one written in an older format
is refused (`STORE_FORMAT` / `CARRYOVER_REQUIRED`) until `orca store carry-forward` is run once
with every other ORCA stopped. That command refuses unless no run lease is live, a whole-store
copy into `format-backups/` matches byte for byte, the store did not change during the copy,
and every run log, collection and plan journal reads under the new build; only then is the
backup published (the newest two verified backups are kept) and the format stamped. A store
written by a newer format, or older than the previous release's, is refused without being
changed. The store epoch stays `operator-journals-v4`; builds before 0.7.1 ignore the marker.
