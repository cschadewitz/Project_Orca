- **daemon:** A delegated run records where it came from. A daemon that delegates a step
  states its workspace id, the parent run and the step as the remote run's `origin`
  (protocol 2.6, optional `origin` on `runs.admit`); the remote shows it on the run and in
  the audit record of the admission. Remotes on an older protocol are delegated to without it.
