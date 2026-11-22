- **app:** Connect to a daemon on another machine with a saved SSH profile (`user@host`, optional
  port, key file and one jump host). The app runs its own ssh without reading any ssh config,
  pins the server's host key on the first connect (and refuses to re-pin a key that went missing
  until you forget it), and keeps the profile's daemon credential in the system keychain. Every
  connection to the daemon is its own authenticated `ssh -W` stream, so the credential reaches
  the pinned server or nowhere. A changed or missing host key, failed SSH sign-in, missing ssh
  client and a server with no daemon listening each get their own message. `ORCA_DAEMON_URL` and
  `ORCA_DAEMON_TOKEN_FILE` still take precedence.
