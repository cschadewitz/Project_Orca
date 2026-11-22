- **daemon:** A delegated run records where it came from. A daemon that delegates a step
  states its workspace id, the parent run and the step as the remote run's `origin`
  (protocol 2.6: optional `origin` on `runs.admit`, canonical ids only, offered by the remote
  in `hello.admitFields`); the remote shows it on the run and in the audit record of the
  admission. A remote that does not offer it is delegated to without it.
