`run.created` payloads may now carry `workspace.previousBranch`, an optional string: the branch
(or detached commit) a `local` workspace was on before ORCA checked out the work item's
`orca/<slug>` branch. It is additive; existing stores need no migration, and runs created
before this change simply lack it.
