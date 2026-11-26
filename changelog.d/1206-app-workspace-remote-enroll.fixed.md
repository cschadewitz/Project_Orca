- **app/daemon:** A workspace the desktop app set up can now enroll a delegation remote. Config
  has a Remote daemons section that lists the configured remotes and their enrollment, and
  Enroll there pins the host key you give and has the worker issue the credential (on Windows,
  paste one the worker issued; it is proved first and saved only when the enrollment commits,
  so a refused one never replaces the credential in use). The app's own daemon runs the enrollment, so the workspace's
  first-run fence still refuses `orca remote enroll` from the CLI, now with a message naming the
  app route.
- **protocol:** 2.13 adds `remotes.list` (`config.read`) and `remotes.enroll` (`config.write`,
  audited), offered by a daemon that may write its workspace.
- **daemon:** enrolling with a credential the worker refuses now answers `DELEGATION_REFUSED`
  instead of an internal error. An enrollment record for a pasted credential names its own
  token file; ORCA 0.8.0 cannot read such a record and asks for the remote to be enrolled again.
