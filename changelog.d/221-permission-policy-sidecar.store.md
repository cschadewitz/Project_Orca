No change to an existing `.orca` store: the event log, plan journal and artifact index are
untouched, and so is `orca.config.yaml`.

There is one new file, and it is not in the store. `orca.permissions.json` appears beside
`orca.config.yaml` the first time someone answers an agent's permission prompt with
"always"; until then it does not exist, and a workspace without one evaluates permissions
exactly as before. It is a project file rather than store state on purpose — the grants in
it are meant to be reviewed — so decide whether to commit it or ignore it the way you would
any other file in the repository. Committing it is the intended default.

The `permissions:` rules in `orca.config.yaml` keep their meaning and keep their precedence:
they are evaluated before anything in the sidecar. A rule may now match on `path:` (one
exact location, resolved against the run's workspace when relative) as well as the existing
`pathPrefix:`; configs written before this release parse and behave unchanged.
