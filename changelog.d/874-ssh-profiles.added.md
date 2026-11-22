- **app:** Connect to a daemon on another machine with a saved SSH profile (`user@host`, optional
  port, key file and one jump host). The app runs its own `ssh -L` tunnel without reading any ssh
  config, pins the server's host key on the first connect, keeps the profile's daemon credential
  in the system keychain and sends it only while the tunnel is verified, and reconnects on the
  same local port when the tunnel drops. A changed host key, failed SSH sign-in, missing ssh
  client, a tunnel port that cannot be bound and a server with no daemon listening each get their
  own message. `ORCA_DAEMON_URL` and `ORCA_DAEMON_TOKEN_FILE` still take precedence.
