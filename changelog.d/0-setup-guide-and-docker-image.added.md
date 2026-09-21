- **deploy:** `deploy/docker/` — a two-stage image that builds the single-file daemon from
  the checkout and runs `orca serve` over a workspace mounted at `/workspace`, with Claude
  Code and Codex behind their ACP adapters (`claude-agent-acp`, `codex-acp`) and a
  `compose.yaml` that publishes the port to loopback only. `--build-arg AGENTS=` builds it
  without the agents, for a daemon whose agents are on another host or that serves
  `--read-only`.
- **docs:** `docs/SETUP.md` — the setup guide for this release: the daemon in Docker, both
  agents authenticated and pinged, the desktop app, and what connecting each client actually
  is. Kepler reaches ORCA as an ACP agent over stdio and never touches the daemon's port;
  T3 Code cannot reach it in either direction and the section says so rather than offering a
  shape for it. Its remote half leads with what the protocol does not do: the port carries no
  authentication, and the client can present no credential — not a header, not a client
  certificate, and not one in the URL, which Node's `fetch` refuses outright — so an SSH
  tunnel or a VPN is the only thing that makes a remote daemon safe.
