- **store:** Publish content-addressed artifact blobs without overwriting shared bytes,
  synchronize them before indexing, and reject corrupted bodies on read or reuse.
  Existing blob paths and index records remain compatible; no migration is required.
