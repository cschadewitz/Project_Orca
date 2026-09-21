- **daemon:** `config.get` returns the ADR 0009 permission sidecar
  (`orca.permissions.json`) as a second document beside `orca.config.yaml`, each with its own
  path and its own revision, and reports the effective permission policy per agent — the
  configured rules first, then the sidecar's, in the order `decidePermission` matches them,
  each labelled with the document it came from and carrying its `addedAt` / `grantedFor`. A
  client can now show why an agent was allowed something without re-implementing the
  layering.
- **daemon:** `config.set` on the `permissions` document writes it through the existing
  writer in `@orca/agents`, under the same `link()` lock and in the same fixed key order, so
  an operator editing a grant and a run answering "allow always" both land instead of one
  silently overwriting the other. A document carrying a `default` is refused: answering one
  prompt must not change the answer to every other one.
- **daemon:** `config.changed` is pushed when ORCA writes the sidecar itself, not only when
  a client does, so a screen watching the policy sees a grant a run just recorded.
- **agents:** `replacePermissionPolicyFile` and `parsePermissionPolicyDocument`, the
  operator's half of the sidecar writer.
