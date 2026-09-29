The store gains a `workflows/` directory: `startRun` keeps the definition each run starts on
as `workflows/<id>@v<version>.json`, written once, and a resumed run walks that definition
rather than the file on disk when the file has moved to another version. `run.created` gains
an optional `workflowStored: true` saying the definition was kept. Runs that predate this
carry no `workflowStored` and have no stored definition; they resume on whatever workflow file
is current, exactly as before. Nothing needs migrating. A run that does carry
`workflowStored` but whose version is neither in `workflows/` nor on disk (a store copied
without that directory) refuses to resume with `WORKFLOW_VERSION_NOT_FOUND`.
