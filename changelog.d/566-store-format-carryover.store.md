Stores now record their format and the ORCA version that last wrote them in
`store-format.json`. Opening a store written before the marker existed, or in the previous
release's format, first copies the whole store into `format-backups/` inside it (the newest
two are kept), then stamps the current format. A store written by a newer format, or older
than the previous release's, is refused without being changed. The marker is additive: the
store epoch stays `operator-journals-v4`, and builds before 0.7.1 ignore it.
