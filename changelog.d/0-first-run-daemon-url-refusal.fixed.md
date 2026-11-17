- **app:** First-run setup's **Connect selected local workspace** now says when `ORCA_DAEMON_URL`
  is what stopped it. With that variable set, the launch is pinned to that daemon and setup
  cannot start its own, but the card showed the generic "could not verify the selected
  directories" refusal, which pointed at the folders instead.
