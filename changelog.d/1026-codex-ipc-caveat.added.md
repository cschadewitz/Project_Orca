- **agents:** an opted-in Codex session (`nativeToolHook: experimental`) now logs, once admitted,
  which host communication endpoints Codex's processes can reach: listening unix sockets and TCP
  ports, and named pipes in the usual per-user and temporary directories. When none is found it
  says "None detected at startup; isolation has not been verified.", and it names any part of
  the check that was incomplete. It is a warning only: it does not restrict the agent or verify
  isolation.
