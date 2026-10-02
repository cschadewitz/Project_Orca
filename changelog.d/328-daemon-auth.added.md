- **daemon:** authentication and authorization on `/rpc` and `/socket`. Bearer credentials
  (`orca1.<id>.<secret>`, hash-only on disk) with expiry, rotation and revocation; a local
  bootstrap token file for same-user clients; a deny-by-default permission matrix over every
  method; per-principal resource scopes that filter lists, hide other principals' runs,
  artifacts, gates and notifications behind the same not-found a missing id gets; a separate
  grant for standing permission rules; socket credentials re-checked per message,
  notification and interval, closing with `4401` on revocation or expiry; and a JSON-lines
  security audit log. `docs/daemon-security.md` has the matrix, deployment and migration.
