- **agents:** an opted-in Codex session (`nativeToolHook: experimental`) now logs, once admitted,
  the potential host communication endpoints observed from the ORCA daemon at startup: listening
  unix sockets and TCP ports in the daemon's network namespace, and named pipes in the per-user
  runtime, temporary and home directories. Sandbox reachability is not tested. When nothing is
  found where it looked it says "None detected at startup; isolation has not been verified.", and
  it names any part of the check that was incomplete. It runs in the background with a deadline
  and does not delay or block the session. It is a warning only: it does not restrict the agent
  or verify isolation.
