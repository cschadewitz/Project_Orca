- **cli:** `orca-cli remote agent install|login|status <host>` puts a pinned agent (Codex or
  GitHub Copilot CLI) on a server that `remote add` set up, and signs it in there (#1236). This
  computer downloads the agent's pinned npm packages, checks their integrity and copies them
  over the pinned host key. The host unpacks them without npm or any install script. Sign-in is
  the agent's own device-code flow, approved in this computer's browser, and the credential
  stays on the host.
