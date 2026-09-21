- **store:** two processes over one store no longer lose each other's documents. A
  `JsonFileDocumentStore` collection used to be read once and rewritten whole from that
  first view, so a long-lived `orca serve` beside a one-shot `orca plan decide` wrote back a
  stale map and dropped whatever the other had written in between — and never saw it on a
  read either. The cache is now trusted only while the file's `{ino, size, mtimeMs}` is
  unchanged, so every `get`/`list` picks up another writer's work, and every
  `put`/`putMany`/`delete` runs inside the `<file>.lock` lock, re-reading under it before it
  renames the new collection into place. Requests, work items, plans, dependencies, risks
  and decisions are all covered; writes are still coalesced, still atomic (tmp + rename) and
  the on-disk format is unchanged.
