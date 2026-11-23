- **daemon:** `orca remote enroll <id>` issues the remote's credential itself when none is
  saved (or with `--issue`): after verifying the remote's host keys it runs the remote's ORCA
  CLI over the same ssh (`auth issue delegate-<workspace id> --preset client`, scoped to the
  workflows this config's agents delegate there), checks the credential, and saves it beside
  the config, readable only by this user. A credential it issued and could not verify, or one
  it issued earlier and has now replaced, is revoked on the remote.
