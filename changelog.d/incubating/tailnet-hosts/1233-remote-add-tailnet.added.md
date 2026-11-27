- **cli/app:** `orca-cli remote add <machine> --tailnet` sets up a machine from your tailnet
  by its name (#1233): the profile is bound to the machine, a Tailscale SSH login that needs
  approval prints the link, and when the machine runs Tailscale SSH the server is checked
  against the host keys your tailnet advertises instead of a first-seen key (#1227). A machine
  without Tailscale SSH gets the one command to enable it. `--push-bundle` copies the signed
  bundle from your computer (#1234). The desktop app's server check uses the advertised keys
  the same way.
