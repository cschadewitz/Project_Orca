- **app:** A remote daemon profile can be bound to a machine on your tailnet (#1226): it dials
  that machine's current Tailscale address on every connect and refuses to connect to a
  different machine that took its name. Its host key can be pinned from the keys the machine
  advertises when it runs Tailscale SSH (#1227). A Tailscale SSH login that waits for approval
  in your browser (check mode) now shows the approval link and waits for it, instead of timing
  out (#1228).
