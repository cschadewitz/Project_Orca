- **app:** Add a machine and Add profile list the machines on your tailnet (#1233, #1226).
  Picking one binds the profile to it, hides the jump host, and allows setup only on an online
  Linux machine. Setup carries the signed bundle to the machine (#1234). A Tailscale SSH login
  that waits for approval is shown in the dialog with the page's host, and **Open approval
  page** opens it (#1228). The confirmation says when the host keys come from your tailnet
  (#1227).
