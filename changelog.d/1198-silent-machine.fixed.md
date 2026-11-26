- **app:** a watched or focused machine that stops answering without closing the connection,
  such as a server that lost power, now shows as reconnecting within 11 seconds instead of
  connected until the SSH tunnel's keepalive gave up. The push stream asks a silent daemon
  whether it is still there after 3 s and reopens when nothing answers within 3 s (#1198).
