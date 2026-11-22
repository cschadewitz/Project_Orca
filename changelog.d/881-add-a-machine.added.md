- **app, cli:** Make a reachable Linux machine a managed ORCA server in one step: **Add a
  machine** in the connection dialog, or `orca remote add user@host` from a source checkout.
  It first checks the machine read only and shows the server's host key fingerprints, the
  account and what it will do; nothing is pinned or installed until you confirm exactly that.
  It then installs this version's signed server bundle, the wrappers and the systemd user unit,
  starts the daemon and checks it, and in the app signs in automatically. A re-run verifies and
  repairs instead of reinstalling, keeps the operator's settings, and starts only a release it
  staged and verified for exactly that version. A machine with an unmanaged ORCA installation
  is refused with the inventory guidance. Setup is fenced against a concurrent setup or update;
  a failed run puts the service, link and lingering back as it found them (durably, even if the
  session drops), and nothing is saved or signed in to unless the result matches what was
  confirmed.
