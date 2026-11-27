- **cli:** `orca-cli remote enroll <id> --tailnet` enrolls a delegation remote with the host
  keys your tailnet advertises for its host (#1229), instead of fingerprints read off the
  worker's console with `--host-key`. The worker must run Tailscale SSH; a machine shared in
  from another tailnet still needs `--host-key`.
