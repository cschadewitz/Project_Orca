A `.orca` store now has a `<file>.lock` beside each of its document collections —
`requests.json.lock`, `work-items.json.lock`, `plans.json.lock` and so on — because every
`JsonFileDocumentStore` mutation runs inside that lock (#196). The lock is created when a
write happens and removed when it finishes, so one is only on disk while somebody is
writing, or after a process died mid-write; a stale one is broken by the next writer on the
same rules the JSONL logs have always used, and a lock file is never a thing to clean up by
hand. Nothing reads them but ORCA, they carry no data, and a store copied or committed with
one in it loads exactly as it would without.

The collections themselves are written through a temp file named with a random tag rather
than the writing process's pid alone, and flushed before the rename, so a crash or a power
loss mid-write can leave a `<file>.<pid>.<tag>.tmp` behind but can never leave the
collection itself half-written. A leftover `.tmp` is safe to delete.
