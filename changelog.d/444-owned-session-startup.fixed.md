- **agents/engine:** Close owned agent sessions when handshake or startup event
  bookkeeping fails. Direct-child cleanup now waits for exit with bounded SIGTERM
  and SIGKILL grace periods, reports incomplete cleanup separately, and preserves
  the original startup failure.
