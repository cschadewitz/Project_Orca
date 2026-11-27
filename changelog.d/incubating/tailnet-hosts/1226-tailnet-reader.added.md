- **protocol:** Remote daemon hosts can be found on your own Tailscale tailnet (#1225). ORCA reads
  the Tailscale client you are already signed in to, by its fixed install path, and never changes
  it or your tailnet. A profile picked from the tailnet is bound to the machine's stable node ID,
  so a renamed or reused name cannot redirect it, and a machine that runs Tailscale SSH can have
  its host key pinned from the keys your tailnet advertises instead of a fingerprint you check by
  hand. Those keys are vouched for by your tailnet's coordination server; Tailnet Lock does not
  sign them.
