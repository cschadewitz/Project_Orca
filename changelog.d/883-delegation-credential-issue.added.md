- **daemon:** `orca remote enroll <id>` issues the remote's credential itself when none is
  saved (or with `--issue`): after verifying the remote's host keys it runs the remote's ORCA
  CLI over the same ssh (`auth issue delegate-<workspace id> --preset client`, scoped to the
  workflows this config's agents delegate there), checks the credential, and saves it beside
  the config, readable only by this user. Re-enrolling reuses it; `--issue` rotates it. A
  rotation that fails part way leaves the previous enrollment working. A credential it issued
  and no longer uses is revoked only on the daemon that issued it; anything it cannot revoke
  yet is kept on a pending list and retried.
