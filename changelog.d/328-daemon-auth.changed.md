- **daemon:** `startDaemon` refuses to start without an explicit `auth` policy, and the
  unauthenticated `loopback-unauthenticated` compatibility mode is refused off loopback. A
  non-loopback bind needs a TLS-terminating proxy named in `trustedProxies`; requests that
  bypass it, arrive over plain http through it, carry a disallowed `Origin` or a non-loopback
  `Host`, or put a credential in the URL are refused. A method missing from the operation
  inventory is `AUTH_FORBIDDEN` even when a method table answers it.
