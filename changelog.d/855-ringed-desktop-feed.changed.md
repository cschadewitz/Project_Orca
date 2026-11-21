- **release:** the private Windows update feed is now a Cloudflare R2 bucket behind a small
  Worker, with rings (internal, preview, stable), percentage rollouts and the
  `Desktop feed (publish signed)` and `Desktop feed (promote)` workflows. Only verified signed
  installers for a tagged commit enter the feed, offered to `internal` first. It replaces the
  SSH feed host (`ORCA_FEED_HOST`); the feed stays off until `ORCA_FEED_BUCKET` is set
  ([UPDATING.md](docs/UPDATING.md#rings-and-controlled-rollouts)).
- **app:** Windows installs that set `ORCA_UPDATE_PRERELEASE=1` (internal and preview testers)
  are offered release candidates from the feed; all others still ignore them, and downgrades
  stay refused.
