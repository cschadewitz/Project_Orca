- **daemon:** `config.set` no longer drops a permission grant recorded while the operator's
  form was open. The `CONFIG_STALE` revision check and the write were two unsynchronised
  steps, so a run answering "allow always" between a client's `config.get` and its
  `config.set` landed in the window between them — and since `config.set` is a replace and
  not a merge, the save then wrote the grant away with nobody told. The revision is now
  re-hashed inside the lock the write takes: the sidecar's own `link()` lock, via a new
  `expectedRevision` on `replacePermissionPolicyFile`, and `<configFile>.lock` for
  `orca.config.yaml`. Two saves made against one revision can no longer both land; the second
  is refused with `CONFIG_STALE` and both revisions, which is what it was always supposed to
  be.
- **daemon:** `runs.start` and `runs.resume` report a lease taken by (or taken away for)
  another process as `RUN_LEASED_ELSEWHERE`, the way `runs.cancel` already did, instead of an
  unclassified internal fault with no run id on it.
- **daemon:** `claims.release` is served by any daemon that drives runs, not only one that
  also has a plan. It has always been in the `runs.control` capability's method list on the
  wire, and it needs no plan at all — but it was behind the plan's writing half, so a daemon
  over a store with no plan in it advertised the method and then answered "unknown method".
- **cli:** `orca serve` advertises `plan.read` / `plan.write` only when it actually serves
  the plan methods, instead of always. A client hiding a plan surface on the capability now
  hides it at the right times.
