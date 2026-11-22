Stores now record their format and the ORCA version that last wrote them in
`store-format.json`. Opening a store written before the marker existed, or in the previous
release's format, carries it forward only after checking: no live run lease, a whole-store
copy into `format-backups/` verified byte for byte, no change to the store during the copy,
and every run log, collection and plan journal readable by the new build. Only then is the
backup published (the newest two verified backups are kept) and the current format stamped.
Any failure refuses startup and leaves the prior format in charge. A store written by a newer
format, or older than the previous release's, is refused without being changed. The marker is
additive: the store epoch stays `operator-journals-v4`, and builds before 0.7.1 ignore it.
