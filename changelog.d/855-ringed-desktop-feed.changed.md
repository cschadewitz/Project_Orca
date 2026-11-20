- **release:** the private Windows update feed is now a Cloudflare R2 bucket behind a small
  Worker, with rings (internal, preview, stable), percentage rollouts and a
  `Desktop feed (promote)` workflow. Publication offers a new version to `internal` only. It
  replaces the SSH feed host (`ORCA_FEED_HOST`); the feed stays off until `ORCA_FEED_BUCKET` is
  set ([UPDATING.md](docs/UPDATING.md#rings-and-controlled-rollouts)).
